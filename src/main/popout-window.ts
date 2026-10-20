import { BrowserWindow, app, screen } from 'electron'
import { debuggingAllowedHere } from './build-flavor'
import { builtinSpellcheck } from '@shared/spellcheck'
import { existsSync } from 'node:fs'
import { join } from 'path'
import { loadWindowState, trackWindowState } from './window-state'
import { installContextMenu } from './context-menu'
import { adoptShellWindow, loadShellPage, shellPreload } from './shell-windows'

// A SATELLITE window: the same renderer bundle, hash-routed to one surface, with its own
// remembered bounds. Built for the browser pane's pop-out (Phase 3) and shaped so the terminal
// pane can reuse it: a pane that pops out calls openPopout() with its hash and a state-file
// name, and gets a real window that closes for real (no hide-to-tray) and tells it when.
//
// What this deliberately does NOT do: host any content itself. The browser's web contents are a
// WebContentsView that MOVES between windows (main ⇄ popout) without reloading; the terminal's
// xterm lives in the renderer and would re-mount from its pty buffer. Either way the satellite
// is only a frame + chrome, and the pane module owns what goes in it.
//
// ── THE CONTRACT (read before consuming) ──────────────────────────────────────────────────
//
//   1. CLOSE HIDES. The red button / ⌘W do not destroy the window: `close` is prevented, the
//      window is hidden, and `onClose` fires. Only an app quit (`isQuitting`) lets a close
//      through. Why: destroying a window that had just given up a WebContentsView hung the main
//      process (browser-pane probe, 2026-09-03) — the teardown path is the hazard, so no
//      consumer gets to take it.
//   2. THE SATELLITE IS REUSED, NOT RECREATED. One window per pane for the app's lifetime,
//      shown and hidden. Measured (probe:browser-leak): 30 pop-out/close cycles leave process
//      and web-contents counts flat; the cost is ONE hidden renderer, fixed, never N.
//   3. THEREFORE: ANY PER-WINDOW SUBSCRIPTION MUST BE DETACHED IN `onClose`. A hidden window's
//      renderer stays mounted — nothing unmounts, no cleanup effect runs — so whatever it
//      subscribed to (a pty sink, a stream, a store) keeps receiving every byte with no visible
//      symptom. The pane that owns the subscription must detach it when `onClose` fires and
//      re-attach when it shows the window again. The browser pane has no such subscription (its
//      WebContentsView moves out in `onClose`); the terminal pane does (its xterm is a pty sink),
//      and its probe must assert exactly ONE sink after pop-out → close.
//
// 3 follows from 1 and 2, and the next consumer will not find it in a PR comment.

export interface PopoutSpec {
  /** Window title. */
  title: string
  /** Renderer hash route, e.g. 'browser' — main.tsx mounts the matching surface. */
  hash: string
  /** Basename of the bounds file under userData, e.g. 'browser-window-state.json'. */
  stateFile: string
  /** Fallback size when nothing is remembered (or the remembered position is off-screen). */
  defaultSize: { width: number; height: number }
  /** The window's 'close' (red button, ⌘W). The window is HIDDEN, not destroyed — the pane
   * reclaims what it parked here and can show the window again later with its bounds intact.
   * (The app quits with `isQuitting`, which lets the close through.) */
  onClose: () => void
  /** True while the app is quitting: close means close. */
  isQuitting: () => boolean
}

export function openPopout(spec: PopoutSpec): BrowserWindow {
  const file = join(app.getPath('userData'), spec.stateFile)
  const st = loadWindowState(file, screen.getAllDisplays().map((d) => d.workArea))
  const remembered = existsSync(file)
  const win = new BrowserWindow({
    width: remembered ? st.width : spec.defaultSize.width,
    height: remembered ? st.height : spec.defaultSize.height,
    ...(st.x !== undefined && st.y !== undefined ? { x: st.x, y: st.y } : {}),
    minWidth: 420,
    minHeight: 320,
    show: false,
    title: spec.title,
    backgroundColor: '#0b0d12',
    webPreferences: {
      devTools: debuggingAllowedHere(),
      preload: shellPreload(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: builtinSpellcheck(process.platform)
    }
  })
  // A Beacon window: trusted by the sender check, and its top frame cannot leave the shell page. It
  // had no navigation guard before 2026-09-24, and a `location =` put a foreign page here with the
  // bridge (scripts/window-guard-probe.mjs).
  adoptShellWindow(win)
  trackWindowState(win, file)
  if (st.maximized) win.maximize()
  win.on('ready-to-show', () => win.show())
  win.on('close', (e) => {
    if (spec.isQuitting()) return
    e.preventDefault()
    spec.onClose()
  })
  // A satellite never opens anything itself: a link from its chrome is an external link.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  void loadShellPage(win, spec.hash)
  // The pop-out's SHELL renderer gets the same menu as the main window. The browser pane's embedded
  // WebContentsView is a FOREIGN web page and keeps its own site menu (or none) — correct for a
  // browser surface, and deliberately not overridden here.
  installContextMenu(win)
  return win
}
