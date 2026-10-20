/**
 * split-panes-smoke — the pane layout model behind several conversations side by side
 * (@shared/split-panes). The main view's wiring is driven by scripts/split-panes-app-probe.mjs.
 *
 * Run: npm run build && npm run smoke:split-panes
 */
import {
  closePane,
  focusPane,
  focusedTarget,
  maxPanesFor,
  MAX_PANES,
  openBeside,
  panesMinWidth,
  parseLayout,
  PANE_MIN_WIDTH,
  PANE_DIVIDER_WIDTH,
  removeSession,
  serializeLayout,
  showIn,
  single,
  visibleSessions,
  moveBoundary,
  withWidths,
  evenWidths,
  paneWeights,
  type PaneLayout
} from '@shared/split-panes'
import { shouldNotify } from './presence'
import { fitPanelWidth, fitSessionListWidth, showSessions, CONVERSATION_MIN_WIDTH, RAIL_WIDTH, SESSION_LIST_WIDTH, PANEL_DIVIDER_WIDTH } from '@shared/side-panel'

const MIN_CHECKS = 70
let checks = 0
let failures = 0
function check(cond: boolean, label: string, detail?: unknown): void {
  checks += 1
  if (cond) console.log(`  ok   ${label}`)
  else {
    console.error(`  FAIL ${label}${detail !== undefined ? `  (${JSON.stringify(detail)})` : ''}`)
    failures += 1
  }
}
process.on('exit', () => {
  if (checks < MIN_CHECKS) {
    console.error(`\n[smoke] FAIL only ${checks} checks ran, expected at least ${MIN_CHECKS}`)
    process.exitCode = 1
  } else if (failures > 0) {
    console.error(`\n[smoke] FAIL ${failures} of ${checks}`)
    process.exitCode = 1
  } else console.log(`\n[smoke] PASS ${checks} checks`)
})
const L = (l: PaneLayout): string => `${l.panes.map((p, i) => (i === l.focus ? `[${p ?? 'home'}]` : String(p ?? 'home'))).join(' ')}`

console.log('\n=== show (a sidebar click) ===')
{
  const home = single(null)
  check(L(showIn(home, 'a')) === '[a]', 'Home → a session replaces it')
  const two: PaneLayout = { panes: ['a', 'b'], focus: 0 }
  check(L(showIn(two, 'c')) === '[c] b', 'a new session replaces the FOCUSED pane only')
  check(L(showIn(two, 'b')) === 'a [b]', 'a session already in a pane focuses that pane (one place at a time)')
  check(showIn(two, 'a') === two, 'showing the focused session changes nothing')
  check(L(showIn(two, null)) === '[home] b', 'Home (New chat) replaces the focused pane')
  check(L(showIn({ panes: ['a', 'b'], focus: 1 }, 'a')) === '[a] b', 'focus moves to where the session already is')
}

console.log('\n=== open beside (a drop, "Open beside") ===')
{
  const one = single('a')
  const r1 = openBeside(one, 'b', 'right')
  check(r1.outcome === 'opened' && L(r1.layout) === 'a [b]', 'right of the only pane, and the new pane is focused')
  const r2 = openBeside(r1.layout, 'c', 'left', 0)
  check(r2.outcome === 'opened' && L(r2.layout) === '[c] a b', 'left of pane 0')
  const r3 = openBeside(r2.layout, 'd', 'right', 1)
  check(r3.outcome === 'opened' && L(r3.layout) === 'c a [d] b', 'right of a middle pane')
  const full = openBeside(r3.layout, 'e', 'right')
  check(full.outcome === 'full' && full.layout === r3.layout, `${MAX_PANES} panes: refused, unchanged (caller offers its own window)`)
  const tight = openBeside(r1.layout, 'c', 'right', 1, 2)
  check(tight.outcome === 'full', 'a room-based max of 2 refuses the third pane')
  const again = openBeside(r1.layout, 'a', 'right')
  check(again.outcome === 'focused' && L(again.layout) === '[a] b', 'a session already on screen is focused, not opened twice')
  const fromHome = openBeside(single(null), 'a', 'right')
  check(fromHome.outcome === 'replaced-home' && L(fromHome.layout) === '[a]', 'beside a lone Home pane: replaces it (nothing to sit beside)')
  const leavingHome = openBeside({ panes: ['a', null], focus: 1 }, 'b', 'right', 1)
  check(L(leavingHome.layout) === 'a [b]', 'a focused Home pane left behind drops out (Home only where focus is)')
  check(openBeside(single('a'), 'b', 'right', 99).outcome === 'opened' && L(openBeside(single('a'), 'b', 'left', -5).layout) === '[b] a', 'an out-of-range anchor is clamped')
}

console.log('\n=== close, focus, remove ===')
{
  const three: PaneLayout = { panes: ['a', 'b', 'c'], focus: 1 }
  check(L(closePane(three, 1)) === '[a] c', 'closing the focused pane focuses its left neighbour')
  check(L(closePane({ panes: ['a', 'b', 'c'], focus: 0 }, 0)) === '[b] c', 'closing the first focused pane focuses the new first')
  check(L(closePane(three, 2)) === 'a [b]', 'closing an unfocused pane keeps focus on the same session')
  check(L(closePane(three, 0)) === '[b] c', 'closing a pane LEFT of focus shifts the index, keeps the session')
  check(L(closePane(single('a'), 0)) === '[home]', 'the last pane never closes: it becomes Home')
  check(closePane(three, 7) === three && closePane(three, -1) === three, 'an out-of-range close is a no-op')
  check(L(focusPane(three, 2)) === 'a b [c]' && focusPane(three, 1) === three && focusPane(three, 9) === three, 'focusPane moves focus, no-op when unchanged or out of range')
  check(L(removeSession(three, 'c')) === 'a [b]', 'removing an on-screen session closes its pane')
  check(removeSession(single('a'), 'a').panes[0] === 'a', 'removing the ONLY pane is left to the caller (placeholder or fallback)')
  check(removeSession(three, 'zzz') === three, 'removing a session not on screen changes nothing')
  check(JSON.stringify(visibleSessions({ panes: ['a', null], focus: 1 })) === '["a"]', 'visibleSessions: Home is not a session')
  check(focusedTarget({ panes: ['a', 'b'], focus: 1 }) === 'b', 'focusedTarget')
}

console.log('\n=== width ===')
{
  check(panesMinWidth(1) === PANE_MIN_WIDTH && panesMinWidth(3) === 3 * PANE_MIN_WIDTH + 2 * PANE_DIVIDER_WIDTH, 'panesMinWidth: n minimums plus n-1 dividers')
  check(maxPanesFor(PANE_MIN_WIDTH) === 1 && maxPanesFor(PANE_MIN_WIDTH - 1) === 1, 'one pane always "fits" (it is the conversation)')
  check(maxPanesFor(panesMinWidth(2)) === 2 && maxPanesFor(panesMinWidth(2) - 1) === 1, 'exactly two minimums plus a divider → 2; one px less → 1')
  check(maxPanesFor(panesMinWidth(3)) === 3 && maxPanesFor(panesMinWidth(3) - 1) === 2, 'the same boundary at 3')
  check(maxPanesFor(10_000) === MAX_PANES, `a huge screen still caps at ${MAX_PANES}`)
  check(maxPanesFor(0) === 1 && maxPanesFor(Number.NaN) === 1, 'unknown room → 1')
}

console.log('\n=== save and restore ===')
{
  const l: PaneLayout = { panes: ['a', 'b', 'c'], focus: 2 }
  check(L(parseLayout(serializeLayout(l))!) === 'a b [c]', 'round-trips')
  check(L(parseLayout(serializeLayout(l), (id) => id !== 'b')!) === 'a [c]', 'a forgotten session is dropped, focus follows its session')
  check(L(parseLayout(serializeLayout(l), (id) => id !== 'c')!) === '[a] b', 'the focused session forgotten → focus clamps to a surviving pane')
  check(parseLayout(serializeLayout(l), () => false) === null, 'nothing known → null (caller falls back to last-session restore)')
  check(parseLayout(JSON.stringify({ panes: [null], focus: 0 })) === null, 'Home only → null (nothing worth restoring)')
  check(L(parseLayout(JSON.stringify({ panes: ['a', 'a', 7, '', null, 'b'], focus: 5 }))!) === 'a [b]', 'drops duplicates, non-strings, empties, unfocused Home')
  check(parseLayout(JSON.stringify({ panes: ['a', 'b', 'c', 'd', 'e', 'f'], focus: 0 }))!.panes.length === MAX_PANES, `capped at ${MAX_PANES}`)
  check(parseLayout('{bad') === null && parseLayout('[1]') === null && parseLayout('{"panes":3}') === null && parseLayout(null) === null, 'garbage → null, no throw')
  check(L(parseLayout(JSON.stringify({ panes: ['a', 'b'], focus: 'x' }))!) === '[a] b', 'a garbage focus → the first pane')
}

console.log('\n=== notifications see every pane ===')
{
  const base = { kind: 'chat_done' as const, sessionId: 'b', windowFocused: true, activeSessionId: 'a' }
  check(shouldNotify(base) === true, 'focused window, reply in a session not on screen → notify (unchanged)')
  check(shouldNotify({ ...base, visibleSessionIds: ['a', 'b'] }) === false, 'focused window, reply in an UNFOCUSED pane you can see → no notify')
  check(shouldNotify({ ...base, windowFocused: false, visibleSessionIds: ['a', 'b'] }) === true, 'window not focused → notify even for a visible pane (you are elsewhere)')
  check(shouldNotify({ ...base, visibleSessionIds: ['a', 'c'] }) === true, 'visible panes that do not include it → notify')
}

console.log('\n=== the list and the dock fit around every pane ===')
{
  // 1100, not 1600: at 1600 both cases hit the list's own 520 cap and compare equal, so the check
  // could not tell whether the panes were counted at all.
  const vw = 1100
  const two = panesMinWidth(2)
  check(fitSessionListWidth(5000, vw, 0, two) === Math.min(520, vw - RAIL_WIDTH - two), 'the list stops where two panes keep their minimum')
  check(fitSessionListWidth(5000, vw, 0, two) < fitSessionListWidth(5000, vw, 0), 'two panes leave the list less room than one')
  check(fitSessionListWidth(5000, vw, 0, 100) === fitSessionListWidth(5000, vw, 0), 'a conversationMin below one conversation is ignored (never less than one)')
  const room = 1200
  check(fitPanelWidth(5000, room, 'browser', two) === room - PANEL_DIVIDER_WIDTH - two, 'the dock stops where two panes keep their minimum')
  check(fitPanelWidth(5000, room, 'browser') === room - PANEL_DIVIDER_WIDTH - CONVERSATION_MIN_WIDTH, 'without it, the old single-conversation fit')
  const b = { open: true, pane: 'browser' as const }
  const w = RAIL_WIDTH + SESSION_LIST_WIDTH + 392 + PANEL_DIVIDER_WIDTH + CONVERSATION_MIN_WIDTH
  check(showSessions('chat', b, { viewport: w, dock: 392 }) === true && showSessions('chat', b, { viewport: w, dock: 392, conversationMin: two }) === false, 'at the width where one conversation keeps the list up, two panes make it yield')
}

console.log('\n=== divider drags: moving a boundary ===')
{
  const W = [500, 500, 500]
  check(JSON.stringify(moveBoundary(W, 0, 100)) === '[600,400,500]', 'dragging boundary 0 right by 100: pane 0 grows, pane 1 shrinks, pane 2 untouched')
  check(JSON.stringify(moveBoundary(W, 1, -50)) === '[500,450,550]', 'boundary 1 left by 50')
  check(JSON.stringify(moveBoundary(W, 0, 400)) === `[${1000 - PANE_MIN_WIDTH},${PANE_MIN_WIDTH},500]`, `a drag past the neighbour's minimum stops at ${PANE_MIN_WIDTH}`)
  check(JSON.stringify(moveBoundary(W, 0, -400)) === `[${PANE_MIN_WIDTH},${1000 - PANE_MIN_WIDTH},500]`, 'and the other way')
  const sum = (a: number[]): number => a.reduce((x, y) => x + y, 0)
  check([[0, 37], [1, -999], [0, 1e9]].every(([i, dx]) => sum(moveBoundary(W, i, dx)) === sum(W)), 'the row width never changes: a boundary moves, nothing else')
  check(JSON.stringify(moveBoundary(W, 2, 50)) === JSON.stringify(W) && JSON.stringify(moveBoundary(W, -1, 50)) === JSON.stringify(W), 'no boundary right of the last pane (or left of the first)')
  check(JSON.stringify(moveBoundary([300, 300], 0, 50)) === '[300,300]', 'a pair already under two minimums (window shrunk) stays put rather than squeezing one further')
  check(JSON.stringify(moveBoundary(W, 0, Number.NaN)) === JSON.stringify(W), 'NaN dx changes nothing')
}

console.log('\n=== weights travel with their panes ===')
{
  const three: PaneLayout = withWidths({ panes: ['a', 'b', 'c'], focus: 0 }, [600, 400, 500])
  const w = paneWeights(three)
  check(three.weights !== undefined && Math.abs(w[0] / w[1] - 1.5) < 0.001 && Math.abs(w.reduce((x, y) => x + y, 0) - 3) < 0.01, 'withWidths stores proportions, scaled to a mean of 1', w)
  check(withWidths({ panes: ['a', 'b'], focus: 0 }, [500, 500]).weights === undefined, 'equal widths store no weights (equal is the default)')
  check(withWidths(three, [1, 2]) === three, 'a widths array of the wrong length is refused')
  check(evenWidths(three).weights === undefined && evenWidths(three).panes.length === 3, 'evenWidths: equal shares again (double-click)')
  const focused = showIn(three, 'c')
  check(JSON.stringify(focused.weights) === JSON.stringify(three.weights) && focused.focus === 2, 'focusing a pane (sidebar click on an on-screen session) keeps the widths')
  const replaced = showIn(three, 'z')
  check(JSON.stringify(replaced.weights) === JSON.stringify(three.weights) && replaced.panes[0] === 'z', 'replacing the focused pane keeps its width')
  check(JSON.stringify(focusPane(three, 1).weights) === JSON.stringify(three.weights), 'focusPane keeps the widths')
  const again = openBeside(three, 'a', 'right')
  check(again.outcome === 'focused' && JSON.stringify(again.layout.weights) === JSON.stringify(three.weights), 'opening an on-screen session (focus) keeps the widths')
  const closed = closePane(three, 1)
  const cw = paneWeights(closed)
  check(closed.panes.join() === 'a,c' && Math.abs(cw[0] / cw[1] - 1.2) < 0.001, 'closing a pane drops its share; the others keep their proportion (600:500)', cw)
  const two = withWidths({ panes: ['a', 'b'], focus: 0 }, [800, 400])
  const ob = openBeside(two, 'c', 'right', 0, 4)
  const ow = paneWeights(ob.layout)
  check(ob.layout.panes.join() === 'a,c,b' && Math.abs(ow[0] / ow[2] - 2) < 0.001, 'a new pane goes in with an average share; the others keep their proportion', ow)
  check(openBeside({ panes: ['a', 'b'], focus: 0 }, 'c', 'right').layout.weights === undefined, 'with no weights, a new pane keeps everything equal')
  check(JSON.stringify(paneWeights({ panes: ['a', 'b'], focus: 0, weights: [1, -2] })) === '[1,1]', 'nonsense weights read as equal')
}

console.log('\n=== weights are saved and restored ===')
{
  const l = withWidths({ panes: ['a', 'b', 'c'], focus: 1 }, [700, 400, 400])
  const back = parseLayout(serializeLayout(l))!
  check(JSON.stringify(back.weights) === JSON.stringify(l.weights) && back.focus === 1, 'round-trips with its weights')
  const dropped = parseLayout(serializeLayout(l), (id) => id !== 'b')!
  const dw = paneWeights(dropped)
  check(dropped.panes.join() === 'a,c' && Math.abs(dw[0] / dw[1] - 1.75) < 0.001, 'a forgotten pane takes its weight with it; the survivors keep their proportion', dw)
  check(parseLayout(JSON.stringify({ panes: ['a', 'b'], focus: 0, weights: [1] }))!.weights === undefined, 'a weights array of the wrong length → equal')
  check(parseLayout(JSON.stringify({ panes: ['a', 'b'], focus: 0, weights: [2, 'x'] }))!.weights === undefined, 'a non-number weight → equal (all or nothing)')
  check(parseLayout(JSON.stringify({ panes: ['a', 'b'], focus: 0, weights: [2, 0] }))!.weights === undefined, 'a zero weight → equal')
  check(!serializeLayout({ panes: ['a', 'b'], focus: 0 }).includes('weights'), 'equal panes save no weights')
}
