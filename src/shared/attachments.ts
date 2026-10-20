// Pure attachment helpers — shared by the renderer composer, the main-process WS sender, and the
// headless smoke. NO DOM, NO `ws`, NO Node: just the wire-shape + data-URL math, so every layer
// builds the SAME `chat_upload` frame the daemon expects (prometheus ws_server.py `_handle_file_upload`).

import type { ChatUploadRequest } from './ipc'

/** The exact daemon `chat_upload` WS frame (:8010). snake_case payload; caption defaults to '' (the
 * daemon treats an empty caption as "no caption"). One frame per file; text rides as the caption on
 * the LAST file (matches the web client). */
export interface ChatUploadFrame {
  type: 'chat_upload'
  payload: {
    session_id: string
    filename: string
    content_base64: string
    mime_type: string
    caption: string
  }
}

/**
 * Largest attachment (raw bytes, pre-base64) a chat_upload frame can safely carry. This matches
 * the daemon's own upload guard: _handle_file_upload refuses anything over 20 MB decoded (with a
 * visible "File too large" message), and since Prometheus#327 (deployed 2026-08-28) its WS frame
 * limit is 32 MiB — comfortably above 20 MB as base64 (~26.7 MB) + envelope, so a frame this size
 * arrives instead of being dropped at the socket. (History: the library's old 1 MiB default
 * silently ate any real screenshot — measured live 2026-08-28, probe-a3-size — which is why this
 * constant existed at 700 KB. Past the daemon's 32 MiB frame limit the socket still closes 1009,
 * so this client-side refusal stays load-bearing, not cosmetic.)
 */
export const CHAT_UPLOAD_SAFE_BYTES = 20 * 1024 * 1024

/** The visible refusal for an oversize attachment. Names the limit and the actual size. */
export function oversizeAttachmentNotice(name: string, size: number): string {
  const mb = (n: number): string => `${(n / (1024 * 1024)).toFixed(1)} MB`
  return `${name} is ${mb(size)} — larger than the ${Math.round(CHAT_UPLOAD_SAFE_BYTES / (1024 * 1024))} MB the daemon accepts, so it was not attached.`
}

/**
 * Paste-as-file threshold (PARITY-PLAN A5): a paste longer than this becomes a .txt attachment
 * chip instead of composer text. Chosen so that pasted logs/files stop drowning the draft while
 * an ordinary long paragraph (a few hundred words) still lands as editable text.
 */
export const PASTE_AS_FILE_CHARS = 8000

/** paste-YYYYMMDD-HHMMSS.txt — same local-time mint as screenshots, same reasons. */
export function pasteFilename(epochMs: number): string {
  const d = new Date(epochMs)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `paste-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.txt`
}

/** UTF-8 text → base64, chunked so a multi-hundred-KB paste never blows the argument limit of
 * String.fromCharCode. Pure (TextEncoder + btoa exist in the renderer and in node ≥ 16). */
export function base64FromText(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let bin = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  return btoa(bin)
}

/** Byte length the paste will occupy on the wire (the guard compares BYTES, not chars). */
export function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).length
}

export function chatUploadFrame(req: ChatUploadRequest): ChatUploadFrame {
  return {
    type: 'chat_upload',
    payload: {
      session_id: req.sessionId,
      filename: req.filename,
      content_base64: req.contentBase64,
      mime_type: req.mimeType,
      caption: req.caption ?? ''
    }
  }
}

/** Strip the "data:<mime>;base64,<b64>" prefix from a FileReader data URL → raw base64. The daemon
 * wants the bare base64 (no prefix). Returns '' if there's no comma (defensive; never throws). */
export function base64FromDataUrl(dataUrl: string): string {
  const comma = dataUrl.indexOf(',')
  return comma >= 0 ? dataUrl.slice(comma + 1) : ''
}
