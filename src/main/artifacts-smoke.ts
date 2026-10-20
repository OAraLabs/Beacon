/**
 * Headless smoke for the Artifacts view (roadmap item 4). Pure model only — classification,
 * formatting, sort, filter and the preview-outcome sentences. Fetching and rendering are
 * hands-on against a live daemon; what this pins is the CONTRACT with the manifest.
 *
 * Run: npm run smoke:artifacts
 */
import {
  ARTIFACT_PREVIEW_MAX_BYTES,
  ARTIFACT_RENDER_CSP,
  ARTIFACT_RENDER_MAX_BYTES,
  ARTIFACT_THUMB_MAX_BYTES,
  artifactRenderUrl,
  artifactThumbUrl,
  imageMimeFromBytes,
  isThumbnailableImage,
  mediaRenderUrl,
  parseArtifactRenderUrl,
  renderKindFor,
  renderTargetFor,
  shortType,
  utf8SafeEnd,
  extensionOf,
  filterArtifacts,
  fmtArtifactTime,
  fmtSize,
  previewKindFor,
  previewNotice,
  sortArtifacts,
  type ArtifactPreview
} from '@shared/artifacts'
import { previewImageSrc, previewTitle } from '@shared/preview'
import { NAV_VIEWS, NAV_TREE, flattenNavTree } from '@shared/views'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

let failures = 0
function assert(cond: boolean, what: string): void {
  console.log(`[smoke] ${cond ? 'PASS' : 'FAIL'}  ${what}`)
  if (!cond) failures++
}

// ── FIXTURE ──────────────────────────────────────────────────────────────────────────────────
// SHAPE captured from the live GET /api/artifacts on the deployed daemon (2026-08-27, 11 rows);
// names are this repo's own spec files, which are already public in the PR text, so nothing
// private is encoded here. What the live read confirmed rather than what I assumed:
//   size   int, as small as 1 byte
//   mtime  FLOAT EPOCH SECONDS (1787792138.7324069) — not milliseconds, and reading it as ms
//          puts every artifact in 1970
//   mime   real values incl. the full OOXML docx type and text/javascript (NOT application/…)
//   path   equal to name on all 11 rows — so a UI that shows both would show the same string twice
const CAPTURED = [
  { id: '719f1fb2b060dcb1', name: 'beacon-voice-spec.md', path: 'beacon-voice-spec.md', size: 10049, mtime: 1787792138.7324069, mime: 'text/markdown' },
  { id: 'aa02bbc1', name: 'notes.txt', path: 'notes.txt', size: 1, mtime: 1787700000.0, mime: 'text/plain' },
  { id: 'cc03dd12', name: 'report.docx', path: 'report.docx', size: 40426, mtime: 1787795000.5, mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
  { id: 'ee04ff23', name: 'build.js', path: 'build.js', size: 2569, mtime: 1787600000.0, mime: 'text/javascript' }
]

console.log('[smoke] === 1. how each artifact can be shown ===')
assert(previewKindFor('text/markdown', 'beacon-voice-spec.md') === 'text', 'markdown previews as text')
assert(previewKindFor('text/plain', 'notes.txt') === 'text', 'plain text previews as text')
assert(previewKindFor('text/javascript', 'build.js') === 'text', 'text/javascript previews as text')
assert(
  previewKindFor('application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'report.docx') === 'binary',
  'a docx is BINARY — rendering it as text would be mojibake, which is worse than saying "no preview"'
)
assert(previewKindFor('image/png', 'shot.png') === 'image', 'an image previews inline')
assert(previewKindFor('application/json', 'data.json') === 'text', 'json previews as text')
assert(previewKindFor('application/ld+json', 'x.jsonld') === 'text', 'a +json suffix type is still text')
assert(previewKindFor('text/markdown; charset=utf-8', 'a.md') === 'text', 'a charset parameter does not defeat the match')
assert(previewKindFor('TEXT/MARKDOWN', 'a.md') === 'text', 'mime match is case-insensitive')
// The octet-stream fallback: the daemon does not always know, so the extension is the second look.
assert(previewKindFor('application/octet-stream', 'HANDOFF.md') === 'text', 'octet-stream + .md falls back to text')
assert(previewKindFor('application/octet-stream', 'archive.zip') === 'binary', 'octet-stream + .zip stays binary')
assert(previewKindFor(undefined, 'script.py') === 'text', 'a missing mime still classifies by extension')
assert(previewKindFor(undefined, 'noextension') === 'binary', 'no mime and no extension is binary, not a guess')
assert(extensionOf('a/b/c.tar.gz') === 'gz' && extensionOf('.bashrc') === '' && extensionOf('plain') === '', 'extensionOf handles paths, dotfiles and none')

console.log('[smoke] === 2. sizes ===')
assert(fmtSize(1) === '1 B' && fmtSize(999) === '999 B', 'bytes stay bytes')
assert(fmtSize(2569) === '3 KB' && fmtSize(40426) === '39 KB', 'kilobytes round')
assert(fmtSize(5 * 1024 * 1024) === '5.0 MB', 'megabytes get a decimal')
assert(fmtSize(0) === '0 B', 'an empty artifact reads as 0 B, not as missing')
assert(fmtSize(Number.NaN) === '—' && fmtSize(-5) === '—', 'a nonsense size renders as a dash, never NaN B')

console.log('[smoke] === 3. mtime is epoch SECONDS ===')
// The manifest sends float seconds; the LCM wire sends milliseconds. Confusing them is silent —
// the artifact simply sorts wrong and displays a date decades off.
const NOW = 1787795738000 // ms
assert(fmtArtifactTime(1787792138, NOW) === '1h ago', `float seconds read as seconds (got ${fmtArtifactTime(1787792138, NOW)})`)
assert(fmtArtifactTime(1787793458, NOW) === '38m ago', `minutes-old artifacts read relative (got ${fmtArtifactTime(1787793458, NOW)})`)
assert(fmtArtifactTime(1787795730, NOW) === 'just now', 'seconds-old reads as just now')
assert(/^[A-Z][a-z]{2} \d+$/.test(fmtArtifactTime(1787000000, NOW)), `older artifacts read as a date (got ${fmtArtifactTime(1787000000, NOW)})`)
assert(fmtArtifactTime(NOW, NOW) !== '1h ago', 'a MILLISECOND value does not accidentally produce a sane-looking answer')
assert(fmtArtifactTime(undefined, NOW) === '' && fmtArtifactTime(0, NOW) === '', 'a missing mtime renders as nothing, not 1970')

console.log('[smoke] === 4. order and filter ===')
const sorted = sortArtifacts(CAPTURED)
assert(sorted[0].name === 'report.docx', `newest first (got ${sorted[0].name})`)
assert(sorted[sorted.length - 1].name === 'build.js', 'oldest last')
assert(sortArtifacts(CAPTURED).length === CAPTURED.length, 'sorting never drops a row')
assert(sortArtifacts([{ name: 'b' }, { name: 'a' }])[0].name === 'a', 'no mtime at all falls back to name, not to random order')
assert(filterArtifacts(CAPTURED, 'spec').length === 1, 'filter matches the name')
assert(filterArtifacts(CAPTURED, 'SPEC').length === 1, 'filter is case-insensitive')
assert(filterArtifacts(CAPTURED, '').length === CAPTURED.length, 'an empty filter shows everything')
assert(filterArtifacts(CAPTURED, 'zzz').length === 0, 'a non-match shows nothing')

console.log('[smoke] === 5. every preview outcome says something ===')
const outcomes: ArtifactPreview[] = [
  { kind: 'text', text: 'x', truncated: false },
  { kind: 'text', text: 'x', truncated: true },
  { kind: 'image', dataUrl: 'data:image/png;base64,AA' },
  { kind: 'unsupported', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', reason: 'binary' },
  { kind: 'too-large', size: 9_000_000 },
  { kind: 'error', message: 'HTTP 404' }
]
for (const o of outcomes) assert(previewNotice(o, 'a.md').length > 0, `${o.kind} produces a visible sentence — no silent blank pane`)
assert(previewNotice(outcomes[1], 'a.md').includes('first'), 'a truncated preview SAYS it is truncated')
assert(previewNotice(outcomes[4], 'a.md').includes('MB'), 'too-large names the size so the refusal is checkable')
assert(previewNotice(outcomes[5], 'a.md').includes('404'), 'an error carries the reason, not just "failed"')
assert(ARTIFACT_PREVIEW_MAX_BYTES > 0 && ARTIFACT_PREVIEW_MAX_BYTES <= 2 * 1024 * 1024, 'the preview cap is a peek, not a viewer')

console.log('[smoke] === 6. short type labels keep the row intact ===')
// The live docx mime is 71 characters. An unshrinkable column of that width pushes size, time
// and the download button off the row — the fixture captured the length, the layout did not.
const LONG_DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
assert(LONG_DOCX.length === 71, `the real docx mime really is that long (${LONG_DOCX.length} chars)`)
assert(shortType(LONG_DOCX, 'report.docx') === 'docx', 'a docx labels as "docx", not as 71 characters')
assert(shortType('text/markdown', 'spec.md') === 'md', 'markdown labels as "md"')
assert(shortType('image/svg+xml', 'logo.svg') === 'svg', 'svg labels as "svg"')
assert(shortType(LONG_DOCX, 'noext') === 'document', 'with no extension it falls back to the mime SUBTYPE tail, not the whole string')
assert(shortType('image/svg+xml', 'noext') === 'svg', 'a +suffix subtype drops the suffix')
assert(shortType(undefined, 'noext') === 'file', 'no mime and no extension still yields a label')
assert(shortType('text/plain', 'archive.tar.gz') === 'gz', 'the LAST extension wins')
const labels = [LONG_DOCX, 'text/markdown', 'image/png', 'application/json', '', 'text/x-something-very-long-indeed']
assert(labels.every((m) => shortType(m, 'x').length <= 8), 'every label fits a narrow column (<= 8 chars)')

console.log('[smoke] === 7. truncation never splits a character ===')
// A cut on a raw byte boundary ends the preview in a replacement glyph, which reads as a corrupt
// file rather than a truncated view.
const enc = new TextEncoder()
const multi = enc.encode('aaa€€€')          // '€' is 3 bytes
assert(utf8SafeEnd(multi, multi.length) === multi.length, 'a cut at or past the end is the end')
assert(utf8SafeEnd(multi, 3) === 3, 'a cut on an ASCII boundary is left alone')
assert(utf8SafeEnd(multi, 4) === 3, 'a cut one byte into a 3-byte character backs up to before it')
assert(utf8SafeEnd(multi, 5) === 3, 'two bytes in, still backs up')
assert(utf8SafeEnd(multi, 6) === 6, 'a cut exactly after a whole character keeps it')
const dec = new TextDecoder('utf-8', { fatal: false })
for (let cut = 0; cut <= multi.length; cut++) {
  const text = dec.decode(multi.subarray(0, utf8SafeEnd(multi, cut)))
  if (text.includes('\uFFFD')) assert(false, `cut at ${cut} produced a replacement glyph`)
}
assert(true, 'no cut position anywhere in the string produces a replacement glyph')
const four = enc.encode('a😀b')             // emoji is 4 bytes
assert(utf8SafeEnd(four, 3) === 1 && utf8SafeEnd(four, 5) === 5, '4-byte characters are handled too')
assert(utf8SafeEnd(enc.encode('abc'), 0) === 0, 'a zero cut is zero, not negative')

console.log('[smoke] === 8. the view is registered, once, under Workspace ===')
assert(NAV_VIEWS.some((v) => v.id === 'artifacts'), 'artifacts is in the view registry')
assert(flattenNavTree().filter((id) => id === 'artifacts').length === 1, 'reachable exactly once in the rail')
const workspace = NAV_TREE.find((e) => e.kind === 'group' && e.group.id === 'grp:workspace')
assert(
  workspace !== undefined && workspace.kind === 'group' && workspace.group.children.includes('artifacts'),
  'nested under Workspace — it earns a view, not one of the top-level slots'
)
assert(
  NAV_TREE.every((e) => e.kind !== 'view' || e.id !== 'artifacts'),
  'and it is NOT also a top-level entry'
)

console.log('[smoke] === 9. rendered artifacts (beacon-artifact://) ===')
// Which artifacts earn a rendered view — narrow on purpose: the two types whose point is being
// looked at rendered. Everything else keeps its source/image behaviour.
assert(renderKindFor('text/html', 'page.html') === 'html', 'html renders as a page')
assert(renderKindFor('application/octet-stream', 'page.htm') === 'html', 'octet-stream + .htm falls back to html')
assert(renderKindFor('image/svg+xml', 'logo.svg') === 'svg', 'svg renders as a vector image')
assert(renderKindFor('application/octet-stream', 'logo.svg') === 'svg', 'octet-stream + .svg falls back to svg')
assert(renderKindFor('TEXT/HTML; charset=utf-8', 'noext') === 'html', 'mime match survives case + parameters')
assert(renderKindFor('application/pdf', 'report.pdf') === 'pdf', "a pdf renders via Chromium's viewer")
assert(renderKindFor('application/octet-stream', 'report.pdf') === 'pdf', 'octet-stream + .pdf falls back to pdf')
assert(parseArtifactRenderUrl(artifactRenderUrl('abc123', 'pdf'))?.kind === 'pdf', 'the pdf kind round-trips the protocol URL')
assert(renderKindFor('text/markdown', 'spec.md') === null, 'markdown does NOT render — it stays a text peek')
assert(renderKindFor('image/png', 'shot.png') === null, 'a raster image keeps the image preview path')
assert(renderKindFor(undefined, 'noextension') === null, 'no mime and no extension renders nothing')

// The mint ⇄ parse roundtrip is the protocol handler's whole input contract.
const RT = parseArtifactRenderUrl(artifactRenderUrl('719f1fb2b060dcb1', 'html'))
assert(RT !== null && RT.kind === 'html' && RT.id === '719f1fb2b060dcb1', 'mint → parse roundtrips id and kind')
const RT2 = parseArtifactRenderUrl(artifactRenderUrl('id with spaces+%', 'svg'))
assert(RT2 !== null && RT2.kind === 'svg' && RT2.id === 'id with spaces+%', 'an id needing escaping roundtrips intact')
// B3: the media route — a source_path reference proxied for <img>, never framed
const MRT = parseArtifactRenderUrl(mediaRenderUrl('/home/demo/.prometheus/files/img/a b.png'))
assert(MRT !== null && MRT.kind === 'media' && MRT.path === '/home/demo/.prometheus/files/img/a b.png', 'media mint → parse roundtrips the path intact')
assert(parseArtifactRenderUrl('beacon-artifact://media/') === null, 'media without a path is refused')
assert(parseArtifactRenderUrl('https://render/abc?kind=html') === null, 'a foreign scheme is refused')
assert(parseArtifactRenderUrl('beacon-artifact://other/abc?kind=html') === null, 'a foreign host is refused')
assert(parseArtifactRenderUrl('beacon-artifact://render/abc') === null, 'a missing kind is refused, not guessed')
assert(parseArtifactRenderUrl('beacon-artifact://render/abc?kind=js') === null, 'an unknown kind is refused')
assert(parseArtifactRenderUrl('beacon-artifact://render/?kind=html') === null, 'an empty id is refused')
assert(parseArtifactRenderUrl('beacon-artifact://render/a/b?kind=html') === null, 'extra path segments are refused')
assert(parseArtifactRenderUrl('not a url at all') === null, 'garbage parses to null, never throws')

// The served CSP is the sandbox's other half: inline style/script may run, nothing may LEAVE.
for (const kind of ['html', 'svg'] as const) {
  const csp = ARTIFACT_RENDER_CSP[kind]
  assert(csp.includes("default-src 'none'"), `${kind} CSP starts from none`)
  assert(!csp.includes('http'), `${kind} CSP names no network scheme anywhere`)
  assert(!csp.includes('beacon-artifact'), `${kind} CSP cannot reach back into the protocol for other artifacts`)
}
assert(ARTIFACT_RENDER_CSP.html.includes("connect-src 'none'"), 'a rendered page cannot fetch')
assert(ARTIFACT_RENDER_CSP.html.includes("frame-src 'none'"), 'a rendered page cannot nest frames')
assert(ARTIFACT_RENDER_CSP.html.includes("script-src 'unsafe-inline'"), 'inline script is the feature — a self-contained page may run')
assert(ARTIFACT_RENDER_MAX_BYTES > ARTIFACT_PREVIEW_MAX_BYTES, 'the render ceiling exceeds the peek cap — rendering exists to beat the 512 KB cut')

console.log('[smoke] === 10. inline image thumbnails (beacon-artifact://image) ===')
// What earns a thumbnail: a raster image small enough to fetch automatically. SVG is the
// interesting exclusion — it is an image to previewKindFor but has its own render path, and an
// auto-fetched thumbnail is no place to widen the scriptable surface.
assert(isThumbnailableImage('image/png', 'shot.png', 700_000), 'a 700 KB png is thumbnailed (image_generate output)')
assert(isThumbnailableImage('image/jpeg', 'shot.jpg'), 'a jpeg with no size stated is thumbnailed')
assert(isThumbnailableImage('image/webp', 'a.webp', 10), 'webp is thumbnailed')
assert(isThumbnailableImage('application/octet-stream', 'shot.png', 100), 'octet-stream + .png falls back to the extension')
assert(isThumbnailableImage('IMAGE/PNG; charset=utf-8', 'noext', 100), 'mime match survives case + parameters with no extension')
assert(!isThumbnailableImage('image/svg+xml', 'logo.svg'), 'an SVG is NOT thumbnailed — it keeps the render path')
assert(!isThumbnailableImage('application/octet-stream', 'logo.svg'), 'octet-stream + .svg is not thumbnailed either')
assert(!isThumbnailableImage('text/markdown', 'spec.md'), 'markdown is not an image')
assert(!isThumbnailableImage(undefined, 'noextension'), 'no mime and no extension thumbs nothing')
// The cap is a GATE, not a truncation point — an image cannot be shown in part, so an oversize
// one stays a plain download chip. And it must clear real generated output, which is why it is
// above the 512 KB text-peek number.
assert(!isThumbnailableImage('image/png', 'big.png', ARTIFACT_THUMB_MAX_BYTES + 1), 'over the cap → no thumbnail, the chip stays')
assert(isThumbnailableImage('image/png', 'big.png', ARTIFACT_THUMB_MAX_BYTES), 'exactly at the cap is allowed')
assert(ARTIFACT_THUMB_MAX_BYTES > ARTIFACT_PREVIEW_MAX_BYTES, 'the thumb gate clears the text-peek cap — a 700 KB generated png must still thumb')
assert(ARTIFACT_THUMB_MAX_BYTES <= ARTIFACT_RENDER_MAX_BYTES, 'the thumb gate stays under the render ceiling')

// The thumbnail route is id-only and declares NO kind: the served type comes from the bytes.
const TURL = artifactThumbUrl('719f1fb2b060dcb1')
assert(parseArtifactRenderUrl(TURL)?.kind === 'image', 'the image route parses')
const T = parseArtifactRenderUrl(TURL)
assert(T !== null && T.kind === 'image' && T.id === '719f1fb2b060dcb1', 'thumb mint → parse roundtrips the id')
assert(parseArtifactRenderUrl(artifactThumbUrl('id with spaces+%'))?.kind === 'image', 'an id needing escaping roundtrips')
const TE = parseArtifactRenderUrl(artifactThumbUrl('id with spaces+%'))
assert(TE !== null && TE.kind === 'image' && TE.id === 'id with spaces+%', 'the escaped id decodes intact')
assert(parseArtifactRenderUrl('beacon-artifact://image/abc?kind=html')?.kind === 'image', 'a ?kind= on the image route is ignored, not honoured')
assert(parseArtifactRenderUrl('beacon-artifact://image/') === null, 'an empty id is refused')
assert(parseArtifactRenderUrl('beacon-artifact://image/a/b') === null, 'extra path segments are refused')
assert(parseArtifactRenderUrl('beacon-artifact://image') === null, 'no id at all is refused')

// The served type is SNIFFED, never trusted from the URL or the manifest — with nosniff, what
// this returns is what the browser is told, so it must be derived from the payload and must
// return null rather than guess for anything it does not recognise.
const bytes = (...n: number[]): Uint8Array => new Uint8Array(n)
assert(imageMimeFromBytes(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) === 'image/png', 'png magic sniffs as png')
assert(imageMimeFromBytes(bytes(0xff, 0xd8, 0xff, 0xe0)) === 'image/jpeg', 'jpeg magic sniffs as jpeg')
assert(imageMimeFromBytes(bytes(...[...'GIF89a'].map((c) => c.charCodeAt(0)))) === 'image/gif', 'gif magic sniffs as gif')
assert(imageMimeFromBytes(bytes(...[...'GIF87a'].map((c) => c.charCodeAt(0)))) === 'image/gif', 'the older gif magic sniffs too')
assert(imageMimeFromBytes(bytes(...[...'RIFF'].map((c) => c.charCodeAt(0)), 0, 0, 0, 0, ...[...'WEBP'].map((c) => c.charCodeAt(0)))) === 'image/webp', 'riff/webp sniffs as webp')
assert(imageMimeFromBytes(bytes(...[...'BM'].map((c) => c.charCodeAt(0)))) === 'image/bmp', 'bmp magic sniffs as bmp')
assert(imageMimeFromBytes(bytes(0x49, 0x49, 0x2a, 0x00)) === 'image/tiff', 'little-endian tiff sniffs as tiff')
assert(imageMimeFromBytes(bytes(0x4d, 0x4d, 0x00, 0x2a)) === 'image/tiff', 'big-endian tiff sniffs as tiff')
assert(
  imageMimeFromBytes(bytes(0, 0, 0, 0x18, ...[...'ftypavif'].map((c) => c.charCodeAt(0)))) === 'image/avif',
  'iso-bmff avif brand sniffs as avif'
)
assert(
  imageMimeFromBytes(bytes(0, 0, 0, 0x18, ...[...'ftypheic'].map((c) => c.charCodeAt(0)))) === 'image/heic',
  'iso-bmff heic brand sniffs as heic'
)
// The refusals matter more than the matches: this is what stops unknown bytes being served under
// an image type. Markup renamed .png, an empty file, a truncated header, a pdf, a zip.
assert(imageMimeFromBytes(bytes(...[...'<svg xmlns'].map((c) => c.charCodeAt(0)))) === null, 'markup renamed to .png is REFUSED, not served as an image')
assert(imageMimeFromBytes(bytes(...[...'%PDF-1.7'].map((c) => c.charCodeAt(0)))) === null, 'a pdf is not an image')
assert(imageMimeFromBytes(bytes(...[...'PK\u0003\u0004'].map((c) => c.charCodeAt(0)))) === null, 'a zip/docx is not an image')
assert(imageMimeFromBytes(bytes()) === null, 'an empty payload sniffs as nothing')
assert(imageMimeFromBytes(bytes(0x89, 0x50, 0x4e)) === null, 'a truncated png header sniffs as nothing, never as a guess')
assert(imageMimeFromBytes(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x09)) === null, 'one wrong byte in the png magic is refused')
assert(imageMimeFromBytes(bytes(0, 0, 0, 0x18, ...[...'ftypisom'].map((c) => c.charCodeAt(0)))) === null, 'an mp4 iso-bmff brand is not served as an image')

console.log('[smoke] === 11. preview target: reference vs base64 ===')
// The pane takes EITHER bytes it already holds or a reference main resolves. Separate fields
// because what the pane holds matters, and a field named dataUrl carrying a protocol URL would
// hide that from a reader.
assert(previewImageSrc({ kind: 'image', dataUrl: 'data:image/png;base64,AA' }) === 'data:image/png;base64,AA', 'a base64 image previews from its own bytes')
assert(previewImageSrc({ kind: 'image', url: TURL }) === TURL, 'a reference previews from its url')
assert(previewImageSrc({ kind: 'image', url: TURL, dataUrl: 'data:,' }) === TURL, 'when both are present the reference wins — cheaper and fresher than stale base64')
assert(previewImageSrc({ kind: 'image' }) === '', 'neither variant yields an empty src, not undefined')
assert(previewImageSrc({ kind: 'text', title: 'a.md', body: 'x' }) === '', 'a non-image target has no image src')
assert(previewTitle({ kind: 'image', url: TURL, title: 'cat.png' }) === 'cat.png', 'a reference preview still shows its title')
assert(previewTitle({ kind: 'image', url: TURL }) === 'image', 'and falls back to "image" with no title')

console.log('[smoke] === 12. the model is WIRED, not just defined ===')
// A pure model with nothing calling it is dead code that passes every test above. These read the
// sources to pin the wiring half — the same source-regex approach badge-smoke uses.
{
  const proto = readFileSync(join(process.cwd(), 'src/main/artifact-protocol.ts'), 'utf8')
  const chips = readFileSync(join(process.cwd(), 'src/renderer/src/components/ArtifactChips.tsx'), 'utf8')
  const pane = readFileSync(join(process.cwd(), 'src/renderer/src/components/PreviewPane.tsx'), 'utf8')
  const idx = readFileSync(join(process.cwd(), 'src/main/index.ts'), 'utf8')

  assert(/parsed\.kind === 'image'/.test(proto), 'the protocol handler routes the image kind')
  assert(/imageMimeFromBytes\(buf\)/.test(proto), 'main derives the served Content-Type from the BYTES via the model, not from the URL or the manifest')
  assert(/if \(!contentType\) return refuse\(415/.test(proto), 'an unrecognised payload is refused 415 — null is never served as an image')
  assert(/ARTIFACT_THUMB_MAX_BYTES\)\s*\n\s*return refuse\(413/.test(proto), 'main enforces the thumb cap after the fetch too — the manifest is a claim, not a guarantee')
  assert(/'X-Content-Type-Options': 'nosniff'/.test(proto), 'the thumbnail response is pinned nosniff so the sniffed type is the only type')

  assert(/isThumbnailableImage\(a\.mime, a\.name, a\.size\)/.test(chips), 'the chip gates on the model with the MANIFEST SIZE, refusing oversize before a fetch')
  assert(/artifactThumbUrl\(a\.id\)/.test(chips), 'the chip embeds by CONTENT ID — no path, no token')
  assert(/onError=/.test(chips) && /failedThumbs/.test(chips), 'a failed thumbnail DEGRADES to the download chip instead of leaving a broken-image glyph')
  assert(/preview\.open\(\{ kind: 'image', url: thumb/.test(chips), 'clicking a thumbnail opens the pane by REFERENCE, not as base64')

  assert(/previewImageSrc\(target\)/.test(pane), 'the pane resolves its src through the model accessor, so reference and base64 cannot drift')
  assert(/img-src 'self' data: beacon-artifact:/.test(idx), "the shell CSP still admits beacon-artifact: for <img> — without it the thumbnail is blocked and silently blank")
}

console.log('[smoke] === 13. View on a chat chip: a rendered deliverable opens in the sandboxed pane, never the browser pane ===')
// A page / svg / pdf mentioned in chat used to be download-only, so the first sight of it was
// after saving, finding and opening a file. The chip now grows a View button that reuses the
// Artifacts panel's rendered preview. renderTargetFor is the one builder both callers share.
{
  const A = { id: 'a1b2c3d4e5f60718', name: 'compare.html' }
  const t = renderTargetFor(A, 'html', { text: '<h1>x</h1>', truncated: false })
  assert(t.kind === 'render' && t.renderKind === 'html' && t.title === 'compare.html', 'an html target is a render target titled by the file name')
  assert(t.url === artifactRenderUrl(A.id, 'html'), 'its url is the protocol URL minted by artifactRenderUrl — content id, no path')
  assert(t.source === '<h1>x</h1>' && t.sourceTruncated === false, 'the Source toggle carries the peek text and its truncation flag')
  assert(renderTargetFor(A, 'html').source === undefined, 'with no peek there is no source — the render is still complete')
  const pdf = renderTargetFor({ id: 'ffeeddccbbaa0011', name: 'r.pdf' }, 'pdf', { text: 'ignored', truncated: false })
  assert(pdf.renderKind === 'pdf' && pdf.source === undefined && pdf.sourceTruncated === undefined, 'a pdf NEVER carries a source, even if a caller passes one — it has no useful text')
  const url = renderTargetFor({ id: 'weird id/with?chars', name: 'x.svg' }, 'svg').url
  const back = parseArtifactRenderUrl(url)
  assert(back !== null && back.kind === 'svg' && 'id' in back && back.id === 'weird id/with?chars', 'a target url round-trips through the protocol parser, id intact')

  const chips = readFileSync(join(process.cwd(), 'src/renderer/src/components/ArtifactChips.tsx'), 'utf8')
  const panel = readFileSync(join(process.cwd(), 'src/renderer/src/components/ArtifactsPanel.tsx'), 'utf8')
  assert(/renderKindFor\(a\.mime, a\.name\)/.test(chips), 'the chip decides renderability with the same renderKindFor the panel and main use')
  assert(/renderTargetFor\(a, kind, \{ text: p\.text, truncated: p\.truncated \}\)/.test(chips) && /renderTargetFor\(a, kind\)/.test(chips), 'the chip opens the shared target (with source for a page/svg, without for a pdf)')
  assert(/renderTargetFor\(a, 'pdf'\)/.test(panel) && /renderTargetFor\(a, rk, \{/.test(panel), 'the Artifacts panel builds its targets through the same builder — one meaning of "open rendered"')
  assert(!/artifactRenderUrl/.test(panel), 'the panel no longer hand-builds a render url, so it cannot drift from the chip')
  assert(/p\.kind === 'text'/.test(chips), 'a page/svg opens only when the source read succeeded — a refusal shows on the button, not as a pane that never opens')
  // The invariant, from this side. browser-invariant-smoke mutates chat components and demands a
  // failure; this pins that the chip never gave it cause to.
  assert(!/\.browser\b|BROWSER_IPC|navigate\(/.test(chips), 'the chip NEVER reaches the browser pane — agent-written script is shown sandboxed, not given a window with a network')
}

console.log('')
console.log('[smoke] ===================== RESULT =====================')
console.log(`[smoke] outcome: ${failures === 0 ? 'PASS ✓' : `FAIL ✗ (${failures})`} (classification, sizes, seconds-not-ms, order, filter, outcomes, nav, thumbnails, sniffing, view)`)
console.log('[smoke] ===================================================')
process.exit(failures === 0 ? 0 : 1)
