// Terminal pane smoke — three halves, all headless (ELECTRON_RUN_AS_NODE, real ptys):
//
//   A. the pure model (@shared/terminal): scrollback bounds, exit prose, token→theme mapping.
//   B. the session manager (terminal-sessions.ts) with REAL node-pty: echo round-trip, scrollback
//      replay on a later attach (what a window reload / pop-out relies on), resize → SIGWINCH
//      (`stty size` reports the new geometry), Ctrl-C interrupts a foreground job, an exit is
//      reported with its code and the session stays listed, disposeAll leaves no live pid.
//   C. THE INVARIANT, asserted on the SOURCE — the absence of any wiring from a chat/agent message
//      to a pty write. Not a comment saying it does not exist: the chat-path files must not mention
//      the pty, the pty files must not mention the chat path, node-pty must be imported in exactly
//      one file, TERMINAL_WRITE must be referenced by exactly the three files of the keyboard path,
//      and every terminal IPC handler must run the Beacon-window-frame guard.
//      House rule (guards prove themselves): the predicates run against embedded fixtures FIRST —
//      one that contains the forbidden wiring, one that is clean — and the smoke exits 2 if a
//      predicate cannot tell them apart. Mutation-tested once against a real wiring (see the
//      Phase 1 commit).
//
// Run: npm run smoke:terminal
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ScrollbackBuffer, TERMINAL_TOKEN_MAP, defaultTitle, describeExit, isTerminalOpenError, xtermThemeFromTokens } from '@shared/terminal'
import { TerminalSessions, resolveProgram, shellEnv, type TerminalSink } from './terminal-sessions'
import { parseAgentIdentities, parseTailscaleStatus, sshCommand, sshReadiness } from '@shared/tailscale'
import { tailnetStatus } from './tailnet'

let failures = 0
let sections = 0
function assert(cond: boolean, what: string): void {
  console.log(`[smoke] ${cond ? 'PASS' : 'FAIL'}  ${what}`)
  if (!cond) failures++
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
async function until(pred: () => boolean, ms: number): Promise<boolean> {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if (pred()) return true
    await sleep(25)
  }
  return pred()
}

// ── C's predicates (pure, on source text) — defined first so the self-test can run first ──────
const SRC = join(fileURLToPath(import.meta.url), '../../../src')
const read = (rel: string): string => readFileSync(join(SRC, rel), 'utf8')
function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.(ts|tsx)$/.test(name)) out.push(full)
  }
  return out
}
/** Code only: line + block comments stripped, so prose cannot mask or fake a hit. */
const code = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
/** Does a chat-path source mention the pty at all (any identifier of the terminal feature)?
 *  The first draft required a dot BEFORE `terminal.` and the self-test caught it: a bare
 *  `terminal.write(` in a chat file would have passed. */
const mentionsPty = (src: string): boolean =>
  /node-pty|\bpty\b|TERMINAL_|terminal-sessions|terminal-ipc|killAllTerminals|registerTerminalHandlers|\bterminal\.|TerminalSessions/i.test(code(src))
/** Does a pty-side source reach for the agent/daemon path? */
const touchesAgentPath = (src: string): boolean =>
  /CHAT_|GATEWAY_EVENT|onStream|onGateway|getConnection|getCache|ConnectionManager|RestClient|\/api\/|daemon|broadcast\(|cache\/service|connection\//.test(code(src))
/** Is every ipcMain handler in the file guarded (one guard call per handler registration)? */
function guardsAllHandlers(src: string): boolean {
  const handlers = (src.match(/ipcMain\.(handle|on)\(/g) ?? []).length
  const guards = (src.match(/isBeaconWindowFrame\(e\)/g) ?? []).length
  return handlers > 0 && guards === handlers
}
/** Imports of a module, as specifiers. */
const importsOf = (src: string): string[] => [...src.matchAll(/from '([^']+)'/g)].map((m) => m[1])

// Fixtures — the self-test. A predicate that passes the dirty fixture is a note, not a guard.
const DIRTY_CHAT = `const onStreamFrame = (f) => { broadcast(IPC.CHAT_STREAM, f); terminal.write(sid, f.text) }`
const CLEAN_CHAT = `const onStreamFrame = (f) => { broadcast(IPC.CHAT_STREAM, f); maybeNotifyTask(f) }`
const DIRTY_PTY = `import { ConnectionManager } from './connection'\nconnection.on('stream', (f) => manager().write(id, f.text))`
const CLEAN_PTY = `import { ipcMain } from 'electron'\nipcMain.on(IPC.TERMINAL_WRITE, (e, id, data) => { if (!isBeaconWindowFrame(e)) return; manager().write(id, data) })`
const UNGUARDED = `ipcMain.on(IPC.TERMINAL_WRITE, (e, id, data) => { if (!isBeaconWindowFrame(e)) return; w(id, data) })\nipcMain.handle(IPC.TERMINAL_OPEN, (e) => open())`
const GUARDED = `ipcMain.on(IPC.TERMINAL_WRITE, (e, id, data) => { if (!isBeaconWindowFrame(e)) return; w(id, data) })\nipcMain.handle(IPC.TERMINAL_OPEN, (e) => { if (!isBeaconWindowFrame(e)) return null; return open() })`
/** Does a renderer surface that lives in a satellite window close itself? A renderer-initiated
 *  window.close() DESTROYS the BrowserWindow, bypassing the cancelable 'close' the satellite
 *  relies on to hide instead (measured 2026-09-03) — for a window hosting a WebContentsView that
 *  is the teardown that hung main. Comments stripped: the sentence above must not count. */
const closesItself = (src: string): boolean => /\bwindow\.close\(/.test(code(src))
const DIRTY_CLOSE = `const popIn = () => { window.beacon?.terminal.popIn(); window.close() }`
const CLEAN_CLOSE = `// never window.close() here\nconst popIn = () => { window.beacon?.terminal.popIn() }`
const selfTest: Array<[boolean, string]> = [
  [closesItself(DIRTY_CLOSE) === true, 'closesItself flags a satellite pane calling window.close()'],
  [closesItself(CLEAN_CLOSE) === false, 'closesItself ignores the word in a comment'],
  [mentionsPty(DIRTY_CHAT) === true, 'mentionsPty flags a chat frame written into a pty'],
  [mentionsPty(CLEAN_CHAT) === false, 'mentionsPty passes a clean chat path'],
  [touchesAgentPath(DIRTY_PTY) === true, 'touchesAgentPath flags a pty fed by the connection'],
  [touchesAgentPath(CLEAN_PTY) === false, 'touchesAgentPath passes the keyboard-only handler'],
  [guardsAllHandlers(UNGUARDED) === false, 'guardsAllHandlers flags one unguarded handler'],
  [guardsAllHandlers(GUARDED) === true, 'guardsAllHandlers passes when every handler checks the sender']
]
for (const [ok, what] of selfTest) {
  if (!ok) {
    console.error(`[smoke] SELF-TEST FAILED: ${what} — the invariant guard cannot detect its own target; refusing to report.`)
    process.exit(2)
  }
}
console.log(`[smoke] self-test: ${selfTest.length}/${selfTest.length} predicates discriminate`)

async function main(): Promise<void> {
  // ── A. pure model ───────────────────────────────────────────────────────────
  console.log('\n[smoke] === A. pure model ===')
  sections++
  {
    const b = new ScrollbackBuffer(10)
    b.push('aaaa'); b.push('bbbb'); b.push('cccc')
    assert(b.snapshot() === 'bbbbcccc' && b.size === 8, 'scrollback evicts whole chunks from the front to stay under the limit')
    b.push('x'.repeat(25))
    assert(b.snapshot() === 'x'.repeat(10), 'a chunk larger than the limit keeps only its tail')
    const empty = new ScrollbackBuffer(10); empty.push('')
    assert(empty.size === 0 && empty.snapshot() === '', 'empty pushes are ignored')
    assert(describeExit({ exitCode: 0, at: 0 }, '/bin/zsh') === 'zsh exited', 'exit 0 prose')
    assert(describeExit({ exitCode: 3, at: 0 }, '/bin/zsh') === 'zsh exited with code 3', 'non-zero exit prose carries the code')
    assert(describeExit({ exitCode: 0, signal: 9, at: 0 }, 'ssh') === 'ssh was killed by signal 9', 'signal prose carries the signal')
    assert(defaultTitle(['/bin/zsh', '-l']) === 'zsh' && defaultTitle(['ssh', 'mini']) === 'ssh mini' && defaultTitle(['ssh', '-o', 'BatchMode=yes', 'box']) === 'ssh box', 'tab titles: shell basename / ssh host (after its -o options)')
    const theme = xtermThemeFromTokens((n) => (n === '--ink' ? ' #fff ' : n === '--c-base' ? '#000' : ''))
    assert(theme.foreground === '#fff' && theme.background === '#000' && theme.cursorAccent === '#000' && !('cursor' in theme), 'theme maps tokens, trims, and OMITS unresolved ones (xterm keeps its default)')
    assert(Object.values(TERMINAL_TOKEN_MAP).every((t) => t.startsWith('--')), 'every theme colour is a token reference, not a literal')
    const env = shellEnv({ ELECTRON_RUN_AS_NODE: '1', PATH: '/usr/bin' })
    assert(!('ELECTRON_RUN_AS_NODE' in env) && env.TERM === 'xterm-256color' && env.PATH === '/usr/bin', 'shell env drops Electron switches, sets TERM, keeps the rest')
  }

  // ── A2. tailnet model (Phase 4) — pure, on a synthetic status (no addresses: the pre-commit guard) ──
  console.log('\n[smoke] === A2. tailnet peers + ssh readiness ===')
  {
    const status = parseTailscaleStatus({
      BackendState: 'Running',
      Peer: {
        a: { HostName: 'box-one', DNSName: 'box-one.example.internal.', OS: 'linux', Online: true, SSH_HostKeys: ['ssh-ed25519 AAAA'] },
        b: { HostName: 'box-two', DNSName: 'box-two.example.internal.', OS: 'linux', Online: true },
        c: { HostName: 'box-off', DNSName: 'box-off.example.internal.', OS: 'macOS', Online: false },
        d: { HostName: 'phone', DNSName: 'phone.example.internal.', OS: 'iOS', Online: true },
        e: { nonsense: true }
      }
    })
    assert(status.backendState === 'Running' && status.peers.map((p) => p.hostName).join(',') === 'box-one,box-two,box-off', `parses peers, drops phones + junk, online first: ${status.peers.map((p) => p.hostName).join(',')}`)
    assert(status.peers[0].dnsName === 'box-one.example.internal' && status.peers[0].tailscaleSsh && !status.peers[1].tailscaleSsh, 'trailing dot stripped; Tailscale SSH read from SSH_HostKeys')
    assert(parseTailscaleStatus(null).peers.length === 0 && parseTailscaleStatus('x').peers.length === 0, 'junk status → no peers, no throw')
    const [one, two, off] = status.peers
    assert(sshReadiness(one, { agentIdentities: 0 }).ok === true && (sshReadiness(one, { agentIdentities: 0 }) as { mode: string }).mode === 'tailscale-ssh', 'Tailscale SSH peer is ready with an EMPTY agent (ACLs authorize, nothing stored)')
    assert(sshReadiness(two, { agentIdentities: 2 }).ok === true && (sshReadiness(two, { agentIdentities: 2 }) as { mode: string }).mode === 'agent', 'a plain peer is ready when the agent holds identities')
    const refused = sshReadiness(two, { agentIdentities: 0 })
    assert(refused.ok === false && /Tailscale SSH is not enabled on box-two/.test(refused.reason) && /holds no identities/.test(refused.reason) && /will not ask for a password/.test(refused.reason), 'neither → refused with BOTH reasons and the no-password promise')
    assert(sshReadiness(two, { agentIdentities: -1 }).ok === false && /no ssh-agent is reachable/.test((sshReadiness(two, { agentIdentities: -1 }) as { reason: string }).reason), 'no agent at all → says so')
    assert(sshReadiness(off, { agentIdentities: 5 }).ok === false && /offline/.test((sshReadiness(off, { agentIdentities: 5 }) as { reason: string }).reason), 'an offline peer is refused even with keys')
    const cmd = sshCommand(one)
    assert(cmd[0] === 'ssh' && cmd[cmd.length - 1] === 'box-one.example.internal' && cmd.includes('BatchMode=yes') && cmd.includes('PasswordAuthentication=no') && cmd.includes('KbdInteractiveAuthentication=no'), `ssh argv switches every interactive credential path off: ${cmd.join(' ')}`)
    assert(parseAgentIdentities('The agent has no identities.', 1) === 0 && parseAgentIdentities('256 SHA256:x a (ED25519)\n256 SHA256:y b (ED25519)\n', 0) === 2 && parseAgentIdentities('Could not open a connection to your authentication agent.', 2) === -1, 'ssh-add -l parsing: none / two / no agent')
    // Live report — this Mac's answer, reported not asserted (a CI box has no tailnet).
    const live = await tailnetStatus(process.env, homedir())
    console.log(`[smoke] tailscale on this Mac: available=${live.available} state=${live.backendState} peers=${live.peers.length} tailscale-ssh peers=${live.peers.filter((p) => p.tailscaleSsh).length} agent identities=${live.agentIdentities}${live.error ? ' error=' + live.error : ''}`)
    assert(typeof live.available === 'boolean' && Array.isArray(live.peers), 'tailnetStatus answers with a description, never a throw')
  }

  // ── B. real ptys ────────────────────────────────────────────────────────────
  console.log('\n[smoke] === B. session manager with real node-pty ===')
  sections++
  const mgr = new TerminalSessions({ shell: '/bin/zsh', shellArgs: ['-f'], home: homedir(), env: process.env, scrollbackLimit: 64 * 1024 })
  let outA = ''
  const exits: Array<{ id: string; code: number }> = []
  const sinkA: TerminalSink = { data: (_id, c) => { outA += c }, exit: (id, ex) => exits.push({ id, code: ex.exitCode }) }
  const opened = mgr.open({ cols: 80, rows: 24 })
  if (isTerminalOpenError(opened)) { console.error('[smoke] cannot open a shell:', opened.error); process.exit(1) }
  const s = opened
  assert(s.pid > 0 && s.exit === null && s.title === 'zsh' && s.cwd === homedir() && s.command[0] === '/bin/zsh', `open: pid ${s.pid}, title zsh, cwd home, argv kept`)
  assert(mgr.rename(s.id, '  build box  ') && mgr.get(s.id)?.title === 'build box', 'rename trims and applies')
  // Crashed-shell prose needs a REASON: a missing program is refused with a sentence, not spawned into a silent exit 1.
  const missing = mgr.open({ cols: 80, rows: 24, command: ['definitely-not-a-program-xyz'] })
  assert(isTerminalOpenError(missing) && /not installed or not on PATH/.test(missing.error), `a missing program is a described refusal: ${JSON.stringify(missing)}`)
  assert(mgr.list().length === 1, 'a refused open leaves no session behind')
  assert(resolveProgram('zsh', '/nonexistent:/bin', '/') === '/bin/zsh' && resolveProgram('/bin/zsh', '', '/') === '/bin/zsh' && resolveProgram('nope', '/bin', '/') === null, 'resolveProgram: PATH search, absolute path, and not-found')
  const first = mgr.attach(s.id, sinkA)
  assert(first !== null && first.session.id === s.id, 'attach returns the session')
  mgr.write(s.id, 'echo SMOKE_$((6*7))\r')
  assert(await until(() => /SMOKE_42/.test(outA), 5000), 'echo round-trips through the pty')

  // A later attach (a reloaded window, a popped-out window) must see the history without a restart.
  let outB = ''
  const sinkB: TerminalSink = { data: (_id, c) => { outB += c }, exit: () => undefined }
  const later = mgr.attach(s.id, sinkB)
  assert(later !== null && /SMOKE_42/.test(later.replay) && later.session.pid === s.pid, 'a later attach replays the scrollback for the SAME pid (no restart)')
  mgr.write(s.id, 'echo BOTH_$((2*2))\r')
  assert(await until(() => /BOTH_4/.test(outA) && /BOTH_4/.test(outB), 5000), 'both attached sinks receive new output')
  mgr.detach(s.id, sinkB)
  const bLen = outB.length
  mgr.write(s.id, 'echo AFTER_DETACH\r')
  assert(await until(() => /AFTER_DETACH\r\n/.test(outA), 5000) && outB.length === bLen, 'a detached sink receives nothing more')

  assert(mgr.resize(s.id, 100, 30) && mgr.get(s.id)?.cols === 100, 'resize is recorded')
  outA = ''
  mgr.write(s.id, 'stty size\r')
  assert(await until(() => /\r\n30 100\r\n/.test(outA), 5000), 'the pty reports the new geometry (SIGWINCH reached the shell)')

  outA = ''
  mgr.write(s.id, 'sleep 30\r')
  await sleep(400)
  mgr.write(s.id, '\x03')
  mgr.write(s.id, 'echo AFTER_$((1+1))\r')
  assert(await until(() => /AFTER_2/.test(outA), 3000), 'Ctrl-C interrupts a foreground job (the prompt came back within 3 s of a 30 s sleep)')

  mgr.write(s.id, 'exit 3\r')
  assert(await until(() => exits.some((e) => e.id === s.id && e.code === 3), 5000), 'exit is reported with its code')
  const afterExit = mgr.get(s.id)
  assert(afterExit !== null && afterExit.exit?.exitCode === 3, 'an exited session stays listed with its exit — the pane shows why, never a silent close')
  assert(mgr.write(s.id, 'x') === false, 'writes to an exited session are refused')
  assert(mgr.list().length === 1, 'list holds the exited session until closed')

  // A real `ssh` through the pane's own argv, to a name that cannot resolve: ssh's words + its exit
  // code land in the pane, and BatchMode guarantees no prompt ever could.
  {
    const sshOut: string[] = []
    const sshExit: number[] = []
    const sshSess = mgr.open({ cols: 80, rows: 24, command: sshCommand({ hostName: 'nowhere', dnsName: 'nowhere.invalid', os: 'linux', online: true, tailscaleSsh: false }) })
    if (isTerminalOpenError(sshSess)) { assert(false, `ssh could not be opened: ${sshSess.error}`) } else {
      mgr.attach(sshSess.id, { data: (_i, c) => sshOut.push(c), exit: (_i, ex) => sshExit.push(ex.exitCode) })
      assert(sshSess.title === 'ssh nowhere.invalid' && sshSess.command[0] === 'ssh', 'an ssh tab is titled after its host and keeps its argv')
      assert(await until(() => sshExit.length > 0, 15000), `ssh to an unresolvable host exited (code ${sshExit[0]})`)
      const text = sshOut.join('')
      assert(sshExit[0] === 255 && /resolve|not known|nodename/i.test(text), `ssh's own words reached the pane: ${JSON.stringify(text.trim().slice(0, 80))}`)
      assert(!/password|passphrase/i.test(text), 'no credential prompt in the output (BatchMode)')
      mgr.close(sshSess.id)
    }
  }

  const s2 = mgr.open({ cols: 80, rows: 24 })
  if (isTerminalOpenError(s2)) { console.error('[smoke] cannot open a second shell:', s2.error); process.exit(1) }
  const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true } catch { return false } }
  assert(alive(s2.pid), 'a second shell is running')
  const killed = mgr.disposeAll()
  assert(killed === 1, `disposeAll reports the live count (1 running, 1 already exited): ${killed}`)
  assert(await until(() => !alive(s2.pid), 3000), 'disposeAll leaves no live pid (no orphan on quit)')
  assert(mgr.list().length === 0, 'disposeAll forgets every session')

  // ── C. the invariant, on the source ─────────────────────────────────────────
  console.log('\n[smoke] === C. INVARIANT: no path from a chat/agent message to a pty ===')
  sections++
  const chatPath = ['main/ipc.ts', 'main/cache/service.ts', 'main/connection/index.ts', 'main/connection/rest.ts', 'main/connection/ws.ts']
  for (const rel of chatPath) assert(!mentionsPty(read(rel)), `${rel} never mentions the pty`)
  {
    // index.ts may name exactly the two registration identifiers, on their own lines; nothing else.
    const idx = read('main/index.ts').split('\n').filter((l) => !/registerTerminalHandlers|killAllTerminals|Terminal pane: the ptys/.test(l)).join('\n')
    assert(!mentionsPty(idx), 'main/index.ts mentions the pty only to register handlers and kill on quit')
  }
  const ptyIpc = read('main/terminal-ipc.ts')
  const ptySess = read('main/terminal-sessions.ts')
  assert(!touchesAgentPath(ptyIpc), 'terminal-ipc.ts never reaches the connection, cache, chat, daemon, or broadcast')
  assert(!touchesAgentPath(ptySess), 'terminal-sessions.ts never reaches the connection, cache, chat, daemon, or broadcast')
  assert(!touchesAgentPath(read('shared/terminal.ts')), 'shared/terminal.ts is agent-free')
  {
    // Phase 4: the tailnet half handles NO credential. It reads a count from ssh-add, never ~/.ssh, writes nothing.
    const tn = read('main/tailnet.ts')
    const tnImports = importsOf(tn)
    assert(tnImports.every((i) => i.startsWith('node:') || i === '@shared/tailscale' || i === './terminal-sessions'), `tailnet.ts imports only node builtins + the pure model: ${tnImports.join(', ')}`)
    assert(!touchesAgentPath(tn), 'tailnet.ts never reaches the connection, cache, chat, daemon, or broadcast')
    // The shared model may NAME passwords — in the sentence promising never to ask for one. The
    // main half, which actually runs things, may not touch files, ~/.ssh, or any key store.
    assert(!/writeFile|appendFile|readFile|\.ssh\/|safeStorage|keychain|password|passphrase/i.test(code(tn)), 'tailnet.ts never reads or writes files, never touches ~/.ssh, a keychain, or a password (comments stripped)')
    assert(!/writeFile|readFile|safeStorage|child_process|execFile|spawn\(/i.test(code(read('shared/tailscale.ts'))), 'shared/tailscale.ts is pure: no I/O, no processes')
    assert(/ssh-add', \['-l'\]/.test(tn), 'the agent is asked only to LIST (ssh-add -l), never to add or export')
  }
  const sessImports = importsOf(ptySess)
  const allowedImport = (i: string): boolean => i === 'node-pty' || i === '@shared/terminal' || i.startsWith('node:')
  assert(sessImports.includes('node-pty') && sessImports.every(allowedImport), `terminal-sessions.ts imports only node-pty, node builtins, and the shared model: ${sessImports.join(', ')}`)
  assert(guardsAllHandlers(ptyIpc), 'every terminal IPC handler checks the sender is a Beacon window main frame')
  // The guard's body moved to shell-windows.ts (2026-09-24) when it gained the shell-page check; the
  // pin follows it. shell-window-smoke tests the decision itself in both directions.
  const shellWin = code(read('main/shell-windows.ts'))
  assert(
    /return isShellSender\(e\)/.test(code(ptyIpc)) &&
      /known: adopted\.has\(wc\)/.test(shellWin) &&
      /mainFrame: frame !== null && frame === wc\.mainFrame/.test(shellWin) &&
      /frameUrl: frame\?\.url \?\? null/.test(shellWin),
    'the guard is a Beacon-window check AND a main-frame check (a rendered artifact iframe is neither) AND a shell-page check'
  )

  const all = walk(SRC)
  const rel = (f: string): string => f.slice(SRC.length + 1)
  const importers = all.filter((f) => /from ['"]node-pty['"]|require\(['"]node-pty['"]\)/.test(readFileSync(f, 'utf8'))).map(rel)
  assert(importers.length === 1 && importers[0] === 'main/terminal-sessions.ts', `node-pty is imported by exactly one file: ${importers.join(', ')}`)
  const writers = all.filter((f) => /TERMINAL_WRITE/.test(readFileSync(f, 'utf8'))).map(rel).sort()
  assert(writers.join(',') === 'main/terminal-ipc.ts,main/terminal-smoke.ts,preload/index.ts,shared/ipc.ts', `TERMINAL_WRITE is referenced only by its definition, the preload, the handler (and this smoke): ${writers.join(', ')}`)
  const preload = read('preload/index.ts')
  const pw = preload.match(/TERMINAL_WRITE/g) ?? []
  assert(pw.length === 1 && /write: \(id: string, data: string\) => ipcRenderer\.send\(IPC\.TERMINAL_WRITE, id, data\)/.test(preload), 'the preload exposes terminal.write as one fire-and-forget send and nothing else')
  const rendererWriters = all.filter((f) => f.includes('/renderer/') && /terminal\.write\(/.test(readFileSync(f, 'utf8'))).map(rel)
  assert(rendererWriters.length === 1 && rendererWriters[0] === 'renderer/src/components/TerminalPanel.tsx', `terminal.write is called from exactly one renderer file: ${rendererWriters.join(', ')}`)
  const pane = read('renderer/src/components/TerminalPanel.tsx')
  assert(/term\.onData\(\(data\) => \{ b\.terminal\.write\(id, data\) \}\)/.test(pane), 'the pane writes ONLY what xterm emitted from the keyboard/paste')
  assert(!/chat\.|events\.|daemon\.|onStream|onGateway|CHAT|GATEWAY|useChat|stream/i.test(code(pane)), 'the pane never touches chat, events, streams, or the daemon (code, comments stripped)')
  assert(!/broadcast/.test(code(ptyIpc)) && /wc\.send\(IPC\.TERMINAL_DATA/.test(ptyIpc), 'pty output goes only to the webContents that attached, never broadcast')
  {
    // Satellite hygiene (popout-window.ts, shared with the browser pane): no surface that can be
    // hosted in a satellite may window.close() itself. Checked for every renderer file under the
    // terminal and browser surfaces that exist in this tree.
    //
    // WHY ONLY THESE DIRECTORIES: a renderer window.close() destroys the window, bypassing the
    // cancelable 'close' (scripts/electron-close-semantics-probe.js). The satellite panes hold
    // something that must be detached on that cancelable path — a WebContentsView (browser) or a
    // live pty attachment (terminal) — so for them a self-close is the hang / the silent
    // destroy-and-recreate. The quick-capture box and the tray HUD also call window.close() on
    // Esc, and there it is CORRECT: they hold no view and no subscription, and a fresh window per
    // toggle is the better lifecycle. Widening this guard to them would forbid the right thing.
    const satelliteSurfaces = all.filter((f) => f.includes('/renderer/') && /\/(components\/Terminal[A-Za-z]*\.tsx|browser\/[^/]+\.tsx?)$/.test(f))
    const selfClosing = satelliteSurfaces.filter((f) => closesItself(readFileSync(f, 'utf8'))).map(rel)
    assert(satelliteSurfaces.length >= 2 && selfClosing.length === 0, `no satellite-hosted surface calls window.close() (${satelliteSurfaces.length} files checked): ${selfClosing.join(', ') || 'none'}`)
  }

  assert(sections === 3, 'all three sections ran')
  console.log(`\n[smoke] terminal: ${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`)
  process.exit(failures === 0 ? 0 : 1)
}
main().catch((e) => { console.error('[smoke] threw:', e); process.exit(1) })
