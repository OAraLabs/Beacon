// Projects on the Prometheus (the daemon's chat projects: docs/design/chat-projects.md there). A project is a named folder on that
// Prometheus's computer with standing instructions and reference files, and a conversation filed in it works in that folder. They
// live on each Prometheus separately: an id from one means nothing to another, and nothing here ever merges two.
//
// This file is the wire and nothing else: what Beacon asks, how each answer is read, and what each refusal is called, in words a
// person can act on. What each answer means is decided here, against what a REAL Prometheus answered
// (src/main/fixtures/chat_projects.json, recorded by scripts/record-chat-projects.py from the daemon's own routes).
//
// GATED on the daemon saying it serves projects (`projects` in the `subscribed` reply's server_capabilities). A Prometheus that does
// not say so is asked nothing and changes nothing: its projects stay the local ones, exactly as they are.
//
// No Node/Electron imports (same rule as the rest of src/shared).

/** What a Prometheus lists in the `subscribed` reply's `server_capabilities` when it serves chat projects. */
export const CHAT_PROJECTS_CAPABILITY = 'projects'

/** Whether a `subscribed` reply's payload lists that capability. Anything malformed is "no". */
export function advertisesChatProjects(subscribedPayload: unknown): boolean {
  const caps = (subscribedPayload as { server_capabilities?: unknown } | null | undefined)?.server_capabilities
  return Array.isArray(caps) && caps.includes(CHAT_PROJECTS_CAPABILITY)
}

export interface ChatProject {
  /** The daemon's id (`cp_` and twelve hex). Only meaningful to the Prometheus that made it. */
  id: string
  name: string
  /** Absolute, on that Prometheus's computer. */
  folder: string
  /** True: Prometheus made the folder under its projects root. False: the owner picked a folder that was already there. */
  folderManaged: boolean
  instructionsChars: number
  /** Changes whenever the instructions file does; the `base_rev` of a save. */
  instructionsRev: string
  files: number
  sessions: number
  /** What a client said when it made the project (`beacon-desktop:<local id>` for one moved from this computer), or null. */
  importKey: string | null
  /** epoch ms */
  createdAt: number
  updatedAt: number
}

export type ChatProjectErrorKind =
  | 'unsupported' // this Prometheus has no projects (404 with no kind, or `unavailable`)
  | 'not_owner' // 401 / 403: this Beacon is not an owner of that Prometheus
  | 'name_taken'
  | 'name_required'
  | 'folder_in_use'
  | 'bad_folder'
  | 'unknown_project'
  | 'unknown_session'
  | 'machine_session'
  | 'workspace_set' // 409: the conversation already works in a folder somebody chose; ask, then say keep or replace
  | 'device_session' // 409: a chat-only device's conversation; ask, then say so or keep it as a label
  | 'unreachable' // no answer
  | 'failed'

export interface ChatProjectError {
  ok: false
  kind: ChatProjectErrorKind
  /** Beacon's words, for the person. Never a status code, a route or a daemon kind. */
  message: string
  status: number
  /** The daemon's own sentence, for the kinds where it says something specific (`bad_folder`: why the folder can't be used). */
  reason?: string
  /** `workspace_set`: the folder the conversation already works in. */
  workspace?: string
}
export type Read<T> = { ok: true; value: T } | ChatProjectError

const WORDS: Record<ChatProjectErrorKind, string> = {
  unsupported: "This Prometheus doesn't have projects yet.",
  not_owner: "This Beacon isn't an owner of this Prometheus, so it can't change projects.",
  name_taken: 'Another project already has that name.',
  name_required: 'A project needs a name.',
  folder_in_use: 'Another project already uses that folder.',
  bad_folder: "Prometheus can't use that folder.",
  unknown_project: 'That project is gone. The list will refresh.',
  unknown_session: "Prometheus doesn't have that conversation any more.",
  machine_session: "That conversation is run by Prometheus itself, so it can't go in a project.",
  workspace_set: 'That conversation already works in a folder that was chosen for it.',
  device_session: 'That conversation belongs to a phone that can only chat.',
  unreachable: "Couldn't reach Prometheus. Try again.",
  failed: "That didn't work. Try again."
}

export function chatProjectWords(kind: ChatProjectErrorKind): string {
  return WORDS[kind]
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null)

/** The refusal an answer is. The daemon's own `kind` is believed where it is one Beacon knows; anything else is read from the status. */
export function refusal(status: number, body: unknown): ChatProjectError {
  const kind = isObj(body) ? str(body.kind) : null
  const error = isObj(body) ? str(body.error) : null
  const err = (k: ChatProjectErrorKind): ChatProjectError => ({
    ok: false,
    kind: k,
    message: WORDS[k],
    status,
    ...(k === 'bad_folder' && error ? { reason: error } : {}),
    ...(k === 'workspace_set' && isObj(body) && typeof body.workspace === 'string' ? { workspace: body.workspace } : {})
  })
  if (status === 0) return err('unreachable')
  if (status === 401 || status === 403) return err('not_owner')
  switch (kind) {
    case 'name_taken':
    case 'name_required':
    case 'folder_in_use':
    case 'bad_folder':
    case 'unknown_project':
    case 'unknown_session':
    case 'machine_session':
    case 'workspace_set':
    case 'device_session':
      return err(kind)
    case 'unavailable':
      return err('unsupported')
  }
  // A Prometheus with no projects answers 404 with no kind at all (the framework's own "not found"). A 404 that DOES carry a kind
  // we do not know is a daemon that serves projects saying something newer: that is a failure, not "no projects".
  if ((status === 404 || status === 405) && kind === null) return err('unsupported')
  return err('failed')
}

/** An answer that was not what the route says it sends: a 200 that cannot be read is a failure, said the same way; any other status is
 *  the refusal it is. */
function notReadable(status: number, body: unknown): ChatProjectError {
  return status === 200 || status === 201 ? { ok: false, kind: 'failed', message: WORDS.failed, status } : refusal(status, body)
}

function readProject(v: unknown, chatOnly = false): ChatProject | null {
  if (!isObj(v)) return null
  const id = str(v.id)
  const name = str(v.name)
  // A device that may only chat is told a project's id, name and conversation count, and not where it is: no folder.
  const folder = str(v.folder) ?? (chatOnly ? '' : null)
  if (!id || name === null || folder === null || (!chatOnly && !folder)) return null
  const num = (x: unknown): number => (typeof x === 'number' && Number.isFinite(x) ? x : 0)
  return {
    id,
    name,
    folder,
    folderManaged: v.folder_managed === true,
    instructionsChars: num(v.instructions_chars),
    instructionsRev: str(v.instructions_rev) ?? '',
    files: num(v.files),
    sessions: num(v.sessions),
    importKey: str(v.import_key),
    createdAt: num(v.created_at) * 1000,
    updatedAt: num(v.updated_at) * 1000
  }
}

export interface ProjectList {
  /** `chat_only`: a device that may only chat is told nothing (an empty list). */
  role: 'owner' | 'chat_only'
  /** The change counter an owner's list carries; null for a chat-only device. */
  rev: number | null
  /** In the daemon's display (creation) order. */
  projects: ChatProject[]
  /** Entries in the answer that were not readable as a project. Never silently zero: the caller can say so. */
  skipped: number
}

/** GET /api/chat-projects */
export function readProjectList(status: number, body: unknown): Read<ProjectList> {
  if (status !== 200 || !isObj(body) || !Array.isArray(body.projects)) return notReadable(status, body)
  const projects: ChatProject[] = []
  let skipped = 0
  const chatOnly = body.role === 'chat_only'
  for (const raw of body.projects) {
    const p = readProject(raw, chatOnly)
    if (p) projects.push(p)
    else skipped++
  }
  const role = chatOnly ? 'chat_only' : 'owner'
  return { ok: true, value: { role, rev: typeof body.rev === 'number' && Number.isFinite(body.rev) ? body.rev : null, projects, skipped } }
}

/** POST /api/chat-projects, PUT /api/chat-projects/{id}: the project, and whether the daemon made it now (`created`) or had it. */
export function readProjectWrite(status: number, body: unknown): Read<{ project: ChatProject; created: boolean | null }> {
  if ((status !== 200 && status !== 201) || !isObj(body) || body.ok !== true) return notReadable(status, body)
  const project = readProject(body.project)
  if (!project) return notReadable(200, null)
  return { ok: true, value: { project, created: typeof body.created === 'boolean' ? body.created : null } }
}

/** DELETE /api/chat-projects/{id}: how many conversations it left unfiled. The folder and every file in it stay. */
export function readProjectDeleted(status: number, body: unknown): Read<{ id: string; unfiled: number }> {
  if (status !== 200 || !isObj(body) || body.ok !== true || typeof body.id !== 'string') return notReadable(status, body)
  return { ok: true, value: { id: body.id, unfiled: typeof body.unfiled === 'number' ? body.unfiled : 0 } }
}

export interface Filed {
  sessionId: string
  /** The project it is in now; null when it was taken out. */
  projectId: string | null
  /** The folder the conversation works in now, or null. */
  workspace: string | null
}

/** PUT /api/sessions/{id}/project */
export function readFiled(status: number, body: unknown): Read<Filed> {
  if (status !== 200 || !isObj(body) || body.ok !== true || typeof body.session_id !== 'string') return notReadable(status, body)
  return { ok: true, value: { sessionId: body.session_id, projectId: str(body.chat_project_id), workspace: str(body.workspace) } }
}

/** POST /api/sessions (a conversation started inside a project). */
export function readStarted(status: number, body: unknown): Read<{ sessionId: string; projectId: string | null; workspace: string | null }> {
  if (status !== 200 || !isObj(body) || typeof body.session_id !== 'string') return notReadable(status, body)
  return { ok: true, value: { sessionId: body.session_id, projectId: str(body.chat_project_id), workspace: str(body.workspace) } }
}

export interface Suggestion {
  /** What the daemon grouped the conversation's tool calls by. */
  key: string
  label: string
  share: number
  calls: number
  /** The existing project accepting would file into; null: accepting makes a project named `label`. */
  project: { id: string; name: string } | null
}

/** GET /api/chat-project-suggestions: for each recent unfiled conversation, what the daemon suggests. */
export function readSuggestions(status: number, body: unknown): Read<{ suggestions: Record<string, Suggestion>; rev: number | null }> {
  if (status !== 200 || !isObj(body) || !isObj(body.suggestions)) return notReadable(status, body)
  // No prototype: a conversation id of `__proto__` is an ordinary key, not a way to set the object's prototype.
  const out: Record<string, Suggestion> = Object.create(null)
  for (const [sid, raw] of Object.entries(body.suggestions)) {
    if (!isObj(raw)) continue
    const key = str(raw.key)
    const label = str(raw.label)
    if (!key || !label) continue
    const p = isObj(raw.project) && typeof raw.project.id === 'string' && typeof raw.project.name === 'string' ? { id: raw.project.id, name: raw.project.name } : null
    out[sid] = { key, label, share: typeof raw.share === 'number' ? raw.share : 0, calls: typeof raw.calls === 'number' ? raw.calls : 0, project: p }
  }
  return { ok: true, value: { suggestions: out, rev: typeof body.rev === 'number' ? body.rev : null } }
}

export type ChangeKind = 'created' | 'updated' | 'deleted' | 'instructions' | 'files' | 'membership'
export interface ProjectChange {
  rev: number
  projectId: string | null
  change: ChangeKind | string
  sessionId: string | null
}

/** A `chat_project_changed` frame, or null for any other frame. The frame is a hint: the reader re-reads the list on a rev it does not have. */
export function readChangeFrame(frame: unknown): ProjectChange | null {
  if (!isObj(frame) || frame.type !== 'chat_project_changed' || !isObj(frame.payload)) return null
  const p = frame.payload
  if (typeof p.rev !== 'number' || !Number.isFinite(p.rev)) return null
  return { rev: p.rev, projectId: str(p.project_id), change: str(p.change) ?? 'unknown', sessionId: str(p.session_id) }
}

// ── What Beacon asks ─────────────────────────────────────────────────────────────────────────────────────────────────────────
// One place for the paths and bodies, so the hub, the migration and the smoke cannot spell a route two ways.

const enc = encodeURIComponent
export const PROJECT_ROUTES = {
  list: () => ({ method: 'GET', path: '/api/chat-projects' }),
  create: (name: string, o: { folder?: string; importKey?: string } = {}) => ({
    method: 'POST',
    path: '/api/chat-projects',
    body: { name, ...(o.folder !== undefined ? { folder: o.folder } : {}), ...(o.importKey !== undefined ? { import_key: o.importKey } : {}) }
  }),
  rename: (id: string, name: string) => ({ method: 'PUT', path: `/api/chat-projects/${enc(id)}`, body: { name } }),
  remove: (id: string) => ({ method: 'DELETE', path: `/api/chat-projects/${enc(id)}` }),
  /** `projectId` null takes the conversation out. `keep` files it as a label only: its folder is not touched. `replace` and `device` are
   *  the answers to the two questions the daemon can ask back (`workspace_set`, `device_session`). */
  file: (sessionId: string, projectId: string | null, o: { keep?: boolean; replace?: boolean; device?: boolean } = {}) => ({
    method: 'PUT',
    path: `/api/sessions/${enc(sessionId)}/project`,
    body: {
      chat_project_id: projectId,
      ...(o.keep ? { keep_workspace: true } : {}),
      ...(o.replace ? { replace_workspace: true } : {}),
      ...(o.device ? { device_session: true } : {})
    }
  }),
  start: (projectId: string) => ({ method: 'POST', path: '/api/sessions', body: { gateway: 'desktop', chat_project_id: projectId } }),
  suggestions: () => ({ method: 'GET', path: '/api/chat-project-suggestions' })
} as const

const IMPORT_KEY_HEAD = 'beacon-desktop:'
/** The `import_key` of a project moved from this computer: `beacon-desktop:<local id>`, printable ASCII with no space (the daemon refuses one), at most 200 characters. Null if
 *  the id would not make a key the daemon accepts: the caller then moves the project without one (and says it can't be re-run safely). */
export function importKey(localId: string): string | null {
  const key = `${IMPORT_KEY_HEAD}${localId}`
  return /^[\x21-\x7e]{1,200}$/.test(key) && localId.length > 0 ? key : null
}

// ── What the window sees and asks (the IPC between the page and main) ───────────────────────────────────────────────────────────────

/** What main knows about this Prometheus's projects. The page draws it and asks main to change it; it never asks the daemon itself. */
export interface ChatProjectsState {
  /** Beacon has heard what this Prometheus does (a `subscribed` reply), or has waited long enough to take silence for "no". Until then
   *  `available: false` means "not known yet", and a view must not act as if it were "no". */
  known: boolean
  /** This Prometheus said it serves projects. False: nothing below is read, nothing is asked, and the local projects are what there are. */
  available: boolean
  /** The projects, in the daemon's order; null until the first read (or while not available). */
  list: ProjectList | null
  /** Conversation id → the project it is filed in, from the daemon's session list. Unfiled ones are absent. */
  filings: Record<string, string>
  /** For each recent unfiled conversation, what the daemon suggests. Owner only; empty otherwise. */
  suggestions: Record<string, Suggestion>
  /** Beacon's words about the last read that failed, or null. The last good list stays on screen. */
  problem: string | null
}

export function noChatProjects(): ChatProjectsState {
  return { known: false, available: false, list: null, filings: {}, suggestions: {}, problem: null }
}

export type ChatProjectsOp =
  | { op: 'refresh' }
  | { op: 'create'; name: string; importKey?: string }
  | { op: 'rename'; id: string; name: string }
  | { op: 'remove'; id: string }
  | { op: 'file'; sessionId: string; projectId: string | null; keep?: boolean; replace?: boolean; device?: boolean }
  | { op: 'start'; projectId: string }

export type ChatProjectsResult =
  | { ok: true; project?: ChatProject; created?: boolean | null; sessionId?: string; unfiled?: number; workspace?: string | null }
  | ChatProjectError

/** The shape of an op the page sent, checked in main: a bad one is refused, never forwarded. */
export function validOp(raw: unknown): ChatProjectsOp | null {
  if (!isObj(raw) || typeof raw.op !== 'string') return null
  const s = (k: string, max = 200): string | null => (typeof raw[k] === 'string' && (raw[k] as string).length > 0 && (raw[k] as string).length <= max ? (raw[k] as string) : null)
  // An id goes into a path. It is one printable segment with nothing a URL parser would read as more: not `.` or `..` (encodeURIComponent
  // leaves dots alone, and the parser resolves them), no `/`, `\`, `?`, `#` or `%`.
  const ident = (k: string, max: number): string | null => {
    const v = s(k, max)
    return v !== null && /^[\x21-\x7e]+$/.test(v) && !/[/\\?#%]/.test(v) && v !== '.' && v !== '..' ? v : null
  }
  const id = ident('id', 120)
  switch (raw.op) {
    case 'refresh':
      return { op: 'refresh' }
    case 'create': {
      const name = s('name', 200)
      const key = raw.importKey === undefined ? undefined : s('importKey')
      return name && key !== null ? { op: 'create', name, ...(key ? { importKey: key } : {}) } : null
    }
    case 'rename': {
      const name = s('name', 200)
      return id && name ? { op: 'rename', id, name } : null
    }
    case 'remove':
      return id ? { op: 'remove', id } : null
    case 'file': {
      const sessionId = ident('sessionId', 256)
      const projectId = raw.projectId === null ? null : ident('projectId', 120)
      if (!sessionId || (raw.projectId !== null && projectId === null)) return null
      const flag = (k: string): boolean | null => (raw[k] === undefined ? false : raw[k] === true ? true : null)
      const keep = flag('keep')
      const replace = flag('replace')
      const device = flag('device')
      if (keep === null || replace === null || device === null) return null
      return { op: 'file', sessionId, projectId, ...(keep ? { keep } : {}), ...(replace ? { replace } : {}), ...(device ? { device } : {}) }
    }
    case 'start': {
      const projectId = ident('projectId', 120)
      return projectId ? { op: 'start', projectId } : null
    }
  }
  return null
}
