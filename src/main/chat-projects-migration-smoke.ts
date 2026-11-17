/**
 * Moving the local projects to a Prometheus: the plan (@shared/chat-projects-migration) and the executor (src/main/chat-projects-migration.ts),
 * against a small model of the daemon's chat projects. The model follows what the daemon's own code does (the answers are its recorded
 * ones, src/main/fixtures/chat_projects.json); `npm run probe:chat-projects-migration` runs the same scenarios against REAL daemons.
 *
 *   * each local folder's conversations go to the Prometheus that has them, a folder spanning two is split with its name on each side,
 *     an empty project goes where its store is, and nothing is dropped or deleted locally;
 *   * every conversation is filed as a LABEL ONLY (keep_workspace): no conversation's write boundary changes;
 *   * a re-run, or two at once, makes no duplicates; an interrupted run records nothing and is finished by the next;
 *   * a Prometheus that is offline, not an owner, or cannot make its folder keeps its part locally and is not marked done.
 */
import fixture from './fixtures/chat_projects.json'
import { readFileSync } from 'node:fs'
import { importKey } from '@shared/chat-projects'
import { MIGRATION_WORDS, migrationNote, planMigration, type MigrationState } from '@shared/chat-projects-migration'
import { parseMigrated } from '@shared/chat-projects-view'
import { parseProjectStore } from '@shared/session-projects'
import { ChatProjectsMigration } from './chat-projects-migration'
import type { ProjectsRequest } from './chat-projects'

const EXPECTED = 61
let failures = 0
let checks = 0
function assert(cond: boolean, label: string, detail?: unknown): void {
  checks++
  console.log(`[chat-projects-migration-smoke] ${cond ? 'PASS' : 'FAIL'}  ${label}${!cond && detail !== undefined ? `  — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`)
  if (!cond) failures++
}
process.on('exit', () => {
  if (checks !== EXPECTED) {
    console.log(`[chat-projects-migration-smoke] FAIL  ${checks} checks ran, expected ${EXPECTED}`)
    failures++
  }
  console.log(failures === 0 ? `[chat-projects-migration-smoke] PASS (${checks} checks)` : `[chat-projects-migration-smoke] ${failures} FAILED`)
  process.exitCode = failures === 0 ? 0 : 1
})

type Recorded = { label: string; status: number; body: unknown }
const rec = (label: string): { status: number; body: unknown } => {
  const e = (fixture.exchanges as Recorded[]).find((x) => x.label === label)
  if (!e) throw new Error(`fixture: no exchange ${label}`)
  return { status: e.status, body: e.body }
}

// ── a daemon, as far as the move can tell ──────────────────────────────────────────────────────────────────────────────────────
class Daemon {
  projects: Array<{ id: string; name: string; key: string | null }> = []
  filing = new Map<string, string>()
  requests: Array<{ method: string; path: string; body: unknown }> = []
  n = 0
  badFolder = false
  down = false
  failAfter: number | null = null
  role: 'owner' | 'chat_only' = 'owner'
  constructor(readonly sessions: string[], readonly listed: string[] = sessions) {}
  full(p: { id: string; name: string; key: string | null }): Record<string, unknown> {
    return { id: p.id, name: p.name, folder: `/daemon/projects/${p.name.toLowerCase().replace(/\W+/g, '-')}`, folder_managed: true, instructions_chars: 0, instructions_rev: '', files: 0, sessions: [...this.filing.values()].filter((x) => x === p.id).length, import_key: p.key, created_at: 1, updated_at: 1 }
  }
  request: ProjectsRequest = async (method, path, body) => {
    this.requests.push({ method, path, body })
    if (this.down) throw new Error('unreachable')
    if (this.failAfter !== null && this.requests.length > this.failAfter) throw new Error('connection dropped')
    const b = (body ?? {}) as Record<string, unknown>
    if (method === 'GET' && path === '/api/chat-projects') {
      return this.role === 'owner' ? { status: 200, body: { role: 'owner', rev: this.requests.length, projects: this.projects.map((p) => this.full(p)) } } : { status: 200, body: { role: 'chat_only', projects: [] } }
    }
    if (method === 'GET' && path === '/api/sessions') return { status: 200, body: this.listed.map((id) => ({ session_id: id, chat_project_id: this.filing.get(id) ?? null })) }
    if (method === 'POST' && path === '/api/chat-projects') {
      if (this.badFolder) return rec('create, the home folder')
      // The daemon cleans a name (it strips control and format characters) and refuses one that is then empty.
      const name = String(b.name ?? '').replace(/[\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g, '').trim()
      if (!name) return rec('create, no name')
      const key = typeof b.import_key === 'string' ? b.import_key : null
      const have = this.projects.find((p) => (key !== null && p.key === key) || p.name.toLowerCase() === name.toLowerCase())
      if (have) return { status: 200, body: { ok: true, project: this.full(have), created: false } }
      const p = { id: `cp_${String(++this.n).padStart(12, '0')}`, name, key }
      this.projects.push(p)
      return { status: 201, body: { ok: true, project: this.full(p), created: true } }
    }
    const filing = /^\/api\/sessions\/([^/]+)\/project$/.exec(path)
    if (method === 'PUT' && filing) {
      const sid = decodeURIComponent(filing[1])
      // An id with a slash in it never reaches the route (the framework decodes %2F before routing): a 404 with no kind of the daemon's own.
      if (sid.includes('/')) return { status: 404, body: { detail: 'Not Found' } }
      if (/^(eval|smoke|gym|bakeoff|coding):/.test(sid) || sid === 'system') return rec('file, a machine session')
      if (!this.sessions.includes(sid)) return rec('file, a session the daemon does not have')
      const p = this.projects.find((x) => x.id === b.chat_project_id)
      if (!p) return rec('file, a project that is not there')
      this.filing.set(sid, p.id)
      return { status: 200, body: { ok: true, session_id: sid, chat_project_id: p.id, workspace: null } }
    }
    const one = /^\/api\/chat-projects\/([^/]+)$/.exec(path)
    if (method === 'DELETE' && one) {
      const p = this.projects.find((x) => x.id === one[1])
      if (!p) return rec('delete, a project that is not there')
      let n = 0
      for (const [sid, pid] of [...this.filing]) if (pid === p.id) (this.filing.delete(sid), n++)
      this.projects = this.projects.filter((x) => x.id !== p.id)
      return { status: 200, body: { ok: true, id: p.id, unfiled: n } }
    }
    return { status: 404, body: { detail: 'Not Found' } }
  }
  byName(): Record<string, string[]> {
    const out: Record<string, string[]> = {}
    for (const p of this.projects) out[p.name] = [...this.filing].filter(([, pid]) => pid === p.id).map(([sid]) => sid).sort()
    return out
  }
  writes(): Array<{ method: string; path: string; body: unknown }> {
    return this.requests.filter((r) => r.method !== 'GET')
  }
}

const store = (projects: Array<[string, string]>, assign: Record<string, string>, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ projects: projects.map(([id, name]) => ({ id, name })), assign, dismissed: {}, ...extra })

interface Run {
  state: MigrationState | null
  reports: MigrationState[]
  flag: string | null
  m: ChatProjectsMigration
}
function mover(
  d: Daemon,
  own: string | null | (() => string | null),
  others: Array<{ folderId: string; raw: string | null }> = [],
  done: { value: string | null } = { value: null },
  clock = { t: 1_000_000 },
  current = { value: true }
): { run: () => Promise<Run>; reports: MigrationState[]; done: { value: string | null } } {
  const reports: MigrationState[] = []
  const m = new ChatProjectsMigration({
    request: d.request,
    readOwn: () => (typeof own === 'function' ? own() : own),
    readOthers: () => others,
    isDone: () => parseMigrated(done.value),
    writeDone: (v) => {
      done.value = v
    },
    report: (s) => reports.push(s),
    isCurrent: () => current.value,
    now: () => clock.t
  })
  return { run: async () => ({ state: await m.run(), reports, flag: done.value, m }), reports, done }
}

const ms = (o: Partial<MigrationState>): MigrationState => ({ status: 'done', projects: 0, moved: 0, leftovers: 0, alreadyFiled: 0, skippedProjects: 0, message: null, fresh: true, ...o })
const L = (...ids: string[]): Map<string, string | null> => new Map(ids.map((id) => [id, null] as [string, string | null]))

// ── the plan ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────
{
  const own = parseProjectStore(store([['p1', 'Kitchen'], ['p2', 'Garden'], ['p3', 'Solo']], { 'desktop:a': 'p1', 'desktop:b': 'p1', 'desktop:c': 'p3' }))
  const far = parseProjectStore(store([['q1', 'Kitchen'], ['q2', 'Reading']], { 'desktop:x': 'q1', 'desktop:y': 'q2', 'desktop:a': 'q2' }))
  const plan = planMigration({ own, others: [{ folderId: 'f2', store: far }], listed: L('desktop:a', 'desktop:x') })
  assert(plan.map((p) => `${p.origin}:${p.name}`).join() === 'own:Kitchen,own:Garden,own:Solo,f2:Kitchen', "its own store's projects come first, in order, empty ones included; another store's only if this Prometheus lists one of its conversations", plan.map((p) => p.name))
  assert(plan[0].sessions.join() === 'desktop:a' && plan[0].missing.join() === 'desktop:b', "only the conversations this Prometheus lists are filed; one it doesn't list is not tried, and is counted as left unfiled")
  assert(plan[1].sessions.length === 0 && plan[1].missing.length === 0, 'an empty project has no conversations and is made anyway')
  assert(plan[2].name === 'Solo' && plan[2].sessions.length === 0 && plan[2].missing.join() === 'desktop:c', 'a project whose conversations are all elsewhere is still made (a name a person chose is not dropped): empty, with its conversations counted as left unfiled')
  assert(plan[3].sessions.join() === 'desktop:x' && plan[3].missing.length === 0, "another store's project brings only the conversations this Prometheus lists, and none already planned (desktop:a is Kitchen's, not Reading's)")
  assert(plan.every((p, i) => p.key === importKey(i < 3 ? p.localId : `f2:${p.localId}`)), 'a project of its own store is keyed beacon-desktop:<id>; another store\'s beacon-desktop:<folder>:<id>, so two stores never share a key')
  assert(planMigration({ own, others: [{ folderId: 'f2', store: far }], listed: new Map() }).length === 3, 'a Prometheus that lists none of them: another store contributes nothing')
  assert(planMigration({ own: parseProjectStore(null), others: [], listed: new Map() }).length === 0, 'nothing local is nothing to move')
  const filed = planMigration({ own, others: [{ folderId: 'f2', store: far }], listed: new Map([['desktop:a', 'cp_there'], ['desktop:b', null], ['desktop:x', 'cp_there']]) })
  assert(filed[0].sessions.join() === 'desktop:b' && filed[0].already.join() === 'desktop:a', 'a conversation the Prometheus already has in a project is not filed again: it is left where it is')
  assert(!filed.some((p) => p.origin === 'f2'), "and another store's project whose only conversation here is already in a project is not made")
}

async function scenarios(): Promise<void> {
// ── a folder that spans two Prometheuses ───────────────────────────────────────────────────────────────────────────────────────
{
  const mixed = store([['p1', 'Kitchen'], ['p2', 'Garden'], ['p3', 'Solo']], { 'desktop:one-1': 'p1', 'desktop:one-2': 'p1', 'desktop:two-1': 'p1', 'desktop:two-2': 'p3', 'desktop:gone': 'p1' })
  const d1 = new Daemon(['desktop:one-1', 'desktop:one-2'])
  const d2 = new Daemon(['desktop:two-1', 'desktop:two-2'])
  const flag1 = { value: null as string | null }
  const flag2 = { value: null as string | null }
  const r1 = await mover(d1, mixed, [{ folderId: 'f2', raw: null }], flag1).run()
  const r2 = await mover(d2, null, [{ folderId: 'f1', raw: mixed }], flag2).run()
  assert(JSON.stringify(d1.byName()) === JSON.stringify({ Kitchen: ['desktop:one-1', 'desktop:one-2'], Garden: [], Solo: [] }), "the first Prometheus gets Kitchen with its two conversations, the empty Garden, and an empty Solo (a project of its own store keeps its name; Solo's conversation is on the other)", d1.byName())
  assert(JSON.stringify(d2.byName()) === JSON.stringify({ Kitchen: ['desktop:two-1'], Solo: ['desktop:two-2'] }), 'the second gets Kitchen with its one (the name kept on each side) and Solo, and no Garden (an empty project stays where its store is)', d2.byName())
  assert(r1.state?.status === 'done' && r1.state.moved === 2 && r1.state.projects === 3 && r1.state.leftovers === 3 && r1.state.fresh, "the first is done: 2 filed; 3 stay unfiled (the other one's two, and one that is nowhere)", r1.state)
  assert(r2.state?.status === 'done' && r2.state.moved === 2 && r2.state.projects === 2 && r2.state.leftovers === 0, 'the second is done: 2 filed, none left', r2.state)
  assert(parseMigrated(flag1.value) && parseMigrated(flag2.value), 'each Prometheus is marked done, in its own record')
  assert(JSON.parse(flag1.value ?? '{}').leftovers.map((l: { why: string }) => l.why).join() === 'gone,gone,gone', 'the record lists what stayed behind and why')
  const all = [...d1.requests, ...d2.requests].filter((r) => r.method === 'PUT')
  assert(all.length > 0 && all.every((r) => (r.body as { keep_workspace?: boolean }).keep_workspace === true && !('replace_workspace' in (r.body as object)) && !('device_session' in (r.body as object))), 'EVERY filing is a label only: keep_workspace, never replace_workspace or device_session, so no conversation\'s write boundary changes')
  assert(![...d1.requests, ...d2.requests].some((r) => r.method === 'DELETE'), 'the move never deletes anything on a Prometheus')
  assert(d1.writes().every((r) => r.method !== 'PUT' || /project$/.test(r.path)) && d1.requests.every((r) => /^\/api\/(chat-projects(\/[^/]+)?|sessions(\/[^/]+\/project)?)$/.test(r.path)), 'only project routes, and the session list, were asked')
  assert(mixed === store([['p1', 'Kitchen'], ['p2', 'Garden'], ['p3', 'Solo']], { 'desktop:one-1': 'p1', 'desktop:one-2': 'p1', 'desktop:two-1': 'p1', 'desktop:two-2': 'p3', 'desktop:gone': 'p1' }), 'the local store is read, never written: nothing is dropped')
}

// ── safe to repeat, and two at once ────────────────────────────────────────────────────────────────────────────────────────────
{
  const mine = store([['p1', 'Kitchen'], ['p2', 'Garden']], { 'desktop:a': 'p1', 'desktop:b': 'p1' })
  const d = new Daemon(['desktop:a', 'desktop:b'])
  await mover(d, mine).run() // the flag is not kept between these two: as if it was lost, or another Beacon moved them
  const once = JSON.stringify(d.byName())
  const n = d.projects.length
  const again = await mover(d, mine).run()
  assert(JSON.stringify(d.byName()) === once && d.projects.length === n && again.state?.status === 'done', 'run again with nothing remembered: the same projects, the same filings, no duplicates (the daemon answers the project it already has)')
  assert(d.requests.filter((r) => r.method === 'POST').every((r) => (r.body as { import_key?: string }).import_key?.startsWith('beacon-desktop:p')), 'every project is made by its import key')
  const twoAtOnce = new Daemon(['desktop:a', 'desktop:b'])
  const m1 = mover(twoAtOnce, mine)
  const m2 = mover(twoAtOnce, mine)
  await Promise.all([m1.run(), m2.run()])
  assert(twoAtOnce.projects.length === 2 && JSON.stringify(twoAtOnce.byName()) === once, 'two Beacons moving the same projects at once make one of each')
  const one = mover(d, mine)
  const [x, y] = await Promise.all([one.run(), one.run()])
  assert((x.state === null) !== (y.state === null), 'one run at a time: a second call while one is out does nothing')
  const done = { value: JSON.stringify({ done: true }) }
  const quiet = new Daemon(['desktop:a'])
  const was = await mover(quiet, mine, [], done).run()
  assert(was.state?.status === 'done' && was.state.fresh === false && quiet.requests.length === 0, 'already done: nothing is asked, and the person is not told again')
}

// ── interrupted, offline, not an owner, no folder ──────────────────────────────────────────────────────────────────────────────
{
  const mine = store([['p1', 'Kitchen'], ['p2', 'Garden']], { 'desktop:a': 'p1', 'desktop:b': 'p1', 'desktop:c': 'p2' })
  const d = new Daemon(['desktop:a', 'desktop:b', 'desktop:c'])
  d.failAfter = 5
  const flag = { value: null as string | null }
  const clock = { t: 1_000_000 }
  const cut = mover(d, mine, [], flag, clock)
  const r = await cut.run()
  assert(r.state?.status === 'incomplete' && r.state.message === MIGRATION_WORDS.incomplete && flag.value === null, 'cut off part way: incomplete, nothing is recorded, and the person is told it will try again')
  assert((await cut.run()).state === null, 'and a moment later it does not ask again (a Prometheus that is failing is left alone)')
  d.failAfter = null
  clock.t += 61_000
  const next = await cut.run()
  assert(next.state?.status === 'done' && parseMigrated(flag.value) && JSON.stringify(d.byName()) === JSON.stringify({ Kitchen: ['desktop:a', 'desktop:b'], Garden: ['desktop:c'] }), 'a minute later it finishes, and nothing is duplicated by the half that was done')

  const off = new Daemon(['desktop:a'])
  off.down = true
  const offFlag = { value: null as string | null }
  const o = await mover(off, mine, [], offFlag).run()
  assert(o.state?.status === 'incomplete' && offFlag.value === null && off.projects.length === 0, 'a Prometheus that cannot be reached: nothing is made, nothing is recorded; its part stays local')

  const chatOnly = new Daemon(['desktop:a'])
  chatOnly.role = 'chat_only'
  const co = await mover(chatOnly, mine).run()
  assert(co.state === null && chatOnly.writes().length === 0 && chatOnly.requests.length === 1, 'a Beacon that is not an owner does nothing: it asks for the list, sees it is told nothing, and stops')

  const noFolder = new Daemon(['desktop:a', 'desktop:b', 'desktop:c'])
  noFolder.badFolder = true
  const nfFlag = { value: null as string | null }
  const nf = await mover(noFolder, mine, [], nfFlag).run()
  assert(nf.state?.status === 'blocked' && nf.state.message === MIGRATION_WORDS.blockedFolder && nfFlag.value === null, 'a Prometheus that cannot make its projects folder: blocked, its part stays local, and the person is told why')
  assert(noFolder.writes().length === 1 && noFolder.projects.length === 0, 'and only the one attempt was made')
  const nfAgain = mover(noFolder, mine)
  await nfAgain.run()
  assert((await nfAgain.run()).state === null, 'and it is not tried again on this connection')

  const noList = new Daemon(['desktop:a'])
  const listless = noList.request
  noList.request = async (method, path, body) => (method === 'GET' && path === '/api/sessions' ? { status: 500, body: { error: 'boom' } } : listless(method, path, body))
  const nlFlag = { value: null as string | null }
  const nl = await mover(noList, mine, [], nlFlag).run()
  assert(nl.state?.status === 'incomplete' && nlFlag.value === null && noList.writes().length === 0, "a Prometheus whose list of conversations can't be read: not done, and nothing is made, because without it the move would be guessing")

  const unknown = new Daemon(['desktop:a'])
  unknown.request = async () => ({ status: 404, body: { detail: 'Not Found' } })
  const un = await mover(unknown, mine).run()
  assert(un.state === null, 'a Prometheus that has no projects (a 404 for the list): nothing to do')

  const vanish = new Daemon(['desktop:a', 'desktop:b', 'desktop:c'])
  const realRequest = vanish.request
  vanish.request = async (method, path, body) => {
    // Somebody removes the projects between the move and its confirmation.
    if (method === 'GET' && path === '/api/chat-projects' && vanish.requests.filter((q) => q.method === 'GET' && q.path === '/api/chat-projects').length >= 1) vanish.projects = []
    return realRequest(method, path, body)
  }
  const vf = { value: null as string | null }
  const v = await mover(vanish, mine, [], vf).run()
  assert(v.state?.status === 'incomplete' && vf.value === null, 'confirmed against the Prometheus\'s own list: a project that is not in it afterwards means it is not done')

  const odd = new Daemon(['desktop:a'])
  odd.request = async (method, path, body) => {
    const out = await new Daemon(['desktop:a']).request(method, path, body)
    return method === 'PUT' ? { status: 500, body: { error: 'boom' } } : out
  }
  const bad = await mover(odd, store([['p1', 'Kitchen']], { 'desktop:a': 'p1' })).run()
  assert(bad.state?.status === 'incomplete', 'a filing that fails in a way that is not "that conversation is not here" is not done: it stops, and it will be tried again')
}

// ── what the review of the move found ───────────────────────────────────────────────────────────────────────────────────────────
{
  // A conversation already in a project on the Prometheus is left where it is.
  const d = new Daemon(['desktop:a', 'desktop:b'])
  d.projects.push({ id: 'cp_elsewhere', name: 'Elsewhere', key: null })
  d.filing.set('desktop:a', 'cp_elsewhere')
  const r = await mover(d, store([['p1', 'Kitchen']], { 'desktop:a': 'p1', 'desktop:b': 'p1' })).run()
  assert(d.filing.get('desktop:a') === 'cp_elsewhere' && d.byName().Kitchen?.join() === 'desktop:b', 'a conversation somebody already filed on the Prometheus is NOT filed again: the daemon would replace that filing')
  assert(!d.requests.some((q) => q.method === 'PUT' && q.path.includes('desktop%3Aa')) && r.state?.alreadyFiled === 1 && r.state.moved === 1, 'it is not even asked about; it is counted as already in a project')

  // A conversation the Prometheus cannot file does not stop the rest.
  const slash = new Daemon(['desktop:a', 'paperclip:issue/42', 'desktop:c'])
  const rs = await mover(slash, store([['p1', 'Kitchen'], ['p2', 'Garden']], { 'desktop:a': 'p1', 'paperclip:issue/42': 'p1', 'desktop:c': 'p2' })).run()
  assert(rs.state?.status === 'done' && rs.state.moved === 2 && rs.state.leftovers === 1 && JSON.parse(rs.flag ?? '{}').leftovers[0].why === 'refused' && slash.byName().Garden?.join() === 'desktop:c', 'one conversation the Prometheus cannot file (an id with a slash in it) is skipped and counted: the rest of the move goes on, and it is done')

  // A project the Prometheus will not take does not stop the rest.
  const junk = new Daemon(['desktop:a'])
  const rj = await mover(junk, store([['p0', '\u200b'], ['p1', 'Kitchen']], { 'desktop:a': 'p1' })).run()
  assert(rj.state?.status === 'done' && rj.state.skippedProjects === 1 && rj.state.projects === 1 && junk.byName().Kitchen?.join() === 'desktop:a', 'a project whose name the Prometheus refuses (empty once cleaned) is skipped and counted: the others are moved')

  // An edit made to the local projects while the move runs is not lost.
  let raw = store([['p1', 'Kitchen']], { 'desktop:a': 'p1' })
  const live = new Daemon(['desktop:a', 'desktop:b'])
  const was = live.request
  let edited = false
  live.request = async (method, path, body) => {
    const out = await was(method, path, body)
    if (method === 'PUT' && !edited) {
      edited = true
      raw = store([['p1', 'Kitchen']], { 'desktop:a': 'p1', 'desktop:b': 'p1' }) // the person drags another conversation in meanwhile
    }
    return out
  }
  const flagL = { value: null as string | null }
  const clockL = { t: 1_000_000 }
  const mv = mover(live, () => raw, [], flagL, clockL)
  const first = await mv.run()
  assert(first.state?.status === 'incomplete' && flagL.value === null, 'an edit to the local projects while the move runs: not done, and not recorded')
  clockL.t += 61_000
  const second = await mv.run()
  assert(second.state?.status === 'done' && live.byName().Kitchen?.join() === 'desktop:a,desktop:b', 'the next pass includes it')

  // The connection is replaced mid-move: it stops, writes nothing, says nothing more.
  const gone = new Daemon(['desktop:a', 'desktop:b'])
  const cur = { value: true }
  const gwas = gone.request
  gone.request = async (method, path, body) => {
    const out = await gwas(method, path, body)
    if (method === 'POST') cur.value = false
    return out
  }
  const gFlag = { value: null as string | null }
  const g = mover(gone, store([['p1', 'Kitchen']], { 'desktop:a': 'p1', 'desktop:b': 'p1' }), [], gFlag, { t: 1_000_000 }, cur)
  const gr = await g.run()
  assert(gr.state === null && gFlag.value === null && gone.requests.filter((q) => q.method === 'PUT').length === 0, 'a connection replaced while the move runs: nothing more is asked of that Prometheus, nothing is recorded')
  assert(g.reports.every((x) => x.status === 'running'), 'and the window is told nothing more about it')

  // Something unforeseen thrown from what it was handed is an unfinished move, not a crash.
  const boom = new Daemon(['desktop:a'])
  const b = mover(boom, () => { throw new Error('locked') }, [], { value: null }, { t: 1_000_000 })
  const br = await b.run()
  assert(br.state?.status === 'incomplete' && (await b.run()).state === null, 'a store that cannot be read: an unfinished move that is not retried at once')
}

// ── what is left behind, and what is said ──────────────────────────────────────────────────────────────────────────────────────
{
  const d = new Daemon(['desktop:a', 'eval:thing'])
  const r = await mover(d, store([['p1', 'Kitchen']], { 'desktop:a': 'p1', 'eval:thing': 'p1', 'desktop:gone': 'p1' })).run()
  assert(r.state?.moved === 1 && r.state.leftovers === 2 && JSON.parse(r.flag ?? '{}').leftovers.map((l: { why: string }) => l.why).sort().join() === 'gone,machine', 'a machine session and a conversation Prometheus does not have are left unfiled, each with its reason, and the rest is filed')
  assert(!!r.state && migrationNote(r.state) === "Your projects moved to this Prometheus (1 project and 1 conversation). 2 conversations couldn't be filed here and stay unfiled: they may be on another Prometheus, or gone. The copy on this computer is kept.", 'the note says what moved, what stayed, and that the local copy is kept', r.state && migrationNote(r.state))
  assert(migrationNote(ms({ projects: 1, moved: 1, leftovers: 1 }))?.includes("1 conversation couldn't be filed here and stays unfiled: it may be on another Prometheus, or gone.") === true, 'the note says "it" and "stays" for one, and does not say Prometheus no longer has it: it may be on another')
  assert(migrationNote(ms({ projects: 0, moved: 0 })) === null && migrationNote(ms({ projects: 2, moved: 3, fresh: false })) === null && migrationNote(ms({ status: 'running', fresh: false })) === null, 'nothing is said when nothing moved, when it was already done, or while it runs')
  assert(migrationNote(ms({ projects: 1, moved: 2, alreadyFiled: 3, skippedProjects: 1 }))?.includes('3 conversations were already in a project there and were left where they are.') === true && migrationNote(ms({ projects: 1, moved: 2, skippedProjects: 1 }))?.includes("1 project couldn't be moved: Prometheus wouldn't take its name.") === true, 'it says how many were already in a project and left alone, and how many projects Prometheus would not take')
  assert(migrationNote(ms({ status: 'blocked', message: MIGRATION_WORDS.blockedFolder, fresh: false })) === MIGRATION_WORDS.blockedFolder && !/HTTP|\/api|bad_folder|import_key/.test(MIGRATION_WORDS.blockedFolder + MIGRATION_WORDS.incomplete), 'a failure is said in the sentence, with no status, route or daemon word')
  const empty = new Daemon([])
  const none = await mover(empty, store([], {})).run()
  assert(none.state?.status === 'done' && none.state.fresh === false && none.flag !== null && empty.writes().length === 0, 'with nothing local there is nothing to move: marked done, nothing written, nothing said')
}

// ── the wiring in main ─────────────────────────────────────────────────────────────────────────────────────────────────────────
{
  const src = (rel: string): string => readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8')
  const main = src('src/main/index.ts')
  assert(/const migration = new ChatProjectsMigration\(\{\s*request: \(method, path, body\) => conn\.projectsCall\(method, path, body\)/.test(main) && (main.match(/new ChatProjectsMigration/g) ?? []).length === 1, 'one mover is made for each connection, and it asks through THAT connection')
  assert(/readOwn: \(\) => folderRepo\.getSetting\(SESSION_PROJECTS_SETTING_KEY\)/.test(main) && /isDone: \(\) => parseMigrated\(folderRepo\.getSetting\(CHAT_PROJECTS_MIGRATED_KEY\)\)/.test(main) && /writeDone: \(value\) => folderRepo\.setSetting\(CHAT_PROJECTS_MIGRATED_KEY, value\)/.test(main), "it reads and records in the folder of the Prometheus it is connected to, the one it was made for")
  assert(/\.filter\(\(i\) => i\.id !== folder\.id\)\s*\.map\(\(i\) => \(\{ folderId: i\.id, raw: folders!\.getSettingFor\(i\.id, SESSION_PROJECTS_SETTING_KEY\) \}\)\)/.test(main), "the other Prometheuses' stores are read, never written")
  assert(/if \(s\.available && s\.list\?\.role === 'owner' && cache && !cache\.isHeld\(\)\) void migration\.run\(\)/.test(main), 'it starts only when the Prometheus says it serves projects, this Beacon is its owner, and the folder is confirmed as its own')
  const mig = src('src/main/chat-projects-migration.ts')
  assert(/isCurrent: \(\) => chatProjects === projects/.test(main) && /await cache\?\.listSessions\(\)\.catch\(\(\) => undefined\)\s*if \(chatProjects !== projects\) return\s*projects\.setMigration\(m\)/.test(main) && /void migration\.run\(\)\.catch\(\(\) => undefined\)/.test(main), 'the mover stops when its connection is replaced, the window gets the filings before it is told "done", and a rejection is never left unhandled')
  assert(!/setSetting|deleteSetting|removeItem|unlink|rmSync/.test(mig.replace(/\/\/.*$/gm, '')) && !/writeFile/.test(mig), 'the mover never writes or deletes a local file or setting itself: only the one record it is handed')
  assert(!/PROJECT_ROUTES\.remove|readProjectDeleted|'DELETE'/.test(mig), 'the mover has no way to delete anything on a Prometheus')
  assert((mig.match(/keep: true/g) ?? []).length === 1 && !/replace:|device:/.test(mig.replace(/\/\/.*$/gm, '')), 'the one place it files says keep: true, and it has no way to say replace or device')
}
}
scenarios().catch((e) => {
  console.log(`[chat-projects-migration-smoke] FAIL  the scenarios threw: ${e instanceof Error ? e.stack : String(e)}`)
  failures++
})
