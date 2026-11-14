// The projects of the Prometheus Beacon is on (@shared/chat-projects): what main knows, and the one place the window's changes are
// made. The window asks main; main asks the Prometheus; nothing else does.
//
// GATED on the Prometheus saying it serves projects (`projects` in a `subscribed` reply). Until it does, and for any Prometheus that
// never does, this asks NOTHING: every operation answers "unsupported" without a request, and the state says `available: false`.
// An older Prometheus is exactly as it was.
//
// Read from the daemon, never merged: one hub belongs to one connection (`reset()` when the connection is replaced), so a project id
// from one Prometheus is never in front of another.
import {
  PROJECT_ROUTES,
  advertisesChatProjects,
  noChatProjects,
  readChangeFrame,
  readFiled,
  readProjectDeleted,
  readProjectList,
  readProjectWrite,
  readStarted,
  readSuggestions,
  refusal,
  type ChatProjectsOp,
  type ChatProjectsResult,
  type ChatProjectsState,
  type ProjectList,
  type Read,
  type Suggestion
} from '@shared/chat-projects'

export type ProjectsRequest = (method: string, path: string, body?: unknown) => Promise<{ status: number; body: unknown }>

export class ChatProjectsHub {
  private available = false
  private list: ProjectList | null = null
  private filings: Record<string, string> = {}
  private suggestions: Record<string, Suggestion> = {}
  private problem: string | null = null
  /** Bumped by `reset()`: an answer that lands after it belongs to a connection that is gone, and is dropped. */
  private gen = 0
  private reading: Promise<void> | null = null
  private readAgain = false

  constructor(
    private readonly deps: {
      request: ProjectsRequest
      onState: (s: ChatProjectsState) => void
    }
  ) {}

  state(): ChatProjectsState {
    return this.available
      ? { available: true, list: this.list, filings: { ...this.filings }, suggestions: { ...this.suggestions }, problem: this.problem }
      : noChatProjects()
  }

  /** A new connection (maybe another Prometheus): forget everything, say nothing is available until it says so. */
  reset(): void {
    this.gen++
    this.available = false
    this.list = null
    this.filings = {}
    this.suggestions = {}
    this.problem = null
    this.reading = null
    this.readAgain = false
    this.emit()
  }

  /** A frame from the socket: the reply to each subscribe says what this Prometheus serves (read every time, on or off: the one at an
   *  address can be upgraded or rolled back between two connections), and a change frame says the list moved. */
  onGatewayEvent(ev: { type?: string; payload?: unknown }): void {
    if (ev.type === 'subscribed') {
      const now = advertisesChatProjects(ev.payload)
      if (now === this.available) return
      this.available = now
      if (!now) {
        this.list = null
        this.filings = {}
        this.suggestions = {}
        this.problem = null
        this.gen++
        this.emit()
        return
      }
      this.emit()
      void this.refresh()
      return
    }
    if (!this.available) return
    const change = readChangeFrame(ev)
    // A rev we don't have: the list is read again. (A frame is a hint, and none comes when the agent edits a folder itself.)
    if (change && (this.list?.rev === null || this.list === null || change.rev !== this.list.rev)) void this.refresh()
  }

  /** The daemon's session list, for which conversation is filed where. A daemon that doesn't say leaves what we have alone. */
  setFilings(rows: ReadonlyArray<{ id: string; chatProjectId?: string | null }>): void {
    if (!this.available) return
    if (!rows.some((r) => r.chatProjectId !== undefined)) return
    const next: Record<string, string> = {}
    for (const r of rows) if (typeof r.chatProjectId === 'string') next[r.id] = r.chatProjectId
    const same = Object.keys(next).length === Object.keys(this.filings).length && Object.entries(next).every(([k, v]) => this.filings[k] === v)
    if (same) return
    this.filings = next
    this.emit()
  }

  /** Read the list and the suggestions again. One read at a time: a call while one is under way asks for one more after it. */
  refresh(): Promise<void> {
    if (!this.available) return Promise.resolve()
    if (this.reading) {
      this.readAgain = true
      return this.reading
    }
    const mine = this.gen
    const run = async (): Promise<void> => {
      do {
        this.readAgain = false
        await this.readOnce(mine)
        if (mine !== this.gen) return
      } while (this.readAgain)
    }
    this.reading = run().finally(() => {
      if (mine === this.gen) this.reading = null
    })
    return this.reading
  }

  private async readOnce(mine: number): Promise<void> {
    const route = PROJECT_ROUTES.list()
    const answer = await this.ask(route.method, route.path)
    if (mine !== this.gen) return
    const list = readProjectList(answer.status, answer.body)
    if (!list.ok) {
      this.problem = list.message
      this.emit()
      return
    }
    this.list = list.value
    this.problem = list.value.skipped > 0 ? "Some of Prometheus's projects couldn't be read." : null
    // The suggestions are the owner's. A hiccup reading them costs nothing: the ones we have stay.
    if (list.value.role === 'owner') {
      const sr = PROJECT_ROUTES.suggestions()
      const sug = await this.ask(sr.method, sr.path)
      if (mine !== this.gen) return
      const read = readSuggestions(sug.status, sug.body)
      if (read.ok) this.suggestions = read.value.suggestions
    } else {
      this.suggestions = {}
    }
    this.emit()
  }

  /** One thing the window asked for. Refused without a request unless this Prometheus serves projects. */
  async run(op: ChatProjectsOp): Promise<ChatProjectsResult> {
    if (!this.available) return refusal(404, null)
    const mine = this.gen
    switch (op.op) {
      case 'refresh':
        await this.refresh()
        return { ok: true }
      case 'create': {
        const r = PROJECT_ROUTES.create(op.name, op.importKey ? { importKey: op.importKey } : {})
        const read = readProjectWrite(...(await this.askArgs(r)))
        if (!read.ok || mine !== this.gen) return read.ok ? { ok: true, project: read.value.project } : read
        this.upsert(read.value.project)
        void this.refresh()
        return { ok: true, project: read.value.project, created: read.value.created }
      }
      case 'rename': {
        const r = PROJECT_ROUTES.rename(op.id, op.name)
        const read = readProjectWrite(...(await this.askArgs(r)))
        if (!read.ok) return this.afterRefusal(read)
        if (mine === this.gen) this.upsert(read.value.project)
        void this.refresh()
        return { ok: true, project: read.value.project }
      }
      case 'remove': {
        const r = PROJECT_ROUTES.remove(op.id)
        const read = readProjectDeleted(...(await this.askArgs(r)))
        if (!read.ok) return this.afterRefusal(read)
        if (mine === this.gen) {
          if (this.list) this.list = { ...this.list, projects: this.list.projects.filter((p) => p.id !== op.id) }
          for (const [sid, pid] of Object.entries(this.filings)) if (pid === op.id) delete this.filings[sid]
          this.emit()
        }
        void this.refresh()
        return { ok: true, unfiled: read.value.unfiled }
      }
      case 'file': {
        const r = PROJECT_ROUTES.file(op.sessionId, op.projectId, { keep: op.keep, replace: op.replace, device: op.device })
        const read = readFiled(...(await this.askArgs(r)))
        if (!read.ok) return this.afterRefusal(read)
        if (mine === this.gen) {
          if (read.value.projectId) this.filings[read.value.sessionId] = read.value.projectId
          else delete this.filings[read.value.sessionId]
          delete this.suggestions[read.value.sessionId]
          this.emit()
        }
        void this.refresh()
        return { ok: true, sessionId: read.value.sessionId, workspace: read.value.workspace }
      }
      case 'start': {
        const r = PROJECT_ROUTES.start(op.projectId)
        const read = readStarted(...(await this.askArgs(r)))
        if (!read.ok) return this.afterRefusal(read)
        if (mine === this.gen && read.value.projectId) {
          this.filings[read.value.sessionId] = read.value.projectId
          this.emit()
        }
        void this.refresh()
        return { ok: true, sessionId: read.value.sessionId, workspace: read.value.workspace }
      }
    }
  }

  /** A project that is no longer there (or that this Beacon may not touch) means the list on screen is out of date. */
  private afterRefusal<T>(read: Read<T> & { ok: false }): Read<T> & { ok: false } {
    if (read.kind === 'unknown_project' || read.kind === 'not_owner') void this.refresh()
    return read
  }

  private upsert(project: ProjectList['projects'][number]): void {
    const list: ProjectList = this.list ?? { role: 'owner', rev: null, projects: [], skipped: 0 }
    const at = list.projects.findIndex((p) => p.id === project.id)
    const projects = at >= 0 ? list.projects.map((p) => (p.id === project.id ? project : p)) : [...list.projects, project]
    this.list = { ...list, projects }
    this.emit()
  }

  private async ask(method: string, path: string, body?: unknown): Promise<{ status: number; body: unknown }> {
    try {
      return await this.deps.request(method, path, body)
    } catch {
      return { status: 0, body: null }
    }
  }

  private async askArgs(r: { method: string; path: string; body?: unknown }): Promise<[number, unknown]> {
    const a = await this.ask(r.method, r.path, r.body)
    return [a.status, a.body]
  }

  private emit(): void {
    this.deps.onState(this.state())
  }
}
