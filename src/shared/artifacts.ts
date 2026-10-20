// Pure artifact-gallery model — shared by the renderer panel and the headless smoke. No DOM.
//
// Artifacts are the agent's OUTBOX: files it produced, listed by GET /api/artifacts as
// {id, name, path, size, mtime, mime}. They are deliberately a separate surface from Files
// (the workspace) because they have a different producer, a different lifecycle and a different
// trust story — the same boundary the vault draws between raw/ and wiki/. Collapsing them into
// one browser would lose a distinction the rest of the system enforces.
//
// The id is a CONTENT id. Every fetch goes by id; a path from a listing is never sent back to the
// daemon as a path (the same rule the download chips already follow).

import type { PreviewTarget } from './preview'

/** Above this, a preview is refused rather than streamed — the pane is a peek, not a viewer. */
export const ARTIFACT_PREVIEW_MAX_BYTES = 512 * 1024

/**
 * Above this, the RENDERED view (beacon-artifact:// fetch) is refused. The render path serves the
 * FULL file — it exists precisely because the 512 KB peek would truncate a page mid-tag — so it
 * needs its own ceiling to keep main from buffering a runaway artifact into memory.
 */
export const ARTIFACT_RENDER_MAX_BYTES = 20 * 1024 * 1024

/** Kinds an artifact can be RENDERED as (beyond source text) — a live page, a vector image, or a
 * document handed to Chromium's built-in PDF viewer. */
export type ArtifactRenderKind = 'html' | 'svg' | 'pdf'

/** The custom scheme main serves rendered artifacts on. See src/main/artifact-protocol.ts. */
export const ARTIFACT_RENDER_SCHEME = 'beacon-artifact'

/**
 * The CSP each rendered artifact is served under. A self-contained page may inline its own style
 * and script — that is what an agent-produced artifact IS — but nothing may leave it: no network
 * (`connect-src 'none'`, no http(s) source anywhere), no subframes, no reaching back into the
 * protocol for another artifact's content (fetch is dead and img/media allow only data:/blob:).
 * The embedding iframe adds `sandbox="allow-scripts"` WITHOUT `allow-same-origin`, so the page
 * runs with an opaque origin: same-origin access to the pane, the bridge, or storage is
 * structurally impossible rather than merely policed.
 */
export const ARTIFACT_RENDER_CSP: Record<ArtifactRenderKind, string> = {
  html: "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; font-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'",
  // An <img>-embedded SVG executes no script by spec; the CSP is belt-and-braces for its styles.
  svg: "default-src 'none'; style-src 'unsafe-inline'",
  // A pdf is DATA rendered by Chromium's own viewer (PDFium executes no document script); the
  // content-type pin + nosniff is the guard that matters — this CSP is belt-and-braces.
  pdf: "default-src 'none'"
}

/** How an artifact can be shown. `binary` is honest about having no preview, not a failure. */
export type ArtifactPreviewKind = 'text' | 'image' | 'binary'

const TEXT_MIMES = new Set([
  'application/json',
  'application/xml',
  'application/javascript',
  'application/x-javascript',
  'application/typescript',
  'application/x-sh',
  'application/x-yaml',
  'application/yaml',
  'application/toml',
  'application/sql'
])

/** Extensions the daemon may hand us as octet-stream but which are plainly text. */
const TEXT_EXTS = new Set([
  'md', 'markdown', 'txt', 'log', 'json', 'jsonl', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf',
  'csv', 'tsv', 'sql', 'sh', 'bash', 'zsh', 'py', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'css',
  'html', 'xml', 'svg', 'patch', 'diff', 'env'
])

export function extensionOf(name: string): string {
  const base = name.slice(name.lastIndexOf('/') + 1)
  const i = base.lastIndexOf('.')
  return i > 0 ? base.slice(i + 1).toLowerCase() : ''
}

/**
 * Decide how to show one artifact. Mime first (the daemon knows), extension as the fallback for
 * the octet-stream case. Anything else is `binary` — a .docx rendered as text is mojibake, and
 * showing mojibake is worse than saying plainly that this one has no preview.
 */
export function previewKindFor(mime: string | undefined, name: string): ArtifactPreviewKind {
  const m = (mime || '').toLowerCase().split(';')[0].trim()
  if (m.startsWith('image/')) return 'image'
  if (m.startsWith('text/')) return 'text'
  if (TEXT_MIMES.has(m)) return 'text'
  if (m.endsWith('+json') || m.endsWith('+xml')) return 'text'
  const ext = extensionOf(name)
  if (ext && TEXT_EXTS.has(ext)) return 'text'
  return 'binary'
}

/**
 * Decide whether an artifact can be RENDERED, not merely shown as source. Deliberately narrow:
 * html and svg are the two types whose entire point is being looked at rendered. Everything else
 * keeps its previewKindFor behaviour. Mime first, extension as the octet-stream fallback — the
 * same two-step previewKindFor uses, for the same reason.
 */
export function renderKindFor(mime: string | undefined, name: string): ArtifactRenderKind | null {
  const m = (mime || '').toLowerCase().split(';')[0].trim()
  const ext = extensionOf(name)
  if (m === 'text/html' || ext === 'html' || ext === 'htm') return 'html'
  if (m === 'image/svg+xml' || ext === 'svg') return 'svg'
  if (m === 'application/pdf' || ext === 'pdf') return 'pdf'
  return null
}

/** The URL the renderer embeds for a rendered artifact. Content id only — never a path. */
export function artifactRenderUrl(id: string, kind: ArtifactRenderKind): string {
  return `${ARTIFACT_RENDER_SCHEME}://render/${encodeURIComponent(id)}?kind=${kind}`
}

/**
 * The preview-pane target for a RENDERABLE artifact. One builder for both callers (the Artifacts
 * panel row and the chat chip's View button) so the two cannot drift on what "open it rendered"
 * means. `peek` is the 512 KB source read the Source toggle shows; a pdf has no useful text source
 * and never carries one. The render itself is the whole file whatever `peek` says.
 */
export function renderTargetFor(
  a: { id: string; name: string },
  kind: ArtifactRenderKind,
  peek?: { text: string; truncated: boolean }
): Extract<PreviewTarget, { kind: 'render' }> {
  const target = { kind: 'render' as const, title: a.name, url: artifactRenderUrl(a.id, kind), renderKind: kind }
  if (kind === 'pdf' || !peek) return target
  return { ...target, source: peek.text, sourceTruncated: peek.truncated }
}

// ── Inline image thumbnails ───────────────────────────────────────────────────
//
// A raster image mentioned in chat used to arrive as a download chip: a filename and a byte
// count. That is the right affordance for a .docx and the wrong one for a picture — the whole
// point of an image is that you can look at it without first taking custody of the file. This
// section is what lets a chip grow a thumbnail.
//
// It rides the SAME protocol as the rendered-artifact pane rather than the ARTIFACT_READ peek,
// for two reasons. The peek returns a base64 data URL, which inflates the bytes by a third and
// parks them in the renderer's heap; a protocol response streams straight into the <img>. And
// the peek is a click-to-open path with a 512 KB ceiling sized for *text* — a thumbnail is
// fetched automatically for every message that mentions one, so it needs its own, separately
// reasoned cap (below).

/**
 * Above this, no thumbnail is fetched at all and the artifact stays a plain download chip.
 *
 * Deliberately larger than ARTIFACT_PREVIEW_MAX_BYTES (512 KB) and for a different reason: text
 * can be shown in part, so its cap is a truncation point, while an image cannot be shown in part
 * — the cap is a gate. Generated images routinely exceed 512 KB (a 768×768 FLUX PNG lands around
 * 700 KB), so the peek's number would have excluded most of what image_generate actually
 * produces. 4 MB keeps a message carrying several thumbnails from buffering much in main.
 *
 * Checked TWICE, and the first check is the one that matters: the manifest already states the
 * size, so an oversize image is refused before any byte is fetched. Checking only in main would
 * download it first and refuse what it had already read — the same trap ipc.ts notes for the
 * peek. The post-fetch check stays because the manifest is a claim, not a guarantee.
 */
export const ARTIFACT_THUMB_MAX_BYTES = 4 * 1024 * 1024

/**
 * True for a raster image that may be thumbnailed inline.
 *
 * SVG is EXCLUDED on purpose even though previewKindFor calls it an image: it is a document
 * format with its own render path (renderKindFor → 'svg'), and an auto-fetched thumbnail is no
 * place to widen the scriptable surface. Mime first, extension as the octet-stream fallback — the
 * same two-step the rest of this module uses, because the daemon's mime is a guess from the
 * filename and may come back as application/octet-stream.
 */
const THUMB_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'avif', 'heic', 'tif', 'tiff', 'ico'])

export function isThumbnailableImage(mime: string | undefined, name: string, size?: number): boolean {
  if (typeof size === 'number' && size > ARTIFACT_THUMB_MAX_BYTES) return false
  const m = (mime || '').toLowerCase().split(';')[0].trim()
  if (m === 'image/svg+xml') return false
  if (m.startsWith('image/')) return true
  return THUMB_EXTS.has(extensionOf(name))
}

/** The URL a chip embeds for its thumbnail. Content id only — never a path, never a mime claim. */
export function artifactThumbUrl(id: string): string {
  return `${ARTIFACT_RENDER_SCHEME}://image/${encodeURIComponent(id)}`
}

/**
 * Identify a raster image from its bytes alone.
 *
 * The served Content-Type comes from HERE rather than from the URL or the manifest because both
 * of those are claims a caller can make; magic bytes are what the file actually is. With
 * X-Content-Type-Options: nosniff, whatever this returns is what the browser is told, so it has
 * to be derived from the payload and it has to return null — not a guess — for anything it does
 * not recognise. null makes the protocol refuse with 415 instead of serving unknown bytes under
 * an image type.
 */
export function imageMimeFromBytes(bytes: Uint8Array): string | null {
  const at = (i: number): number => (i < bytes.length ? bytes[i] : -1)
  const eq = (i: number, ...v: number[]): boolean => v.every((b, k) => at(i + k) === b)
  const ascii = (i: number, s: string): boolean => eq(i, ...[...s].map((c) => c.charCodeAt(0)))

  if (eq(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png'
  if (eq(0, 0xff, 0xd8, 0xff)) return 'image/jpeg'
  if (ascii(0, 'GIF87a') || ascii(0, 'GIF89a')) return 'image/gif'
  if (ascii(0, 'BM')) return 'image/bmp'
  if (ascii(0, 'RIFF') && ascii(8, 'WEBP')) return 'image/webp'
  if (eq(0, 0x49, 0x49, 0x2a, 0x00) || eq(0, 0x4d, 0x4d, 0x00, 0x2a)) return 'image/tiff'
  if (eq(0, 0x00, 0x00, 0x01, 0x00)) return 'image/x-icon'
  // ISO-BMFF (avif/heic): a 4-byte size then 'ftyp', with the brand naming the codec.
  if (ascii(4, 'ftyp')) {
    const brand = String.fromCharCode(at(8), at(9), at(10), at(11))
    if (brand === 'avif' || brand === 'avis') return 'image/avif'
    if (brand === 'heic' || brand === 'heix' || brand === 'mif1' || brand === 'msf1') return 'image/heic'
  }
  return null
}

/** Stored-media thumbnail URL (B3): main proxies GET /api/media?path= (Prometheus 343). The
 * source_path is DATA here and on the daemon — the daemon path-confines it; Beacon never touches
 * disk with it. Embedded only via <img> (img-src beacon-artifact:), never framed. */
export function mediaRenderUrl(sourcePath: string): string {
  return `${ARTIFACT_RENDER_SCHEME}://media/?p=${encodeURIComponent(sourcePath)}`
}

/** What a beacon-artifact:// URL asks for: a rendered artifact by content id, media bytes, or an
 * inline image thumbnail by content id. */
export type ArtifactRequestParse =
  | { kind: ArtifactRenderKind; id: string }
  | { kind: 'media'; path: string }
  | { kind: 'image'; id: string }

/**
 * Parse (and validate) a beacon-artifact:// request URL. Returns null for anything that is not
 * exactly the shape artifactRenderUrl mints — wrong scheme, wrong host, a kind that is not a
 * render kind, an empty id, or extra path segments. The protocol handler refuses on null; a 400
 * with a reason beats guessing at what a malformed URL meant.
 */
export function parseArtifactRenderUrl(url: string): ArtifactRequestParse | null {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return null
  }
  if (u.protocol !== `${ARTIFACT_RENDER_SCHEME}:`) return null
  // The thumbnail route: id only, and no kind parameter — the served type is sniffed from the
  // bytes in main, never declared by the URL. A ?kind= here is ignored on purpose, not honoured.
  if (u.host === 'image') {
    const raw = u.pathname.replace(/^\//, '')
    if (!raw || raw.includes('/')) return null
    let id: string
    try {
      id = decodeURIComponent(raw)
    } catch {
      return null
    }
    if (!id) return null
    return { kind: 'image', id }
  }
  if (u.host === 'media') {
    const p = u.searchParams.get('p')
    if (!p) return null
    return { kind: 'media', path: p }
  }
  if (u.host !== 'render') return null
  const kind = u.searchParams.get('kind')
  if (kind !== 'html' && kind !== 'svg' && kind !== 'pdf') return null
  const raw = u.pathname.replace(/^\//, '')
  if (!raw || raw.includes('/')) return null
  let id: string
  try {
    id = decodeURIComponent(raw)
  } catch {
    return null
  }
  if (!id) return null
  return { id, kind }
}

/**
 * A short, column-safe label for a type. The real mime values are long — the docx one captured
 * from the live manifest is 71 characters — and a full mime in a fixed-width row pushes size,
 * time and the download button off the edge. The full value belongs in a title attribute, not
 * in the layout.
 */
export function shortType(mime: string | undefined, name: string): string {
  const ext = extensionOf(name)
  if (ext) return ext.length <= 5 ? ext : ext.slice(0, 5)
  const m = (mime || '').toLowerCase().split(';')[0].trim()
  if (!m) return 'file'
  const sub = m.slice(m.indexOf('/') + 1)
  // `vnd.openxmlformats-…wordprocessingml.document` → `document`; `svg+xml` → `svg`
  const tail = sub.split('.').pop() || sub
  const head = tail.split('+')[0]
  return head.length <= 8 ? head : head.slice(0, 8)
}

/** Byte count for humans. One definition — the download chips had their own copy. */
export function fmtSize(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '—'
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`
  if (n >= 1024) return `${Math.round(n / 1024)} KB`
  return `${n} B`
}

/**
 * Artifact mtime is epoch SECONDS (a float), not milliseconds — the manifest and the LCM wire
 * disagree about this, and reading one as the other puts every artifact in 1970.
 */
export function fmtArtifactTime(mtimeSeconds: number | undefined, now: number = Date.now()): string {
  if (typeof mtimeSeconds !== 'number' || !Number.isFinite(mtimeSeconds) || mtimeSeconds <= 0) return ''
  const t = mtimeSeconds * 1000
  const mins = Math.floor((now - t) / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const d = new Date(t)
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`
}

export interface SortableArtifact {
  name: string
  mtime?: number
  size?: number
}

/** Newest first — an outbox is read from the top. Stable by name when mtimes tie or are missing. */
export function sortArtifacts<T extends SortableArtifact>(list: T[]): T[] {
  return [...list].sort((a, z) => {
    const am = typeof a.mtime === 'number' && Number.isFinite(a.mtime) ? a.mtime : 0
    const zm = typeof z.mtime === 'number' && Number.isFinite(z.mtime) ? z.mtime : 0
    if (am !== zm) return zm - am
    return a.name.localeCompare(z.name)
  })
}

/** Substring match over name and path — the panel's filter box. Case-insensitive. Pure. */
export function filterArtifacts<T extends { name: string; path?: string }>(list: T[], q: string): T[] {
  const needle = q.trim().toLowerCase()
  if (!needle) return list
  return list.filter((a) => a.name.toLowerCase().includes(needle) || (a.path || '').toLowerCase().includes(needle))
}

/**
 * The largest cut <= maxBytes that does not land inside a UTF-8 character. Cutting on a raw byte
 * boundary splits a multi-byte sequence, and the truncated preview then ends in a replacement
 * glyph — a corruption the reader would reasonably blame on the file rather than on the viewer.
 *
 * Walks back over continuation bytes (10xxxxxx) to the lead byte, then keeps the whole sequence
 * only if it fits. Pure; operates on bytes, so it is testable without a Buffer.
 */
export function utf8SafeEnd(bytes: Uint8Array, maxBytes: number): number {
  if (maxBytes >= bytes.length) return bytes.length
  if (maxBytes <= 0) return 0
  let end = maxBytes
  // step back to the start of the character that straddles the cut
  let i = end - 1
  let seen = 0
  while (i >= 0 && (bytes[i] & 0xc0) === 0x80 && seen < 3) {
    i--
    seen++
  }
  if (i < 0) return end
  const lead = bytes[i]
  const need = lead < 0x80 ? 1 : lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1
  // the sequence starting at i fits entirely inside the cut → keep it; otherwise cut before it
  return i + need <= end ? end : i
}

/** What a preview attempt produced. `unsupported`/`too-large` are OUTCOMES, not errors. */
export type ArtifactPreview =
  | { kind: 'text'; text: string; truncated: boolean }
  | { kind: 'image'; dataUrl: string }
  | { kind: 'unsupported'; mime: string; reason: string }
  | { kind: 'too-large'; size: number }
  | { kind: 'error'; message: string }

/** One sentence for whatever came back — no silent blank pane. */
export function previewNotice(p: ArtifactPreview, name: string): string {
  switch (p.kind) {
    case 'text':
      return p.truncated ? `${name} — showing the first ${Math.round(ARTIFACT_PREVIEW_MAX_BYTES / 1024)} KB` : name
    case 'image':
      return name
    case 'unsupported':
      return `No preview for ${p.mime || 'this type'} — download it to open in an app that can.`
    case 'too-large':
      return `Too large to preview (${fmtSize(p.size)}). Download it instead.`
    case 'error':
      return `Could not read it: ${p.message}`
  }
}
