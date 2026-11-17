// Moving this computer's projects to the Prometheus Beacon is connected to (@shared/chat-projects-migration says what and why).
//
// ONCE per Prometheus, and safe to repeat at any point: a project is made by `import_key` (the daemon answers the one it already has),
// a conversation is filed only if the Prometheus has it in NO project, and nothing local is ever deleted. It stops at the first thing it
// cannot be sure of and leaves the local projects exactly as they were; the next connection (or a minute later) tries again.
//
//   * A conversation is filed as a LABEL ONLY (`keep_workspace: true`): an old conversation keeps working where it worked, so no
//     conversation's write boundary changes by a move. Neither `workspace_set` nor `device_session` can be answered.
//   * It files only conversations the Prometheus LISTS (its list is durable and complete) and has in no project. One already in a project
//     there was put there by somebody, here or on the phone, and the daemon would replace that filing: it is left where it is.
//   * It never deletes anything on a Prometheus.
//   * One thing the Prometheus will not take (a conversation it cannot file, a project name it refuses) is skipped and counted; it does not
//     stop the rest. A refusal that says the Prometheus itself is the problem (no answer, a server error, not the owner) stops the move.
//   * The move is confirmed before it is recorded: the Prometheus's list must hold every project made, and the person's own local store must
//     be what it was when the move began (an edit made meanwhile means another pass, not "done").
//   * It belongs to one connection. When that connection is replaced or forgotten it stops asking and writes nothing.
import {
  PROJECT_ROUTES,
  readFiled,
  readProjectList,
  readProjectWrite,
  readSessionList,
  type ChatProjectErrorKind
} from '@shared/chat-projects'
import { MIGRATION_WORDS, planMigration, type MigrationState } from '@shared/chat-projects-migration'
import { parseProjectStore, type ProjectStore } from '@shared/session-projects'
import type { ProjectsRequest } from './chat-projects'

export interface MigrationDeps {
  request: ProjectsRequest
  /** This Prometheus's own local store, as stored (null when nothing is). */
  readOwn(): string | null
  /** Every other Prometheus's local store, as stored. */
  readOthers(): Array<{ folderId: string; raw: string | null }>
  /** The move has been recorded for this Prometheus. */
  isDone(): boolean
  /** Record it. */
  writeDone(value: string): void
  /** What the window is told. */
  report(m: MigrationState): void
  /** False once the connection this mover was made for has been replaced or forgotten: it stops, and writes nothing. */
  isCurrent(): boolean
  now?: () => number
}

const MAX_LEFTOVERS_KEPT = 200
/** After an attempt that did not finish (or had nothing to do), the next is not made for this long: the window's state changes often and a
 *  Prometheus that is failing is not to be asked again on each of them. */
const BACKOFF_MS = 60_000

/** A refusal that says THIS conversation cannot be filed here, whatever is tried: it is skipped and counted. */
const SKIP_SESSION: ReadonlySet<ChatProjectErrorKind> = new Set(['unsupported', 'workspace_set', 'device_session'])
/** A refusal that says the Prometheus will not take THIS project (its name or its folder): it is skipped and counted. */
const SKIP_PROJECT: ReadonlySet<ChatProjectErrorKind> = new Set(['name_required', 'name_taken', 'folder_in_use'])

class Superseded extends Error {}

export class ChatProjectsMigration {
  private running = false
  private finished = false
  private notBefore = 0

  constructor(private readonly deps: MigrationDeps) {}

  private clock(): number {
    return this.deps.now?.() ?? Date.now()
  }

  /** Run the move if it has not been done for this Prometheus and is not running. Resolves to the state it ended in, or null when it did nothing. */
  async run(): Promise<MigrationState | null> {
    if (this.running || this.finished) return null
    if (this.clock() < this.notBefore) return null
    this.running = true
    try {
      if (this.deps.isDone()) {
        this.finished = true
        return this.say({ ...ZERO, status: 'done' })
      }
      const end = await this.execute()
      // Done is done; a Prometheus that cannot make its folder is told about once. Anything else is tried again, later.
      if (end && (end.status === 'done' || end.status === 'blocked')) this.finished = true
      else this.notBefore = this.clock() + BACKOFF_MS
      return end
    } catch (e) {
      // The connection was replaced: nothing to say, and nothing written. Anything else the move could not foresee is an unfinished move.
      if (e instanceof Superseded) return null
      this.notBefore = this.clock() + BACKOFF_MS
      return this.say({ ...ZERO, status: 'incomplete', message: MIGRATION_WORDS.incomplete })
    } finally {
      this.running = false
    }
  }

  private say(m: MigrationState): MigrationState {
    if (!this.deps.isCurrent()) throw new Superseded()
    this.deps.report(m)
    return m
  }

  private async ask(r: { method: string; path: string; body?: unknown }): Promise<{ status: number; body: unknown }> {
    if (!this.deps.isCurrent()) throw new Superseded()
    let out: { status: number; body: unknown }
    try {
      out = await this.deps.request(r.method, r.path, r.body)
    } catch {
      out = { status: 0, body: null }
    }
    if (!this.deps.isCurrent()) throw new Superseded()
    return out
  }

  private async execute(): Promise<MigrationState | null> {
    const stop = (status: 'blocked' | 'incomplete', message: string, so: Counts): MigrationState => this.say({ ...so, status, message, fresh: false })

    // Only an owner moves projects: a device that may only chat is told nothing, and does nothing.
    const l0 = await this.ask(PROJECT_ROUTES.list())
    const first = readProjectList(l0.status, l0.body)
    if (!first.ok) return first.kind === 'not_owner' || first.kind === 'unsupported' ? null : stop('incomplete', MIGRATION_WORDS.incomplete, NONE)
    if (first.value.role !== 'owner') return null

    // Which conversations this Prometheus has, and which are already in a project. Without that it would be guessing, so it does not go on.
    const listedAnswer = await this.ask(PROJECT_ROUTES.sessions())
    const listed = readSessionList(listedAnswer.status, listedAnswer.body)
    if (!listed) return stop('incomplete', MIGRATION_WORDS.incomplete, NONE)
    const ownRaw = this.deps.readOwn()
    const own = parseProjectStore(ownRaw)
    const others = this.deps.readOthers().map((o) => ({ folderId: o.folderId, store: parseProjectStore(o.raw) as ProjectStore }))
    const plan = planMigration({ own, others, listed })
    if (plan.length === 0) {
      this.record({ projects: 0, moved: 0, leftovers: [], alreadyFiled: 0, skippedProjects: 0 })
      this.finished = true
      return this.say({ ...ZERO, status: 'done' })
    }

    this.say({ ...ZERO, status: 'running' })
    const kept = new Set<string>()
    const leftovers: Array<{ sessionId: string; why: 'gone' | 'machine' | 'refused' }> = []
    let moved = 0
    let skippedProjects = 0
    const alreadyFiled = plan.reduce((n, p) => n + p.already.length, 0)
    const so = (): Counts => ({ projects: kept.size, moved, leftovers: leftovers.length, alreadyFiled, skippedProjects })

    for (const p of plan) {
      const made = await this.ask(PROJECT_ROUTES.create(p.name, p.key ? { importKey: p.key } : {}))
      const w = readProjectWrite(made.status, made.body)
      if (!w.ok) {
        // The Prometheus cannot make its projects folder: this Prometheus's part stays local, and the person is told why.
        if (w.kind === 'bad_folder') return stop('blocked', MIGRATION_WORDS.blockedFolder, so())
        if (SKIP_PROJECT.has(w.kind)) {
          // It will not take this one (a name that is empty once it has cleaned it, say). The rest go on; this one stays in the local copy.
          skippedProjects++
          for (const id of [...p.sessions, ...p.missing]) leftovers.push({ sessionId: id, why: 'refused' })
          continue
        }
        return stop('incomplete', MIGRATION_WORDS.incomplete, so())
      }
      const project = w.value.project
      kept.add(project.id)
      for (const id of p.missing) leftovers.push({ sessionId: id, why: 'gone' })
      for (const id of p.sessions) {
        const a = await this.ask(PROJECT_ROUTES.file(id, project.id, { keep: true }))
        const r = readFiled(a.status, a.body)
        if (r.ok) moved++
        else if (r.kind === 'unknown_session') leftovers.push({ sessionId: id, why: 'gone' })
        else if (r.kind === 'machine_session') leftovers.push({ sessionId: id, why: 'machine' })
        else if (SKIP_SESSION.has(r.kind)) leftovers.push({ sessionId: id, why: 'refused' })
        else return stop('incomplete', MIGRATION_WORDS.incomplete, so())
      }
    }

    // Confirmed against the Prometheus's own list before it is recorded.
    const l1 = await this.ask(PROJECT_ROUTES.list())
    const after = readProjectList(l1.status, l1.body)
    if (!after.ok || after.value.role !== 'owner') return stop('incomplete', MIGRATION_WORDS.incomplete, so())
    const present = new Set(after.value.projects.map((x) => x.id))
    for (const id of kept) if (!present.has(id)) return stop('incomplete', MIGRATION_WORDS.incomplete, so())
    // An edit made to the local projects while this ran is not in the plan: not "done", another pass.
    if (this.deps.readOwn() !== ownRaw) return stop('incomplete', MIGRATION_WORDS.incomplete, so())

    this.record({ projects: kept.size, moved, leftovers: leftovers.slice(0, MAX_LEFTOVERS_KEPT), alreadyFiled, skippedProjects })
    this.finished = true
    return this.say({ ...so(), status: 'done', message: null, fresh: true })
  }

  private record(r: { projects: number; moved: number; leftovers: unknown[]; alreadyFiled: number; skippedProjects: number }): void {
    if (!this.deps.isCurrent()) throw new Superseded()
    this.deps.writeDone(JSON.stringify({ done: true, at: this.clock(), ...r }))
  }
}

interface Counts {
  projects: number
  moved: number
  leftovers: number
  alreadyFiled: number
  skippedProjects: number
}
const NONE: Counts = { projects: 0, moved: 0, leftovers: 0, alreadyFiled: 0, skippedProjects: 0 }
const ZERO: MigrationState = { status: 'done', ...NONE, message: null, fresh: false }
