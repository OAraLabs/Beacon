#!/usr/bin/env node
// ErrorBoundary wiring — structural, on the source.
//
// WHY THIS IS STRUCTURAL RATHER THAN A RENDER. React's error boundaries do not work under
// renderToStaticMarkup: server rendering PROPAGATES the throw instead of letting a boundary catch it,
// so an SSR smoke would fail on a working boundary or prove nothing. The render — does React catch,
// and can a person get OUT — is `probe:error-boundary`, which drives the built app. This file is the
// cheap floor that runs in verify: it pins the wiring the probe measured.
//
// WHAT THE PROBE FOUND THAT THIS FILE'S FIRST VERSION COULD NOT: SubNav was outside the per-view
// boundary in the tree — asserted here, true — and under its fallback on screen, because the one
// fallback there was was `position: fixed; inset: 0`. So the wiring below includes WHICH fallback
// each boundary gets (only the root may cover the window), not just where the boundary sits.
//
// HOW IT KEEPS ITSELF HONEST: every check is a named predicate over the three sources. Each runs on
// the real tree (must hold), then each PLANTED mutation re-runs the SAME predicates on the mutated
// tree and requires the one it targets to fail. The plants cannot drift from the checks, because
// there is only one copy of each check.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

let failures = 0
function report(ok, what, detail = '') {
  console.log(`[smoke] ${ok ? 'PASS' : 'FAIL'}  ${what}${detail && !ok ? `\n        ${detail}` : ''}`)
  if (!ok) failures++
}

const FILES = {
  main: 'src/renderer/src/main.tsx',
  boundary: 'src/renderer/src/components/ErrorBoundary.tsx',
  view: 'src/renderer/src/components/MainView.tsx',
  preload: 'src/preload/index.ts',
  shell: 'src/main/index.ts',
  guard: 'src/main/shell-windows.ts',
  decision: 'src/shared/shell-window.ts'
}
const real = Object.fromEntries(Object.entries(FILES).map(([k, p]) => [k, readFileSync(join(process.cwd(), p), 'utf8')]))

/** Code without comments. The comment that explains why `location.reload()` is gone names it, so an
 *  absence check that read comments would fail on the explanation, not on the code. */
const code = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

const at = (text, re) => {
  const m = re.exec(text)
  return m ? m.index : -1
}
// Split panes (2026-10-12): one boundary PER PANE, keyed by that pane's session (`target`).
const CHAT_BOUNDARY = /<ErrorBoundary\s+key=\{target \?\? 'home'\}/
const PANES_MAP = /layout\.panes\.map\(/
const VIEW_BOUNDARY = /<ErrorBoundary\s+key=\{view\}\s+label=/
const DOCK_BOUNDARY = /<ErrorBoundary\s+key=\{panel\.pane\}/

/** name → predicate(src). One copy of each; the plants below run these same functions. */
const CHECKS = {
  // ── the component ──
  'ErrorBoundary is a class with getDerivedStateFromError and componentDidCatch': (s) =>
    /export class ErrorBoundary extends Component/.test(s.boundary) && /static getDerivedStateFromError/.test(s.boundary) && /componentDidCatch/.test(s.boundary),
  'the crash surface makes no network call and reports nothing — its one bridge call is the reload': (s) => {
    const c = code(s.boundary)
    const bridge = c.match(/window\.beacon\??\.[\w?.]+/g) ?? []
    return !/fetch\(|XMLHttpRequest/.test(c) && bridge.length === 1 && bridge[0] === 'window.beacon.reloadWindow'
  },
  // `location.reload()` is dead in a built app: the shell is a file:// page, a renderer-started reload
  // raises will-navigate, and the shell's navigation guard refuses every non-web URL. This pinned
  // `window.location.reload()` for as long as the buttons were dead. The click is proven by the probe.
  'both "Reload Beacon" buttons reload through main, never location.reload()': (s) => {
    const c = code(s.boundary)
    const labels = (c.match(/>\s*Reload Beacon\s*</g) ?? []).length
    const wired = (c.match(/<button onClick=\{reloadBeacon\}[^>]*>\s*Reload Beacon\s*</g) ?? []).length
    return labels === 2 && wired === 2 && /const reloadBeacon = \(\): void => window\.beacon\.reloadWindow\(\)/.test(c) && !/location\.reload/.test(c)
  },
  'every fallback is an alert and shows the message': (s) => /role="alert"/.test(s.boundary) && /String\(error\?\.message \?\? error\)/.test(s.boundary),
  // The layout rule the probe measured: exactly ONE fixed surface, and it is chosen only for scope 'window'.
  'only scope="window" gets the fixed, full-window surface — panels stay in their slot': (s) =>
    (s.boundary.match(/position: 'fixed'/g) ?? []).length === 1 && /this\.props\.scope === 'window' \?/.test(s.boundary),
  'the copy does not promise unsent drafts survive': (s) => !/drafts are safe/i.test(s.boundary),

  // ── the root (main.tsx) ──
  'the root boundary encloses every hash route': (s) => {
    const i = s.main.indexOf('{isCapture ?')
    const open = s.main.lastIndexOf('<ErrorBoundary', i)
    const close = s.main.indexOf('</ErrorBoundary>', i)
    const route = s.main.slice(i, close)
    return i > 0 && open > 0 && close > i && ['QuickCapture', 'TrayHud', 'BrowserPopout', 'TerminalWindow', '<App />'].every((r) => route.includes(r))
  },
  'the root is scope="window" — the one place a fallback may cover the window': (s) => {
    const i = s.main.indexOf('{isCapture ?')
    return s.main.lastIndexOf('<ErrorBoundary scope="window">', i) > 0
  },
  'StrictMode is inside the root boundary': (s) => {
    const i = s.main.indexOf('{isCapture ?')
    const open = s.main.lastIndexOf('<ErrorBoundary', i)
    const strict = s.main.indexOf('<React.StrictMode>', open)
    return open > 0 && strict > open && strict < i
  },

  // ── MainView ──
  'no MainView boundary is scope="window"': (s) => !/scope="window"/.test(s.view),
  'the view boundary is keyed by view (unkeyed, a captured error survives navigation)': (s) => VIEW_BOUNDARY.test(s.view),
  'SubNav renders outside (above) the view boundary': (s) => {
    const sub = s.view.indexOf('{usesPillRow(view) ? <SubNav')
    const b = at(s.view, VIEW_BOUNDARY)
    return sub > 0 && b > sub
  },
  'the conversation column has a boundary keyed by session, around ChatHome AND ChatShell': (s) => {
    const b = at(s.view, CHAT_BOUNDARY)
    const close = s.view.indexOf('</ErrorBoundary>', b)
    return b > 0 && s.view.indexOf('<ChatHome', b) > b && s.view.indexOf('<ChatHome', b) < close && s.view.indexOf('<ChatShell', b) > b && s.view.indexOf('<ChatShell', b) < close
  },
  'the conversation boundary is inside the per-pane map: each pane fails alone': (s) => {
    const m = at(s.view, PANES_MAP)
    const b = at(s.view, CHAT_BOUNDARY)
    return m > 0 && b > m
  },
  'the Sidebar is outside the conversation boundary — it is the way out': (s) => {
    const side = s.view.indexOf('<Sidebar')
    const b = at(s.view, CHAT_BOUNDARY)
    return side > 0 && b > side
  },
  'the dock has its own boundary, keyed by pane, around SidePanel': (s) => {
    const b = at(s.view, DOCK_BOUNDARY)
    const panel = s.view.indexOf('<SidePanel', b)
    return b > 0 && panel > b && panel < s.view.indexOf('</ErrorBoundary>', b)
  },

  // ── the reload, main side ──
  'the preload sends reloadWindow to main on WINDOW_RELOAD': (s) => /reloadWindow: \(\) => ipcRenderer\.send\(IPC\.WINDOW_RELOAD\)/.test(code(s.preload)),
  // onFromShell (src/main/shell-windows.ts) runs the sender check before the listener: a window Beacon
  // created, its top frame, the shell page. smoke:ipc-sender holds the helper to that shape.
  'main reloads the SENDER, and only a Beacon window main frame': (s) =>
    /onFromShell\(IPC\.WINDOW_RELOAD, \(e\) => \{\n    e\.sender\.reload\(\)\n  \}\)/.test(code(s.shell)) &&
    /import \{[^}]*\bonFromShell\b[^}]*\} from '\.\/shell-windows'/.test(code(s.shell)),
  // The fix goes AROUND the guard, not through it. The guard exists so a dropped or redirected file://
  // document never gets the preload bridge; letting "the shell's own page" through would also let a
  // link or a redirect to that URL through, and will-navigate cannot tell either from a reload.
  // Since #187 the guard is adoptShellWindow (src/main/shell-windows.ts) on BOTH events, deciding with
  // mayShellWindowNavigate (@shared/shell-window): about:blank, and the shell page ONLY when it is
  // served over http (the dev server's own reload). The built shell's file:// page stays refused.
  // Since #191 shellUrl() is null when main cannot name its page, and then only about:blank passes.
  'the shell navigation guard is not widened: every non-web URL is still refused': (s) => {
    const listeners = ['will-navigate', 'will-redirect'].every((ev) =>
      new RegExp(`wc\\.on\\('${ev}', \\(e, url\\) => \\{\\n    if \\(!mayShellWindowNavigate\\(url, shellUrl\\(\\)\\)\\) \\{\\n      e\\.preventDefault\\(\\)`).test(code(s.guard))
    )
    const decision = /export function mayShellWindowNavigate\(url: string, shellUrl: string \| null\): boolean \{\n  if \(url === 'about:blank'\) return true\n  return shellUrl !== null && isWebUrl\(shellUrl\) && isShellDocument\(url, shellUrl\)\n\}/.test(code(s.decision))
    return listeners && decision && /\badoptShellWindow\(win\)/.test(code(s.shell))
  }
}

for (const [name, pred] of Object.entries(CHECKS)) report(pred(real) === true, name)

// ── plant-and-flag ─────────────────────────────────────────────────────────────────────────────
const PLANTS = [
  { name: 'the root boundary is removed', file: 'main', from: /  <ErrorBoundary scope="window">\n    <React\.StrictMode>/, to: '  <React.StrictMode>', breaks: 'the root boundary encloses every hash route' },
  { name: 'the root loses scope="window"', file: 'main', from: /<ErrorBoundary scope="window">/, to: '<ErrorBoundary>', breaks: 'the root is scope="window" — the one place a fallback may cover the window' },
  { name: 'StrictMode wraps the boundary instead', file: 'main', from: /  <ErrorBoundary scope="window">\n    <React\.StrictMode>/, to: '  <React.StrictMode>\n    <ErrorBoundary scope="window">', breaks: 'StrictMode is inside the root boundary' },
  { name: 'the fixed surface becomes the default (the first cut)', file: 'boundary', from: /this\.props\.scope === 'window' \?/, to: "this.props.scope !== 'panel' ?", breaks: 'only scope="window" gets the fixed, full-window surface — panels stay in their slot' },
  { name: 'a panel fallback is positioned fixed', file: 'boundary', from: /minWidth: 0,\n        minHeight: 0,\n        alignSelf: 'stretch',/, to: "minWidth: 0,\n        minHeight: 0,\n        position: 'fixed',\n        alignSelf: 'stretch',", breaks: 'only scope="window" gets the fixed, full-window surface — panels stay in their slot' },
  { name: 'the view boundary is given scope="window"', file: 'view', from: /key=\{view\}\n(\s+)label=/, to: 'key={view}\n$1scope="window"\n$1label=', breaks: 'no MainView boundary is scope="window"' },
  { name: 'the view boundary loses its key', file: 'view', from: /<ErrorBoundary\n(\s+)key=\{view\}\n/, to: '<ErrorBoundary\n', breaks: 'the view boundary is keyed by view (unkeyed, a captured error survives navigation)' },
  { name: 'SubNav moves inside the view boundary', file: 'view', from: /\{usesPillRow\(view\) \? <SubNav/, to: '<ErrorBoundary key={view} label="x">{usesPillRow(view) ? <SubNav', breaks: 'SubNav renders outside (above) the view boundary' },
  { name: 'the conversation boundary is removed', file: 'view', from: /<ErrorBoundary\n(\s+)key=\{target \?\? 'home'\}/, to: '<ErrorBoundary', breaks: 'the conversation column has a boundary keyed by session, around ChatHome AND ChatShell' },
  { name: 'the Sidebar moves inside the conversation boundary', file: 'view', from: /\{sessionsShowing \? \(/, to: "<ErrorBoundary key={target ?? 'home'}>{sessionsShowing ? (", breaks: 'the Sidebar is outside the conversation boundary — it is the way out' },
  { name: 'one boundary wraps all the panes instead of each', file: 'view', from: /layout\.panes\.map\(/, to: 'layout.panes.slice().map(', breaks: 'the conversation boundary is inside the per-pane map: each pane fails alone' },
  { name: 'the dock boundary is removed', file: 'view', from: /<ErrorBoundary\n(\s+)key=\{panel\.pane\}/, to: '<ErrorBoundary', breaks: 'the dock has its own boundary, keyed by pane, around SidePanel' },
  { name: 'the crash surface reports over IPC', file: 'boundary', from: /    console\.error\('\[beacon\] render error caught by ErrorBoundary'/, to: "    void window.beacon?.watchdog({ kind: 'render-error' } as never)\n    console.error('[beacon] render error caught by ErrorBoundary'", breaks: 'the crash surface makes no network call and reports nothing — its one bridge call is the reload' },
  { name: 'the panel Reload goes back to location.reload()', file: 'boundary', from: /<button onClick=\{reloadBeacon\} style=\{secondaryButton\}>/, to: '<button onClick={() => window.location.reload()} style={secondaryButton}>', breaks: 'both "Reload Beacon" buttons reload through main, never location.reload()' },
  { name: 'the root Reload goes back to location.reload()', file: 'boundary', from: /<button onClick=\{reloadBeacon\} style=\{primaryButton\}>/, to: '<button onClick={() => window.location.reload()} style={primaryButton}>', breaks: 'both "Reload Beacon" buttons reload through main, never location.reload()' },
  { name: 'reloadBeacon reloads in the renderer instead', file: 'boundary', from: /=> window\.beacon\.reloadWindow\(\)/, to: '=> window.location.reload()', breaks: 'both "Reload Beacon" buttons reload through main, never location.reload()' },
  { name: 'the preload stops sending the reload', file: 'preload', from: /reloadWindow: \(\) => ipcRenderer\.send\(IPC\.WINDOW_RELOAD\)/, to: 'reloadWindow: () => undefined', breaks: 'the preload sends reloadWindow to main on WINDOW_RELOAD' },
  { name: 'main stops reloading the sender', file: 'shell', from: /    e\.sender\.reload\(\)\n/, to: '    void e\n', breaks: 'main reloads the SENDER, and only a Beacon window main frame' },
  { name: 'main drops the sender guard (registers raw)', file: 'shell', from: /onFromShell\(IPC\.WINDOW_RELOAD,/, to: 'ipcMain.on(IPC.WINDOW_RELOAD,', breaks: 'main reloads the SENDER, and only a Beacon window main frame' },
  { name: 'the guard lets the shell navigate to its own page', file: 'decision', from: /return shellUrl !== null && isWebUrl\(shellUrl\) && isShellDocument\(url, shellUrl\)/, to: 'return shellUrl !== null && isShellDocument(url, shellUrl)', breaks: 'the shell navigation guard is not widened: every non-web URL is still refused' },
  { name: 'the guard watches will-navigate only', file: 'guard', from: /  wc\.on\('will-redirect', \(e, url\) => \{\n    if \(!mayShellWindowNavigate\(url, shellUrl\(\)\)\) \{/, to: "  wc.on('will-redirect', (e, url) => {\n    if (false) {", breaks: 'the shell navigation guard is not widened: every non-web URL is still refused' },
  { name: 'the drafts promise comes back', file: 'boundary', from: /Your conversations are kept on the daemon/, to: 'Your conversations and drafts are safe — kept on the daemon', breaks: 'the copy does not promise unsent drafts survive' }
]

let seen = 0
for (const p of PLANTS) {
  if (!p.from.test(real[p.file])) {
    report(false, `plant "${p.name}" — its pattern no longer matches the source`, 'update the plant, do not delete it')
    continue
  }
  const mutated = { ...real, [p.file]: real[p.file].replace(p.from, p.to) }
  if (mutated[p.file] === real[p.file]) {
    report(false, `plant "${p.name}" applied no change`)
    continue
  }
  const caught = CHECKS[p.breaks](mutated) === false
  report(caught, `plant "${p.name}" is SEEN by "${p.breaks}"`)
  if (caught) seen++
}
report(seen === PLANTS.length, `every plant was seen (${seen}/${PLANTS.length})`)

console.log(
  failures === 0
    ? `\n[smoke] outcome: PASS ✓ (error-boundary wiring: ${Object.keys(CHECKS).length} checks, ${seen} planted mutations all seen)`
    : `\n[smoke] outcome: FAIL ✗ (${failures})`
)
console.log('[smoke] The CATCH and the LAYOUT are proven by `npm run probe:error-boundary` on the built app, not here.')
process.exit(failures === 0 ? 0 : 1)
