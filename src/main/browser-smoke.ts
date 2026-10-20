/**
 * Headless smoke for the browser pane's PURE layer (@shared/browser-pane): what the URL bar
 * accepts and refuses, the error-page copy per Chromium code, the hole → view geometry, the
 * send-to-chat message shape and its truncation marker, zoom stepping, the notice ring.
 * The embed itself (WebContentsView, session, hardening, CSP) is proven by
 * scripts/browser-pane-probe.mjs against the real app; the invariant by browser-invariant-smoke.
 *
 * Run: npm run smoke:browser
 */
import {
  BROWSER_PARTITION,
  EXTRACT_MAX_CHARS,
  MAX_NOTICES,
  appendComposerInsert,
  composeSendToChat,
  describeLoadError,
  isAllowedNavigation,
  nextZoomLevel,
  normalizeUrlInput,
  permissionNoticeText,
  pushNotice,
  truncateExtract,
  viewBoundsFromRect,
  zoomPercent,
  type BrowserNotice
} from '@shared/browser-pane'

let failures = 0
function assert(cond: boolean, what: string, detail = ''): void {
  console.log(`[smoke] ${cond ? 'PASS' : 'FAIL'}  ${what}${detail ? ` — ${detail}` : ''}`)
  if (!cond) failures++
}

console.log('[smoke] === 1. the URL bar: http(s) only, no search, no other scheme ===')
const ok = (s: string): string | null => {
  const r = normalizeUrlInput(s)
  return r.ok ? r.url : null
}
const refused = (s: string): string | null => {
  const r = normalizeUrlInput(s)
  return r.ok ? null : r.reason
}
assert(ok('https://example.com/a?b=1') === 'https://example.com/a?b=1', 'a full https URL passes unchanged')
assert(ok('example.com') === 'https://example.com/', 'a bare host gets https://')
assert(ok('localhost:8005/x') === 'http://localhost:8005/x', 'localhost gets http:// (no TLS on a dev port)')
assert(ok('10.0.0.5:8005') === 'http://10.0.0.5:8005/', 'host:port is not mistaken for scheme:')
assert(/javascript/.test(refused('javascript:1') ?? '') || /search engine/.test(refused('javascript:1') ?? ''), 'javascript:1 is still refused')
assert(ok('192.168.1.10:3000') === 'http://192.168.1.10:3000/', 'a private IPv4 gets http://')
assert(ok('  Example.COM  ') === 'https://example.com/', 'whitespace trimmed, host lowercased by the URL parser')
assert(/javascript/.test(refused('javascript:alert(1)') ?? ''), 'javascript: is refused and named')
assert(/file/.test(refused('file:///etc/passwd') ?? ''), 'file: is refused and named')
assert(/data/.test(refused('data:text/html,<script>1</script>') ?? ''), 'data: is refused and named')
assert(refused('beacon-artifact://x/y') !== null, 'the app\'s own artifact scheme is refused (a page must not reach it)')
assert(/search engine/.test(refused('how do I frobnicate') ?? ''), 'a phrase is refused with the no-search-engine reason')
assert(/search engine/.test(refused('nodots') ?? ''), 'a bare word without a dot is refused')
assert(refused('') !== null && refused('   ') !== null, 'empty input is refused')
assert(isAllowedNavigation('https://x.y/') && isAllowedNavigation('http://x/') && isAllowedNavigation('about:blank'), 'pages may navigate to http(s) and about:blank')
assert(!isAllowedNavigation('file:///x') && !isAllowedNavigation('javascript:1') && !isAllowedNavigation('beacon-artifact://a/b') && !isAllowedNavigation('chrome://settings'), 'pages may not navigate to file/javascript/app/chrome schemes')
assert(!BROWSER_PARTITION.startsWith('persist:') && BROWSER_PARTITION.length > 0, `the partition '${BROWSER_PARTITION}' is in-memory (no persist:)`)

console.log('[smoke] === 2. error pages: readable, per Chromium code ===')
const dns = describeLoadError(-105, 'ERR_NAME_NOT_RESOLVED', 'https://nope.invalid/path')
assert(dns?.kind === 'dns' && /nope\.invalid could not be found/.test(dns.headline), 'DNS failure names the host')
assert(!!dns && /Tailscale/.test(dns.detail), 'DNS detail mentions the network the user is likely on')
const ref = describeLoadError(-102, 'ERR_CONNECTION_REFUSED', 'http://127.0.0.1:9/')
assert(ref?.kind === 'refused' && /refused the connection/.test(ref.headline), 'refused → "refused the connection"')
const cert = describeLoadError(-202, 'ERR_CERT_AUTHORITY_INVALID', 'https://self.signed/')
assert(cert?.kind === 'cert' && /certificate problem/.test(cert.headline) && /does not offer a way to proceed past a bad certificate/.test(cert.detail), 'cert error says there is no way past it')
assert(describeLoadError(-200, 'ERR_CERT_COMMON_NAME_INVALID', 'https://a/')?.kind === 'cert', 'the whole -2xx range is a cert error')
assert(describeLoadError(-106, 'ERR_INTERNET_DISCONNECTED', 'https://a/')?.kind === 'offline', 'offline is its own page')
assert(describeLoadError(-7, 'ERR_TIMED_OUT', 'https://a/')?.kind === 'timeout' && describeLoadError(-118, 'ERR_CONNECTION_TIMED_OUT', 'https://a/')?.kind === 'timeout', 'both timeout codes → timeout')
assert(describeLoadError(-312, 'ERR_UNSAFE_PORT', 'http://a:1/')?.kind === 'blocked', 'unsafe port → blocked (not a generic failure)')
assert(describeLoadError(-3, 'ERR_ABORTED', 'https://a/') === null, 'ERR_ABORTED (Stop, or a superseding navigation) is NOT an error page')
const other = describeLoadError(-999, 'ERR_WHATEVER', 'not a url')
assert(other?.kind === 'other' && other.detail.includes('ERR_WHATEVER') && other.detail.includes('-999'), 'unknown codes keep Chromium\'s token and number')

console.log('[smoke] === 3. geometry: CSS px → DIP, clamped ===')
const content = { width: 1200, height: 800 }
const b1 = viewBoundsFromRect({ x: 600.4, y: 40.6, width: 500.2, height: 700 }, 1, content)
assert(!!b1 && b1.x === 600 && b1.y === 41 && b1.width === 501 && b1.height === 700, 'rounded to integers at zoom 1', JSON.stringify(b1))
const b2 = viewBoundsFromRect({ x: 500, y: 40, width: 400, height: 600 }, 1.2, content)
assert(!!b2 && b2.x === 600 && b2.y === 48 && b2.width === 480 && b2.height === 720, 'a zoomed shell scales the rect (⌘+ persists across launches)', JSON.stringify(b2))
const b3 = viewBoundsFromRect({ x: 1000, y: 700, width: 500, height: 500 }, 1, content)
assert(!!b3 && b3.x + b3.width === 1200 && b3.y + b3.height === 800, 'clamped to the window content area', JSON.stringify(b3))
assert(viewBoundsFromRect({ x: 10, y: 10, width: 4, height: 300 }, 1, content) === null, 'a sub-8px sliver is "hidden", not a 4px view')
assert(viewBoundsFromRect({ x: -50, y: -50, width: 100, height: 100 }, 1, content)?.x === 0, 'negative origin clamps to 0')
assert(viewBoundsFromRect({ x: 10, y: 10, width: 100, height: 100 }, Number.NaN, content)?.width === 100, 'a NaN zoom factor is treated as 1')

console.log('[smoke] === 4. send to chat: shape, labels, truncation ===')
const msg = composeSendToChat({ url: 'https://ex.com/p', title: 'Ex Page', selection: 'the chosen bit', text: 'everything on the page' })
assert(msg.startsWith('From the browser: Ex Page\nhttps://ex.com/p\n'), 'header names the origin: title + URL', JSON.stringify(msg.slice(0, 60)))
assert(/Selected text:\n"""\nthe chosen bit\n"""$/.test(msg), 'selection wins and is fenced', JSON.stringify(msg))
const msg2 = composeSendToChat({ url: 'https://ex.com/p', title: '', selection: '   ', text: 'everything on the page' })
assert(msg2.startsWith('From the browser: https://ex.com/p\n') && /Page text:\n"""\neverything on the page\n"""$/.test(msg2), 'whitespace-only selection → page text; empty title → the URL stands in')
const big = 'x'.repeat(EXTRACT_MAX_CHARS + 5000)
const t = truncateExtract(big)
assert(t.truncated && t.text.length < big.length && /\[… truncated here: 20,000 of 25,000 characters shown\]$/.test(t.text), 'over the cap: cut, with a VISIBLE marker naming both counts', t.text.slice(-70))
assert(t.text.startsWith('x'.repeat(EXTRACT_MAX_CHARS)) && t.text.charAt(EXTRACT_MAX_CHARS) === '\n', 'the marker follows exactly the cap\'s worth of text')
const small = truncateExtract('a\r\nb   \n\n\n\n\nc  ')
assert(!small.truncated && small.text === 'a\nb\n\nc', 'under the cap: CRLF normalised, trailing spaces and blank runs collapsed, nothing cut', JSON.stringify(small.text))
const at = truncateExtract('y'.repeat(EXTRACT_MAX_CHARS))
assert(!at.truncated, 'exactly the cap is not truncated')
const composedBig = composeSendToChat({ url: 'u', title: 't', selection: '', text: big })
assert(appendComposerInsert('', 'BLOCK') === 'BLOCK' && appendComposerInsert('   ', 'BLOCK') === 'BLOCK', 'an empty draft takes the block as is')
assert(appendComposerInsert('what does this say?  ', 'BLOCK') === 'what does this say?\n\nBLOCK', 'a draft in progress keeps its words; the block lands on its own paragraph')
assert(appendComposerInsert('keep me', '   ') === 'keep me', 'an empty block changes nothing')
assert(/truncated here/.test(composedBig), 'the composed message carries the marker')

console.log('[smoke] === 5. zoom + notices ===')
assert(nextZoomLevel(0, 'in') === 1 && nextZoomLevel(0, 'out') === -1 && nextZoomLevel(3, 'reset') === 0, 'in/out/reset step by one level')
assert(nextZoomLevel(5, 'in') === 5 && nextZoomLevel(-5, 'out') === -5, 'clamped at ±5')
assert(zoomPercent(0) === 100 && zoomPercent(1) === 120 && zoomPercent(-1) === 83, 'level → percent (Chromium\'s 1.2 ratio)')
let ring: BrowserNotice[] = []
for (let i = 1; i <= MAX_NOTICES + 3; i++) ring = pushNotice(ring, { id: i, kind: 'permission', text: `n${i}`, at: i })
assert(ring.length === MAX_NOTICES && ring[0].id === 4 && ring[ring.length - 1].id === MAX_NOTICES + 3, `the notice ring keeps the newest ${MAX_NOTICES}`)
assert(/ex\.com asked for the camera or microphone — denied/.test(permissionNoticeText('media', 'ex.com')), 'media → "camera or microphone"')
assert(/asked for your location/.test(permissionNoticeText('geolocation', 'ex.com')), 'geolocation → "your location"')
assert(/asked for frobnicate — denied/.test(permissionNoticeText('frobnicate', 'ex.com')), 'an unknown permission is still named, never swallowed')

console.log('')
console.log('[smoke] ===================== RESULT =====================')
console.log(`[smoke] outcome: ${failures === 0 ? 'PASS ✓' : `FAIL ✗ (${failures})`} (URL bar, error copy, geometry, send-to-chat, zoom, notices)`)
console.log('[smoke] ===================================================')
process.exit(failures === 0 ? 0 : 1)
