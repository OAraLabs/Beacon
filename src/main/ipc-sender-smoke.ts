// IPC sender smoke: headless (ELECTRON_RUN_AS_NODE), no window. Asserts on the SOURCE that every IPC
// handler main registers checks its sender before it does anything else (ipc-sender-invariant.ts has
// the rules, S1–S5, and the OPEN_CHANNELS allowlist).
//
//   0. SELF-TEST. The checker runs over embedded fixtures first: clean ones must pass, and each dirty
//      one (no check, a check after a write, a check whose result is ignored, a bypassing `&&`, a
//      string or regex that could derail the parser, an alias of ipcMain…) must be flagged under its
//      rule. If one is not, the smoke exits 2 and reports nothing: a guard that cannot see its own
//      target is a note, not a guard.
//   1. THE REAL TREE: every .ts under src/main except *-smoke.ts and *-invariant.ts. Clean, with the
//      exact number of registrations per file, cross-checked by a second, dumber count.
//   2. MUTATIONS of the real tree, each removing or weakening one check. Each must be flagged.
//
// What it cannot prove: that isShellSender answers correctly at runtime, or that a real foreign page
// is refused. shell-window-smoke tests the decision; scripts/window-guard-probe.mjs drives the built
// app with a foreign page and a stranger window.
//
// The verdict runs on process 'exit' with an exact check count, so an early return or a throw cannot
// report green.
//
// Run: npm run build && npm run smoke:ipc-sender   (from the repo root; reads src/main)
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { checkIpcSenders, lex, OPEN_CHANNELS, type Report, type SourceFile } from './ipc-sender-invariant'

const EXPECTED_CHECKS = 57
let checks = 0
let failures = 0
let reported = false
function assert(cond: boolean, what: string, detail = ''): void {
  checks++
  console.log(`[smoke] ${cond ? 'PASS' : 'FAIL'}  ${what}${!cond && detail ? `\n         ${detail}` : ''}`)
  if (!cond) failures++
}
process.on('exit', () => {
  if (reported) return
  reported = true
  if (checks !== EXPECTED_CHECKS) {
    console.log(`\n[smoke] RESULT: INCOMPLETE — ${checks} checks ran, expected ${EXPECTED_CHECKS}`)
    process.exitCode = 1
    return
  }
  console.log(`\n[smoke] RESULT: ${failures === 0 ? 'PASS' : 'FAIL'} — ${checks - failures}/${checks}`)
  if (failures) process.exitCode = 1
})

// ── 0. self-test ──────────────────────────────────────────────────────────────────────────────────
// A stand-in shell-windows.ts with the real helpers' shape, so the fixtures do not depend on the tree.
const SW_PATH = 'src/main/shell-windows.ts'
const SW = `import { ipcMain, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron'
export function isShellSender(e: IpcMainEvent | IpcMainInvokeEvent): boolean {
  return shellSenderRefusal(factsOf(e)) === null
}
export function handleFromShell(channel: string, handler: (e: IpcMainInvokeEvent, ...args: any[]) => unknown): void {
  ipcMain.handle(channel, (e, ...args) => (isShellSender(e) ? handler(e, ...args) : null))
}
export function onFromShell(channel: string, listener: (e: IpcMainEvent, ...args: any[]) => void): void {
  ipcMain.on(channel, (e, ...args) => {
    if (!isShellSender(e)) return
    listener(e, ...args)
  })
}
`
const IMPORT_CHECK = `import { isShellSender } from './shell-windows'\n`
const IMPORT_HELPERS = `import { handleFromShell, onFromShell } from './shell-windows'\n`
const fx = (text: string, extra: SourceFile[] = [], sw = SW): SourceFile[] => [{ path: SW_PATH, text: sw }, { path: 'src/main/fx.ts', text }, ...extra]

type Case = { name: string; files: SourceFile[]; allow?: Record<string, string>; expect: 'clean' | RegExp; registrations?: number }
const CASES: Case[] = [
  // clean
  { name: 'a handler registered through handleFromShell', expect: 'clean', registrations: 1,
    files: fx(`${IMPORT_HELPERS}handleFromShell(IPC.A, async (_e, k: string) => repo.get(k))`) },
  { name: 'a raw handler whose first statement is if (!isShellSender(e) || …) return null', expect: 'clean',
    files: fx(`${IMPORT_CHECK}ipcMain.handle(IPC.A, (e, k) => {\n  if (!isShellSender(e) || typeof k !== 'string') return null\n  return repo.get(k)\n})`) },
  { name: 'a local delegate, used as const w = check(e); if (!w) return', expect: 'clean',
    files: fx(`${IMPORT_CHECK}function hostOf(e: E): W | null {\n  if (!isShellSender(e)) return null\n  return main\n}\nipcMain.on(IPC.A, (e, r) => {\n  const w = hostOf(e)\n  if (!w) return\n  go(w, r)\n})`) },
  { name: 'a delegate imported from the file that declares it', expect: 'clean',
    files: fx(`import { isFrame } from './fa'\nipcMain.on(IPC.A, (e) => {\n  if (!isFrame(e)) return\n  go()\n})`, [{ path: 'src/main/fa.ts', text: `${IMPORT_CHECK}export function isFrame(e: E): boolean {\n  return isShellSender(e)\n}` }]) },
  { name: 'an expression body CHECK(e) ? value : []', expect: 'clean',
    files: fx(`${IMPORT_CHECK}ipcMain.handle(IPC.A, (e): string[] => (isShellSender(e) ? list() : []))`) },
  { name: 'strings, a regex and a template holding ) // /* and a fake registration do not derail the parser', expect: 'clean', registrations: 1,
    files: fx(`${IMPORT_CHECK}const s = 'ipcMain.handle(IPC.B, () => 1) // not code'\nconst r = /['"(]\\/\\*/g\nconst t = \`\${f(')')} /* nor this */\`\nipcMain.handle(IPC.A, (e) => {\n  if (!isShellSender(e)) return null\n  return 'a ) /* b'.length + s.length + t.length + String(r)\n})`) },
  { name: 'an OPEN_CHANNELS entry lets its one raw handler answer any sender', expect: 'clean', allow: { 'IPC.OPEN': 'fixture' },
    files: fx(`ipcMain.handle(IPC.OPEN, () => theme())`) },
  // dirty
  { name: 'a raw handler with no check (a handler with its check removed)', expect: /^S1/,
    files: fx(`ipcMain.handle(IPC.A, async (_e, k: string) => repo.get(k))`) },
  { name: 'the check after a write', expect: /^S1/,
    files: fx(`${IMPORT_CHECK}ipcMain.handle(IPC.A, (e, k) => {\n  repo.set(k)\n  if (!isShellSender(e)) return null\n})`) },
  { name: 'the check called with its result ignored', expect: /^S1/,
    files: fx(`${IMPORT_CHECK}ipcMain.on(IPC.A, (e) => {\n  isShellSender(e)\n  write()\n})`) },
  { name: 'if (!check(e) && x) return, which lets a refused sender through when x is false', expect: /^S1/,
    files: fx(`${IMPORT_CHECK}ipcMain.on(IPC.A, (e, v) => {\n  if (!isShellSender(e) && v) return\n  write(v)\n})`) },
  { name: 'the check given something other than the handler event', expect: /^S1/,
    files: fx(`${IMPORT_CHECK}ipcMain.on(IPC.A, (e, other) => {\n  if (!isShellSender(other)) return\n  write(e)\n})`) },
  { name: 'a refusal that makes a call (return fallback())', expect: /^S1/,
    files: fx(`${IMPORT_CHECK}ipcMain.handle(IPC.A, (e) => {\n  if (!isShellSender(e)) return fallback()\n  return get()\n})`) },
  { name: 'an inverted ternary (check ? null : value)', expect: /^S1/,
    files: fx(`${IMPORT_CHECK}ipcMain.handle(IPC.A, (e) => (isShellSender(e) ? null : secret()))`) },
  { name: 'a nested ternary in the refused branch', expect: /^S1/,
    files: fx(`${IMPORT_CHECK}ipcMain.handle(IPC.A, (e) => (isShellSender(e) ? a() : b ? c() : null))`) },
  { name: 'an identity-only "check" that never calls isShellSender', expect: /^S1/,
    files: fx(`${IMPORT_CHECK}function hostOf(e: E): boolean {\n  return main.webContents === e.sender\n}\nipcMain.on(IPC.A, (e) => {\n  if (!hostOf(e)) return\n  go()\n})`) },
  { name: 'isShellSender imported from somewhere other than shell-windows.ts', expect: /^S1/,
    files: fx(`import { isShellSender } from './fake'\nipcMain.on(IPC.A, (e) => {\n  if (!isShellSender(e)) return\n  go()\n})`) },
  { name: 'a handler passed by reference (its check cannot be seen)', expect: /^S1/,
    files: fx(`ipcMain.handle(IPC.A, onA)`) },
  { name: 'the check only in a comment', expect: /^S1/,
    files: fx(`${IMPORT_CHECK}ipcMain.handle(IPC.A, (e) => {\n  // if (!isShellSender(e)) return null\n  return get()\n})`) },
  { name: 'an unguarded handler after a regex literal and a template (the lexer does not swallow it)', expect: /^S1/,
    files: fx(`const r = /['"(]\\/\\*/g\nconst t = \`\${f(')')}\`\nipcMain.handle(IPC.A, (_e) => get())`) },
  { name: 'webContents.ipc.handle with no check', expect: /^S1/,
    files: fx(`win.webContents.ipc.handle(IPC.A, () => get())`) },
  { name: 'the OPEN_CHANNELS control: the same open handler with the channel NOT listed', expect: /^S1/,
    files: fx(`ipcMain.handle(IPC.OPEN, () => theme())`) },
  { name: 'an alias of ipcMain', expect: /^S2/,
    files: fx(`const bus = ipcMain\nbus.handle(IPC.A, () => get())`) },
  { name: 'a helper declared outside shell-windows.ts', expect: /^S3/,
    files: fx(`export function handleFromShell(c: string, h: H): void {\n  ipcMain.handle(c, h)\n}`) },
  { name: 'a helper imported from somewhere other than shell-windows.ts', expect: /^S3/,
    files: fx(`import { handleFromShell } from './elsewhere'\nhandleFromShell(IPC.A, () => get())`) },
  { name: 'handleFromShell with its check removed', expect: /^S3/,
    files: fx(`${IMPORT_HELPERS}handleFromShell(IPC.A, () => get())`, [], SW.replace('(e, ...args) => (isShellSender(e) ? handler(e, ...args) : null)', 'handler')) },
  { name: 'an OPEN_CHANNELS entry naming no registration', expect: /^S4/, allow: { 'IPC.GONE': 'fixture' },
    files: fx(`${IMPORT_HELPERS}handleFromShell(IPC.A, () => get())`) },
  { name: 'an OPEN_CHANNELS entry whose handler checks anyway', expect: /^S4/, allow: { 'IPC.A': 'fixture' },
    files: fx(`${IMPORT_CHECK}ipcMain.handle(IPC.A, (e) => (isShellSender(e) ? get() : null))`) },
  { name: "a raw 'ipc-message' listener", expect: /^S5/,
    files: fx(`wc.on('ipc-message', (_e, ch) => run(ch))`) }
]
const selfFailures: string[] = []
for (const c of CASES) {
  const r = checkIpcSenders(c.files, c.allow ?? {})
  const ok =
    c.expect === 'clean'
      ? r.violations.length === 0 && (c.registrations === undefined || r.registrations.filter((x) => x.file === 'src/main/fx.ts').length === c.registrations)
      : r.violations.some((v) => (c.expect as RegExp).test(v))
  if (!ok) selfFailures.push(`${c.expect === 'clean' ? 'clean' : 'dirty'} fixture "${c.name}": ${JSON.stringify(r.violations)} (${r.registrations.length} registrations)`)
}
if (selfFailures.length) {
  for (const f of selfFailures) console.error(`[smoke] SELF-TEST FAILED: ${f}`)
  console.error('[smoke] the checker cannot tell a guarded handler from an unguarded one; refusing to report.')
  reported = true
  process.exit(2)
}
console.log(`[smoke] self-test: ${CASES.length}/${CASES.length} fixtures classified correctly (${CASES.filter((c) => c.expect === 'clean').length} clean, ${CASES.filter((c) => c.expect !== 'clean').length} dirty)`)

// ── 1. the real tree ──────────────────────────────────────────────────────────────────────────────
const ROOT = process.cwd()
const MAIN = join(ROOT, 'src/main')
if (!existsSync(join(MAIN, 'shell-windows.ts'))) {
  console.error(`[smoke] no src/main/shell-windows.ts under ${ROOT}; run from the repo root`)
  reported = true
  process.exit(2)
}
function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (name.endsWith('.ts') && !name.endsWith('-smoke.ts') && !name.endsWith('-invariant.ts')) out.push(p)
  }
  return out
}
const files: SourceFile[] = walk(MAIN).map((p) => ({ path: relative(ROOT, p).split('\\').join('/'), text: readFileSync(p, 'utf8') }))

/** Every file that registers IPC, and how. Update it when you add a handler: the count is how this
 *  smoke knows it read the tree the way you think it did, and a new FILE here is a new IPC surface
 *  someone should look at. */
const REGISTRATIONS: Record<string, { helper: number; raw: number }> = {
  'src/main/ipc.ts': { helper: 40, raw: 0 },
  'src/main/index.ts': { helper: 19, raw: 0 },
  'src/main/integrations-ipc.ts': { helper: 6, raw: 0 },
  'src/main/loop-ipc.ts': { helper: 5, raw: 0 },
  'src/main/discovery-ipc.ts': { helper: 4, raw: 0 },
  'src/main/path-a-ipc.ts': { helper: 5, raw: 0 },
  'src/main/join-ipc.ts': { helper: 6, raw: 0 },
  'src/main/network-setting-ipc.ts': { helper: 3, raw: 0 },
  'src/main/main-model-ipc.ts': { helper: 5, raw: 0 },
  'src/main/owner-promotion-ipc.ts': { helper: 1, raw: 0 },
  'src/main/pair-pin-ipc.ts': { helper: 1, raw: 0 },
  'src/main/model-setup-ipc.ts': { helper: 4, raw: 0 },
  'src/main/screenshot-ipc.ts': { helper: 3, raw: 0 },
  'src/main/voice.ts': { helper: 5, raw: 0 },
  'src/main/vad-client.ts': { helper: 4, raw: 0 },
  'src/main/session-window-ipc.ts': { helper: 4, raw: 0 },
  // raw, each handler's first call is paneHost (isShellSender + the pane's two host windows)
  'src/main/browser-pane.ts': { helper: 0, raw: 16 },
  // raw, each handler's first call is isBeaconWindowFrame (= isShellSender), with typed refusals
  'src/main/terminal-ipc.ts': { helper: 0, raw: 12 },
  // the two helpers' own bodies
  'src/main/shell-windows.ts': { helper: 0, raw: 2 }
}
const EXPECTED_OPEN_CHANNELS = 0

console.log('\n[smoke] === 1. the real tree ===')
const real = checkIpcSenders(files)
assert(files.length >= 30 && files.some((f) => f.path === 'src/main/ipc.ts'), `read src/main (${files.length} files, smokes and invariants excluded)`)
const tally = new Map<string, { helper: number; raw: number }>()
for (const r of real.registrations) {
  const t = tally.get(r.file) ?? { helper: 0, raw: 0 }
  t[r.via]++
  tally.set(r.file, t)
}
for (const [file, want] of Object.entries(REGISTRATIONS)) {
  const got = tally.get(file) ?? { helper: 0, raw: 0 }
  assert(got.helper === want.helper && got.raw === want.raw, `${file}: ${want.helper + want.raw} registrations (${want.helper} via helper, ${want.raw} raw)`, `found ${got.helper} via helper, ${got.raw} raw`)
}
const unexpected = [...tally.keys()].filter((f) => !(f in REGISTRATIONS))
assert(unexpected.length === 0, 'no other file in src/main registers an IPC handler', `also registering: ${unexpected.join(', ')}`)
{
  // A second count that shares nothing with the parser but the file list: comments stripped with a
  // plain regex, calls counted with another. If the parser misses a registration, they disagree.
  let crude = 0
  for (const f of files) {
    const c = f.text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\])\/\/.*$/gm, '$1')
    crude += (c.match(/\bipcMain\.(handle|handleOnce|on|once|addListener|prependListener|prependOnceListener)\(/g) ?? []).length
    crude += (c.match(/(?<!function )\b(handleFromShell|onFromShell)\(/g) ?? []).length
  }
  assert(crude === real.registrations.length, `an independent count agrees with the parser (${real.registrations.length} registrations)`, `crude count ${crude}`)
}
for (const file of Object.keys(REGISTRATIONS)) {
  const regs = real.registrations.filter((r) => r.file === file)
  const bad = real.violations.filter((v) => v.startsWith(`S1 ${file}:`))
  const guarded = regs.filter((r) => r.guard !== null && r.guard !== 'open').length
  assert(bad.length === 0 && guarded === regs.length, `${file}: every handler checks its sender before anything else (${guarded}/${regs.length})`, bad.join('\n         '))
}
assert(real.violations.length === 0, 'no violation anywhere: no unguarded handler, no other use of ipcMain, helpers intact, allowlist live, no raw ipc-message (S1–S5)', real.violations.join('\n         '))
assert(
  Object.keys(OPEN_CHANNELS).length === EXPECTED_OPEN_CHANNELS && real.registrations.filter((r) => r.guard === 'open').length === EXPECTED_OPEN_CHANNELS,
  `OPEN_CHANNELS has ${EXPECTED_OPEN_CHANNELS} entries: no channel answers every sender`,
  `entries: ${Object.keys(OPEN_CHANNELS).join(', ')}`
)
{
  // The root of trust every check above leads to. Its WHOLE body is pinned (comments aside): one
  // decision, the shared shellSenderRefusal that shell-window-smoke tests both ways, on a window
  // Beacon adopted, and a refusal when reading the event throws. Nothing can answer yes before it.
  const sw = files.find((f) => f.path === SW_PATH)?.text ?? ''
  const at = sw.indexOf('export function isShellSender(')
  const body = at === -1 ? '' : (/^[^{]*(\{[\s\S]*?\n\})/.exec(lex(sw).code.slice(at))?.[1] ?? '').replace(/\s+/g, ' ')
  const ROOT_BODY =
    '{ try { const wc = e.sender const frame = e.senderFrame return ( shellSenderRefusal({ known: adopted.has(wc) && !wc.isDestroyed(), ' +
    'mainFrame: frame !== null && frame === wc.mainFrame, frameUrl: frame?.url ?? null, shellUrl: shellUrl() }) === null ) } catch { return false } }'
  assert(body === ROOT_BODY, 'isShellSender is exactly the shared decision on an adopted window, and refuses on a throw', body)
}
console.log(`[smoke] FACT delegates: ${real.delegates.join('; ')}`)

// ── 2. mutations of the real tree: each removes or weakens one check, and must be flagged ─────────
console.log('\n[smoke] === 2. the checker sees each weakened check ===')
type Mutation = { name: string; rule: RegExp; apply: (f: SourceFile[]) => SourceFile[]; allow?: Record<string, string> }
const edit = (fs: SourceFile[], path: string, fn: (t: string) => string): SourceFile[] => {
  const hit = fs.find((f) => f.path === path)
  if (!hit) throw new Error(`mutation target missing: ${path}`)
  const next = fn(hit.text)
  if (next === hit.text) throw new Error(`mutation did not change ${path}`)
  return fs.map((f) => (f === hit ? { ...f, text: next } : f))
}
/** Replace exactly one occurrence, or throw: a mutation that does not apply must not score a kill. */
const once = (t: string, anchor: string, replacement: string): string => {
  const n = t.split(anchor).length - 1
  if (n !== 1) throw new Error(`anchor found ${n}× (need exactly 1): ${anchor.slice(0, 70)}`)
  return t.replace(anchor, replacement)
}
const MUTATIONS: Mutation[] = [
  { name: 'ipc.ts: settings.get registered raw (its check removed)', rule: /^S1 src\/main\/ipc\.ts:.*IPC\.SETTINGS_GET/,
    apply: (f) => edit(f, 'src/main/ipc.ts', (t) => once(t, 'handleFromShell(IPC.SETTINGS_GET,', 'ipcMain.handle(IPC.SETTINGS_GET,')) },
  { name: 'ipc.ts: daemon.write registered raw', rule: /^S1 src\/main\/ipc\.ts:.*IPC\.DAEMON_WRITE/,
    apply: (f) => edit(f, 'src/main/ipc.ts', (t) => once(t, 'handleFromShell(\n    IPC.DAEMON_WRITE,', 'ipcMain.handle(\n    IPC.DAEMON_WRITE,')) },
  { name: 'index.ts: the updater install handler registered raw', rule: /^S1 src\/main\/index\.ts:.*IPC\.UPDATER_INSTALL/,
    apply: (f) => edit(f, 'src/main/index.ts', (t) => once(t, 'handleFromShell(IPC.UPDATER_INSTALL,', 'ipcMain.handle(IPC.UPDATER_INSTALL,')) },
  { name: 'vad-client.ts: the audio send registered raw', rule: /^S1 src\/main\/vad-client\.ts:.*IPC\.VAD_AUDIO/,
    apply: (f) => edit(f, 'src/main/vad-client.ts', (t) => once(t, 'onFromShell(IPC.VAD_AUDIO,', 'ipcMain.on(IPC.VAD_AUDIO,')) },
  // (TERMINAL_OPEN, not the write channel: smoke:terminal pins which files may name that one.)
  { name: 'terminal-ipc.ts: opening a pty loses its check', rule: /^S1 src\/main\/terminal-ipc\.ts:.*IPC\.TERMINAL_OPEN/,
    apply: (f) => edit(f, 'src/main/terminal-ipc.ts', (t) => once(t, 'TerminalOpenError | null => {\n    if (!isBeaconWindowFrame(e)) return null\n', 'TerminalOpenError | null => {\n')) },
  { name: 'terminal-ipc.ts: isBeaconWindowFrame stops calling isShellSender', rule: /^S1 src\/main\/terminal-ipc\.ts:/,
    apply: (f) => edit(f, 'src/main/terminal-ipc.ts', (t) => once(t, '  return isShellSender(e)\n', '  return e.sender.isFocused()\n')) },
  { name: 'browser-pane.ts: navigate runs a call before its check', rule: /^S1 src\/main\/browser-pane\.ts:.*BROWSER_IPC\.NAVIGATE/,
    apply: (f) => edit(f, 'src/main/browser-pane.ts', (t) => once(t, 'NavigateResult | null => {\n    if (!paneHost(e)) return null\n', 'NavigateResult | null => {\n    push()\n    if (!paneHost(e)) return null\n')) },
  { name: 'browser-pane.ts: paneHost checks identity only (as before 2026-09-24)', rule: /^S1 src\/main\/browser-pane\.ts:/,
    apply: (f) => edit(f, 'src/main/browser-pane.ts', (t) => once(t, '    if (!isShellSender(e)) return null\n    const main = deps.getMainWindow()\n', '    const main = deps.getMainWindow()\n')) },
  { name: 'shell-windows.ts: handleFromShell calls the handler without the check', rule: /^S3/,
    apply: (f) => edit(f, SW_PATH, (t) => once(t, '(e, ...args) => (isShellSender(e) ? handler(e, ...args) : null)', 'handler')) },
  { name: 'shell-windows.ts: onFromShell with its check inverted', rule: /^S1 src\/main\/shell-windows\.ts:/,
    apply: (f) => edit(f, SW_PATH, (t) => once(t, '    if (!isShellSender(e)) return\n    listener(e, ...args)', '    if (isShellSender(e)) return\n    listener(e, ...args)')) },
  { name: 'a new main module registers a handler with no check', rule: /^S1 src\/main\/agent-bridge\.ts:/,
    apply: (f) => [...f, { path: 'src/main/agent-bridge.ts', text: "import { ipcMain } from 'electron'\nexport function register(): void {\n  ipcMain.handle('agent:run', (_e, cmd: string) => run(cmd))\n}\n" }] },
  { name: 'index.ts: an alias of ipcMain', rule: /^S2 src\/main\/index\.ts:/,
    apply: (f) => edit(f, 'src/main/index.ts', (t) => t + '\nconst bus = ipcMain\nbus.handle(IPC.SETTINGS_GET, () => null)\n') },
  { name: 'OPEN_CHANNELS lists a channel that goes through the helper', rule: /^S4/, allow: { 'IPC.SETTINGS_GET': 'mutation' },
    apply: (f) => f }
]
for (const m of MUTATIONS) {
  let r: Report
  try {
    r = checkIpcSenders(m.apply(files), m.allow ?? OPEN_CHANNELS)
  } catch (e) {
    assert(false, `flagged: ${m.name}`, `the mutation did not apply: ${(e as Error).message}`)
    continue
  }
  const hits = r.violations.filter((v) => m.rule.test(v))
  assert(hits.length > 0, `flagged: ${m.name}`, `no violation matched ${m.rule}; got ${JSON.stringify(r.violations)}`)
}

console.log(`\n[smoke] ipc-sender: ${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`)
