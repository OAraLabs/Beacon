/**
 * work-folder-smoke — a conversation's working folder (@shared/work-folder), headless.
 *
 *   1. loopback is only where the proof is TRIED; what proves a shared disk is Prometheus seeing
 *      a folder Beacon just made;
 *   2. how a folder is shown;
 *   3. which folders are refused as "everything", and which pass (on the REAL path);
 *   4. the header chip: bound, none, could-not-check, and nothing only when there is nothing to check;
 *   5. the words before a folder is set (everything setting it does), after, and when it fails;
 *   6. the call sites go through these rules. What the app then does is the probe's to show.
 *
 * Run: npm run build && npm run smoke:work-folder
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { elsewhereWords, folderChip, folderConfirm, folderDisplay, folderFailure, folderName, folderProblem, folderSetWords, hereVerdict, isThisComputer, otherComputerName, readFailureKind, type FolderRead } from '@shared/work-folder'

const MIN_CHECKS = 130
let checks = 0
let failures = 0
function check(cond: boolean, name: string, detail = ''): void {
  checks++
  if (cond) console.log(`  ✓ ${name}`)
  else {
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`)
    failures++
  }
}
process.on('exit', () => {
  console.log('===================== RESULT =====================')
  if (failures === 0 && checks < MIN_CHECKS) {
    console.error(`work-folder smoke: FAIL ✗ (only ${checks} of at least ${MIN_CHECKS} checks ran)`)
    process.exitCode = 1
  } else if (failures > 0) {
    console.error(`work-folder smoke: FAIL ✗ (${failures} of ${checks})`)
    process.exitCode = 1
  } else console.log(`work-folder smoke: PASS ✓ (${checks} checks: shared-disk proof, display, refused folders, chip, words, wiring)`)
})

const HOME = '/home/demo'

console.log('1. is Prometheus on this computer')
for (const yes of ['http://127.0.0.1:8005', 'http://localhost:8005', 'https://localhost:8006', 'http://[::1]:8005', 'http://LOCALHOST:8005']) check(isThisComputer(yes), `${yes} is this computer`)
for (const no of ['http://192.168.1.20:8005', 'http://my-computer.local:8005', 'https://example.com', 'http://localhost.example.com:8005', 'http://127.0.0.1.example.com', 'http://10.0.0.5:8005', 'not a url', '', null, undefined]) {
  check(!isThisComputer(no as string | null | undefined), `${JSON.stringify(no)} is not taken for this computer`)
}

{
  const M = '/private/var/folders/xx/T/beacon-here-AbC123'
  check(hereVerdict({ ok: true, sent: M, answered: M }) === 'here', 'Prometheus accepted the folder Beacon just made, and named it back: one disk')
  check(hereVerdict({ ok: true, sent: M, answered: `${M}/` }) === 'here', 'a trailing slash is the same folder')
  check(hereVerdict({ ok: true, sent: M, answered: '/somewhere/else' }) === 'unknown', 'it named a DIFFERENT folder back: nothing is proved')
  check(hereVerdict({ ok: true, sent: M, answered: null }) === 'unknown' && hereVerdict({ ok: true, sent: M, answered: undefined }) === 'unknown', 'it named nothing back: nothing is proved')
  const W = "Error invoking remote method 'daemon:write': Error: "
  check(hereVerdict({ ok: false, message: `HTTP 400: PUT /api/sessions/x/workspace — {"error":"${M} is not an existing directory"}` }) === 'elsewhere', 'it could not see the folder: reached through this computer, but no shared disk (a tunnel, a container)')
  check(hereVerdict({ ok: false, message: `${W}HTTP 400: PUT /api/sessions/x/workspace — {"error":"${M} is not an existing directory"}` }) === 'elsewhere', "the same through Electron's wrapper")
  check(hereVerdict({ ok: false, message: 'HTTP 400: PUT /api/sessions/x/workspace — {"error":"path is under a denied path"}' }) === 'unknown', 'refused for another reason proves nothing either way')
  for (const m of ['HTTP 403: PUT /api/sessions/x/workspace — {}', 'HTTP 503: PUT /api/sessions/x/workspace — {"error":"no durable store"}', 'fetch failed', 'HTTP 404: PUT /api/sessions/x/workspace — Not Found']) {
    check(hereVerdict({ ok: false, message: m }) === 'unknown', `"${m.slice(0, 40)}" proves nothing: the picker is not offered on a guess`)
  }
  check(otherComputerName('Local') === '' && otherComputerName(' local ') === '' && otherComputerName('Studio') === 'Studio' && otherComputerName(null) === '', '"Local" is never used as another computer\'s name (it would read as this one)')
}

console.log('2. how a folder is shown')
check(folderDisplay('/home/demo/Documents/Taxes 2026', HOME) === '~/Documents/Taxes 2026', 'the home folder is ~')
check(folderDisplay('/home/demo', HOME) === '~' && folderDisplay('/home/demo/', HOME) === '~', 'home itself is ~, with or without a trailing slash')
check(folderDisplay('/home/demonstration/x', HOME) === '/home/demonstration/x', 'a folder that only starts like home is left alone')
check(folderDisplay('/srv/work', HOME) === '/srv/work' && folderDisplay('/srv/work', null) === '/srv/work', 'a folder outside home, or with no home known, is shown whole')
check(folderName('/home/demo/Documents/Taxes 2026/') === 'Taxes 2026' && folderName('/') === '/' && folderName('/srv') === 'srv', 'the chip shows the folder\'s own name')

console.log('3. which folders are refused')
for (const [p, why] of [
  ['/', 'the whole disk'],
  ['/home/demo', 'the whole home folder'],
  ['/home/demo/', 'the whole home folder, with a slash'],
  ['/home', 'the folder that holds home'],
  ['/Users', 'the folder of all users'],
  ['/System/Library', 'a system folder'],
  ['/usr/local/bin', 'a system folder'],
  ['/etc', 'a system folder'],
  ['/Applications/Beacon.app', 'an application'],
  ['/home/someone-else/Documents', "another person's home"],
  ['/Users/someone-else', "another person's whole folder"],
  ['/home/demo/.ssh', 'the keys folder'],
  ['/home/demo/.prometheus/workspace', "Prometheus's own folder"],
  ['/home/demo/.config/app', 'a hidden settings folder'],
  ['/home/demo/Library/Application Support', 'the Library folder'],
  ['/home/demo/library', 'the Library folder in any case'],
  ['/home/demo/Library/CloudStorage', 'the cloud-storage root'],
  ['/home/demo/Library/CloudStorage/Provider-Name', 'a whole cloud drive'],
  ['/home/demo/Library/Mobile Documents/com~apple~CloudDocs', 'a whole cloud drive'],
  ['/Volumes', 'where disks are mounted'],
  ['/Volumes/Backup', 'a whole disk'],
  ['/media/demo', "a person's removable disks"],
  ['/mnt', 'the mount folder'],
  ['/mnt/data', 'a whole mounted disk'],
  ['/run/user/1000', 'the session sockets'],
  ['/lib/modules', 'a system folder'],
  ['/snap/core', 'a system folder'],
  ['/srv', 'a top-level folder of the disk'],
  ['/opt', 'a top-level folder of the disk'],
  ['/tmp', 'a top-level folder of the disk'],
  ['/home/demo/Documents/..', 'a path with .. in it'],
  ['/home/demo/Documents/../.ssh', 'a path that climbs out with ..'],
  ['/home/demo/./Documents', 'a path with . in it'],
  ['/home/demo//Documents', 'a path with an empty part'],
  ['/home/demo/Documents ', 'a name ending in a space (Prometheus would drop it and mean another folder)'],
  [' /home/demo/Documents', 'a path starting with a space'],
  ['relative/path', 'a path that is not absolute'],
  ['', 'nothing']
] as const) {
  check(folderProblem(p, HOME) !== '', `${JSON.stringify(p)} is refused: ${why}`)
}
for (const p of [
  '/home/demo/Documents',
  '/home/demo/Documents/Taxes 2026',
  '/home/demo/Desktop/site',
  '/home/demo/projects/.hidden-inside-a-project',
  '/home/demo/Library Books',
  '/home/demo/Downloads/',
  '/home/demo/a\\b',
  '/home/demo/Library/CloudStorage/Provider-Name/Work',
  '/home/demo/Library/Mobile Documents/com~apple~CloudDocs/Notes',
  '/srv/work',
  '/opt/site',
  '/tmp/scratch',
  '/mnt/data/reports',
  '/media/demo/USB/photos',
  '/Volumes/Backup/project',
  '/Users/Shared/team'
]) {
  check(folderProblem(p, HOME) === '', `${p} passes`, folderProblem(p, HOME))
}
check(/whole home folder/.test(folderProblem(HOME, HOME)) && /whole disk/.test(folderProblem('/', HOME)) && /settings and keys/.test(folderProblem('/home/demo/.ssh', HOME)) && /whole disk/.test(folderProblem('/Volumes/Backup', HOME)) && /cloud-storage/.test(folderProblem('/home/demo/Library/CloudStorage/Provider-Name', HOME)), 'each refusal says which kind of "too much" it is')
check(folderProblem('/srv/work', null) === '' && folderProblem('/', null) !== '' && folderProblem('/usr', null) !== '', 'with no home known, the disk and system folders are still refused')
check(folderProblem('/home/demo/Documents', null) !== '', "and a folder under the homes cannot be told from another person's, so it is refused")
check(folderProblem('/home/demo/a\\..\\.ssh', HOME) === '', 'a backslash is an ordinary character in a name here: it is not rewritten into a way up')
check(folderProblem(42 as unknown as string, HOME) !== '', 'something that is not a path at all is refused')

console.log('4. the header chip')
{
  const ok = (ws: Record<string, unknown>): FolderRead => ({ kind: 'ok', ws })
  check(folderChip({ kind: 'asking' }, HOME, true, '').state === 'hidden', 'before Prometheus answers: nothing is drawn')
  check(folderChip({ kind: 'absent' }, HOME, true, '').state === 'hidden', 'an older Prometheus with no such route: nothing is drawn')
  const none = folderChip(ok({ source: 'daemon', workspace: '/home/demo/.prometheus/workspace' }), HOME, true, '')
  check(none.state === 'none' && none.text === 'No folder' && none.path === null, "Prometheus's own default is not shown as a folder this conversation works in")
  check(folderChip(ok({ source: 'session', workspace: '  ' }), HOME, true, '').state === 'none', 'a blank bound folder is none')
  const here = folderChip(ok({ source: 'session', workspace: '/home/demo/Documents/Taxes 2026' }), HOME, true, '')
  check(here.state === 'bound' && here.text === 'Taxes 2026' && here.path === '/home/demo/Documents/Taxes 2026', 'a bound folder shows its name')
  check(here.title === 'Your assistant is working in ~/Documents/Taxes 2026, on this computer.', 'and its full line says where, in ~ form', here.title)
  const there = folderChip(ok({ source: 'session', workspace: '/home/op/reports' }), HOME, false, 'Studio')
  check(there.state === 'bound' && there.title === 'Your assistant is working in /home/op/reports, on Studio.', 'a folder on another computer is shown whole, and says which computer', there.title)
  check(folderChip(ok({ source: 'session', workspace: '/home/demo/x' }), HOME, false, 'Studio').title.includes('/home/demo/x'), "the ~ of THIS computer is never applied to another computer's path")
  check(/on the Prometheus computer/.test(folderChip(ok({ source: 'session', workspace: '/srv/x' }), HOME, false, '').title), 'with no name for the other computer it still says it is elsewhere')
  check(folderChip(ok({ source: 'session', path: '/srv/a' }), HOME, true, '').path === '/srv/a' && folderChip(ok({ source: 'session', cwd: '/srv/b' }), HOME, true, '').path === '/srv/b', 'older field names for the bound folder are read')
  for (const bad of [[] as unknown, { workspace: '/x' }, { source: 7 }]) {
    check(folderChip({ kind: 'ok', ws: bad as Record<string, unknown> }, HOME, true, '').state === 'hidden', `an answer that is not the shape Prometheus gives (${JSON.stringify(bad)}) is not shown as "No folder"`)
  }
  // "Always shown": a check that fails after the folder was known does not make the chip go away.
  const lost = folderChip({ kind: 'failed', last: { source: 'session', workspace: '/home/demo/Documents/Taxes 2026' } }, HOME, true, '')
  check(lost.state === 'unknown' && lost.text === 'Taxes 2026?' && lost.path === '/home/demo/Documents/Taxes 2026', 'a failed check after a known folder keeps the folder, marked as unchecked')
  check(/could not check/.test(lost.title) && /last working in ~\/Documents\/Taxes 2026, on this computer/.test(lost.title), 'and says both that it could not check and what it last knew', lost.title)
  const never = folderChip({ kind: 'failed', last: null }, HOME, true, '')
  check(never.state === 'unknown' && never.text === 'Folder?' && /could not check/.test(never.title) && !/last working/.test(never.title), 'a failed check with nothing known says only that it could not check')
  check(folderChip({ kind: 'failed', last: { source: 'daemon' } }, HOME, true, '').text === 'Folder?', 'and does not turn "no folder, last time" into a claim')
  check(readFailureKind('HTTP 404: GET /api/sessions/x/workspace') === 'absent' && readFailureKind("Error invoking remote method 'daemon:get': Error: HTTP 403: GET /x") === 'absent', 'no such route, or not this Beacon\'s to read: there is nothing to check')
  for (const m of ['fetch failed', 'HTTP 500: GET /x', 'HTTP 503: GET /x', 'timeout', '']) check(readFailureKind(m) === 'failed', `"${m}" is "could not check just now"`)
}

console.log('5. the words')
{
  const c = folderConfirm('/home/demo/Documents/Taxes 2026', HOME)
  const all = [c.title, c.body, ...c.does, c.after].join(' ')
  check(c.title === 'Let your assistant work in ~/Documents/Taxes 2026?', 'the question names the folder')
  check(/this conversation/.test(all) && /next reply/.test(all), 'it says where it applies, and from when')
  // Each thing binding a workspace does in Prometheus, said in words (checked against the daemon).
  check(/change and delete files in this folder without asking you each time/.test(all), 'it says changes and deletions there stop asking')
  check(/run commands there/.test(all), 'that commands run there')
  check(/instruction files/.test(all) && /PROMETHEUS\.md/.test(all) && /trust/.test(all), 'that instruction files found there are followed, so the folder has to be trusted')
  check(/keep a copy/.test(all) && /undone/.test(all), 'that a copy is kept each turn for undo')
  check(/the one place this conversation writes without asking/.test(all), 'that it replaces where the conversation wrote before, not adds to it')
  check(/Nothing outside the folder is opened/.test(all) && /no other conversation is changed/.test(all), 'and what it does not do')
  check(c.does.length === 4 && !/will be able to read/.test(all), 'it does not present reading as something newly granted (reading was never confined)')
  const ok = folderSetWords('/home/demo/Documents', '/home/demo/Documents', HOME)
  check(ok.ok && !ok.mismatch && /now works in ~\/Documents, from its next reply/.test(ok.words), 'a set that landed on the folder agreed to says so')
  check(folderSetWords('/home/demo/Documents', '/home/demo/Documents/', HOME).ok, 'a trailing slash is the same folder')
  check(/Files and Folders/.test(ok.words), "and says what to do if the computer won't let Prometheus in")
  const other = folderSetWords('/home/demo/link', '/mnt/real/place', HOME)
  check(other.ok === false && other.mismatch === true && /different folder \(\/mnt\/real\/place\)/.test(other.words) && /taken it back/.test(other.words), 'when Prometheus bound a DIFFERENT folder than the one agreed to, that is not a success: it is taken back and said')
  for (const r of [null, undefined, '', '  ']) {
    const w = folderSetWords('/x/y', r as string | null | undefined, HOME)
    check(w.ok === false && w.mismatch === false, `a set Prometheus answered with ${JSON.stringify(r)} is not claimed, and there is nothing to take back`)
  }
  const W = "Error invoking remote method 'daemon:write': Error: "
  check(/not allowed/.test(folderFailure(`${W}HTTP 403: PUT /api/sessions/x/workspace — {"error":"operator_only"}`)), 'a 403 says this Beacon is not allowed')
  check(/too old/.test(folderFailure(`${W}HTTP 404: PUT /api/sessions/x/workspace — Not Found`)), 'a 404 says Prometheus is too old')
  check(folderFailure(`${W}HTTP 400: PUT /api/sessions/x/workspace — {"error":"not a directory: /home/demo/file.txt"}`) === 'Prometheus did not accept that folder: not a directory: /home/demo/file.txt', "any other refusal is Prometheus's reason")
  check(/could not reach Prometheus/.test(folderFailure(`${W}fetch failed`)) && /Nothing has changed/.test(folderFailure('')), 'no answer says nothing changed')
  for (const m of [`${W}HTTP 403: PUT /api/sessions/x/workspace — {}`, `${W}HTTP 500: PUT /api/sessions/x/workspace — boom`, `${W}fetch failed`]) {
    check(!/HTTP \d|\/api\/|remote method/.test(folderFailure(m)), 'no status line, route or IPC wrapper reaches the words')
  }
  check(/Prometheus runs on Studio/.test(elsewhereWords('Studio')) && /\/workspace/.test(elsewhereWords('Studio')) && /another computer/.test(elsewhereWords('')), 'elsewhere: it says why there is no picker, and the way that does work')
  check(/through this computer/.test(elsewhereWords('', 'tunnel')) && /tunnel, a container/.test(elsewhereWords('', 'tunnel')) && /\/workspace/.test(elsewhereWords('', 'tunnel')), 'a tunnel is said to be one: reached through this computer, without its folders')
  check(/could not check/.test(elsewhereWords('', 'unknown')) && /will not offer/.test(elsewhereWords('', 'unknown')), 'when it could not be checked, it says so, and that it will not guess')
}

console.log('6. the call sites go through the rules')
// These only pin that main and the chip USE the rules tested above, in the order that matters.
// That a link to the home folder is refused, that a tunnel gets no picker, and that the set is one
// PUT of the confirmed path, are shown by the probe against a stand-in Prometheus.
{
  const read = (p: string): string => readFileSync(join(process.cwd(), p), 'utf8')
  const main = read('src/main/index.ts')
  const pick = main.slice(main.indexOf('handleFromShell(IPC.WORK_FOLDER_PICK'), main.indexOf('// Files handed over by the system') > 0 ? main.indexOf('// Files handed over by the system') : main.indexOf('// Only the quick-capture window may hold itself up'))
  const at = (needle: string): number => pick.indexOf(needle)
  check(at("if ((await proveHere()) !== 'here') return { kind: 'not-here' }") > 0 && at("if ((await proveHere()) !== 'here') return { kind: 'not-here' }") < at('showOpenDialog'), 'main refuses the picker, before opening it, unless a shared disk was proved')
  check(at('realpathSync(res.filePaths[0])') > at('showOpenDialog') && at('folderProblem(real, realHome())') > at('realpathSync(res.filePaths[0])'), 'what was picked is resolved to its real path, and THAT is what is checked')
  check(/return problem \? \{ kind: 'refused', words: problem \} : \{ kind: 'picked', path: real \}/.test(pick), 'and only the real path is ever handed to the page')
  check(/properties: \['openDirectory', 'createDirectory'\]/.test(pick) && !/openFile|multiSelections/.test(pick) && !/readFileSync|readdir|writeFile/.test(pick), 'the picker picks one folder, and main reads nothing in it')
  const prove = main.slice(main.indexOf('const proveHere = async'), main.indexOf('const realHome = '))
  check(/if \(!apiBase \|\| !isThisComputer\(apiBase\)\) return 'elsewhere'/.test(prove) && /hereVerdict\(\{ ok: true, sent: marker, answered: r\?\.workspace \}\)/.test(prove), 'the proof is tried only over loopback, and judged by hereVerdict')
  check(/finally \{[\s\S]*'DELETE'[\s\S]*rmSync\(marker/.test(prove), "the throwaway binding is taken back and the marker folder removed, whatever the answer")
  check(/if \(verdict === 'unknown'\) return 'unknown'/.test(prove) && prove.indexOf("if (verdict === 'unknown') return 'unknown'") < prove.indexOf('hereProof.set('), 'an answer that proves nothing is not remembered')
  const chip = read('src/renderer/src/components/WorkFolderChip.tsx')
  check(!/folderProblem/.test(chip), 'the page does not run the folder check itself: main already did, on the real path')
  check(/const set = async[\s\S]*?daemon\.write\(route, bindBody\(confirmed\), 'PUT'\)/.test(chip) && (chip.match(/bindBody\(/g) ?? []).length === 1 && (chip.match(/[^a-zA-Z]set\(\(step as/g) ?? []).length === 1, 'the folder is set by one PUT in one function, called from the confirmation alone')
  check(/if \(outcome\.mismatch\) await b\.daemon\.write\(route, undefined, 'DELETE'\)/.test(chip), 'a folder Prometheus resolved differently is taken back')
  check(/if \(mine !== seq\.current\) return/.test(chip), 'an older read that lands late is dropped')
  check(/s\.state === 'connected'\) void reread\(\)/.test(chip) && /addEventListener\(WORKSPACE_CHANGED, onChanged\)/.test(chip), 'it reads again when the connection comes back and when the folder is changed elsewhere')
  check(/announceWorkspaceChanged\(target\)/.test(read('src/renderer/src/components/CheckpointsPanel.tsx')), 'the Checkpoints panel says when it changes the folder')
  const shell = read('src/renderer/src/components/ChatShell.tsx')
  check(/\{limited \|\| !roleHeard \? null : <WorkFolderChip sessionId=\{sessionId\}/.test(shell), "the chip is in every conversation's header, except on an approved device or before the role is known")
}
