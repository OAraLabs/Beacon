/**
 * session-projects-smoke — project folders for the session sidebar, and the suggestion derived
 * from each session's tool-call paths (@shared/session-projects).
 *
 * Four parts:
 *   1. The store: create/rename/delete/assign, and a parse that survives garbage.
 *   2. The path rule: which project folder a path belongs to. Fixtures use the path shapes the
 *      real cache held on 2026-10-12 (/home/op/prometheus-deploy, ~/projects/beacon-desktop,
 *      ~/.prometheus/data, ~/android-sdk), not invented ones.
 *   3. The suggestion threshold and the grouping order (pinned > project > pseudo > recency).
 *   4. The cache query and the memo, against a real temp SQLite cache: tool_use inputs are read,
 *      tool_result bodies and malformed rows are not, and a session is re-read only when its
 *      messages changed.
 *
 * The verdict runs on process 'exit' with a minimum check count, so a section that returns early
 * fails the run instead of passing it short.
 *
 * Run: npm run build && npm run smoke:session-projects
 */
import { existsSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openCache } from './cache/db'
import { CacheRepo, type CanonicalMessage } from './cache/repo'
import { CacheService } from './cache/service'
import type { ConnectionManager } from './connection'
import {
  assignSession,
  createProject,
  deleteProject,
  dismissSuggestion,
  emptyProjectStore,
  parseProjectStore,
  projectOfPath,
  projectsInToolInput,
  renameProject,
  rowSuggestion,
  serializeProjectStore,
  suggestProject,
  tallyToolInputs,
  parseUnfiledMode,
  type ProjectStore
} from '@shared/session-projects'
import { groupSessions, projectBucket, sidebarPseudoBuckets, PINNED_BUCKET, HARNESS_BUCKET, UNFILED_BUCKET } from '@shared/session-groups'

const MIN_CHECKS = 60
let checks = 0
let failures = 0
function check(cond: boolean, label: string, detail?: string): void {
  checks += 1
  if (cond) console.log(`  ok   ${label}`)
  else {
    console.error(`  FAIL ${label}${detail ? `  (${detail})` : ''}`)
    failures += 1
  }
}
process.on('exit', () => {
  if (checks < MIN_CHECKS) {
    console.error(`\n[smoke] FAIL only ${checks} checks ran, expected at least ${MIN_CHECKS}: a section did not run`)
    process.exitCode = 1
  } else if (failures > 0) {
    console.error(`\n[smoke] FAIL ${failures} of ${checks}`)
    process.exitCode = 1
  } else console.log(`\n[smoke] PASS ${checks} checks`)
})

// ── 1. the store ─────────────────────────────────────────────────────────────
console.log('\n=== 1. store ===')
{
  let s: ProjectStore = emptyProjectStore()
  const a = createProject(s, '  Beacon   desktop ')
  check(a.id !== null && a.store.projects[0]?.name === 'Beacon desktop', 'create trims and collapses whitespace')
  s = a.store
  const twin = createProject(s, 'beacon DESKTOP')
  check(twin.id === a.id && twin.store.projects.length === 1, 'a same-name create (any case) returns the existing project, no twin')
  check(createProject(s, '   ').id === null && createProject(s, '   ').store === s, 'an empty name creates nothing')
  const b = createProject(s, 'Prometheus')
  s = b.store
  check(s.projects.map((p) => p.name).join(',') === 'Beacon desktop,Prometheus', 'projects keep creation order')

  s = assignSession(s, 'beacon:1', a.id!)
  s = assignSession(s, 'beacon:2', a.id!)
  s = assignSession(s, 'beacon:3', b.id!)
  check(s.assign['beacon:1'] === a.id && s.assign['beacon:3'] === b.id, 'assign files sessions')
  check(assignSession(s, 'beacon:4', 'nope') === s, 'assigning to an unknown project is a no-op')
  s = assignSession(s, 'beacon:2', null)
  check(!('beacon:2' in s.assign), 'assign null unfiles')

  check(renameProject(s, b.id!, 'beacon desktop') === s, 'rename onto another project’s name is refused')
  check(renameProject(s, b.id!, '') === s, 'rename to empty is refused')
  const renamed = renameProject(s, b.id!, 'Prometheus daemon')
  check(renamed.projects.find((p) => p.id === b.id)?.name === 'Prometheus daemon', 'rename changes the name, keeps the id')
  check(renamed.assign['beacon:3'] === b.id, 'rename keeps its sessions filed')

  const del = deleteProject(s, a.id!)
  check(del.projects.length === 1 && !('beacon:1' in del.assign) && del.assign['beacon:3'] === b.id, 'delete unfiles only its own sessions')

  s = dismissSuggestion(s, 'beacon:9', 'pilot')
  const round = parseProjectStore(serializeProjectStore(s))
  check(JSON.stringify(round) === JSON.stringify(s), 'serialize → parse round-trips')

  check(JSON.stringify(parseProjectStore(null)) === JSON.stringify(emptyProjectStore()), 'null → empty store')
  check(parseProjectStore('{not json').projects.length === 0, 'bad JSON → empty store, no throw')
  check(parseProjectStore('[1,2]').projects.length === 0, 'an array → empty store')
  const dirty = parseProjectStore(
    JSON.stringify({
      projects: [{ id: 'p1', name: 'A' }, { id: 'p1', name: 'B' }, { id: 'p2', name: 'a' }, { id: 'p3' }, null, { id: 'p4', name: 'D' }],
      assign: { s1: 'p1', s2: 'ghost', s3: 7, s4: 'p4' },
      dismissed: { s5: 'x', s6: 3 }
    })
  )
  check(dirty.projects.map((p) => p.id).join(',') === 'p1,p4', 'parse drops duplicate ids, duplicate names, and malformed entries', dirty.projects.map((p) => p.id).join(','))
  check(dirty.assign.s1 === 'p1' && dirty.assign.s4 === 'p4' && !('s2' in dirty.assign) && !('s3' in dirty.assign), 'parse drops assignments to missing projects and non-strings')
  check(dirty.dismissed.s5 === 'x' && !('s6' in dirty.dismissed), 'parse keeps string dismissals only')
}

// ── 2. the path rule ─────────────────────────────────────────────────────────
console.log('\n=== 2. path → project ===')
{
  const key = (p: string): string | null => projectOfPath(p)?.key ?? null
  const label = (p: string): string | null => projectOfPath(p)?.label ?? null
  check(key('/Users/op/projects/beacon-desktop/src/main/index.ts') === 'beacon-desktop', '~/projects/<x>/… → x (container skipped)')
  check(key('/home/op/prometheus-deploy/src/prometheus/__main__.py') === 'prometheus', 'prometheus-deploy folds into prometheus')
  check(label('/home/op/Prometheus/src/a.py') === 'Prometheus', 'the label keeps the folder’s own case')
  check(key('~/projects/beacon-desktop/.claude/worktrees/foo/x.ts') === 'beacon-desktop', 'a worktree inside the repo is the repo')
  check(key('/home/op/beacon-wt-3/src/a.ts') === 'beacon', 'a -wt-N checkout folds')
  check(key('/home/op/.prometheus/workspace/Officefootballpool/app.py') === 'officefootballpool', '~/.prometheus/workspace/<x> is project x')
  check(key('/home/op/.prometheus/data/cron_jobs.json') === null, '~/.prometheus/data is the agent’s home, not a project')
  check(key('/home/op/.prometheus/files/notes.md') === null, '~/.prometheus/files (the outbox) is not a project')
  check(key('/home/op/.config/oara/middleware.env') === null, 'other dot-directories are not projects')
  check(key('/home/op/android-sdk/platform-tools/adb') === null, 'a toolchain folder is not a project')
  check(key('/home/op/jdk-17/bin/java') === null, 'a jdk folder is not a project')
  check(key('/Users/op/Downloads/x.zip') === null, 'Downloads is not a project')
  check(key('/home/op/notes.md') === null, 'a file directly in home is not a project')
  check(key('/home/op/projects/README.md') === null, 'a file directly in a container is not a project')
  check(key('/home/op') === null && key('/home/op/') === null, 'home itself is not a project')
  check(key('/home/op/pilot') === 'pilot' && key('~/projects/reachout') === 'reachout', 'a bare project directory (cd target) is a project')
  check(key('/home/op/projects') === null, 'a bare container is not a project')
  check(key('/tmp/beacon/x.ts') === null && key('/etc/hosts') === null, 'paths outside home are not projects')
  check(key('relative/path/x.ts') === null, 'a relative path is not resolved')

  const bash = JSON.stringify({ command: 'cd /home/op/pilot && git status && cat ~/projects/beacon-desktop/package.json | head' })
  const hits = projectsInToolInput(bash).map((p) => p.key).sort().join(',')
  check(hits === 'beacon-desktop,pilot', 'a shell command yields every project it names', hits)
  const twice = JSON.stringify({ command: 'ls /home/op/pilot/a /home/op/pilot/b' })
  check(projectsInToolInput(twice).length === 1, 'one call naming a project twice counts it once')
  const quoted = JSON.stringify({ path: '/home/op/reachout/src/app.ts', content: 'line\n/home/op/other/x' })
  check(projectsInToolInput(quoted).map((p) => p.key).sort().join(',') === 'other,reachout', 'a path stops at an escaped newline in JSON text')
}

// ── 3. the suggestion and the grouping ───────────────────────────────────────
console.log('\n=== 3. suggestion + grouping ===')
{
  const call = (path: string): string => JSON.stringify({ path })
  const B = '/home/op/projects/beacon-desktop/src/a.ts'
  const P = '/home/op/Prometheus/src/b.py'
  const N = '/home/op/.prometheus/data/x.json'

  const clear = suggestProject(tallyToolInputs([call(B), call(B), call(B), call(P), call(N), call(N)]))
  check(clear?.key === 'beacon-desktop' && clear.calls === 4 && Math.abs(clear.share - 0.75) < 1e-9, '3 of 4 project calls → suggested at 75% (non-project calls are not in the denominator)', JSON.stringify(clear))
  check(suggestProject(tallyToolInputs([call(B), call(B)])) === null, 'fewer than 3 project calls → no suggestion')
  check(suggestProject(tallyToolInputs([call(B), call(B), call(B), call(P), call(P)]))?.key === 'beacon-desktop', 'exactly 60% (3 of 5) is suggested: the threshold is inclusive')
  check(suggestProject(tallyToolInputs([call(B), call(B), call(B), call(P), call(P), call(P), call(B), call(P)])) === null, 'a 50/50 session gets no suggestion')
  check(suggestProject(tallyToolInputs([call(B), call(B), call(P), call(P), call('/home/op/pilot/x')])) === null, 'a split with no majority gets no suggestion')
  // A real tie ABOVE the threshold: every call touches both projects (a copy between them), so each
  // has 100%. Only the tie rule stops this from naming whichever sorted first.
  const both = JSON.stringify({ command: `cp ${B} ${P}` })
  check(suggestProject(tallyToolInputs([both, both, both])) === null, 'a tie at 100% (every call touches both) gets no suggestion')
  const mixedCase = suggestProject(
    tallyToolInputs([call('/home/op/reachout/a'), call('/home/op/ReachOut/b'), call('/home/op/ReachOut/c')])
  )
  check(mixedCase?.key === 'reachout' && mixedCase.label === 'ReachOut' && mixedCase.share === 1, 'reachout + ReachOut are one project; the commoner spelling labels it', JSON.stringify(mixedCase))

  let st = createProject(emptyProjectStore(), 'Beacon-Desktop').store
  const pid = st.projects[0].id
  const hint = { key: 'beacon-desktop', label: 'beacon-desktop', share: 0.9, calls: 10 }
  const sug = rowSuggestion(st, 's1', hint)
  check(sug?.existing?.id === pid, 'a suggestion names the existing project of the same name (any case)')
  st = assignSession(st, 's1', pid)
  check(rowSuggestion(st, 's1', hint) === null, 'a filed session gets no suggestion')
  st = dismissSuggestion(st, 's2', 'beacon-desktop')
  check(rowSuggestion(st, 's2', hint) === null, 'a dismissed suggestion stays dismissed')
  check(rowSuggestion(st, 's2', { ...hint, key: 'pilot', label: 'pilot' })?.hint.key === 'pilot', 'a DIFFERENT suggestion for a dismissed session shows again')
  check(rowSuggestion(st, 's3', undefined) === null, 'no hint → no suggestion')

  // Grouping. now = noon; rows are all "today" unless shaped otherwise.
  const now = new Date(2026, 9, 12, 12, 0, 0)
  const t = now.getTime()
  const rows = [
    { id: 'beacon:a', gateway: 'beacon', lastActive: t - 1000 },
    { id: 'beacon:b', gateway: 'beacon', lastActive: t - 2000 },
    { id: 'beacon:c', gateway: 'beacon', lastActive: t - 3000 },
    { id: 'probe123', gateway: 'beacon', lastActive: t - 4000 }, // harness-shaped id
    { id: 'beacon:d', gateway: 'beacon', lastActive: t - 5000 }
  ]
  const list = [
    { id: 'p1', name: 'Beacon' },
    { id: 'p2', name: 'Empty' },
    { id: 'p3', name: 'Prometheus' }
  ]
  const assign: Record<string, string> = { 'beacon:a': 'p3', 'beacon:b': 'p1', 'beacon:d': 'p1', probe123: 'p1', 'beacon:c': 'ghost' }
  const pinnedIds = new Set(['beacon:d'])
  const g = groupSessions(rows, sidebarPseudoBuckets(), now, (r) => pinnedIds.has(r.id), { list, of: (r) => assign[r.id], keepEmpty: true })
  const order = g.map((x) => x.bucket).join(' | ')
  check(order === `${PINNED_BUCKET} | ${projectBucket('p1')} | ${projectBucket('p2')} | ${projectBucket('p3')} | Today`, 'order: Pinned, projects in the operator’s order, then recency', order)
  const p1 = g.find((x) => x.bucket === projectBucket('p1'))
  check(p1?.project?.name === 'Beacon' && p1.rows.map((r) => r.id).join(',') === 'beacon:b,probe123', 'a project holds its rows in recency order', p1?.rows.map((r) => r.id).join(','))
  check(g[0].rows.map((r) => r.id).join(',') === 'beacon:d', 'a pinned row stays in Pinned even when filed (the pin wins)')
  check(!g.some((x) => x.bucket === HARNESS_BUCKET), 'filing beats the Harness pseudo-bucket (an explicit act beats a derived one)')
  check(g.find((x) => x.bucket === 'Today')?.rows.map((r) => r.id).join(',') === 'beacon:c', 'a row filed into a project that no longer exists falls back to recency')
  check(g.find((x) => x.bucket === projectBucket('p2'))?.rows.length === 0, 'keepEmpty renders an empty project (somewhere to drop)')
  const filtered = groupSessions(rows, sidebarPseudoBuckets(), now, () => false, { list, of: (r) => assign[r.id], keepEmpty: false })
  check(!filtered.some((x) => x.bucket === projectBucket('p2')), 'without keepEmpty an empty project is omitted')
  const legacy = groupSessions(rows, sidebarPseudoBuckets(), now, () => false)
  check(!legacy.some((x) => x.project) && legacy.some((x) => x.bucket === HARNESS_BUCKET), 'with no projects passed, grouping is unchanged')
  // Unfiled as one list: the same rows the date buckets would hold, under one heading, newest first.
  const day = 86_400_000
  const spread = [
    { id: 'beacon:new', gateway: 'beacon', lastActive: t - 1000 },
    { id: 'beacon:filed', gateway: 'beacon', lastActive: t - 1500 },
    { id: 'beacon:yday', gateway: 'beacon', lastActive: t - day },
    { id: 'probe999', gateway: 'beacon', lastActive: t - 2000 }, // Harness-shaped
    { id: 'beacon:old', gateway: 'beacon', lastActive: t - 40 * day },
    { id: 'beacon:pin', gateway: 'beacon', lastActive: t - 3 * day }
  ]
  const opts = (unfiled?: 'date' | 'one') => ({ list: [{ id: 'p1', name: 'Beacon' }], of: (r: { id: string }) => (r.id === 'beacon:filed' ? 'p1' : undefined), keepEmpty: true, unfiled })
  const isPin = (r: { id: string }): boolean => r.id === 'beacon:pin'
  const one = groupSessions(spread, sidebarPseudoBuckets(), now, isPin, opts('one'))
  const oneOrder = one.map((x) => x.bucket).join(' | ')
  check(oneOrder === `${PINNED_BUCKET} | ${projectBucket('p1')} | ${UNFILED_BUCKET} | ${HARNESS_BUCKET}`, 'one list: Pinned, projects, Unfiled, then Harness (a classification stays its own group)', oneOrder)
  check(one.find((x) => x.bucket === UNFILED_BUCKET)?.rows.map((r) => r.id).join(',') === 'beacon:new,beacon:yday,beacon:old', 'Unfiled holds every unfiled row across all dates, newest first, and nothing pinned or filed', one.find((x) => x.bucket === UNFILED_BUCKET)?.rows.map((r) => r.id).join(','))
  check(!one.some((x) => ['Today', 'Yesterday', 'Earlier this week', 'Older'].includes(x.bucket)), 'one list: no date buckets alongside it')
  const byDate = groupSessions(spread, sidebarPseudoBuckets(), now, isPin, opts('date'))
  const dated = byDate.filter((x) => ['Today', 'Yesterday', 'Earlier this week', 'Older'].includes(x.bucket)).flatMap((x) => x.rows.map((r) => r.id)).join(',')
  check(dated === 'beacon:new,beacon:yday,beacon:old' && !byDate.some((x) => x.bucket === UNFILED_BUCKET), 'by date: the same three rows, spread over the date buckets, no Unfiled group', dated)
  check(JSON.stringify(groupSessions(spread, sidebarPseudoBuckets(), now, isPin, opts())) === JSON.stringify(byDate), 'unset means by date (the default is unchanged)')
  const allFiled = groupSessions([spread[1]], sidebarPseudoBuckets(), now, () => false, opts('one'))
  check(!allFiled.some((x) => x.bucket === UNFILED_BUCKET), 'an empty Unfiled group is omitted, not rendered blank')
  check(parseUnfiledMode('one') === 'one' && parseUnfiledMode('date') === 'date' && parseUnfiledMode(null) === 'date' && parseUnfiledMode('ONE') === 'date' && parseUnfiledMode('{"x":1}') === 'date', 'the setting reads only the exact value "one"; anything else is by date')
  check((projectBucket('Today') as string) !== 'Today', 'a project named like a recency bucket cannot share its collapse key')
}

// ── 4. the cache query and the memo ──────────────────────────────────────────
console.log('\n=== 4. cache: tool_use inputs + memo ===')
{
  const DB = join(tmpdir(), `beacon-session-projects-smoke-${process.pid}.db`)
  const clean = (): void => {
    for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) if (existsSync(f)) unlinkSync(f)
  }
  clean()
  const db = openCache(DB)
  try {
    const repo = new CacheRepo(db)
    const use = (id: string, name: string, input: unknown): Record<string, unknown> => ({ type: 'tool_use', id, name, input })
    const msg = (rowId: number, role: string, blocks: unknown): CanonicalMessage => ({
      rowId,
      ordinal: rowId,
      role,
      content: '',
      contentJson: typeof blocks === 'string' ? blocks : JSON.stringify(blocks)
    })
    const SID = 'beacon:projects-smoke'
    repo.ensureSession(SID, 'beacon')
    repo.reconcileSession(
      SID,
      [
        msg(1, 'assistant', [{ type: 'text', text: 'reading' }, use('t1', 'read_file', { path: '/home/op/pilot/a.py' }), use('t2', 'read_file', { path: '/home/op/pilot/b.py' })]),
        // A tool_result whose BODY names another project: must not count. It is the file's contents.
        msg(2, 'user', [{ type: 'tool_result', tool_use_id: 't1', content: 'see /home/op/Prometheus/src/x.py and /home/op/Prometheus/y' }]),
        msg(3, 'assistant', [use('t3', 'bash', { command: 'cd /home/op/pilot && pytest' })]),
        msg(4, 'assistant', '{"type": "tool_use", "input": {"path": "/home/op/Prometheus/z"}}'), // an object, not an array
        msg(5, 'assistant', '[{"type": "tool_use", "input": {"path": "/home/op/Prometheus/broken"'), // invalid JSON
        msg(6, 'assistant', 'plain text that mentions "tool_use" and /home/op/Prometheus/q'),
        // Array elements that are not objects: json_extract on a bare string throws, and one such
        // row would fail every session's hint.
        msg(7, 'assistant', '["tool_use", 42, null, "/home/op/Prometheus/s"]'),
        // A block that is NOT tool_use but carries an `input`: only the type decides.
        // It shares a row with a real tool_use, or the LIKE prefilter would drop the row before the
        // type condition is ever asked (the first version of this fixture tested nothing).
        msg(8, 'assistant', [
          { type: 'server_tool_use', id: 'x', input: { path: '/home/op/Prometheus/srv' } },
          use('t8', 'read_file', { path: '/home/op/pilot/c.py' })
        ])
      ],
      8
    )
    let inputs: string[] = []
    let threw = ''
    try {
      inputs = repo.toolUseInputs(SID)
    } catch (e) {
      threw = e instanceof Error ? e.message : String(e)
    }
    check(threw === '', 'a row of non-object array elements does not throw', threw)
    check(inputs.length === 4, 'four tool_use inputs read; tool_result, object row, bad JSON, plain text, scalars and other block types are skipped', `${inputs.length}: ${inputs.join(' ; ')}`)
    check(!inputs.some((i) => i.includes('Prometheus')), 'no Prometheus path leaked in from a tool_result body or a malformed row')

    const svc = new CacheService(repo, {} as ConnectionManager)
    const h1 = svc.projectHints()
    check(h1[SID]?.key === 'pilot' && h1[SID].calls === 4 && h1[SID].share === 1, 'the service suggests pilot at 100% of 4', JSON.stringify(h1[SID]))

    // Memo: a second call with nothing changed must not re-read. Prove it by counting reads.
    let reads = 0
    const orig = repo.toolUseInputs.bind(repo)
    repo.toolUseInputs = (sid: string): string[] => {
      reads += 1
      return orig(sid)
    }
    svc.projectHints()
    check(reads === 0, 'unchanged session → not re-read', `${reads} reads`)

    // New messages move the stamp: re-read, and the answer changes with the evidence.
    repo.reconcileSession(
      SID,
      [9, 10, 11, 12].map((n) => msg(n, 'assistant', [use(`u${n}`, 'read_file', { path: `/home/op/Prometheus/f${n}.py` })])),
      12
    )
    const h2 = svc.projectHints()
    check(reads === 1, 'changed session → re-read once', `${reads} reads`)
    check(!(SID in h2), 'pilot 4 vs Prometheus 4 (50%) is mixed: the hint goes away rather than flip a coin', JSON.stringify(h2[SID]))
    repo.reconcileSession(SID, [msg(13, 'assistant', [use('u13', 'read_file', { path: '/home/op/Prometheus/g.py' })])], 13)
    check(!(SID in svc.projectHints()), '5 of 9 (56%) is still under the bar: no suggestion yet')
    repo.reconcileSession(SID, [msg(14, 'assistant', [use('u14', 'read_file', { path: '/home/op/Prometheus/h.py' })])], 14)
    const h3 = svc.projectHints()
    check(h3[SID]?.key === 'prometheus' && h3[SID].calls === 10 && h3[SID].share === 0.6, '6 of 10 (60%): the suggestion follows the new majority', JSON.stringify(h3[SID]))

    // A session that drops out of the cache drops out of the hints.
    db.prepare('DELETE FROM messages WHERE session_id = ?').run(SID)
    check(!(SID in svc.projectHints()), 'a session with no cached messages has no hint')
  } finally {
    db.close()
    clean()
  }
}
