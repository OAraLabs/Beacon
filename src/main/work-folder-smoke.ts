/**
 * work-folder-smoke — a conversation's working folder (@shared/work-folder), headless.
 *
 *   1. when Prometheus counts as being on this computer (loopback only);
 *   2. how a folder is shown;
 *   3. which folders are refused as "everything", and which pass;
 *   4. the header chip: bound, none, and nothing when nothing can be said;
 *   5. the words before a folder is set, after, and when it fails;
 *   6. main decides where Prometheus is, and the call sites go through these rules.
 *
 * Run: npm run build && npm run smoke:work-folder
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { elsewhereWords, folderChip, folderConfirm, folderDisplay, folderFailure, folderName, folderProblem, folderSetWords, isThisComputer } from '@shared/work-folder'

const MIN_CHECKS = 70
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
  } else console.log(`work-folder smoke: PASS ✓ (${checks} checks: this computer, display, refused folders, chip, words, wiring)`)
})

const HOME = '/home/demo'

console.log('1. is Prometheus on this computer')
for (const yes of ['http://127.0.0.1:8005', 'http://localhost:8005', 'https://localhost:8006', 'http://[::1]:8005', 'http://LOCALHOST:8005']) check(isThisComputer(yes), `${yes} is this computer`)
for (const no of ['http://192.168.1.20:8005', 'http://my-computer.local:8005', 'https://example.com', 'http://localhost.example.com:8005', 'http://127.0.0.1.example.com', 'http://10.0.0.5:8005', 'not a url', '', null, undefined]) {
  check(!isThisComputer(no as string | null | undefined), `${JSON.stringify(no)} is not taken for this computer`)
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
  ['/home/demo/.ssh', 'the keys folder'],
  ['/home/demo/.prometheus/workspace', "Prometheus's own folder"],
  ['/home/demo/.config/app', 'a hidden settings folder'],
  ['/home/demo/Library/Application Support', 'the Library folder'],
  ['/home/demo/library', 'the Library folder in any case'],
  ['relative/path', 'a path that is not absolute'],
  ['', 'nothing']
] as const) {
  check(folderProblem(p, HOME) !== '', `${JSON.stringify(p)} is refused: ${why}`)
}
for (const p of ['/home/demo/Documents', '/home/demo/Documents/Taxes 2026', '/home/demo/Desktop/site', '/home/demo/projects/.hidden-inside-a-project', '/home/demo/Library Books', '/srv/work', '/mnt/data/reports', '/home/demo/Downloads/']) {
  check(folderProblem(p, HOME) === '', `${p} passes`, folderProblem(p, HOME))
}
check(/whole home folder/.test(folderProblem(HOME, HOME)) && /whole disk/.test(folderProblem('/', HOME)) && /settings and keys/.test(folderProblem('/home/demo/.ssh', HOME)), 'each refusal says which kind of "too much" it is')
check(folderProblem('/srv/work', null) === '' && folderProblem('/', null) !== '' && folderProblem('/usr', null) !== '', 'with no home known, the disk and system folders are still refused')
check(folderProblem('/home/demo/Documents', null) !== '', "and a folder under the homes cannot be told from another person's, so it is refused")

console.log('4. the header chip')
{
  check(folderChip(undefined, HOME, true, '').state === 'hidden', 'before Prometheus answers: nothing is drawn')
  check(folderChip(null, HOME, true, '').state === 'hidden', 'an older Prometheus with no such route: nothing is drawn')
  const none = folderChip({ source: 'daemon', workspace: '/home/demo/.prometheus/workspace' }, HOME, true, '')
  check(none.state === 'none' && none.text === 'No folder' && none.path === null, "Prometheus's own default is not shown as a folder this conversation works in")
  check(folderChip({ source: 'session', workspace: '  ' }, HOME, true, '').state === 'none', 'a blank bound folder is none')
  const here = folderChip({ source: 'session', workspace: '/home/demo/Documents/Taxes 2026' }, HOME, true, '')
  check(here.state === 'bound' && here.text === 'Taxes 2026' && here.path === '/home/demo/Documents/Taxes 2026', 'a bound folder shows its name')
  check(here.title === 'Your assistant is working in ~/Documents/Taxes 2026, on this computer.', 'and its full line says where, in ~ form', here.title)
  const there = folderChip({ source: 'session', workspace: '/home/op/reports' }, HOME, false, 'Studio')
  check(there.state === 'bound' && there.title === 'Your assistant is working in /home/op/reports, on Studio.', 'a folder on another computer is shown whole, and says which computer', there.title)
  check(folderChip({ source: 'session', workspace: '/home/demo/x' }, HOME, false, 'Studio').title.includes('/home/demo/x'), "the ~ of THIS computer is never applied to another computer's path")
  check(/on the Prometheus computer/.test(folderChip({ source: 'session', workspace: '/srv/x' }, HOME, false, '').title), 'with no name for the other computer it still says it is elsewhere')
  check(folderChip({ source: 'session', path: '/srv/a' }, HOME, true, '').path === '/srv/a' && folderChip({ source: 'session', cwd: '/srv/b' }, HOME, true, '').path === '/srv/b', 'older field names for the bound folder are read')
}

console.log('5. the words')
{
  const c = folderConfirm('/home/demo/Documents/Taxes 2026', HOME)
  check(c.title === 'Let your assistant work in ~/Documents/Taxes 2026?', 'the question names the folder')
  check(/read, change and delete files/.test(c.body) && /this conversation/.test(c.body) && /next reply/.test(c.body) && /Nothing outside the folder/.test(c.body), 'and says what is granted, where, from when, and what is not')
  const ok = folderSetWords('/home/demo/Documents', '/home/demo/Documents', HOME)
  check(ok.ok && /now works in ~\/Documents, from its next reply/.test(ok.words) && !/leads there/.test(ok.words), 'a set that landed says so')
  check(/Files and Folders/.test(ok.words), "and says what to do if the computer won't let Prometheus in")
  const linked = folderSetWords('/home/demo/link', '/mnt/real/place', HOME)
  check(linked.ok && /now works in \/mnt\/real\/place \(the folder you chose leads there\)/.test(linked.words), 'when Prometheus resolved it elsewhere, the real folder is the one named')
  for (const r of [null, undefined, '', '  ']) check(folderSetWords('/x/y', r as string | null | undefined, HOME).ok === false, `a set Prometheus answered with ${JSON.stringify(r)} is not claimed`)
  const W = "Error invoking remote method 'daemon:write': Error: "
  check(/not allowed/.test(folderFailure(`${W}HTTP 403: PUT /api/sessions/x/workspace — {"error":"operator_only"}`)), 'a 403 says this Beacon is not allowed')
  check(/too old/.test(folderFailure(`${W}HTTP 404: PUT /api/sessions/x/workspace — Not Found`)), 'a 404 says Prometheus is too old')
  check(folderFailure(`${W}HTTP 400: PUT /api/sessions/x/workspace — {"error":"not a directory: /home/demo/file.txt"}`) === 'Prometheus did not accept that folder: not a directory: /home/demo/file.txt', "any other refusal is Prometheus's reason")
  check(/could not reach Prometheus/.test(folderFailure(`${W}fetch failed`)) && /Nothing has changed/.test(folderFailure('')), 'no answer says nothing changed')
  for (const m of [`${W}HTTP 403: PUT /api/sessions/x/workspace — {}`, `${W}HTTP 500: PUT /api/sessions/x/workspace — boom`, `${W}fetch failed`]) {
    check(!/HTTP \d|\/api\/|remote method/.test(folderFailure(m)), 'no status line, route or IPC wrapper reaches the words')
  }
  check(/Prometheus runs on Studio/.test(elsewhereWords('Studio')) && /\/workspace/.test(elsewhereWords('Studio')) && /another computer/.test(elsewhereWords('')), 'elsewhere: it says why there is no picker, and the way that does work')
}

console.log('6. main decides, and the call sites use the rules')
{
  const read = (p: string): string => readFileSync(join(process.cwd(), p), 'utf8')
  const main = read('src/main/index.ts')
  const pick = main.slice(main.indexOf('handleFromShell(IPC.WORK_FOLDER_PICK'), main.indexOf('// Only the quick-capture window may hold itself up'))
  check(pick.length > 0 && pick.indexOf("if (!prometheusIsHere()) return { kind: 'not-here' }") > 0 && pick.indexOf("if (!prometheusIsHere()) return { kind: 'not-here' }") < pick.indexOf('showOpenDialog'), 'main refuses the picker before opening it when Prometheus is not on this computer')
  check(/const prometheusIsHere = \(\): boolean => isThisComputer\(repo\?\.getDefaultGatewayProfile\(\)\?\.apiBase\)/.test(main), 'and decides that from the connection it holds, never from what the page says')
  check(/properties: \['openDirectory', 'createDirectory'\]/.test(pick) && !/openFile|multiSelections/.test(pick), 'the picker picks one folder, never files')
  check(!/readFileSync|readdir|writeFile/.test(pick), 'main reads nothing from the folder: it only names what the person chose')
  const chip = read('src/renderer/src/components/WorkFolderChip.tsx')
  check(chip.indexOf('folderProblem(picked.path, home)') > 0 && chip.indexOf('folderProblem(picked.path, home)') < chip.indexOf("setStep({ kind: 'confirm'"), 'a picked folder is checked before it can reach the confirmation')
  check(/const set = async[\s\S]*?daemon\.write\(path, bindBody\(chosen\), 'PUT'\)/.test(chip) && (chip.match(/void set\(/g) ?? []).length === 1 && /className="work-folder-btn is-primary" onClick=\{\(\) => void set\(/.test(chip), "the folder is set from one place only: the confirmation's own button")
  check(/if \(chip\.state === 'hidden'\) return null/.test(chip), 'nothing is drawn until there is something true to say')
  const shell = read('src/renderer/src/components/ChatShell.tsx')
  check(/\{limited \? null : <WorkFolderChip sessionId=\{sessionId\}/.test(shell), "the chip is in every conversation's header, except on an approved device")
}
