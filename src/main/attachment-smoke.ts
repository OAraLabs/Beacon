/**
 * Phase-4 attachment smoke (headless / ELECTRON_RUN_AS_NODE). Proves the PURE pieces of the upload
 * path that need no display and no live socket: the outbound `chat_upload` WS frame shape (must match
 * the daemon's ws_server.py `_handle_file_upload` contract), data-URL → base64 extraction, and the
 * image/file ContentPart model — including that the content_json adapter still DROPS unknown daemon
 * blocks, since the daemon has NO media block type (attachment parts are renderer-optimistic only).
 */
import {
  chatUploadFrame,
  base64FromDataUrl,
  base64FromText,
  PASTE_AS_FILE_CHARS,
  pasteFilename,
  utf8ByteLength
} from '@shared/attachments'
import { partsFromContentJson, type ContentPart } from '@shared/parts'

let failures = 0
function assert(cond: boolean, label: string): void {
  console.log(`[smoke] ${cond ? 'PASS' : 'FAIL'}  ${label}`)
  if (!cond) failures++
}
const j = (v: unknown): string => JSON.stringify(v)

// ── 1. chat_upload frame matches the daemon contract (snake_case, exact field set) ──
console.log('[smoke] === 1. chatUploadFrame wire shape ===')
const frame = chatUploadFrame({
  sessionId: 'desktop:smoke',
  filename: 'cat.png',
  contentBase64: 'QUJD',
  mimeType: 'image/png',
  caption: 'look at this'
})
assert(frame.type === 'chat_upload', `type === chat_upload (got ${frame.type})`)
assert(frame.payload.session_id === 'desktop:smoke', 'sessionId → session_id')
assert(frame.payload.filename === 'cat.png', 'filename carried')
assert(frame.payload.content_base64 === 'QUJD', 'contentBase64 → content_base64')
assert(frame.payload.mime_type === 'image/png', 'mimeType → mime_type')
assert(frame.payload.caption === 'look at this', 'caption carried')
assert(
  j(Object.keys(frame.payload).sort()) === j(['caption', 'content_base64', 'filename', 'mime_type', 'session_id']),
  'payload has EXACTLY the 5 daemon fields (no extras)'
)
// omitted caption → '' (daemon treats empty as "no caption"), never undefined → never serializes to null
const f2 = chatUploadFrame({ sessionId: 's', filename: 'd.pdf', contentBase64: 'eA==', mimeType: 'application/pdf' })
assert(f2.payload.caption === '', 'omitted caption → "" (not undefined)')

// ── 2. base64FromDataUrl strips the FileReader data-URL prefix ──
console.log('\n[smoke] === 2. base64FromDataUrl ===')
assert(base64FromDataUrl('data:image/png;base64,QUJD') === 'QUJD', 'strips data:…;base64, prefix')
assert(base64FromDataUrl('data:text/plain,SGk=') === 'SGk=', 'strips non-base64 data prefix (comma split)')
assert(base64FromDataUrl('QUJD') === '', 'no comma → "" (defensive, never throws)')
assert(base64FromDataUrl('') === '', 'empty → ""')

// ── 3. image/file ContentPart model + adapter still drops unknown daemon blocks ──
console.log('\n[smoke] === 3. parts model ===')
const img: ContentPart = { type: 'image', dataUrl: 'data:image/png;base64,QUJD' }
const file: ContentPart = { type: 'file', fileName: 'a.pdf', fileSize: 2048, mimeType: 'application/pdf' }
assert(img.type === 'image' && img.dataUrl === 'data:image/png;base64,QUJD', 'image part shape')
assert(file.type === 'file' && file.fileName === 'a.pdf' && file.fileSize === 2048, 'file part shape')
// The daemon has NO image block → an "image" daemon block must NOT round-trip; the adapter drops it
// and falls back to the flat content (this is WHY desktop thumbnails are optimistic-only).
// B3 changed image blocks from dropped to RENDERED — but only ones that carry something. A
// degenerate image block with no bytes, no source_path and no description still falls back.
const adapted = partsFromContentJson(j([{ type: 'image', source: 'x' }]), 'flat')
assert(
  adapted.length === 1 && adapted[0].type === 'text' && adapted[0].text === 'flat',
  'a bare image block (no bytes/ref/description) still drops → flat fallback'
)

// ── PARITY-PLAN A5: paste-as-file helpers ──
console.log('[smoke] === A5. paste-as-file ===')
{
  assert(PASTE_AS_FILE_CHARS >= 2000 && PASTE_AS_FILE_CHARS <= 50_000, 'threshold catches pasted files, not paragraphs')
  const t = new Date(2026, 7, 28, 21, 7, 5).getTime()
  assert(pasteFilename(t) === 'paste-20260828-210705.txt', `paste filename is deterministic (got ${pasteFilename(t)})`)
  // Round-trip through the SAME decode the daemon side performs (base64 → utf8 bytes).
  const text = 'héllo — Ω 😀\n' + 'x'.repeat(70_000)
  const b64 = base64FromText(text)
  const back = Buffer.from(b64, 'base64').toString('utf8')
  assert(back === text, 'text → base64 → utf8 round-trips, multibyte + emoji + 70K chars intact')
  assert(utf8ByteLength('€') === 3 && utf8ByteLength('a') === 1, 'the guard counts BYTES, not chars — a euro is three of them')
}

console.log('\n[smoke] ===================== RESULT =====================')
console.log(
  `[smoke] outcome: ${failures === 0 ? 'PASS ✓ (chat_upload frame, base64 extraction, parts model)' : `FAIL ✗ (${failures})`}`
)
console.log('[smoke] ===================================================')
process.exit(failures === 0 ? 0 : 1)
