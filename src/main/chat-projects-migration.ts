// Moving this computer's projects to the Prometheus Beacon is connected to (@shared/chat-projects-migration says what and why).
//
// ONCE per Prometheus, and safe to repeat at any point: a project is made by `import_key` (the daemon answers the one it already has),
// a conversation is filed in a project it is already in with the same answer, and nothing local is ever deleted. It stops at the first
// thing it cannot be sure of and leaves the local projects exactly as they were; the next connection tries again.
//
//   * A conversation is filed as a LABEL ONLY (`keep_workspace: true`): an old conversation keeps working where it worked, so no
//     conversation's write boundary changes by a move. Neither `workspace_set` nor `device_session` can be answered.
//   * The move is confirmed before it is recorded: the Prometheus's list must hold every project made, and every filing must have been
//     answered (filed, or a Prometheus that does not have that conversation, or runs it itself). Anything else is not "done".
//   * It never deletes anything on a Prometheus. It asks the Prometheus's own session list which conversations it has, and files only those:
//     the list is durable and complete, so one it does not list is not there.
import {
  PROJECT_ROUTES,
  readFiled,
  readProjectList,
  readProjectWrite,
  readSessionIds
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
  now?: () => number
}

const MAX_LEFTOVERS_KEPT = 200
/** After an attempt that did not finish (or had nothing to do), the next is not made for this long: the window's state changes often and a
 *  Prometheus that is failing is not to be asked again on each of them. */
const BACKOFF_MS = 60_000

export class ChatProjectsMigration {
  private running = false
  private finished = false
  private notBefore = 0

  constructor(private readonly deps: MigrationDeps) {}

  /** Run the move if it has not been done for this Prometheus and is not running. Resolves to the state it ended in, or null when it did nothing. */
  async run(): Promise<MigrationState | null> {
    if (this.running || this.finished) return null
    if ((this.deps.now?.() ?? Date.now()) < this.notBefore) return null
    if (this.deps.isDone()) {
      this.finished = true
      return this.say({ status: 'done', projects: 0, moved: 0, leftovers: 0, message: null, fresh: false })
    }
    this.running = true
    try {
      const end = await this.execute()
      // Done is done; a Prometheus that cannot make its folder is told about once. Anything else is tried again, later.
      if (end && (end.status === 'done' || end.status === 'blocked')) this.finished = true
      else this.notBefore = (this.deps.now?.() ?? Date.now()) + BACKOFF_MS
      return end
    } finally {
      this.running = false
    }
  }

  private say(m: MigrationState): MigrationState {
    this.deps.report(m)
    return m
  }

  private async ask(r: { method: string; path: string; body?: unknown }): Promise<{ status: number; body: unknown }> {
    try {
      return await this.deps.request(r.method, r.path, r.body)
    } catch {
      return { status: 0, body: null }
    }
  }

  private async execute(): Promise<MigrationState | null> {
    const stop = (status: 'blocked' | 'incomplete', message: string, so: { projects: number; moved: number; leftovers: number }): MigrationState =>
      this.say({ status, projects: so.projects, moved: so.moved, leftovers: so.leftovers, message, fresh: false })

    // Only an owner moves projects: a device that may only chat is told nothing, and does nothing.
    const l0 = await this.ask(PROJECT_ROUTES.list())
    const first = readProjectList(l0.status, l0.body)
    if (!first.ok) return first.kind === 'not_owner' || first.kind === 'unsupported' ? null : stop('incomplete', MIGRATION_WORDS.incomplete, { projects: 0, moved: 0, leftovers: 0 })
    if (first.value.role !== 'owner') return null

    // Which conversations this Prometheus has. Without that it would be guessing, so it does not go on.
    const listedAnswer = await this.ask(PROJECT_ROUTES.sessions())
    const listed = readSessionIds(listedAnswer.status, listedAnswer.body)
    if (!listed) return stop('incomplete', MIGRATION_WORDS.incomplete, { projects: 0, moved: 0, leftovers: 0 })
    const own = parseProjectStore(this.deps.readOwn())
    const others = this.deps.readOthers().map((o) => ({ folderId: o.folderId, store: parseProjectStore(o.raw) as ProjectStore }))
    const plan = planMigration({ own, others, listed })
    if (plan.length === 0) {
      this.deps.writeDone(JSON.stringify({ done: true, at: this.deps.now?.() ?? Date.now(), projects: 0, moved: 0, leftovers: [] }))
      this.finished = true
      return this.say({ status: 'done', projects: 0, moved: 0, leftovers: 0, message: null, fresh: false })
    }

    this.say({ status: 'running', projects: 0, moved: 0, leftovers: 0, message: null, fresh: false })
    const kept = new Set<string>()
    const leftovers: Array<{ sessionId: string; why: 'gone' | 'machine' }> = []
    let moved = 0
    const so = (): { projects: number; moved: number; leftovers: number } => ({ projects: kept.size, moved, leftovers: leftovers.length })

    for (const p of plan) {
      const made = await this.ask(PROJECT_ROUTES.create(p.name, p.key ? { importKey: p.key } : {}))
      const w = readProjectWrite(made.status, made.body)
      if (!w.ok) {
        // The Prometheus cannot make its projects folder: this Prometheus's part stays local, and the person is told why.
        if (w.kind === 'bad_folder') return stop('blocked', MIGRATION_WORDS.blockedFolder, so())
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
        else return stop('incomplete', MIGRATION_WORDS.incomplete, so())
      }
    }

    // Confirmed against the Prometheus's own list before it is recorded.
    const l1 = await this.ask(PROJECT_ROUTES.list())
    const after = readProjectList(l1.status, l1.body)
    if (!after.ok || after.value.role !== 'owner') return stop('incomplete', MIGRATION_WORDS.incomplete, so())
    const present = new Set(after.value.projects.map((x) => x.id))
    for (const id of kept) if (!present.has(id)) return stop('incomplete', MIGRATION_WORDS.incomplete, so())

    this.deps.writeDone(
      JSON.stringify({ done: true, at: this.deps.now?.() ?? Date.now(), projects: kept.size, moved, leftovers: leftovers.slice(0, MAX_LEFTOVERS_KEPT) })
    )
    this.finished = true
    return this.say({ status: 'done', projects: kept.size, moved, leftovers: leftovers.length, message: null, fresh: true })
  }
}
