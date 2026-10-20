/**
 * Loop Manager smoke (headless / ELECTRON_RUN_AS_NODE). Proves the PURE core the board rides on —
 * TASKS.md parse + byte-faithful write-back, LOOP.md → /api/code compilation, registry sanitation,
 * the confined-fs guards, and that a launched run's WS events route to the right project by
 * session_id. Real behavior, no mocks: run with `npm run smoke:loop`.
 */
import {
  addTask,
  codingSessionId,
  compilePayload,
  contractPickerEntries,
  parseLoopContract,
  parseTasks,
  removeTask,
  sanitizeProjects,
  setTaskDone,
  taskRatio,
  DEFAULT_LOOP_MD,
  extractDaemonError
} from '@shared/loop'
import { reduceCodingRuns, type CodingRuns } from '@shared/coding'
import { isAllowedProjectFile, isWithinRoot } from './loop-fs'

let failures = 0
function assert(cond: boolean, label: string): void {
  console.log(`[smoke] ${cond ? 'PASS' : 'FAIL'}  ${label}`)
  if (!cond) failures++
}

// A realistic TASKS.md with a heading, blank lines, two task states, a tag, and a non-task note.
const TASKS = `# Project tasks

- [ ] Build the parser [Core]
- [x] Write the spec
- [ ] Fix the off-by-one

Notes: the lines above and below tasks must survive verbatim.
`

// ── 1. parse ──────────────────────────────────────────────────────────────────
const parsed = parseTasks(TASKS)
assert(parsed.tasks.length === 3, 'parseTasks finds 3 tasks')
assert(parsed.tasks[0].text === 'Build the parser' && parsed.tasks[0].tag === 'Core', 'tag stripped to a field')
assert(parsed.tasks[0].done === false && parsed.tasks[1].done === true, 'checkbox state read')
assert(taskRatio(parsed.tasks).done === 1 && taskRatio(parsed.tasks).total === 3, 'taskRatio 1/3')

// ── 2. byte-faithful round-trips ───────────────────────────────────────────────
assert(parsed.lines.join('\n') === TASKS, 'split/join reproduces the file byte-for-byte')

const toggled = setTaskDone(TASKS, parsed.tasks[0].lineIndex, true)
assert(toggled.includes('- [x] Build the parser [Core]'), 'toggle flips only the checkbox, keeps text + tag')
assert(toggled.split('\n').length === TASKS.split('\n').length, 'toggle changes no other line count')
const back = setTaskDone(toggled, parsed.tasks[0].lineIndex, false)
assert(back === TASKS, 'toggle round-trip restores original bytes')

// non-task lines preserved on toggle
assert(
  toggled.includes('Notes: the lines above and below tasks must survive verbatim.') &&
    toggled.startsWith('# Project tasks'),
  'toggle preserves heading + trailing note verbatim'
)

// ── 3. add / remove ────────────────────────────────────────────────────────────
const added = addTask(TASKS, 'A new task', 'Later')
const addedParsed = parseTasks(added)
assert(addedParsed.tasks.length === 4, 'addTask yields 4 tasks')
assert(addedParsed.tasks[3].text === 'A new task' && addedParsed.tasks[3].tag === 'Later', 'added task parses back')
assert(added.includes('Notes: the lines above'), 'addTask preserves the trailing note')

const removed = removeTask(TASKS, parsed.tasks[1].lineIndex)
const removedParsed = parseTasks(removed)
assert(removedParsed.tasks.length === 2, 'removeTask yields 2 tasks')
assert(!removed.includes('Write the spec'), 'removeTask drops exactly that line')
assert(removed.includes('Build the parser') && removed.includes('Fix the off-by-one'), 'removeTask keeps the others')

// blank text is a no-op
assert(addTask(TASKS, '   ') === TASKS, 'addTask blank text is a no-op')
assert(setTaskDone(TASKS, 0, true) === TASKS, 'setTaskDone on a non-task line (the heading) is a no-op')

// ── 4. LOOP.md contract + compile ──────────────────────────────────────────────
const contract = parseLoopContract(DEFAULT_LOOP_MD)
assert(contract.acceptanceCommand === 'PYTHONPATH=src python3 -m pytest -q', 'acceptance parsed')
assert(contract.maxRounds === 30 && contract.maxWallSeconds === 1200, 'rounds + wall parsed')
assert(!!contract.conventions && contract.conventions.includes('minimal'), 'conventions parsed')

const ok = compilePayload(contract, 'Implement feature X', '/home/demo/proj')
assert(ok.errors.length === 0, 'compile with full contract → no errors')
assert(ok.payload.repo === '/home/demo/proj', 'payload.repo = rootPath')
assert(ok.payload.acceptance_command === contract.acceptanceCommand, 'payload.acceptance_command from done-signal')
assert(ok.payload.max_rounds === 30 && ok.payload.max_wall_seconds === 1200, 'payload caps from contract')
assert(ok.payload.description.startsWith('Match the surrounding') && ok.payload.description.includes('Implement feature X'), 'conventions prepended to description')

// defaults when the contract omits caps
const bare = parseLoopContract('Acceptance: make test')
const bareOut = compilePayload(bare, 'Task', '/repo')
assert(bareOut.payload.max_rounds === 30 && bareOut.payload.max_wall_seconds === 1200, 'missing caps fall back to engine defaults (30/1200)')

// blocking errors
const noAcc = compilePayload(parseLoopContract('# nothing machine-relevant'), 'Task', '/repo')
assert(noAcc.errors.some((e) => e.includes('Acceptance')), 'no acceptance → blocking error')
const noTask = compilePayload(contract, '   ', '/repo')
assert(noTask.errors.some((e) => e.includes('No task')), 'no task → blocking error')
const noRoot = compilePayload(contract, 'Task', '')
assert(noRoot.errors.some((e) => e.includes('No project root')), 'no root → blocking error')

// ── 5. registry sanitation ─────────────────────────────────────────────────────
const dirty = [
  { id: 'a', label: 'Proj A', rootPath: '/a', color: 'arc' },
  { id: 'b', rootPath: '/b' }, // no label → defaults to rootPath; no color → 'arc'
  { id: 'a', rootPath: '/dup' }, // duplicate id → dropped
  { label: 'no id', rootPath: '/c' }, // no id → dropped
  { id: 'd', label: 'no root' }, // no rootPath → dropped
  'garbage',
  null
]
const clean = sanitizeProjects(dirty)
assert(clean.length === 2, 'sanitizeProjects keeps only the 2 valid unique entries')
assert(clean[1].label === '/b' && clean[1].color === 'arc', 'defaults: label←rootPath, color←arc')
assert(sanitizeProjects('not an array') as unknown as unknown[] && sanitizeProjects('x').length === 0, 'non-array → []')

// ── 6. confined-fs guards (pure) ───────────────────────────────────────────────
assert(isWithinRoot('/home/demo/proj', '/home/demo/proj/TASKS.md'), 'within-root: child path ok')
assert(!isWithinRoot('/home/demo/proj', '/home/demo/other/TASKS.md'), 'within-root: sibling rejected')
assert(!isWithinRoot('/home/demo/proj', '/home/demo/proj/../etc/passwd'), 'within-root: ../ escape rejected')
assert(isAllowedProjectFile(['/home/demo/proj'], '/home/demo/proj/LOOP.md'), 'allowed: LOOP.md under root')
assert(!isAllowedProjectFile(['/home/demo/proj'], '/home/demo/proj/secrets.env'), 'allowed: non-loop basename rejected')
assert(!isAllowedProjectFile(['/home/demo/proj'], '/etc/TASKS.md'), 'allowed: loop basename outside root rejected')

// ── 7. WS routing by session_id ────────────────────────────────────────────────
const sid = codingSessionId('c12345')
assert(sid === 'coding:c12345', 'codingSessionId names the daemon stream key')
let runs: CodingRuns = {}
runs = reduceCodingRuns(runs, { type: 'coding_round', payload: { session_id: sid, round_index: 0, outcome: 'continue' } })
runs = reduceCodingRuns(runs, { type: 'coding_round', payload: { session_id: 'coding:OTHER', round_index: 0, outcome: 'continue' } })
assert(!!runs[sid] && runs[sid].rounds.length === 1, "our run's round folds under its own session key")
assert(runs[sid].rounds[0].roundIndex === 0, 'round_index captured for routing')
assert(!!runs['coding:OTHER'] && runs['coding:OTHER'] !== runs[sid], "another run's events route to a DIFFERENT key, not ours")

// NOTE: the local on-disk read/write round-trip moved to the daemon (/api/project-file) — project
// files now route through it (Loop Manager remote-files), so the Beacon side keeps only the PURE
// pre-check guards above (isWithinRoot / isAllowedProjectFile). The byte-level write/read is covered
// daemon-side by Prometheus tests/test_api_project_file.py.

// ── 8. daemon error extraction — the UI shows the daemon's SPECIFIC reason, not the HTTP string ──
assert(
  extractDaemonError('HTTP 400: PUT /api/project-file — {"error":"not a git repository (no .git): /x"}') ===
    'not a git repository (no .git): /x',
  'extractDaemonError pulls the {error} out of a write failure'
)
assert(
  extractDaemonError('HTTP 404: GET /api/project-file?repo=%2Fx — {"error":"file not found: TASKS.md"}') ===
    'file not found: TASKS.md',
  'extractDaemonError pulls the {error} out of a read failure'
)
assert(extractDaemonError('boom, no json here') === 'boom, no json here', 'extractDaemonError falls back to the raw message')

// ── 9. From-Documents picker filter — the ContractEditor browses /api/documents; only walkable
// dirs + loadable .md files may appear, dirs first ───────────────────────────────────────────────
const pickerRows = contractPickerEntries([
  { name: 'zeta.md', type: 'file' as const },
  { name: 'notes.txt', type: 'file' as const },
  { name: 'loops', type: 'dir' as const },
  { name: 'Alpha.MD', type: 'file' as const },
  { name: 'diagram.png', type: 'file' as const }
])
assert(pickerRows.length === 3, 'picker keeps dirs + .md only (txt/png filtered out)')
assert(pickerRows[0].name === 'loops' && pickerRows[0].type === 'dir', 'dirs sort ahead of files')
assert(pickerRows[1].name === 'Alpha.MD' && pickerRows[2].name === 'zeta.md', '.md match is case-insensitive; files alphabetical')
assert(contractPickerEntries(undefined).length === 0, 'a missing entries array yields an empty picker, not a crash')

console.log(`\n[smoke] loop-manager: ${failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'}`)
process.exit(failures > 0 ? 1 : 0)
