// The browser-pane invariant, as a SOURCE checker (pure — no fs; the smoke feeds it files).
//
// THE INVARIANT: the browser pane is a human viewer. The agent must not be able to navigate it,
// click in it, read it autonomously, or inject script into it. A path from a chat/agent message to
// loadURL / executeJavaScript / sendInputEvent on this view would bypass the daemon's gated,
// audited `browser` tool without ever looking like a tool call — so nothing downstream would catch
// it. This checker asserts the ABSENCE of such wiring on the source itself, not on a comment:
//
//   R1  injection APIs: executeJavaScript / sendInputEvent / insertCSS / insertText / downloadURL
//       appear nowhere in src/main; executeJavaScriptInIsolatedWorld appears exactly once, in
//       browser-pane.ts, called with the constant EXTRACT_SCRIPT (no interpolation of anything
//       but a numeric cap); loadURL/loadFile outside browser-pane.ts only load the app's own renderer
//       (its index.html, the dev server, or shellUrl(), which is one of those two).
//   R2  browser-pane.ts imports nothing from the connection / cache / daemon-IPC world and names
//       no chat or gateway channel — no daemon frame can reach it.
//   R3  no other main file touches the pane: only index.ts imports it (registerBrowserPane), and
//       no file but browser-pane.ts names a browser: channel.
//   R4  every ipcMain handler in browser-pane.ts is on a BROWSER_IPC channel and begins with
//       paneHost (the count of handlers equals the count of checks), and paneHost's first act is
//       the shell-sender check every privileged handler in main makes (isShellSender).
//   R5  the page's webPreferences: sandbox on, contextIsolation on, nodeIntegration off, the
//       browser-pane partition, and NO preload; the partition is not persist:.
//   R6  the renderer bridge namespace `beacon.browser` is used only under src/renderer/src/browser/,
//       and those files touch no chat / gateway / daemon bridge and import no chat component.
//   R7  the preload's `browser` block exposes exactly the expected methods, and subscribes only to
//       the state / chrome-key / compose-insert channels from main (main never sends the chrome a
//       URL to open).
//   R8  main sends the chrome only STATE, CHROME_KEY and COMPOSE_INSERT — and COMPOSE_INSERT (page
//       text towards the composer, for a click made in the pop-out) from exactly one place: inside
//       the EXTRACT handler, never from a page event or a frame.
//   R9  the ONE chat → pane route, added 2026-10-11 at the owner's request: a person's plain click
//       on a link to a LOCAL address (this machine, a private network, a tailnet) in a chat message
//       opens the pane, because an agent that serves a page hands you a URL and retyping it was the
//       bug. It is the URL bar with the text supplied by the message — a gesture, not a channel —
//       and it is pinned to exactly that: the click handler in MessageRenderer is the only caller
//       of requestPaneLink, behind shouldOpenInPane (which refuses any untrusted click first and any
//       non-local or non-http(s) address); PaneLinkRelay under browser/ is the only subscriber and
//       re-checks the address before it navigates; the hand-off module imports nothing. R6 still
//       forbids every other use of the bridge outside browser/, so a message arriving, an effect, a
//       frame or a second component cannot reach the pane by any other path.
//
// browser-invariant-smoke.ts runs this over the real tree (must be clean) AND over synthetic
// mutations that each plant one of the wirings above (each must be flagged). A guard that cannot
// see the bug it exists for is a note, not a guard.

export interface SourceFile {
  /** repo-relative posix path, e.g. src/main/browser-pane.ts */
  path: string
  text: string
}

/** The preload methods the renderer chrome may call. Extended per phase; nothing else may appear. */
export const EXPECTED_BRIDGE_METHODS = [
  'navigate',
  'back',
  'forward',
  'reload',
  'stop',
  'zoom',
  'find',
  'extract',
  'bounds',
  'state',
  'onState',
  'onChromeKey',
  'detach',
  'reattach',
  'onComposeInsert',
  'newTab',
  'closeTab',
  'selectTab',
  'moveTab'
] as const

const MAIN_TO_RENDERER = new Set(['STATE', 'CHROME_KEY', 'COMPOSE_INSERT'])

/** Strip comments so a word in prose never counts as wiring (and never hides it). Line comments
 * only when `//` follows start-of-line or whitespace, so 'http://…' strings survive. */
export function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1')
}

function count(re: RegExp, s: string): number {
  return (s.match(re) ?? []).length
}

const isMain = (p: string): boolean => p.startsWith('src/main/') && !p.endsWith('-smoke.ts') && p !== 'src/main/browser-invariant.ts'
const isRendererBrowser = (p: string): boolean => p.startsWith('src/renderer/src/browser/')
const isRenderer = (p: string): boolean => p.startsWith('src/renderer/src/') && /\.(tsx?|css)$/.test(p)

export function checkBrowserInvariant(files: SourceFile[]): string[] {
  const v: string[] = []
  const get = (p: string): SourceFile | undefined => files.find((f) => f.path === p)
  const pane = get('src/main/browser-pane.ts')
  const preload = get('src/preload/index.ts')
  const shared = get('src/shared/browser-pane.ts')
  if (!pane) v.push('R0 src/main/browser-pane.ts is missing')
  if (!preload) v.push('R0 src/preload/index.ts is missing')
  if (!shared) v.push('R0 src/shared/browser-pane.ts is missing')
  if (!pane || !preload || !shared) return v
  const paneSrc = stripComments(pane.text)

  // ── R1: injection surface ──────────────────────────────────────────────────
  for (const f of files.filter((x) => isMain(x.path))) {
    const s = stripComments(f.text)
    for (const api of ['executeJavaScript', 'sendInputEvent', 'insertCSS', 'insertText', 'downloadURL']) {
      const n = count(new RegExp(`\\.${api}\\(`, 'g'), s)
      if (n > 0) v.push(`R1 ${f.path}: ${api}( appears ${n}× — main must never inject into a page`)
    }
    const iso = count(/executeJavaScriptInIsolatedWorld\(/g, s)
    if (f.path !== 'src/main/browser-pane.ts' && iso > 0) v.push(`R1 ${f.path}: executeJavaScriptInIsolatedWorld( outside browser-pane.ts`)
    if (f.path !== 'src/main/browser-pane.ts') {
      for (const line of s.split('\n')) {
        if (/\.(loadURL|loadFile)\(/.test(line) && !/ELECTRON_RENDERER_URL|index\.html|shellUrl\(\)/.test(line)) {
          v.push(`R1 ${f.path}: loadURL/loadFile of something other than the app renderer: ${line.trim().slice(0, 100)}`)
        }
      }
    }
  }
  const iso = count(/executeJavaScriptInIsolatedWorld\(/g, paneSrc)
  if (iso !== 1) v.push(`R1 browser-pane.ts: expected exactly one executeJavaScriptInIsolatedWorld( call, found ${iso}`)
  if (!/executeJavaScriptInIsolatedWorld\(\s*EXTRACT_WORLD,\s*\[\s*\{\s*code:\s*EXTRACT_SCRIPT\s*\}\s*\],\s*true\s*\)/.test(paneSrc)) {
    v.push('R1 browser-pane.ts: the isolated-world call must be exactly (EXTRACT_WORLD, [{ code: EXTRACT_SCRIPT }], true)')
  }
  const decl = /const EXTRACT_SCRIPT = `([\s\S]*?)`/.exec(paneSrc)
  if (!decl) v.push('R1 browser-pane.ts: EXTRACT_SCRIPT must be a module-level const template literal')
  else {
    const interpolations = decl[1].match(/\$\{[^}]*\}/g) ?? []
    for (const i of interpolations) {
      if (i !== '${EXTRACT_MAX_CHARS * 4}') v.push(`R1 browser-pane.ts: EXTRACT_SCRIPT interpolates ${i} — the script must be constant`)
    }
  }

  // ── R2: no daemon data can reach the pane module ───────────────────────────
  for (const imp of paneSrc.matchAll(/from\s+'([^']+)'/g)) {
    const m = imp[1]
    if (/^\.\/(connection|cache|ipc|voice|integrations|loop)/.test(m) || /^@shared\/(ipc|gateway-events|daemon-api|approval)/.test(m)) {
      v.push(`R2 browser-pane.ts imports ${m} — the pane module must not see connection/cache/daemon data`)
    }
  }
  for (const tok of ['CHAT_STREAM', 'GATEWAY_EVENT', 'CHAT_SEND', "'chat:", "'gateway:", 'ConnectionManager', 'onStreamFrame', "'stream'", 'gatewayEvent', 'getConnection']) {
    if (paneSrc.includes(tok)) v.push(`R2 browser-pane.ts mentions ${tok}`)
  }

  // ── R3: nobody else touches the pane ───────────────────────────────────────
  for (const f of files.filter((x) => isMain(x.path) && x.path !== 'src/main/browser-pane.ts')) {
    const s = stripComments(f.text)
    if (/from\s+'\.\/browser-pane'/.test(s) && f.path !== 'src/main/index.ts') v.push(`R3 ${f.path} imports ./browser-pane`)
    if (f.path === 'src/main/index.ts') {
      const named = /import\s+\{([^}]+)\}\s+from\s+'\.\/browser-pane'/.exec(s)
      if (named && named[1].split(',').map((x) => x.trim()).some((x) => x !== 'registerBrowserPane')) {
        v.push(`R3 index.ts imports more than registerBrowserPane from ./browser-pane: ${named[1].trim()}`)
      }
    }
    if (/BROWSER_IPC|'browser:/.test(s)) v.push(`R3 ${f.path} names a browser: channel`)
  }

  // ── R4: every handler is a chrome control from a shell window ──────────────
  const handlers = count(/ipcMain\.(on|handle)\(/g, paneSrc)
  const onBrowserChannel = count(/ipcMain\.(on|handle)\(\s*BROWSER_IPC\./g, paneSrc)
  const checks = count(/paneHost\(e\)/g, paneSrc)
  if (handlers !== onBrowserChannel) v.push(`R4 browser-pane.ts: ${handlers} ipcMain handlers but only ${onBrowserChannel} on BROWSER_IPC channels`)
  if (handlers !== checks) v.push(`R4 browser-pane.ts: ${handlers} ipcMain handlers but ${checks} paneHost(e) checks`)
  if (!/function paneHost\(e: IpcMainEvent \| IpcMainInvokeEvent\): BrowserWindow \| null \{\s*if \(!isShellSender\(e\)\) return null\n/.test(paneSrc)) {
    v.push('R4 browser-pane.ts: paneHost must refuse (return null) unless isShellSender(e), before anything else')
  }
  if (handlers === 0) v.push('R4 browser-pane.ts: no ipcMain handlers found (the chrome cannot drive the pane)')

  // ── R5: page hardening ─────────────────────────────────────────────────────
  const wcv = /new WebContentsView\(\{\s*webPreferences:\s*\{([\s\S]*?)\}\s*\}\)/.exec(paneSrc)
  if (!wcv) v.push('R5 browser-pane.ts: no `new WebContentsView({ webPreferences: {…} })` block found')
  else {
    const p = wcv[1]
    for (const need of ['sandbox: true', 'contextIsolation: true', 'nodeIntegration: false', 'partition: BROWSER_PARTITION', 'webviewTag: false']) {
      if (!p.includes(need)) v.push(`R5 browser-pane.ts: webPreferences lacks ${need}`)
    }
    if (/preload\s*:/.test(p)) v.push('R5 browser-pane.ts: the page gets a preload — it must get no bridge of any kind')
  }
  if (count(/new WebContentsView\(/g, paneSrc) !== 1) v.push('R5 browser-pane.ts: expected exactly one WebContentsView construction site')
  const part = /export const BROWSER_PARTITION = '([^']*)'/.exec(shared.text)
  if (!part) v.push('R5 shared/browser-pane.ts: BROWSER_PARTITION literal not found')
  else if (part[1].startsWith('persist:') || part[1] === '') v.push(`R5 partition '${part[1]}' must be in-memory (no persist:) and non-empty`)

  // ── R6: the renderer side ──────────────────────────────────────────────────
  const bridgeRef = /\b(?:window\.beacon|beacon|b)\??\.browser\b/
  for (const f of files.filter((x) => isRenderer(x.path))) {
    const s = stripComments(f.text)
    if (!isRendererBrowser(f.path) && bridgeRef.test(s)) v.push(`R6 ${f.path} uses the beacon.browser bridge outside src/renderer/src/browser/`)
    if (isRendererBrowser(f.path)) {
      for (const tok of ['.chat.', '.onStream(', '.onGateway(', '.daemon.', '.history.', '.events.', '.sessions.', 'gateway-store', 'ChatShell', 'MessageRenderer', 'chat:send']) {
        if (s.includes(tok)) v.push(`R6 ${f.path} touches ${tok} — the chrome must not see chat/daemon data`)
      }
    }
  }

  // ── R7: the preload surface ────────────────────────────────────────────────
  const block = /\n  browser:\s*\{([\s\S]*?)\n  \},?\n/.exec(stripComments(preload.text))
  if (!block) v.push('R7 preload: no `browser: {…}` block')
  else {
    const body = block[1]
    const methods = [...body.matchAll(/^\s{4}([A-Za-z_]+)\s*:/gm)].map((m) => m[1])
    const expected = [...EXPECTED_BRIDGE_METHODS]
    for (const m of methods) if (!expected.includes(m as (typeof EXPECTED_BRIDGE_METHODS)[number])) v.push(`R7 preload exposes unexpected browser.${m}`)
    for (const m of expected) if (!methods.includes(m)) v.push(`R7 preload lacks browser.${m}`)
    for (const sub of body.matchAll(/ipcRenderer\.on\(\s*BROWSER_IPC\.([A-Z_]+)/g)) {
      if (!MAIN_TO_RENDERER.has(sub[1])) v.push(`R7 preload subscribes the chrome to BROWSER_IPC.${sub[1]} — main may only push state and key names`)
    }
    for (const ch of body.matchAll(/ipcRenderer\.(invoke|send)\(\s*([^,)]+)/g)) {
      if (!/^BROWSER_IPC\./.test(ch[2].trim())) v.push(`R7 preload browser.* calls a non-BROWSER_IPC channel: ${ch[2].trim()}`)
    }
  }

  // ── R8: what main pushes to the chrome ─────────────────────────────────────
  for (const m of paneSrc.matchAll(/\.send\(\s*BROWSER_IPC\.([A-Z_]+)/g)) {
    if (!MAIN_TO_RENDERER.has(m[1])) v.push(`R8 browser-pane.ts sends BROWSER_IPC.${m[1]} to a renderer — only STATE, CHROME_KEY and COMPOSE_INSERT may go that way`)
  }
  // COMPOSE_INSERT carries page text towards the composer. It may be sent from exactly one place:
  // inside the EXTRACT handler (a user click in the pop-out), never from an event or a frame.
  const composeSends = [...paneSrc.matchAll(/\.send\(\s*BROWSER_IPC\.COMPOSE_INSERT/g)].map((m) => m.index ?? -1)
  const extractStart = paneSrc.indexOf('ipcMain.handle(BROWSER_IPC.EXTRACT')
  const extractEnd = extractStart >= 0 ? paneSrc.indexOf('\n  })', extractStart) : -1
  if (composeSends.length > 1) v.push(`R8 browser-pane.ts sends COMPOSE_INSERT from ${composeSends.length} places — one, inside the extract handler, is the limit`)
  for (const i of composeSends) {
    if (extractStart < 0 || i < extractStart || i > extractEnd) v.push('R8 browser-pane.ts sends COMPOSE_INSERT outside the EXTRACT handler')
  }

  // ── R9: the one chat → pane route is a person's click on a local link ──────
  const PANE_LINK = 'src/shared/pane-link.ts'
  const LINK_OPEN = 'src/renderer/src/link-open.ts'
  const RELAY = 'src/renderer/src/browser/PaneLinkRelay.tsx'
  const ANCHOR = 'src/renderer/src/components/MessageRenderer.tsx'
  const paneLink = get(PANE_LINK)
  const linkOpen = get(LINK_OPEN)
  const relay = get(RELAY)
  const anchor = get(ANCHOR)
  for (const [p, f] of [[PANE_LINK, paneLink], [LINK_OPEN, linkOpen], [RELAY, relay], [ANCHOR, anchor]] as const) {
    if (!f) v.push(`R9 ${p} is missing`)
  }
  if (paneLink && linkOpen && relay && anchor) {
    // (a) one caller, one subscriber — anywhere else in the renderer is a second route.
    for (const f of files.filter((x) => isRenderer(x.path) && x.path !== LINK_OPEN)) {
      const s = stripComments(f.text)
      if (f.path !== ANCHOR && count(/\brequestPaneLink\(/g, s) > 0) v.push(`R9 ${f.path} calls requestPaneLink( — only the anchor click in MessageRenderer may`)
      if (f.path !== RELAY && count(/\bonPaneLink\(/g, s) > 0) v.push(`R9 ${f.path} subscribes onPaneLink( — only PaneLinkRelay may`)
    }
    // (b) the caller is the anchor's onClick, and shouldOpenInPane gates it in the same condition.
    const a = stripComments(anchor.text)
    const calls = count(/\brequestPaneLink\(/g, a)
    if (calls !== 1) v.push(`R9 MessageRenderer calls requestPaneLink( ${calls}× — it must be exactly once`)
    else {
      const before = a.slice(0, a.search(/\brequestPaneLink\(/))
      if (!/shouldOpenInPane\(e\.nativeEvent,\s*href\)\s*&&\s*$/.test(before)) v.push('R9 MessageRenderer: requestPaneLink( must be guarded as `shouldOpenInPane(e.nativeEvent, href) && requestPaneLink(…)`')
      if (!/onClick=/.test(before.slice(-400))) v.push('R9 MessageRenderer: requestPaneLink( must sit inside the anchor onClick handler')
    }
    // (c) the decision refuses an untrusted click FIRST, and an address that is not local http(s).
    const pl = stripComments(paneLink.text)
    const sop = /export function shouldOpenInPane\([^)]*\)[^{]*\{([\s\S]*?)\n\}/.exec(pl)
    if (!sop) v.push('R9 pane-link.ts: shouldOpenInPane not found')
    else {
      if (!sop[1].trimStart().startsWith('if (e.isTrusted !== true) return false')) v.push('R9 shouldOpenInPane must refuse an untrusted click (e.isTrusted !== true) as its first act')
      if (!/isPaneLink\(href\)/.test(sop[1])) v.push('R9 shouldOpenInPane must require isPaneLink(href)')
      if (!/e\.button !== 0/.test(sop[1])) v.push('R9 shouldOpenInPane must require the primary button')
    }
    const ipl = /export function isPaneLink\([^)]*\)[^{]*\{([\s\S]*?)\n\}/.exec(pl)
    if (!ipl) v.push('R9 pane-link.ts: isPaneLink not found')
    else {
      if (!/isWebUrl\(/.test(ipl[1])) v.push('R9 isPaneLink must require a web URL (isWebUrl)')
      if (!/isLocalHost\(u\.hostname\)/.test(ipl[1])) v.push('R9 isPaneLink must require a local host (isLocalHost(u.hostname))')
    }
    // (d) the hand-off imports nothing and exposes exactly the two functions.
    const lo = stripComments(linkOpen.text)
    if (/^\s*import\s/m.test(lo)) v.push('R9 link-open.ts imports something — the hand-off must stay neutral')
    const exported = [...lo.matchAll(/^export\s+(?:async\s+)?(?:function|const|let|class|type|interface)\s+([A-Za-z_]+)/gm)].map((m) => m[1]).sort().join(',')
    if (exported !== 'onPaneLink,requestPaneLink') v.push(`R9 link-open.ts exports ${exported || 'nothing'} — expected exactly onPaneLink and requestPaneLink`)
    // (e) the receiving end re-checks the address and navigates to exactly what it was given.
    const rl = stripComments(relay.text)
    const navs = count(/\.browser\.navigate\(/g, rl)
    if (navs !== 1) v.push(`R9 PaneLinkRelay navigates ${navs}× — it must be exactly once`)
    else {
      if (!/\.browser\.navigate\(url\)/.test(rl)) v.push('R9 PaneLinkRelay must navigate to the url it was handed, unmodified')
      if (!/isPaneLink\(url\)/.test(rl.slice(0, rl.indexOf('.browser.navigate(')))) v.push('R9 PaneLinkRelay must re-check isPaneLink(url) before it navigates')
    }
  }

  return v
}
