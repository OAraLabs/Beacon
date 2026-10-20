/**
 * Structural smoke for the window minimum size.
 *
 * WHAT THIS PINS, AND WHY IT IS NOT THE PROBE. scripts/min-size-probe.mjs resizes the REAL window
 * below the floor and reads getSize() back — that is the behavioural proof, and it needs a display.
 * This runs in `verify`, so it runs in CI, and it guards the one thing a probe cannot: that the two
 * consumers of the floor keep reading the SAME constant.
 *
 * THE DRIFT RISK. `sanitizeWindowState` clamps a size restored from window-state.json at launch;
 * `createWindow` sets minWidth/minHeight on the live window. Those are two code paths enforcing one
 * invariant. If either grows its own literal, a size that is accepted on restore can be one the
 * window refuses to be dragged to (or the reverse), and nothing fails until someone resizes — which
 * is exactly how the original gap survived: the sanitizer had a floor, was tested, and the live
 * window had none.
 *
 * So: assert the constants are exported, assert BOTH consumers name them rather than restate the
 * numbers, and self-test the checker so it cannot pass on a file it failed to read.
 *
 *   npm run build && npm run smoke:min-size
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { MIN_WINDOW_HEIGHT, MIN_WINDOW_WIDTH, sanitizeWindowState } from './window-state'

let failures = 0
function assert(cond: boolean, what: string, detail = ''): void {
  console.log(`[smoke] ${cond ? 'PASS' : 'FAIL'}  ${what}${detail && !cond ? `\n        ${detail}` : ''}`)
  if (!cond) failures++
}

const ROOT = process.cwd()
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')
const windowStateSrc = read('src/main/window-state.ts')
const indexSrc = read('src/main/index.ts')

console.log('[smoke] === the constants are the single source ===')
assert(MIN_WINDOW_WIDTH === 480, 'MIN_WINDOW_WIDTH is exported and is 480')
assert(MIN_WINDOW_HEIGHT === 360, 'MIN_WINDOW_HEIGHT is exported and is 360')
assert(/export const MIN_WINDOW_WIDTH = 480/.test(windowStateSrc), 'the width floor is exported as a named constant, not a literal at the use site')
assert(/export const MIN_WINDOW_HEIGHT = 360/.test(windowStateSrc), 'the height floor is exported as a named constant, not a literal at the use site')

console.log('\n[smoke] === consumer 1: the restore-time sanitizer ===')
assert(windowStateSrc.includes('s.width >= MIN_WINDOW_WIDTH'), 'sanitizeWindowState compares width against the EXPORTED constant')
assert(windowStateSrc.includes('s.height >= MIN_WINDOW_HEIGHT'), 'sanitizeWindowState compares height against the EXPORTED constant')
// Behavioural, not just textual: the sanitizer really does clamp to those numbers.
const display = { x: 0, y: 0, width: 2560, height: 1440 }
const tiny = sanitizeWindowState({ width: 10, height: 10 }, [display])
// It FALLS BACK TO THE DEFAULT rather than clamping up to the minimum — that is what the sanitizer
// does (`>= MIN ? round : DEFAULT`), and the assertion is written to be true of either, since what
// matters is that no below-floor size can be restored. Naming it accurately so the next reader is not
// misled into thinking the minimum is the restore target.
assert(tiny.width >= MIN_WINDOW_WIDTH && tiny.height >= MIN_WINDOW_HEIGHT, `a 10x10 restored size cannot come back below the floor (got ${tiny.width}x${tiny.height}, the default)`)
const ok = sanitizeWindowState({ width: 1200, height: 900 }, [display])
assert(ok.width === 1200 && ok.height === 900, 'a sane restored size is left alone — the clamp is a floor, not a target')

console.log('\n[smoke] === consumer 2: the LIVE window (the half that was missing) ===')
assert(indexSrc.includes('minWidth: MIN_WINDOW_WIDTH'), 'createWindow sets minWidth FROM THE CONSTANT — a literal here is the drift this smoke exists to catch')
assert(indexSrc.includes('minHeight: MIN_WINDOW_HEIGHT'), 'createWindow sets minHeight FROM THE CONSTANT')
assert(indexSrc.includes('MIN_WINDOW_HEIGHT, MIN_WINDOW_WIDTH') || indexSrc.includes('MIN_WINDOW_WIDTH, MIN_WINDOW_HEIGHT'), 'index.ts imports both constants from ./window-state rather than declaring its own')
// A literal floor pasted into the BrowserWindow options would pass a loose check, so say it must not
// be there: the numbers belong to window-state.ts alone.
const browserWindowBlock = indexSrc.slice(indexSrc.indexOf('new BrowserWindow({'), indexSrc.indexOf('new BrowserWindow({') + 1400)
assert(!/\bminWidth:\s*4\d\d\b/.test(browserWindowBlock) && !/\bminHeight:\s*3\d\d\b/.test(browserWindowBlock), 'the BrowserWindow options carry no literal minimum — 480/360 appear only in window-state.ts')

console.log('\n[smoke] === no private alias of the floor survives ===')
assert(!/const MIN_W = /.test(windowStateSrc) && !/const MIN_H = /.test(windowStateSrc), 'the old private MIN_W/MIN_H aliases are gone — two names for one constant is how they drift apart')
assert((windowStateSrc.match(/480/g) ?? []).length === 1, 'the number 480 appears exactly ONCE in window-state.ts (its declaration)')
assert((windowStateSrc.match(/360/g) ?? []).length === 1, 'the number 360 appears exactly ONCE in window-state.ts (its declaration)')

console.log('\n[smoke] === self-test: the checker can actually see the drift ===')
{
  // A checker that cannot detect a regression is not a floor. Plant each drift and require it to be
  // seen, in the browser-invariant idiom.
  const sawLiteral = /minWidth:\s*480/.test(indexSrc.replace('minWidth: MIN_WINDOW_WIDTH', 'minWidth: 480'))
  assert(sawLiteral, 'planting a literal minWidth in index.ts WOULD be seen by the no-literal assertion')
  const sawAlias = /const MIN_W = /.test(`${windowStateSrc}\nconst MIN_W = 480`)
  assert(sawAlias, 'reintroducing a private MIN_W alias WOULD be seen')
  // Renaming the constant at the use site (leaving a private OWN_MIN behind) must be seen.
  const renamed = indexSrc.replace(/MIN_WINDOW_WIDTH/g, 'OWN_MIN')
  assert(!renamed.includes('minWidth: MIN_WINDOW_WIDTH'), 'renaming the constant away at the use site WOULD be seen by the FROM-THE-CONSTANT assertion')
  assert(read('src/main/window-state.ts').length > 500, 'control: the source files were actually read (a failed read would silently pass the negative assertions above)')
}

console.log(`\n[smoke] outcome: ${failures === 0 ? 'PASS ✓' : `FAIL ✗ (${failures})`}`)
process.exit(failures === 0 ? 0 : 1)
