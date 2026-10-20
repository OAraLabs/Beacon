// Staging a file for a chat_upload — the renderer half, shared by BOTH composers.
//
// This lived inside ChatShell until 2026-09-14, when the home screen grew the same controls. Two
// copies of "read a File, refuse it if it is too big" is how the two composers drift: the home one
// still carried `(Enter to start, Shift+Enter for newline)` in its placeholder months after the
// thread composer lost it. One reader, one refusal rule, both surfaces.
//
// FileReader is a DOM API, so this is renderer-only rather than @shared.

import { base64FromDataUrl, CHAT_UPLOAD_SAFE_BYTES, oversizeAttachmentNotice } from '@shared/attachments'

/** A file staged in a composer (read to a data URL) before it is sent as a chat_upload. */
export interface PendingFile {
  dataUrl: string
  base64: string
  mimeType: string
  name: string
  isImage: boolean
  size: number
}

/** Read a File to a data URL, splitting out the raw base64 the upload frame carries. */
export function readAttachment(file: File): Promise<PendingFile> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const dataUrl = String(reader.result ?? '')
      resolve({
        dataUrl,
        base64: base64FromDataUrl(dataUrl),
        mimeType: file.type || 'application/octet-stream',
        name: file.name,
        isImage: (file.type || '').startsWith('image/'),
        size: file.size
      })
    }
    reader.onerror = () => reject(reader.error ?? new Error('file read failed'))
    reader.readAsDataURL(file)
  })
}

/**
 * Stage a batch: read what fits, and say out loud what did not.
 *
 * Oversize files are REFUSED HERE, visibly, before any bytes are read. The cap mirrors the
 * daemon's own 20 MB upload guard (see CHAT_UPLOAD_SAFE_BYTES); past its 32 MiB frame limit the
 * socket just closes 1009, so a local refusal naming the size beats a dropped connection.
 *
 * (History: this constant was 700 KB because the daemon's WS library capped frames at 1 MiB by
 * default and an oversize frame vanished in SILENCE — measured 2026-08-28. Prometheus e9a41f4
 * raised that limit the same day. The refusal stays load-bearing either way; only the number
 * moved.)
 */
export async function stageFiles(files: FileList | File[]): Promise<{ ok: PendingFile[]; note: string }> {
  const arr = Array.from(files)
  if (arr.length === 0) return { ok: [], note: '' }
  const fits = arr.filter((f) => f.size <= CHAT_UPLOAD_SAFE_BYTES)
  const refused = arr.filter((f) => f.size > CHAT_UPLOAD_SAFE_BYTES)
  const note = refused.map((f) => oversizeAttachmentNotice(f.name, f.size)).join(' ')
  if (fits.length === 0) return { ok: [], note }
  const read = await Promise.all(fits.map((f) => readAttachment(f).catch(() => null)))
  return { ok: read.filter((x): x is PendingFile => x !== null), note }
}
