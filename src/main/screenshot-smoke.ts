/**
 * Headless smoke for screenshot capture — the pure model only: ordering, the
 * filename mint, and the TCC access-state sentences. desktopCapturer itself needs a display and a
 * grant, so the capture round-trip is display-verified over CDP; what this pins is the contract
 * the picker renders from — above all that an un-granted state produces a SENTENCE, because
 * un-granted capture does not error, it hands back convincing black rectangles.
 *
 * Run: npm run smoke:screenshot
 */
import { CHAT_UPLOAD_SAFE_BYTES, oversizeAttachmentNotice } from '@shared/attachments'
import {
  emptyGrabError,
  orderSources,
  screenAccessHint,
  screenshotFilename,
  transientGrabError,
  type ScreenAccessState
} from '@shared/capture'

let failures = 0
function assert(cond: boolean, what: string): void {
  console.log(`[smoke] ${cond ? 'PASS' : 'FAIL'}  ${what}`)
  if (!cond) failures++
}

console.log('[smoke] === 1. ordering: screens first, names inside ===')
const mixed = [
  { kind: 'window' as const, name: 'Zed' },
  { kind: 'screen' as const, name: 'Screen 2' },
  { kind: 'window' as const, name: 'Activity Monitor' },
  { kind: 'screen' as const, name: 'Screen 1' }
]
const ordered = orderSources(mixed)
assert(ordered[0].name === 'Screen 1' && ordered[1].name === 'Screen 2', 'screens lead, in name order')
assert(ordered[2].name === 'Activity Monitor' && ordered[3].name === 'Zed', 'windows follow, in name order')
assert(orderSources(mixed).length === mixed.length, 'ordering never drops a source')
assert(mixed[0].name === 'Zed', 'input array is not mutated')

console.log('[smoke] === 2. filename: sortable, deterministic, no locale ===')
// 2026-08-28 21:07:05 local — the mint uses LOCAL time on purpose (it names the user\'s moment).
const t = new Date(2026, 7, 28, 21, 7, 5).getTime()
assert(screenshotFilename(t) === 'screenshot-20260828-210705.png', `mint is deterministic (got ${screenshotFilename(t)})`)
assert(screenshotFilename(t) === screenshotFilename(t), 'same instant, same name')
const jan = new Date(2026, 0, 3, 4, 5, 6).getTime()
assert(screenshotFilename(jan) === 'screenshot-20260103-040506.png', 'single digits are zero-padded everywhere')
assert(screenshotFilename(t).endsWith('.png'), 'a png grab names itself .png')
assert(screenshotFilename(t, 'image/jpeg').endsWith('.jpg'), 'a wire-fitted jpeg grab names itself .jpg')

console.log('[smoke] === 2b. the wire cap matches the daemon and refuses visibly ===')
// The cap mirrors the daemon's 20 MB upload guard (Prometheus#327 raised the WS frame limit to
// 32 MiB, so 20 MB of raw bytes fits the frame as base64 with envelope margin: 20 MB * 4/3 < 32 MiB).
assert(CHAT_UPLOAD_SAFE_BYTES === 20 * 1024 * 1024, 'the safe cap equals the daemon upload guard (20 MB)')
assert(Math.ceil((CHAT_UPLOAD_SAFE_BYTES * 4) / 3) + 64 * 1024 < 32 * 1024 * 1024, 'the cap as base64 + envelope stays under the daemon 32 MiB frame limit')
const notice = oversizeAttachmentNotice('video.mov', 27_262_976)
assert(notice.includes('video.mov') && notice.includes('26.0 MB'), 'the refusal names the file and its size')
assert(notice.includes(`${Math.round(CHAT_UPLOAD_SAFE_BYTES / (1024 * 1024))} MB`), 'the refusal names the limit')

console.log('[smoke] === 3. every access state says the right amount ===')
const STATES: ScreenAccessState[] = ['granted', 'denied', 'restricted', 'not-determined', 'unknown']
for (const s of STATES) assert(typeof screenAccessHint(s) === 'string', `${s} produces a string, never undefined`)
assert(screenAccessHint('granted') === '', 'granted shows the grid, not a hint')
assert(screenAccessHint('unknown') === '', 'unknown (non-darwin) shows the grid too — it is not a failure')
for (const s of ['denied', 'restricted', 'not-determined'] as const) {
  const hint = screenAccessHint(s)
  assert(hint.length > 0, `${s} produces a visible sentence — black rectangles are not an answer`)
  assert(hint.includes('Screen Recording'), `${s} names the actual System Settings pane`)
}
assert(emptyGrabError().includes('Screen Recording'), 'an empty grab names the likely cause, not just "failed"')
assert(transientGrabError().length > 0 && !transientGrabError().includes('System Settings'), 'a transient blank (access granted) does NOT send the user to System Settings')
assert(transientGrabError() !== emptyGrabError(), 'the two empty-grab causes stay distinguishable')

console.log('')
console.log('[smoke] ===================== RESULT =====================')
console.log(`[smoke] outcome: ${failures === 0 ? 'PASS ✓' : `FAIL ✗ (${failures})`} (ordering, filename, access sentences)`)
console.log('[smoke] ===================================================')
process.exit(failures === 0 ? 0 : 1)
