/**
 * Headless smoke for the badge model (@shared/badge).
 *
 * Proves WHAT count to show and when to show none — pure, no display. What it cannot prove is that
 * main calls app.setBadgeCount with that number (a platform call needing a Unity desktop / macOS
 * permission): that is scripts/badge-probe.mjs, which patches setBadgeCount and drives the real
 * APPROVALS_COUNT ipc. Split as always so "wrong number" and "never set" are different gates.
 *
 *   npm run build && npm run smoke:badge
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { badgeCount, displayedBadgeCount, hasBadge } from '@shared/badge'

let failures = 0
function assert(cond: boolean, what: string, detail = ''): void {
  console.log(`[smoke] ${cond ? 'PASS' : 'FAIL'}  ${what}${detail && !cond ? `\n        ${detail}` : ''}`)
  if (!cond) failures++
}

console.log('[smoke] === the badge IS the pending-approval count ===')
assert(badgeCount(0).count === 0, 'zero approvals → zero badge')
assert(badgeCount(3).count === 3, 'three approvals → a badge of 3')
assert(hasBadge(badgeCount(0)) === false, 'zero means NO badge (Electron clears on 0; it does not show a zero)')
assert(hasBadge(badgeCount(1)) === true, 'one approval is enough to show a badge — the agent is stopped on it')

console.log('\n[smoke] === hostile values cannot reach the OS surface ===')
assert(badgeCount(NaN).count === 0, 'NaN → 0 — a badge showing NaN would be on the dock, outside the app\'s own validation')
assert(badgeCount(-5).count === 0, 'negative → 0')
assert(badgeCount(2.7).count === 2, 'fractional is floored, matching the APPROVALS_COUNT ipc handler exactly')
assert(badgeCount(Number.POSITIVE_INFINITY).count === 0, 'Infinity → 0 — isFinite guards it, as the ipc handler does')
// The clamp here must AGREE with the ipc handler's, or the tray line and the badge can disagree.
const ipcClamp = (n: number) => (typeof n === 'number' && Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0)
for (const v of [0, 1, 3, -5, 2.7, NaN, Infinity]) assert(badgeCount(v).count === ipcClamp(v), `badgeCount(${v}) matches the ipc handler's clamp (${badgeCount(v).count} vs ${ipcClamp(v)})`)

console.log('\n[smoke] === the DISPLAYED count is capped separately from the counted one ===')
assert(displayedBadgeCount(badgeCount(5)) === 5, 'a small count displays exactly')
assert(displayedBadgeCount(badgeCount(150)) === 99, '150 approvals displays as 99 — a three-digit badge overflows the dock icon')
assert(displayedBadgeCount(badgeCount(150), 9) === 9, 'the cap is a parameter, so a smaller dock can cap lower')
assert(displayedBadgeCount(badgeCount(0)) === 0, 'zero is never capped — it is "no badge", not "capped to max"')
assert(displayedBadgeCount(badgeCount(99)) === 99, 'exactly at the cap displays exactly (the bound is inclusive)')
assert(displayedBadgeCount(badgeCount(150)) !== badgeCount(150).count, 'and the DISPLAYED count really differs from the COUNTED one — the tray still shows 150, the badge shows 99')

console.log('\n[smoke] === main wires the model and guards the platform ===')
{
  const mainSrc = readFileSync(join(process.cwd(), 'src/main/index.ts'), 'utf8')
  assert(/app\.setBadgeCount\(/.test(mainSrc), 'main calls app.setBadgeCount — the model is wired to the OS, not just defined')
  assert(/displayedBadgeCount\(badgeCount\(pendingApprovals\)\)/.test(mainSrc), 'main sets the badge FROM the model on the SAME pendingApprovals counter the tray uses — one source, so they cannot drift')
  assert(/updateBadge\(\)/.test(mainSrc) && /function updateTray/.test(mainSrc), 'updateBadge is called from updateTray — the one funnel every approval-count change already flows through')
  assert(/process\.platform === 'win32'/.test(mainSrc) && /return/.test(mainSrc), "Windows is guarded out — setBadgeCount is @platform linux,darwin, NOT Windows, so calling it there is a silent no-op at best")
  assert(/const ok = app\.setBadgeCount/.test(mainSrc) && /if \(!ok/.test(mainSrc), 'the return value is CHECKED — false means the desktop cannot show a badge (no Unity / no permission), and swallowing that silently makes "never appears" look like "never tried"')
  assert(/badgeUnsupportedLogged/.test(mainSrc), 'and the unsupported-platform note is logged ONCE, not on every approval change')
}

console.log(`\n[smoke] outcome: ${failures === 0 ? 'PASS ✓' : `FAIL ✗ (${failures})`}`)
process.exit(failures === 0 ? 0 : 1)
