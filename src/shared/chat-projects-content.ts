// A project's instructions and reference files on the Prometheus (the daemon's chat projects, design 3.5): what Beacon asks, how each answer
// is read, and what the window may ask of main. Against what a REAL daemon answered (`content` in src/main/fixtures/chat_projects.json).
//
// The instructions are one text file (PROMETHEUS.md) in the project's folder, read by every conversation filed in it; the reference files are
// files in that folder. They live on the Prometheus's computer: Beacon shows and changes them there and keeps no copy. A save carries the
// revision it was made from, so an edit made elsewhere in the meantime is a conflict to show, never an overwrite.
//
// No Node/Electron imports (same rule as the rest of src/shared).

import { refusal, type ChatProjectError, type Read } from './chat-projects'

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null)
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
/** A 200 that cannot be read, or any other status: the refusal it is. */
const notReadable = (status: number, body: unknown): ChatProjectError => (status === 200 ? { ok: false, kind: 'failed', message: refusal(500, null).message, status } : refusal(status, body))

export interface InstructionsFile {
  /** Where the loader reads it, on that computer. */
  path: string
  chars: number
  /** Over the per-file limit: the loader reads only the start. */
  truncated: boolean
  /** Past the total limit, or not stacked: the loader does not read it for this conversation. */
  omitted: boolean
  /** An earlier convention file at the same level wins: the file that does. */
  shadowedBy: string | null
  symlink: boolean
}

export interface Instructions {
  content: string
  /** The revision to send with a save. Empty for no instructions yet. */
  rev: string
  /** The most characters the loader reads from one file. */
  maxChars: number
  /** What the loader reads for a conversation in this folder, deepest first. */
  effective: InstructionsFile[]
}

/** GET /api/chat-projects/{id}/instructions */
export function readInstructions(status: number, body: unknown): Read<Instructions> {
  if (status !== 200 || !isObj(body) || typeof body.content !== 'string' || typeof body.rev !== 'string') return notReadable(status, body)
  const effective: InstructionsFile[] = []
  for (const f of Array.isArray(body.effective) ? body.effective : []) {
    if (!isObj(f) || typeof f.path !== 'string') continue
    effective.push({ path: f.path, chars: num(f.chars), truncated: f.truncated === true, omitted: f.omitted === true, shadowedBy: str(f.shadowed_by), symlink: f.symlink === true })
  }
  return { ok: true, value: { content: body.content, rev: body.rev, maxChars: num(body.max_chars) > 0 ? num(body.max_chars) : 12_000, effective } }
}

/** PUT /api/chat-projects/{id}/instructions: the new revision. A `conflict` refusal carries the current text and revision; `would_shadow` the files. */
export function readInstructionsSaved(status: number, body: unknown): Read<{ rev: string }> {
  if (status !== 200 || !isObj(body) || body.ok !== true || typeof body.rev !== 'string') return notReadable(status, body)
  return { ok: true, value: { rev: body.rev } }
}

export interface ProjectFile {
  name: string
  size: number
  /** epoch ms */
  modified: number
  mime: string | null
}

function readFile(v: unknown): ProjectFile | null {
  if (!isObj(v) || typeof v.name !== 'string' || !v.name) return null
  return { name: v.name, size: num(v.size), modified: num(v.mtime) * 1000, mime: str(v.mime) }
}

/** GET /api/chat-projects/{id}/files */
export function readFiles(status: number, body: unknown): Read<ProjectFile[]> {
  if (status !== 200 || !isObj(body) || !Array.isArray(body.files)) return notReadable(status, body)
  const out: ProjectFile[] = []
  for (const f of body.files) {
    const p = readFile(f)
    if (p) out.push(p)
  }
  return { ok: true, value: out }
}

/** PUT /api/chat-projects/{id}/files/{name} */
export function readFileWritten(status: number, body: unknown): Read<ProjectFile> {
  if (status !== 200 || !isObj(body) || body.ok !== true) return notReadable(status, body)
  const f = readFile(body.file)
  return f ? { ok: true, value: f } : notReadable(200, null)
}

/** DELETE /api/chat-projects/{id}/files/{name} */
export function readFileDeleted(status: number, body: unknown): Read<true> {
  return status === 200 && isObj(body) && body.ok === true ? { ok: true, value: true } : notReadable(status, body)
}

// ── What Beacon asks ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

const enc = encodeURIComponent
export const CONTENT_ROUTES = {
  instructions: (id: string) => ({ method: 'GET', path: `/api/chat-projects/${enc(id)}/instructions` }),
  saveInstructions: (id: string, content: string, baseRev: string, shadowOk = false) => ({
    method: 'PUT',
    path: `/api/chat-projects/${enc(id)}/instructions`,
    body: { content, base_rev: baseRev, ...(shadowOk ? { shadow_ok: true } : {}) }
  }),
  files: (id: string) => ({ method: 'GET', path: `/api/chat-projects/${enc(id)}/files` }),
  /** The raw bytes are the request body (not base64, not multipart); `replace` is a query parameter. */
  putFile: (id: string, name: string, replace: boolean) => ({ method: 'PUT', path: `/api/chat-projects/${enc(id)}/files/${enc(name)}`, replace }),
  getFile: (id: string, name: string) => ({ method: 'GET', path: `/api/chat-projects/${enc(id)}/files/${enc(name)}` }),
  deleteFile: (id: string, name: string) => ({ method: 'DELETE', path: `/api/chat-projects/${enc(id)}/files/${enc(name)}` })
} as const

/** The path a request is made to: the route's, with `?replace=true` when it overwrites. The daemon's own spelling. */
export const withReplace = (path: string, replace: boolean): string => (replace ? `${path}?replace=true` : path)

/** The most a reference file may be: the daemon refuses more (413). Checked before reading a file into memory. */
export const MAX_FILE_BYTES = 20 * 1024 * 1024

// ── What the window may ask of main ──────────────────────────────────────────────────────────────────────────────────────────────

export type ContentOp =
  | { op: 'instructions'; id: string }
  | { op: 'save-instructions'; id: string; content: string; baseRev: string; shadowOk?: boolean }
  | { op: 'files'; id: string }
  /** Main opens the system's file picker, so no path ever comes from the page. `replace`: overwrite a file of the same name.
   *  `name` (with `replace`): choose ONE file to put in the place of that reference file, under that file's name. */
  | { op: 'upload'; id: string; replace?: boolean; name?: string }
  /** Main opens the system's save panel. */
  | { op: 'download'; id: string; name: string }
  | { op: 'delete-file'; id: string; name: string }

export type ContentResult =
  | {
      ok: true
      instructions?: Instructions
      rev?: string
      files?: ProjectFile[]
      /** `upload`: what went up, what is already there (not replaced), and what failed with why. */
      uploaded?: ProjectFile[]
      existing?: string[]
      failed?: Array<{ name: string; message: string }>
      /** `upload` and `download`: the person closed the panel without choosing. */
      cancelled?: boolean
      saved?: boolean
    }
  | ChatProjectError

/** The shape of an op the page sent, checked in main. An id and a name go into a path: one printable segment, never `.` or `..`. */
export function validContentOp(raw: unknown): ContentOp | null {
  if (!isObj(raw) || typeof raw.op !== 'string') return null
  // A name is sent encoded (`encodeURIComponent`), so only what cannot be one segment of a file name is refused here.
  const seg = (v: unknown, max: number, isName: boolean): string | null =>
    typeof v === 'string' && v.length > 0 && v.length <= max && !/[\x00-\x1f\x7f/\\]/.test(v) && v !== '.' && v !== '..' && (isName || /^[\x21-\x7e]+$/.test(v)) && (isName || !/[?#%]/.test(v)) ? v : null
  const id = seg(raw.id, 120, false)
  if (!id) return null
  switch (raw.op) {
    case 'instructions':
      return { op: 'instructions', id }
    case 'files':
      return { op: 'files', id }
    case 'save-instructions': {
      if (typeof raw.content !== 'string' || raw.content.length > 1_000_000 || typeof raw.baseRev !== 'string' || raw.baseRev.length > 100) return null
      if (raw.shadowOk !== undefined && typeof raw.shadowOk !== 'boolean') return null
      return { op: 'save-instructions', id, content: raw.content, baseRev: raw.baseRev, ...(raw.shadowOk ? { shadowOk: true } : {}) }
    }
    case 'upload': {
      if (raw.replace !== undefined && typeof raw.replace !== 'boolean') return null
      if (raw.name === undefined) return { op: 'upload', id, ...(raw.replace ? { replace: true } : {}) }
      // Putting a file in the place of one: only ever with replace, and the name is a name.
      const name = raw.replace === true ? seg(raw.name, 120, true) : null
      return name ? { op: 'upload', id, replace: true, name } : null
    }
    case 'download':
    case 'delete-file': {
      const name = seg(raw.name, 120, true)
      return name ? { op: raw.op, id, name } : null
    }
  }
  return null
}
