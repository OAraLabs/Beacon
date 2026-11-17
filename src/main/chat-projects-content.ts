// A project's instructions and reference files on the Prometheus (@shared/chat-projects-content), asked on behalf of the window.
//
// One of these is made for each connection, like the hub, and asks THAT connection. It asks nothing of a Prometheus that has not said
// it serves projects. The window never names a path on this computer: the files to upload are chosen in the system's own panel, and
// the place a file is saved is too, both opened here in main.

import { lstat, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename } from 'node:path'
import { refusal, type ChatProjectError } from '@shared/chat-projects'
import {
  CONTENT_ROUTES,
  MAX_FILE_BYTES,
  readFileDeleted,
  readFileWritten,
  readFiles,
  readInstructions,
  readInstructionsSaved,
  type ContentOp,
  type ContentResult,
  type ProjectFile
} from '@shared/chat-projects-content'
import type { ProjectsRequest } from './chat-projects'

export type ProjectsBytes = (
  method: string,
  path: string,
  opts: { replace?: boolean; body?: Buffer; maxBytes: number }
) => Promise<{ status: number; body: unknown; bytes: Buffer | null; contentType: string | null }>

/** The system's panels, made by whoever called (they belong to the window that asked). */
export interface ContentPanels {
  /** Files to add, as paths (one only when `multiple` is false); null when the person closed the panel. */
  pickFiles(multiple: boolean): Promise<string[] | null>
  /** Where to save, as a path; null when the person closed the panel. */
  pickSaveAs(defaultName: string): Promise<string | null>
}

/** A refusal that is not one the Prometheus gave: said in Beacon's own words. */
const own = (kind: 'io_error' | 'too_large' | 'bad_name' | 'unreachable', message: string): ChatProjectError => ({ ok: false, kind, message, status: 0 })

/** What ends an upload of several files: the answer would be the same for the next one. */
const ENDS_UPLOAD = new Set(['unreachable', 'not_owner', 'unsupported', 'unknown_project', 'too_many', 'folder_missing'])

export class ChatProjectContent {
  constructor(
    private readonly deps: {
      request: ProjectsRequest
      bytes: ProjectsBytes
      /** The Prometheus has said it serves projects. */
      available: () => boolean
      /** This is still the connection Beacon is on: a connection that was replaced writes nothing and shows nothing. */
      isCurrent: () => boolean
      /** Marks a saved file as having come from another computer (src/main/quarantine.ts). Called on the file before it takes its place,
       *  so it is never there unmarked; whether it could be marked does not change whether the file was saved. */
      markDownloaded?: (path: string) => Promise<boolean>
    }
  ) {}

  async run(op: ContentOp, panels: ContentPanels): Promise<ContentResult> {
    if (!this.deps.available()) return refusal(404, null)
    const gone = (): ContentResult => refusal(0, null)
    const ask = async (r: { method: string; path: string; body?: unknown }): Promise<[number, unknown]> => {
      try {
        const a = await this.deps.request(r.method, r.path, r.body)
        return [a.status, a.body]
      } catch {
        return [0, null]
      }
    }
    switch (op.op) {
      case 'instructions': {
        const read = readInstructions(...(await ask(CONTENT_ROUTES.instructions(op.id))))
        if (!this.deps.isCurrent()) return gone()
        return read.ok ? { ok: true, instructions: read.value } : read
      }
      case 'save-instructions': {
        const read = readInstructionsSaved(...(await ask(CONTENT_ROUTES.saveInstructions(op.id, op.content, op.baseRev, op.shadowOk === true))))
        if (!this.deps.isCurrent()) return gone()
        return read.ok ? { ok: true, rev: read.value.rev } : read
      }
      case 'files': {
        const read = readFiles(...(await ask(CONTENT_ROUTES.files(op.id))))
        if (!this.deps.isCurrent()) return gone()
        return read.ok ? { ok: true, files: read.value } : read
      }
      case 'delete-file': {
        const read = readFileDeleted(...(await ask(CONTENT_ROUTES.deleteFile(op.id, op.name))))
        if (!this.deps.isCurrent()) return gone()
        return read.ok ? { ok: true } : read
      }
      case 'upload':
        return this.upload(op.id, op.replace === true, panels, op.name)
      case 'download':
        return this.download(op.id, op.name, panels)
    }
  }

  private async upload(id: string, replace: boolean, panels: ContentPanels, asName?: string): Promise<ContentResult> {
    const picked = await panels.pickFiles(asName === undefined)
    if (!this.deps.isCurrent()) return refusal(0, null)
    if (!picked || picked.length === 0) return { ok: true, cancelled: true }
    const uploaded: ProjectFile[] = []
    const existing: string[] = []
    const failed: Array<{ name: string; message: string }> = []
    let stop: ChatProjectError | null = null
    // Putting a file in the place of one reference file: the one the person chose, under that file's name, and nothing else.
    for (const path of asName === undefined ? picked : picked.slice(0, 1)) {
      const name = asName ?? basename(path)
      if (stop) {
        failed.push({ name, message: `Not sent. ${stop.message}` })
        continue
      }
      const file = await readLocal(path)
      if (!file.ok) {
        failed.push({ name, message: file.message })
        continue
      }
      const r = CONTENT_ROUTES.putFile(id, name, replace)
      let answer: { status: number; body: unknown }
      try {
        answer = await this.deps.bytes(r.method, r.path, { replace: r.replace, body: file.bytes, maxBytes: MAX_FILE_BYTES })
      } catch {
        // A name the transport will not put in a path (a backslash): the Prometheus is never asked.
        failed.push({ name, message: refusal(400, { kind: 'bad_name' }).message })
        continue
      }
      if (!this.deps.isCurrent()) return refusal(0, null)
      const read = readFileWritten(answer.status, answer.body)
      if (read.ok) uploaded.push(read.value)
      else if (read.kind === 'exists') existing.push(name)
      else {
        failed.push({ name, message: read.message })
        if (ENDS_UPLOAD.has(read.kind)) stop = read
      }
    }
    return { ok: true, uploaded, existing, failed }
  }

  private async download(id: string, name: string, panels: ContentPanels): Promise<ContentResult> {
    const target = await panels.pickSaveAs(name)
    if (!this.deps.isCurrent()) return refusal(0, null)
    if (!target) return { ok: true, cancelled: true }
    const r = CONTENT_ROUTES.getFile(id, name)
    let answer: { status: number; body: unknown; bytes: Buffer | null }
    try {
      answer = await this.deps.bytes(r.method, r.path, { maxBytes: MAX_FILE_BYTES })
    } catch {
      return refusal(400, { kind: 'bad_name' })
    }
    if (!this.deps.isCurrent()) return refusal(0, null)
    if (answer.status !== 200 || !answer.bytes) return refusal(answer.status, answer.body)
    // Beside it first, then moved into place: a write that fails part way never leaves a half file where the person chose, or takes the
    // place of one that was there.
    const part = `${target}.beacon-part`
    try {
      await writeFile(part, answer.bytes)
      // A marker that throws, or rejects, never fails the save.
      await Promise.resolve()
        .then(() => this.deps.markDownloaded?.(part))
        .catch(() => false)
      await rename(part, target)
    } catch {
      await rm(part, { force: true }).catch(() => undefined)
      return own('io_error', "Beacon couldn't save the file there.")
    }
    return { ok: true, saved: true }
  }
}

/** A file the person chose, read whole, if it is a plain file within the limit. Checked before it is read: a file of any size is never loaded to find out. */
async function readLocal(path: string): Promise<{ ok: true; bytes: Buffer } | { ok: false; message: string }> {
  try {
    const st = await lstat(path).catch(() => null)
    // The panel returns the file as chosen; a link to a file is a file (the person chose it), a folder or anything else is not.
    const real = st?.isSymbolicLink() ? await stat(path) : st
    if (!st) return { ok: false, message: "Beacon couldn't read that file." }
    if (!real || !real.isFile()) return { ok: false, message: 'That is not a plain file.' }
    if (real.size > MAX_FILE_BYTES) return { ok: false, message: refusal(413, null).message }
    const bytes = await readFile(path)
    if (bytes.byteLength > MAX_FILE_BYTES) return { ok: false, message: refusal(413, null).message }
    return { ok: true, bytes }
  } catch {
    return { ok: false, message: "Beacon couldn't read that file." }
  }
}
