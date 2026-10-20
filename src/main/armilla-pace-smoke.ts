/**
 * Headless smoke for Armilla's frame pacing (@shared/armilla-pace).
 *
 * Proves the decision table exhaustively: at rest the sky waits IDLE_FRAME_MS whether or not the
 * window has focus; with work to show it takes every display frame when focused and
 * UNFOCUSED_FRAME_MS when not. Then proves Armilla is wired to it, so a correct model wired to
 * nothing fails here.
 *
 * WHAT THIS CANNOT PROVE: that the painted sky follows the table. That needs a window;
 * scripts/armilla-pace-probe.mjs counts real redraws in the built app (macOS).
 *
 *   npm run build && npm run smoke:armilla-pace
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { IDLE_FRAME_MS, UNFOCUSED_FRAME_MS, nextFrameDelay } from '@shared/armilla-pace'

let failures = 0
function assert(cond: boolean, what: string, detail = ''): void {
  console.log(`[smoke] ${cond ? 'PASS' : 'FAIL'}  ${what}${detail && !cond ? `\n        ${detail}` : ''}`)
  if (!cond) failures++
}

console.log('[smoke] === the three paces are ordered ===')
assert(UNFOCUSED_FRAME_MS > 0, 'an unfocused working sky waits between frames (0 would be every display frame)')
assert(UNFOCUSED_FRAME_MS < IDLE_FRAME_MS, 'and redraws faster than a resting sky: work stays visibly faster than rest')
assert(IDLE_FRAME_MS <= 100, 'a resting sky waits at most 100 ms: the equator moves ~8.8 viewBox units/s at rest, so a longer wait makes the turn visibly step', `IDLE_FRAME_MS=${IDLE_FRAME_MS}`)

console.log('\n[smoke] === at rest: the slow pace, focused or not ===')
assert(nextFrameDelay({ heat: 0, transients: false, focused: true }) === IDLE_FRAME_MS, 'no heat, nothing in flight, focused → IDLE_FRAME_MS (the 120-redraws-a-second-at-rest case this fixes)')
assert(nextFrameDelay({ heat: 0, transients: false, focused: false }) === IDLE_FRAME_MS, 'no heat, nothing in flight, unfocused → IDLE_FRAME_MS, not the faster unfocused working pace')

console.log('\n[smoke] === working: every frame when focused, slowed when not ===')
assert(nextFrameDelay({ heat: 0.4, transients: false, focused: true }) === 0, 'heat, focused → every display frame (unchanged from before)')
assert(nextFrameDelay({ heat: 0.4, transients: false, focused: false }) === UNFOCUSED_FRAME_MS, 'heat, unfocused → UNFOCUSED_FRAME_MS: slowed, never frozen')
assert(nextFrameDelay({ heat: 0.001, transients: false, focused: true }) === 0, 'any heat at all counts as work: the decaying tail stays smooth until it reaches 0')

console.log('\n[smoke] === a ripple or comet in flight counts as work, even with no heat ===')
assert(nextFrameDelay({ heat: 0, transients: true, focused: true }) === 0, 'transient, focused → every display frame (a comet laps the dial in 2.4 s and would teleport at the rest pace)')
assert(nextFrameDelay({ heat: 0, transients: true, focused: false }) === UNFOCUSED_FRAME_MS, 'transient, unfocused → UNFOCUSED_FRAME_MS')
assert(nextFrameDelay({ heat: 1, transients: true, focused: true }) === 0, 'heat and transient, focused → every display frame')

console.log('\n[smoke] === Armilla is wired to the model ===')
{
  // Comments stripped: a comment naming nextFrameDelay must not satisfy these.
  const src = readFileSync(join(process.cwd(), 'src/renderer/src/components/Armilla.tsx'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '')
  assert(/from '@shared\/armilla-pace'/.test(src), 'Armilla imports the pacing model')
  const tick = src.slice(src.indexOf('const tick = '), src.indexOf('const tick = ') + 1500)
  assert(tick.includes('nextFrameDelay({'), 'its tick asks the model for the next delay', tick.slice(0, 200))
  assert(/ripples\.length > 0 \|\| comet !== null/.test(tick), 'and passes ripples AND comets as transients (either alone would let the other teleport)')
  assert(/focused: document\.hasFocus\(\)/.test(tick), 'and passes the live focus state')
  assert(/clearTimeout\(pace\)/.test(src), 'unmount clears the pacing timer (else a resting sky ticks once more after Mission closes)')
}

console.log(`\n[smoke] outcome: ${failures === 0 ? 'PASS ✓' : `FAIL ✗ (${failures})`}`)
process.exit(failures === 0 ? 0 : 1)
