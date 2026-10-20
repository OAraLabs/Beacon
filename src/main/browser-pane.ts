import { WebContentsView, ipcMain, session, shell, type BrowserWindow, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron'
import { debuggingAllowedHere } from './build-flavor'
import { builtinSpellcheck } from '@shared/spellcheck'
import {
  BROWSER_IPC,
  BROWSER_PARTITION,
  EXTRACT_MAX_CHARS,
  composeSendToChat,
  crashError,
  describeLoadError,
  isAllowedNavigation,
  nextZoomLevel,
  normalizeUrlInput,
  permissionNoticeText,
  pushNotice,
  viewBoundsFromRect,
  zoomPercent,
  type BrowserExtract,
  type BrowserHost,
  type BrowserLoadError,
  type BrowserNotice,
  type BrowserState,
  type BrowserTab,
  type ChromeKey,
  type FindRequest,
  type NavigateResult,
  type NoticeKind,
  type ViewRect,
  type ZoomDirection
} from '@shared/browser-pane'
import { isShellSender } from './shell-windows'

// The browser pane's web contents live HERE, in main, as WebContentsViews (Electron ≥ 30; the
// <webview> tag is discouraged and would put the guest inside the shell renderer's process tree).
// The renderer only draws the chrome around a hole and reports where the hole is.
//
// THE INVARIANT (see @shared/browser-pane): the user drives this. This module therefore
//   - imports nothing from the connection / chat / gateway-event world, and handles no frame
//     from the daemon — there is no code path from a message to loadURL;
//   - accepts IPC only from the shell page in its own host windows (paneHost), never from a page;
//   - runs exactly ONE script in a page, a constant, read-only extraction, in an isolated world,
//     only on the user's "Send to chat" click (executeJavaScript is never called);
//   - gives the page no preload and no bridge: sandbox on, contextIsolation on, nodeIntegration off.
// browser-invariant-smoke.ts asserts each of those on the source of this file.

export interface BrowserPaneDeps {
  /** The main shell window (the pane's default host). */
  getMainWindow: () => BrowserWindow | null
  /** Create the pop-out window (Phase 3). `onClose` fires from its 'close' event, before the
   * window is destroyed — the pane reclaims the view there. */
  openPopout: (onClose: () => void) => BrowserWindow
  isDev: boolean
}

interface Tab {
  id: string
  view: WebContentsView
  error: BrowserLoadError | null
  /** The URL the user asked for, so an error page can name it even before did-navigate. */
  requested: string
}

/** Constant, read-only, no interpolation — the ONLY script this app ever runs in a page. It runs
 * in an isolated world (its own JS globals; the page's monkey-patches cannot reach it) on the
 * user's click, and returns text only. */
const EXTRACT_WORLD = 731
const EXTRACT_SCRIPT = `(() => {
  const sel = window.getSelection ? String(window.getSelection()) : '';
  const root = document.querySelector('article, main, [role="main"]') || document.body;
  const text = root ? (root.innerText || root.textContent || '') : '';
  return { selection: sel.slice(0, ${EXTRACT_MAX_CHARS * 4}), text: text.slice(0, ${EXTRACT_MAX_CHARS * 4}) };
})()`

export function registerBrowserPane(deps: BrowserPaneDeps): void {
  const tabs: Tab[] = []
  let activeId: string | null = null
  let hostWin: BrowserWindow | null = null
  let hostKind: BrowserHost = 'none'
  let popout: BrowserWindow | null = null
  let bounds: ViewRect | null = null
  let notices: BrowserNotice[] = []
  let noticeSeq = 0
  let tabSeq = 0
  let find: { active: number; total: number } | null = null
  let sessionReady = false

  // ── who may talk to this module ─────────────────────────────────────────
  /** The host window a chrome control came from, or null to refuse it. Every handler's first call.
   * Two conditions, both required: the sender is the shell page in the top frame of a window Beacon
   * created (isShellSender, the check every privileged handler in main makes), AND that window is
   * one of the pane's two hosts, the main window or the browser pop-out. Quick-capture, the HUD and
   * the terminal pop-out pass the first and not the second.
   *
   * A page has no preload and cannot send IPC at all; this is the belt to that suspender. Before
   * 2026-09-24 it asked only which window the sender was, so a foreign document force-loaded into
   * the main window passed, and a refusal THREW (a rejected invoke; for a send, an exception out of
   * an ipcMain listener). It now refuses the way every other handler does: a send is dropped, an
   * invoke gets null. */
  function paneHost(e: IpcMainEvent | IpcMainInvokeEvent): BrowserWindow | null {
    if (!isShellSender(e)) return null
    const main = deps.getMainWindow()
    if (main && !main.isDestroyed() && e.sender === main.webContents) return main
    if (popout && !popout.isDestroyed() && e.sender === popout.webContents) return popout
    return null
  }

  // ── state out ────────────────────────────────────────────────────────────
  function tabState(t: Tab): BrowserTab {
    const wc = t.view.webContents
    return {
      id: t.id,
      url: t.error ? t.error.url : wc.getURL() || t.requested,
      title: wc.getTitle(),
      loading: wc.isLoading(),
      canGoBack: wc.navigationHistory.canGoBack(),
      canGoForward: wc.navigationHistory.canGoForward(),
      zoomPercent: zoomPercent(wc.getZoomLevel()),
      error: t.error
    }
  }
  function state(): BrowserState {
    return { tabs: tabs.map(tabState), activeTabId: activeId, host: hostKind, notices, find }
  }
  function push(): void {
    const s = state()
    const targets = new Set<BrowserWindow>()
    const main = deps.getMainWindow()
    if (main) targets.add(main)
    if (hostWin) targets.add(hostWin)
    for (const w of targets) {
      if (!w.isDestroyed() && !w.webContents.isDestroyed()) w.webContents.send(BROWSER_IPC.STATE, s)
    }
  }
  function notice(kind: NoticeKind, text: string): void {
    notices = pushNotice(notices, { id: ++noticeSeq, kind, text, at: Date.now() })
    console.log(`[browser] ${kind}: ${text}`)
    push()
  }
  function chromeKey(key: ChromeKey): void {
    if (hostWin && !hostWin.isDestroyed()) hostWin.webContents.send(BROWSER_IPC.CHROME_KEY, key)
  }

  // ── the browsing session: its own partition, nothing granted ────────────
  function ensureSession(): Electron.Session {
    const ses = session.fromPartition(BROWSER_PARTITION)
    if (sessionReady) return ses
    sessionReady = true
    // Permissions: DENIED, no prompt, and the chrome says so. Both the async request
    // (getUserMedia, Notification.requestPermission) and the synchronous check
    // (navigator.permissions.query, Notification.permission) land here; one notice per
    // origin+permission per 10s window, because a page that polls would otherwise flood the
    // chrome with the same refusal while a genuinely repeated ask still gets shown.
    const recent = new Map<string, number>()
    const report = (permission: string, origin: string): void => {
      const key = `${origin}|${permission}`
      const now = Date.now()
      if ((recent.get(key) ?? 0) > now - 10_000) return
      recent.set(key, now)
      notice('permission', permissionNoticeText(permission, origin))
    }
    ses.setPermissionRequestHandler((_wc, permission, cb, details) => {
      report(permission, originOf(details?.requestingUrl ?? _wc.getURL()))
      cb(false)
    })
    ses.setPermissionCheckHandler((_wc, permission, requestingOrigin) => {
      report(permission, originOf(requestingOrigin))
      return false
    })
    ses.setDevicePermissionHandler(() => false)
    // Downloads: BLOCKED in this phase — nothing this pane does writes to disk.
    ses.on('will-download', (e, item) => {
      e.preventDefault()
      notice('download', `Download blocked: ${item.getFilename() || item.getURL()} — this viewer does not save files.`)
    })
    return ses
  }

  // ── tabs ─────────────────────────────────────────────────────────────────
  function active(): Tab | null {
    return tabs.find((t) => t.id === activeId) ?? null
  }

  function createTab(): Tab {
    ensureSession()
    const view = new WebContentsView({
      webPreferences: {
        devTools: debuggingAllowedHere(),
        partition: BROWSER_PARTITION,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        nodeIntegrationInWorker: false,
        nodeIntegrationInSubFrames: false,
        webSecurity: true,
        allowRunningInsecureContent: false,
        webviewTag: false,
        // No preload: the page gets no bridge of any kind. (Justification for adding one would
        // have to appear in the PR that adds it; the invariant smoke pins its absence.)
        // macOS only: elsewhere the built-in spellchecker downloads dictionaries from Google's CDN.
        spellcheck: builtinSpellcheck(process.platform)
      }
    })
    const tab: Tab = { id: `tab-${++tabSeq}`, view, error: null, requested: '' }
    const wc = view.webContents
    view.setBackgroundColor('#ffffff') // pages assume paper; a NOX-dark flash under a white page reads as a glitch

    // window.open / target=_blank: a new tab (Phase 4), else the system browser. NEVER a bare popup.
    wc.setWindowOpenHandler(({ url }) => {
      if (!isAllowedNavigation(url) || url === 'about:blank') {
        notice('popup', `A popup to ${url.slice(0, 80)} was blocked.`)
        return { action: 'deny' }
      }
      if (tabsEnabled) {
        newTab()
        const t = active()!
        t.requested = url
        void t.view.webContents.loadURL(url).catch(() => undefined)
        push()
      } else {
        notice('popup', `Opened ${url.slice(0, 80)} in your system browser (the page asked for a new window).`)
        void shell.openExternal(url)
      }
      return { action: 'deny' }
    })
    wc.on('will-navigate', (e, url) => {
      if (!isAllowedNavigation(url)) {
        e.preventDefault()
        notice('navigation', `Navigation to ${url.slice(0, 80)} was refused — only http and https open here.`)
      }
    })
    wc.on('will-attach-webview', (e) => e.preventDefault())
    // A page's beforeunload prompt would otherwise pin the user to it with no visible dialog.
    wc.on('will-prevent-unload', (e) => e.preventDefault())

    const sync = (): void => push()
    wc.on('did-start-loading', () => {
      tab.error = null
      push()
    })
    wc.on('did-stop-loading', sync)
    wc.on('did-navigate', (_e, url) => {
      tab.requested = url
      tab.error = null
      find = null
      push()
    })
    wc.on('did-navigate-in-page', sync)
    wc.on('page-title-updated', sync)
    wc.on('did-fail-load', (_e, code, description, url, isMainFrame) => {
      if (!isMainFrame) return
      const err = describeLoadError(code, description, url || tab.requested)
      if (!err) return
      tab.error = err
      applyBounds()
      push()
    })
    wc.on('render-process-gone', (_e, details) => {
      tab.error = crashError(wc.getURL() || tab.requested, details.reason)
      applyBounds()
      push()
    })
    wc.on('found-in-page', (_e, r) => {
      find = { active: r.activeMatchOrdinal, total: r.matches }
      push()
    })
    wc.on('zoom-changed', sync)
    // Keystrokes that land in the PAGE but belong to the chrome. Forwarded as key NAMES — the
    // chrome focuses its URL bar or find box; no content crosses.
    wc.on('before-input-event', (e, input) => {
      if (input.type !== 'keyDown') return
      const mod = process.platform === 'darwin' ? input.meta : input.control
      const k = input.key.toLowerCase()
      let key: ChromeKey | null = null
      if (mod && !input.shift && k === 'l') key = 'focus-url'
      else if (mod && !input.shift && k === 'f') key = 'find'
      else if (mod && !input.shift && k === 't') key = 'new-tab'
      else if (mod && !input.shift && k === 'w') key = 'close-tab'
      else if (!mod && k === 'escape') key = 'escape'
      else if (mod && !input.shift && k === 'r') {
        wc.reload()
        e.preventDefault()
        return
      } else if (mod && (k === '[' || (input.alt && k === 'arrowleft'))) {
        wc.navigationHistory.goBack()
        e.preventDefault()
        return
      } else if (mod && (k === ']' || (input.alt && k === 'arrowright'))) {
        wc.navigationHistory.goForward()
        e.preventDefault()
        return
      } else if (mod && (k === '=' || k === '+')) {
        setZoom(tab, 'in')
        e.preventDefault()
        return
      } else if (mod && k === '-') {
        setZoom(tab, 'out')
        e.preventDefault()
        return
      } else if (mod && k === '0') {
        setZoom(tab, 'reset')
        e.preventDefault()
        return
      }
      if (key) {
        e.preventDefault()
        chromeKey(key)
      }
    })
    return tab
  }

  function selectTab(id: string): void {
    const next = tabs.find((t) => t.id === id)
    if (!next) return
    const prev = active()
    if (prev && prev !== next && hostWin && !hostWin.isDestroyed()) {
      try {
        hostWin.contentView.removeChildView(prev.view)
      } catch {
        /* not attached */
      }
    }
    activeId = next.id
    find = null
    attachActive()
    push()
  }

  function ensureTab(): Tab {
    let t = active()
    if (!t) {
      t = createTab()
      tabs.push(t)
      activeId = t.id
      attachActive()
    }
    return t
  }

  // ── hosting ──────────────────────────────────────────────────────────────
  function attachActive(): void {
    const t = active()
    if (!t || !hostWin || hostWin.isDestroyed()) return
    if (!hostWin.contentView.children.includes(t.view)) hostWin.contentView.addChildView(t.view)
    applyBounds()
  }

  function setHost(win: BrowserWindow | null, kind: BrowserHost): void {
    if (hostWin === win) return
    const t = active()
    if (t && hostWin && !hostWin.isDestroyed()) {
      try {
        hostWin.contentView.removeChildView(t.view)
      } catch {
        /* not attached */
      }
    }
    hostWin = win
    hostKind = win ? kind : 'none'
    bounds = null
    attachActive()
    push()
  }

  /** Hidden = invisible AND zero-sized. Electron 33's View has setVisible but no getVisible, so
   * the zero rect is what makes "hidden" observable from outside (the probe reads getBounds). */
  function hide(t: Tab): void {
    t.view.setVisible(false)
    t.view.setBounds({ x: 0, y: 0, width: 0, height: 0 })
  }

  function applyBounds(): void {
    const t = active()
    if (!t || !hostWin || hostWin.isDestroyed()) return
    if (!bounds || t.error) {
      hide(t)
      return
    }
    const [cw, ch] = hostWin.getContentSize()
    const b = viewBoundsFromRect(bounds, hostWin.webContents.getZoomFactor(), { width: cw, height: ch })
    if (!b) {
      hide(t)
      return
    }
    t.view.setBounds(b)
    t.view.setVisible(true)
  }

  function setZoom(t: Tab, dir: ZoomDirection): void {
    t.view.webContents.setZoomLevel(nextZoomLevel(t.view.webContents.getZoomLevel(), dir))
    push()
  }

  function originOf(url: string): string {
    try {
      return new URL(url).host || url
    } catch {
      return url
    }
  }

  /** Phase 4: window.open opens a tab here, not the system browser. */
  const tabsEnabled = true

  // ── tabs (Phase 4) ─────────────────────────────────────────────────────────
  function newTab(): void {
    const t = createTab()
    tabs.push(t)
    selectTab(t.id)
    // ⌘T came from inside a page: keyboard focus must leave that view for the chrome, or the
    // URL bar's focus() is a no-op and the user types into the old page.
    if (hostWin && !hostWin.isDestroyed()) hostWin.webContents.focus()
  }
  function closeTab(id: string): void {
    const i = tabs.findIndex((t) => t.id === id)
    if (i < 0) return
    const [t] = tabs.splice(i, 1)
    if (hostWin && !hostWin.isDestroyed()) {
      try {
        hostWin.contentView.removeChildView(t.view)
      } catch {
        /* not attached */
      }
    }
    t.view.webContents.close()
    if (activeId === id) {
      activeId = null
      const next = tabs[Math.min(i, tabs.length - 1)]
      if (next) selectTab(next.id)
      else push()
    } else push()
  }
  function moveTab(id: string, toIndex: number): void {
    const from = tabs.findIndex((t) => t.id === id)
    if (from < 0) return
    const to = Math.max(0, Math.min(tabs.length - 1, Math.floor(toIndex)))
    if (to === from) return
    const [t] = tabs.splice(from, 1)
    tabs.splice(to, 0, t)
    push()
  }

  // ── pop-out (Phase 3): the SAME web contents move between windows ────────
  // The view is removed from one contentView and added to the other; nothing reloads, history
  // and scroll position survive. Closing the pop-out (red button, ⌘W) reattaches — the page is
  // never lost with the frame around it.
  function detach(): void {
    ensureTab()
    if (!popout || popout.isDestroyed()) {
      // Created once, then hidden/shown (the capture + HUD lifecycle): the window's 'close' is
      // a reattach, not a teardown. Destroying a window that has just given up a
      // WebContentsView hung the main process in the probe; a hidden window has no teardown
      // path to hang in, keeps its bounds, and is instant to show again.
      popout = deps.openPopout(() => reattach())
      popout.on('closed', () => {
        if (hostKind === 'popout') setHost(deps.getMainWindow(), 'main')
        popout = null
      })
    }
    setHost(popout, 'popout')
    if (!popout.isVisible()) popout.show()
    popout.focus()
  }
  function reattach(): void {
    if (hostKind === 'popout') setHost(deps.getMainWindow(), 'main')
    if (popout && !popout.isDestroyed() && popout.isVisible()) popout.hide()
    const main = deps.getMainWindow()
    if (main && !main.isDestroyed()) {
      main.show()
      main.focus()
    }
  }

  // ── IPC: the chrome's controls, and nothing else ─────────────────────────
  ipcMain.on(BROWSER_IPC.BOUNDS, (e, rect: ViewRect | null) => {
    const win = paneHost(e)
    if (!win) return
    // The window that reports geometry is the host. Before any host exists, the reporting shell
    // becomes it; a report from a window that is NOT the host (the main pane while popped out)
    // is ignored — its pane shows the detached state and reports null anyway.
    if (!hostWin) setHost(win, win === deps.getMainWindow() ? 'main' : 'popout')
    if (win !== hostWin) return
    bounds = rect && typeof rect.x === 'number' && typeof rect.width === 'number' ? rect : null
    applyBounds()
  })
  ipcMain.handle(BROWSER_IPC.STATE_GET, (e) => {
    if (!paneHost(e)) return null
    return state()
  })
  ipcMain.handle(BROWSER_IPC.NAVIGATE, (e, input: string): NavigateResult | null => {
    if (!paneHost(e)) return null
    const r = normalizeUrlInput(typeof input === 'string' ? input : '')
    if (!r.ok) return r
    const t = ensureTab()
    t.requested = r.url
    t.error = null
    void t.view.webContents.loadURL(r.url).catch(() => undefined) // did-fail-load carries the outcome
    push()
    return r
  })
  ipcMain.on(BROWSER_IPC.BACK, (e) => {
    if (!paneHost(e)) return
    active()?.view.webContents.navigationHistory.goBack()
  })
  ipcMain.on(BROWSER_IPC.FORWARD, (e) => {
    if (!paneHost(e)) return
    active()?.view.webContents.navigationHistory.goForward()
  })
  ipcMain.on(BROWSER_IPC.RELOAD, (e) => {
    if (!paneHost(e)) return
    const t = active()
    if (!t) return
    if (t.error) {
      t.error = null
      void t.view.webContents.loadURL(t.requested).catch(() => undefined)
    } else t.view.webContents.reload()
  })
  ipcMain.on(BROWSER_IPC.STOP, (e) => {
    if (!paneHost(e)) return
    active()?.view.webContents.stop()
  })
  ipcMain.on(BROWSER_IPC.ZOOM, (e, dir: ZoomDirection) => {
    if (!paneHost(e)) return
    const t = active()
    if (t && (dir === 'in' || dir === 'out' || dir === 'reset')) setZoom(t, dir)
  })
  ipcMain.on(BROWSER_IPC.FIND, (e, req: FindRequest) => {
    if (!paneHost(e)) return
    const t = active()
    if (!t || !req) return
    if (req.stop || !req.text) {
      t.view.webContents.stopFindInPage('clearSelection')
      find = null
      push()
      return
    }
    t.view.webContents.findInPage(String(req.text).slice(0, 200), { forward: req.forward !== false, findNext: false })
  })
  ipcMain.on(BROWSER_IPC.TAB_NEW, (e) => {
    if (!paneHost(e)) return
    newTab()
  })
  ipcMain.on(BROWSER_IPC.TAB_CLOSE, (e, id: string) => {
    if (!paneHost(e)) return
    if (typeof id === 'string') closeTab(id)
  })
  ipcMain.on(BROWSER_IPC.TAB_SELECT, (e, id: string) => {
    if (!paneHost(e)) return
    if (typeof id === 'string') selectTab(id)
  })
  ipcMain.on(BROWSER_IPC.TAB_MOVE, (e, req: { id: string; toIndex: number }) => {
    if (!paneHost(e)) return
    if (req && typeof req.id === 'string' && typeof req.toIndex === 'number') moveTab(req.id, req.toIndex)
  })
  ipcMain.on(BROWSER_IPC.DETACH, (e) => {
    if (!paneHost(e)) return
    detach()
  })
  ipcMain.on(BROWSER_IPC.REATTACH, (e) => {
    if (!paneHost(e)) return
    reattach()
  })
  ipcMain.handle(BROWSER_IPC.EXTRACT, async (e): Promise<BrowserExtract | null> => {
    const sender = paneHost(e)
    if (!sender) return null
    const t = active()
    if (!t || t.error) return null
    const wc = t.view.webContents
    const url = wc.getURL()
    if (!url || url === 'about:blank') return null
    let r: { selection?: unknown; text?: unknown } | null = null
    try {
      r = await wc.executeJavaScriptInIsolatedWorld(EXTRACT_WORLD, [{ code: EXTRACT_SCRIPT }], true)
    } catch (err) {
      notice('input', `Could not read the page: ${(err as Error).message}`)
      return null
    }
    const extract: BrowserExtract = {
      url,
      title: wc.getTitle(),
      selection: typeof r?.selection === 'string' ? r.selection : '',
      text: typeof r?.text === 'string' ? r.text : ''
    }
    // A click in the POP-OUT: that window has no composer, so the block goes to the main
    // window's — the one main→renderer message that carries page text, and it carries it
    // only here, only because the user clicked, only towards the composer.
    const main = deps.getMainWindow()
    if (popout && sender === popout && main && !main.isDestroyed() && !main.webContents.isDestroyed()) {
      main.webContents.send(BROWSER_IPC.COMPOSE_INSERT, composeSendToChat(extract))
      main.show()
      main.focus()
    }
    return extract
  })
}
