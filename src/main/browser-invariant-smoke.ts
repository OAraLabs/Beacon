/**
 * THE INVARIANT TEST for the browser pane: no IPC path exists from a chat/agent message to
 * loadURL / executeJavaScript / sendInputEvent on the pane's web contents. Asserted on the SOURCE
 * (absence of wiring), not on a comment — see browser-invariant.ts for the rules R1–R8.
 *
 * Two halves, both required:
 *   1. the real tree is clean (zero violations);
 *   2. the checker can SEE the bug: each synthetic mutation below plants one forbidden wiring in a
 *      copy of the real files and must produce at least one violation. If any mutation passes
 *      clean, the guard is blind to that shape and this smoke FAILS — a guard that cannot detect
 *      the bug it exists for is a note, not a guard.
 *
 * Run: npm run smoke:browser-invariant   (from the repo root — reads src/)
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { checkBrowserInvariant, type SourceFile } from './browser-invariant'

let failures = 0
function assert(cond: boolean, what: string, detail = ''): void {
  console.log(`[smoke] ${cond ? 'PASS' : 'FAIL'}  ${what}${detail ? `\n         ${detail}` : ''}`)
  if (!cond) failures++
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(tsx?|css)$/.test(name)) out.push(p)
  }
  return out
}

const ROOT = process.cwd()
const files: SourceFile[] = walk(join(ROOT, 'src')).map((p) => ({ path: relative(ROOT, p).split('\\').join('/'), text: readFileSync(p, 'utf8') }))
assert(files.some((f) => f.path === 'src/main/browser-pane.ts'), `read the source tree from ${ROOT} (${files.length} files)`)

console.log('[smoke] === 1. the real tree ===')
const real = checkBrowserInvariant(files)
assert(real.length === 0, 'no path from a chat/agent message to the browser view (R1–R9 clean)', real.join('\n         '))

console.log('[smoke] === 2. the guard can see the bug (each mutation must be flagged) ===')
type Mutation = { name: string; rule: RegExp; apply: (f: SourceFile[]) => SourceFile[] }
const edit = (fs: SourceFile[], path: string, fn: (t: string) => string): SourceFile[] => {
  const hit = fs.find((f) => f.path === path)
  if (!hit) throw new Error(`mutation target missing: ${path}`)
  const next = fn(hit.text)
  if (next === hit.text) throw new Error(`mutation did not change ${path} — anchor not found`)
  return fs.map((f) => (f === hit ? { ...f, text: next } : f))
}
const once = (t: string, anchor: string, replacement: string): string => {
  const n = t.split(anchor).length - 1
  if (n !== 1) throw new Error(`anchor found ${n}× (need exactly 1): ${anchor.slice(0, 60)}`)
  return t.replace(anchor, replacement)
}
const PANE = 'src/main/browser-pane.ts'
const ANCHOR = 'src/renderer/src/components/MessageRenderer.tsx'
const PANE_LINK = 'src/shared/pane-link.ts'
const RELAY = 'src/renderer/src/browser/PaneLinkRelay.tsx'
const mutations: Mutation[] = [
  {
    name: 'a stream frame drives loadURL inside browser-pane.ts (import + handler)',
    rule: /^R2/,
    apply: (f) =>
      edit(f, PANE, (t) =>
        once(t, "} from '@shared/browser-pane'\n", "} from '@shared/browser-pane'\nimport { ConnectionManager } from './connection'\n") +
        "\nexport function wire(c: ConnectionManager) { c.on('stream', (fr: { content: string }) => { void fr.content }) }\n"
      )
  },
  {
    name: 'main executes a frame\'s content as script in the shell window (index.ts)',
    rule: /^R1/,
    apply: (f) => edit(f, 'src/main/index.ts', (t) => t + '\nfunction __bad(frame: { content: string }) { void mainWindow?.webContents.executeJavaScript(frame.content) }\n')
  },
  {
    name: 'a second main module loads a URL from a message',
    rule: /^R1/,
    apply: (f) => [...f, { path: 'src/main/agent-nav.ts', text: "export function go(w: { loadURL(u: string): void }, m: { url: string }) { w.loadURL(m.url) }\n" }]
  },
  {
    name: 'the extraction script interpolates a variable (script no longer constant)',
    rule: /^R1/,
    apply: (f) => edit(f, PANE, (t) => once(t, 'const root = document.querySelector', 'const root = ${extra}; const root2 = document.querySelector'))
  },
  {
    name: 'a handler without the shell-sender check',
    rule: /^R4/,
    apply: (f) => edit(f, PANE, (t) => once(t, 'ipcMain.on(BROWSER_IPC.BACK, (e) => {\n    if (!paneHost(e)) return\n', 'ipcMain.on(BROWSER_IPC.BACK, (e) => {\n    void e\n'))
  },
  {
    name: 'the host check stops requiring the shell page (identity only, as before 2026-09-24)',
    rule: /^R4/,
    apply: (f) => edit(f, PANE, (t) => once(t, '    if (!isShellSender(e)) return null\n', ''))
  },
  {
    name: 'a handler on a non-browser channel (e.g. a chat frame) inside the pane module',
    rule: /^R(2|4)/,
    apply: (f) => edit(f, PANE, (t) => t + "\nipcMain.on('chat:stream', (e) => { void e })\n")
  },
  {
    name: 'the page gets a preload',
    rule: /^R5/,
    apply: (f) => edit(f, PANE, (t) => once(t, '        webviewTag: false,\n', "        webviewTag: false,\n        preload: '/tmp/x.js',\n"))
  },
  {
    name: 'the partition becomes persistent',
    rule: /^R5/,
    apply: (f) => edit(f, 'src/shared/browser-pane.ts', (t) => once(t, "export const BROWSER_PARTITION = 'browser-pane'", "export const BROWSER_PARTITION = 'persist:browser-pane'"))
  },
  {
    name: 'ChatShell navigates the pane from a message',
    rule: /^R6/,
    apply: (f) => edit(f, 'src/renderer/src/components/ChatShell.tsx', (t) => t + '\nexport function __bad(m: { content: string }) { void window.beacon.browser.navigate(m.content) }\n')
  },
  {
    name: 'MessageRenderer routes a link click into the pane',
    rule: /^R6/,
    apply: (f) => edit(f, 'src/renderer/src/components/MessageRenderer.tsx', (t) => t + '\nexport function __bad(href: string) { const b = window.beacon; void b?.browser.navigate(href) }\n')
  },
  {
    name: 'the pane chrome subscribes to the chat stream',
    rule: /^R6/,
    apply: (f) => edit(f, 'src/renderer/src/browser/BrowserPane.tsx', (t) => t + "\nexport function __bad() { window.beacon.chat.onStream(() => undefined) }\n")
  },
  {
    name: 'the preload grows an extra browser method',
    rule: /^R7/,
    apply: (f) => edit(f, 'src/preload/index.ts', (t) => once(t, '    navigate: (input: string) => ipcRenderer.invoke(BROWSER_IPC.NAVIGATE, input),\n', "    navigate: (input: string) => ipcRenderer.invoke(BROWSER_IPC.NAVIGATE, input),\n    openFromAgent: (u: string) => ipcRenderer.invoke(BROWSER_IPC.NAVIGATE, u),\n"))
  },
  {
    name: 'main pushes the chrome a command channel (main → renderer navigate)',
    rule: /^R(7|8)/,
    apply: (f) =>
      edit(f, 'src/preload/index.ts', (t) =>
        once(t, '    onChromeKey: (cb: (key: ChromeKey) => void) => {\n', "    onChromeKey: (cb: (key: ChromeKey) => void) => {\n      ipcRenderer.on(BROWSER_IPC.NAVIGATE, () => undefined)\n")
      )
  },
  {
    name: 'main pushes page text to the composer from a page event (outside the extract handler)',
    rule: /^R8/,
    apply: (f) => edit(f, PANE, (t) => once(t, "    wc.on('did-navigate-in-page', sync)\n", "    wc.on('did-navigate-in-page', sync)\n    wc.on('page-title-updated', () => deps.getMainWindow()?.webContents.send(BROWSER_IPC.COMPOSE_INSERT, wc.getTitle()))\n"))
  },
  // ── R9: the one sanctioned chat → pane route (a person's click on a local link) ──
  {
    name: 'ChatShell offers the pane a link on message arrival (a second caller)',
    rule: /^R9/,
    apply: (f) => edit(f, 'src/renderer/src/components/ChatShell.tsx', (t) => t + "\nimport { requestPaneLink } from '../link-open'\nexport function __bad(m: { content: string }) { requestPaneLink(m.content) }\n")
  },
  {
    name: 'a second subscriber to the link hand-off',
    rule: /^R9/,
    apply: (f) => edit(f, 'src/renderer/src/components/ChatShell.tsx', (t) => t + "\nimport { onPaneLink } from '../link-open'\nexport function __bad2() { onPaneLink(() => true) }\n")
  },
  {
    name: 'the anchor click drops the trusted-click gate',
    rule: /^R9/,
    apply: (f) => edit(f, ANCHOR, (t) => once(t, 'shouldOpenInPane(e.nativeEvent, href) && requestPaneLink(', 'requestPaneLink('))
  },
  {
    name: 'the anchor gate is ORed with the hand-off instead of ANDed',
    rule: /^R9/,
    apply: (f) => edit(f, ANCHOR, (t) => once(t, 'shouldOpenInPane(e.nativeEvent, href) && requestPaneLink(', 'shouldOpenInPane(e.nativeEvent, href) || requestPaneLink('))
  },
  {
    name: 'shouldOpenInPane stops refusing an untrusted click',
    rule: /^R9/,
    apply: (f) => edit(f, PANE_LINK, (t) => once(t, '  if (e.isTrusted !== true) return false\n', ''))
  },
  {
    name: 'shouldOpenInPane stops requiring the primary button',
    rule: /^R9/,
    apply: (f) => edit(f, PANE_LINK, (t) => once(t, 'if (e.button !== 0 || e.metaKey', 'if (e.metaKey'))
  },
  {
    name: 'isPaneLink drops the local-host requirement (every public link would open in the pane)',
    rule: /^R9/,
    apply: (f) => edit(f, PANE_LINK, (t) => once(t, ' && isLocalHost(u.hostname)', ''))
  },
  {
    name: 'isPaneLink stops requiring a web URL',
    rule: /^R9/,
    apply: (f) => edit(f, PANE_LINK, (t) => once(t, '  if (!isWebUrl(s)) return false\n', ''))
  },
  {
    name: 'the relay navigates without re-checking the address',
    rule: /^R9/,
    apply: (f) => edit(f, RELAY, (t) => once(t, '!isPaneLink(url) || ', ''))
  },
  {
    name: 'the relay navigates to something other than the url it was handed',
    rule: /^R9/,
    apply: (f) => edit(f, RELAY, (t) => once(t, '.browser.navigate(url)', ".browser.navigate(url + '/x')"))
  },
  {
    name: 'the link hand-off imports from the chat world',
    rule: /^R9/,
    apply: (f) => edit(f, 'src/renderer/src/link-open.ts', (t) => once(t, 'type PaneLinkHandler =', "import { MessageBody } from './components/MessageRenderer'\nvoid MessageBody\ntype PaneLinkHandler ="))
  },
  {
    name: 'the link hand-off grows a third export',
    rule: /^R9/,
    apply: (f) => edit(f, 'src/renderer/src/link-open.ts', (t) => t + '\nexport function openAnything(u: string): boolean { return requestPaneLink(u) }\n')
  },
  {
    name: 'the anchor handler is deleted and a message-level effect takes its place (caller count drops to zero)',
    rule: /^R9/,
    apply: (f) => edit(f, ANCHOR, (t) => once(t, 'shouldOpenInPane(e.nativeEvent, href) && requestPaneLink(href as string)', 'false'))
  },
  {
    name: 'a second module imports the pane and drives it',
    rule: /^R3/,
    apply: (f) => [...f, { path: 'src/main/agent-bridge.ts', text: "import { registerBrowserPane } from './browser-pane'\nexport const x = registerBrowserPane\nexport const ch = 'browser:navigate'\n" }]
  }
]
for (const m of mutations) {
  let out: string[]
  try {
    out = checkBrowserInvariant(m.apply(files.map((f) => ({ ...f }))))
  } catch (err) {
    assert(false, `mutation applies: ${m.name}`, (err as Error).message)
    continue
  }
  const hit = out.filter((line) => m.rule.test(line))
  assert(hit.length > 0, `flagged: ${m.name}`, hit[0] ?? `(no violation matching ${m.rule} — got: ${out.join(' | ') || 'nothing'})`)
}

console.log('')
console.log('[smoke] ===================== RESULT =====================')
console.log(`[smoke] outcome: ${failures === 0 ? 'PASS ✓' : `FAIL ✗ (${failures})`} (browser-pane invariant: real tree clean, ${mutations.length} planted wirings all seen)`)
console.log('[smoke] ===================================================')
process.exit(failures === 0 ? 0 : 1)
