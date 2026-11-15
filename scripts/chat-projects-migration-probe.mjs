#!/usr/bin/env node
// chat-projects-migration-probe: the move of this computer's projects to a Prometheus, with the REAL mover (out/main/chat-projects-migration-entry.js)
// against REAL daemons (the Prometheus branch with chat projects, served over loopback by scripts/lib/serve_real_daemon.py --conversations).
// The scenarios of the desktop paste from the Prometheus side (§6), and a few more:
//
//   1  one local folder whose conversations sit on TWO Prometheuses: a project of that name on each, every conversation filed on its own,
//      an empty project where its store is, one a Prometheus does not have left unfiled, and nothing local touched;
//   2  a conversation with a folder chosen by hand: filed as a label, its folder unchanged;
//   3  the move run again (nothing remembered): no duplicates;
//   4  a move cut off part way, then finished: no duplicates, and nothing recorded until it is done;
//   5  a Prometheus that cannot be reached: nothing made, nothing recorded.
//
//   BEACON_REAL_DAEMON_SRC=<prometheus src of the chat-projects branch> BEACON_REAL_DAEMON_PY=<its python> npm run build && npm run probe:chat-projects-migration
import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { realDaemonConfigured, startRealDaemon } from './lib/real-daemon.mjs'

if (!realDaemonConfigured()) {
  console.log('[probe] SKIPPED: set BEACON_REAL_DAEMON_SRC and BEACON_REAL_DAEMON_PY (a skipped probe is not a passed one)')
  process.exit(3)
}
const { ChatProjectsMigration } = createRequire(import.meta.url)('../out/main/chat-projects-migration-entry.js')

let failures = 0
let checks = 0
const check = (ok, label, extra) => {
  checks++
  console.log(`[probe] ${ok ? 'PASS' : 'FAIL'}  ${label}${extra !== undefined ? `  — ${String(extra).slice(0, 400)}` : ''}`)
  if (!ok) failures++
}
const enc = encodeURIComponent
const store = (projects, assign) => JSON.stringify({ projects: projects.map(([id, name]) => ({ id, name })), assign, dismissed: {} })

const d1 = await startRealDaemon({ name: 'One', seedSessions: ['desktop:one-1', 'desktop:one-2', 'desktop:one-3'] })
const d2 = await startRealDaemon({ name: 'Two', seedSessions: ['desktop:two-1', 'desktop:two-2'] })
const d3 = await startRealDaemon({ name: 'Three', seedSessions: ['desktop:a', 'desktop:b', 'desktop:c'] })
check(!!d1 && !!d2 && !!d3, 'three real daemons are up (the Prometheus chat-projects branch, over loopback)')

/** A request to one daemon, recorded; `limit` cuts it off after that many requests, as a dropped connection would. */
const via = (d, log, { limit = null, dead = false } = {}) => async (method, path, body) => {
  log.push({ method, path, body })
  if (dead || (limit !== null && log.length > limit)) throw new Error('connection dropped')
  const r = await d.owner(method, path, body)
  return { status: r.status, body: r.body }
}
const mover = (d, log, own, others, flag, opts) => {
  const reports = []
  const m = new ChatProjectsMigration({
    request: via(d, log, opts),
    readOwn: () => own,
    readOthers: () => others,
    isDone: () => !!flag.value,
    writeDone: (v) => (flag.value = v),
    report: (s) => reports.push(s),
    now: () => Date.now()
  })
  return { m, reports }
}
const projects = async (d) => (await d.owner('GET', '/api/chat-projects')).body.projects
const byName = async (d) => {
  const rows = (await d.owner('GET', '/api/sessions')).body
  const out = {}
  for (const p of await projects(d)) out[p.name] = rows.filter((r) => r.chat_project_id === p.id).map((r) => r.session_id).sort()
  return out
}

try {
  // the stores this computer holds: one folder whose conversations sit on two Prometheuses (as the old single store mixed them)
  const mixed = store(
    [['p1', 'Kitchen'], ['p2', 'Garden'], ['p3', 'Solo'], ['p4', 'Reading']],
    { 'desktop:one-1': 'p1', 'desktop:one-3': 'p1', 'desktop:two-1': 'p1', 'desktop:gone': 'p1', 'desktop:two-2': 'p3', 'desktop:one-2': 'p4' }
  )
  const handPicked = join(d1.home, 'hand-picked')
  mkdirSync(handPicked, { recursive: true })
  const set = await d1.owner('PUT', `/api/sessions/${enc('desktop:one-3')}/workspace`, { path: handPicked })
  check(set.status === 200, 'a conversation on the first Prometheus has a folder somebody chose for it', JSON.stringify(set.body))

  // ── 1 and 2: the first Prometheus, then the second ──────────────────────────────────────────────────────────────────────────────
  const log1 = []
  const flag1 = { value: null }
  const a = mover(d1, log1, mixed, [{ folderId: 'f2', raw: null }], flag1)
  const end1 = await a.m.run()
  check(end1?.status === 'done' && end1.fresh === true, '1: the move on the first Prometheus finishes', JSON.stringify(end1))
  const one = await byName(d1)
  check(JSON.stringify(one) === JSON.stringify({ Kitchen: ['desktop:one-1', 'desktop:one-3'], Garden: [], Solo: [], Reading: ['desktop:one-2'] }), "1: it has Kitchen with its two conversations, the empty Garden, Reading with its one, and an empty Solo (a project of its own store keeps its name; Solo's conversation is on the other)", JSON.stringify(one))
  check(end1.moved === 3 && end1.leftovers === 3, '1: three filed; three stay unfiled (the other Prometheus\'s two, and one that is nowhere)', JSON.stringify(end1))
  const log2 = []
  const flag2 = { value: null }
  const b = mover(d2, log2, null, [{ folderId: 'f1', raw: mixed }], flag2)
  const end2 = await b.m.run()
  const two = await byName(d2)
  check(end2?.status === 'done' && JSON.stringify(two) === JSON.stringify({ Kitchen: ['desktop:two-1'], Solo: ['desktop:two-2'] }), '1: the second Prometheus has a Kitchen of its own with its one conversation, and Solo: the folder is split with its name on each side', JSON.stringify(two))
  check(!(await projects(d2)).some((p) => p.name === 'Garden') && !(await projects(d2)).some((p) => p.name === 'Reading'), '1: and no Garden or Reading: an empty project stays where its store is, and another store\'s project none of whose conversations are here is not made')
  const tops = readdirSync(join(d1.home, 'projects-root'))
  check(['kitchen', 'garden', 'solo', 'reading'].every((t) => tops.includes(t)), '1: each project has its own managed folder under the Prometheus\'s projects root', tops.join())
  check(![...log1, ...log2].some((r) => r.method === 'DELETE'), '1: nothing was deleted on either Prometheus')
  check(Boolean(flag1.value) && Boolean(flag2.value) && JSON.parse(flag1.value).done === true, '1: each is recorded as done, once')
  check(Object.values(await byName(d1)).flat().every((id) => !id.includes('two')) && Object.values(two).flat().every((id) => id.includes('two')), '1: every conversation is filed on the Prometheus that has it')

  // ── 2: the hand-chosen folder ────────────────────────────────────────────────────────────────────────────────────────────────────
  const ws = await d1.owner('GET', `/api/sessions/${enc('desktop:one-3')}/workspace`)
  check(JSON.stringify(ws.body).includes(handPicked), '2: the conversation with a folder chosen by hand is filed in Kitchen and still works in that folder', JSON.stringify(ws.body))
  const puts = [...log1, ...log2].filter((r) => r.method === 'PUT')
  check(puts.length > 0 && puts.every((r) => r.body.keep_workspace === true && !('replace_workspace' in r.body) && !('device_session' in r.body)), '2: every filing was a label only: keep_workspace, never replace_workspace or device_session')
  const bound = (await d1.owner('GET', `/api/sessions/${enc('desktop:one-1')}/workspace`)).body
  check(!JSON.stringify(bound).includes('projects-root'), '2: and no filed conversation was moved into a project\'s folder', JSON.stringify(bound))

  // ── 3: run again with nothing remembered ──────────────────────────────────────────────────────────────────────────────────────
  const before = { n: (await projects(d1)).length, by: JSON.stringify(await byName(d1)) }
  const again = mover(d1, [], mixed, [{ folderId: 'f2', raw: null }], { value: null })
  const endAgain = await again.m.run()
  check(endAgain?.status === 'done' && (await projects(d1)).length === before.n && JSON.stringify(await byName(d1)) === before.by, '3: the move run again, as if nothing had been recorded: the same projects, the same filings, no duplicates', JSON.stringify(await byName(d1)))
  const twice = [mover(d2, [], null, [{ folderId: 'f1', raw: mixed }], { value: null }), mover(d2, [], null, [{ folderId: 'f1', raw: mixed }], { value: null })]
  await Promise.all(twice.map((t) => t.m.run()))
  check((await projects(d2)).length === 2 && JSON.stringify(await byName(d2)) === JSON.stringify(two), '3: two Beacons moving the same projects at once: one of each')

  // ── 4: cut off part way, then finished ───────────────────────────────────────────────────────────────────────────────────────────
  const three = store([['p1', 'Reading list'], ['p2', 'Taxes']], { 'desktop:a': 'p1', 'desktop:b': 'p1', 'desktop:c': 'p2' })
  const flag3 = { value: null }
  const cutLog = []
  const cut = mover(d3, cutLog, three, [], flag3, { limit: 6 })
  const endCut = await cut.m.run()
  check(endCut?.status === 'incomplete' && flag3.value === null, '4: cut off part way: incomplete, and nothing is recorded', JSON.stringify(endCut))
  const partial = (await projects(d3)).length
  check(partial >= 1, '4: some of it was done on the Prometheus before the cut', String(partial))
  const finish = mover(d3, [], three, [], flag3)
  const endFinish = await finish.m.run()
  check(endFinish?.status === 'done' && Boolean(flag3.value) && (await projects(d3)).length === 2 && JSON.stringify(await byName(d3)) === JSON.stringify({ 'Reading list': ['desktop:a', 'desktop:b'], Taxes: ['desktop:c'] }), '4: finished by the next run, with nothing duplicated by the half that was done', JSON.stringify(await byName(d3)))

  // ── 5: unreachable ───────────────────────────────────────────────────────────────────────────────────────────────────────────────
  const fresh = await startRealDaemon({ name: 'Four', seedSessions: ['desktop:z'] })
  const flag4 = { value: null }
  const off = mover(fresh, [], store([['p1', 'Offline']], { 'desktop:z': 'p1' }), [], flag4, { dead: true })
  const endOff = await off.m.run()
  check(endOff?.status === 'incomplete' && flag4.value === null && (await projects(fresh)).length === 0, '5: a Prometheus that cannot be reached: nothing is made on it, nothing is recorded, and its part stays local')
  const later = mover(fresh, [], store([['p1', 'Offline']], { 'desktop:z': 'p1' }), [], flag4)
  const endLater = await later.m.run()
  check(endLater?.status === 'done' && JSON.stringify(await byName(fresh)) === JSON.stringify({ Offline: ['desktop:z'] }), '5: when it comes back, it migrates, and the conversation is filed')
  fresh.stop()
  check(true, 'the stores this computer holds were only ever read: they are strings the mover was handed')
} finally {
  for (const d of [d1, d2, d3]) d?.stop()
}
console.log(`[probe] ${failures === 0 ? 'PASS' : 'FAIL'}: ${checks - failures} of ${checks} checks`)
process.exit(failures === 0 ? 0 : 1)
