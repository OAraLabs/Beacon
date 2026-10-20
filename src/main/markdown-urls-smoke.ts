/**
 * The markdown URL filter — headless, no DOM, no packaged build.
 *
 * WHY THIS IS A SMOKE AND NOT JUST A UNIT TEST OF A PURE FUNCTION: the defect it closes only
 * REPRODUCES in a packaged build, where the renderer's document base is file:// and a relative href
 * resolves to a local path the shell window then hands to the OS. Nobody can assert that by running
 * `npm run dev`. So the assertion lives at the layer that decides the href at all — the transform —
 * and it pins the CONTRACT: what react-markdown's default does versus what ours does, side by side.
 *
 * Run: npm run build && ELECTRON_RUN_AS_NODE=1 electron out/shared/markdown-urls-smoke.js
 * (the shared smokes compile alongside main's; see electron.vite.config.ts)
 */
import { isAllowedNavigation, isWebUrl, safeExternalUrl } from '@shared/browser-pane'
import { markdownUrlTransform } from '@shared/markdown-urls'

let failures = 0
function assert(cond: boolean, what: string, detail = ''): void {
  console.log(`[smoke] ${cond ? 'PASS' : 'FAIL'}  ${what}${detail ? ` — ${detail}` : ''}`)
  if (!cond) failures++
}

console.log('[smoke] === 1. the defect: colon-free hrefs must not survive ===')
// These are the two shapes react-markdown's default transform passes through UNCHANGED, because
// with no colon it concludes "relative". Against a file:// base they become local paths.
assert(markdownUrlTransform('/Users/me/Downloads/report.bat') === '', 'a root-relative path is refused')
assert(markdownUrlTransform('report.bat') === '', 'a bare relative filename is refused')
assert(markdownUrlTransform('../../../../etc/passwd') === '', 'a traversal path is refused')
assert(markdownUrlTransform('C:\\Users\\me\\Downloads\\x.bat') === '', 'a windows path is refused')

console.log('[smoke] === 2. explicit dangerous schemes are refused ===')
for (const bad of [
  'file:///Users/me/Downloads/report.bat',
  'javascript:alert(1)',
  'data:text/html,<script>alert(1)</script>',
  'beacon-artifact://render/x?kind=html',
  'chrome://settings',
  'vbscript:msgbox(1)',
  'about:config'
]) {
  assert(markdownUrlTransform(bad) === '', `${bad.slice(0, 28)} is refused`)
}

console.log('[smoke] === 3. real links still work (the lock-out direction) ===')
assert(
  markdownUrlTransform('https://example.com/a?b=1#c') === 'https://example.com/a?b=1#c',
  'an https URL passes unchanged'
)
assert(markdownUrlTransform('http://10.0.0.5:8005/x') === 'http://10.0.0.5:8005/x', 'an http URL passes unchanged')
assert(markdownUrlTransform('mailto:a@b.c') === 'mailto:a@b.c', 'mailto passes')
assert(markdownUrlTransform('ircs://irc.example/x') === 'ircs://irc.example/x', 'ircs passes')
assert(markdownUrlTransform('xmpp:a@b.c') === 'xmpp:a@b.c', 'xmpp passes')
assert(markdownUrlTransform('  https://example.com  ') === 'https://example.com', 'whitespace trimmed')

console.log('[smoke] === 4. degenerate input ===')
assert(markdownUrlTransform('') === '', 'empty is refused')
assert(markdownUrlTransform('   ') === '', 'whitespace-only is refused')
assert(markdownUrlTransform(undefined as unknown as string) === '', 'undefined is refused, not thrown')

console.log('[smoke] === 5. the OS-launcher predicate (main-process half) ===')
// safeExternalUrl answers a DIFFERENT question than isAllowedNavigation: that one permits
// about:blank because it is a legal target for a VIEW; handing about:blank to the OS launcher is
// meaningless. The two must not be conflated.
assert(safeExternalUrl('https://example.com') === 'https://example.com', 'a web URL is safe to open')
assert(safeExternalUrl('about:blank') === null, 'about:blank is NOT safe to hand to the OS')
assert(safeExternalUrl('file:///Users/me/x.bat') === null, 'file: is not safe to hand to the OS')
assert(safeExternalUrl('/Users/me/Downloads/x.bat') === null, 'a relative path is not safe to hand to the OS')
assert(safeExternalUrl('') === null && safeExternalUrl(null as unknown as string) === null, 'empty/null refused')
assert(isAllowedNavigation('about:blank') === true, 'but a view MAY navigate to about:blank')
assert(isWebUrl('about:blank') === false, 'about:blank is not a web URL')
assert(isWebUrl('https://x.y/') === true && isWebUrl('file:///x') === false, 'isWebUrl is the single source')

console.log(`[smoke] outcome: ${failures === 0 ? 'PASS ✓' : `FAIL ✗ (${failures})`}`)
if (failures > 0) process.exit(1)
