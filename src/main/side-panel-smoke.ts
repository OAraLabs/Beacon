// Side-panel smoke (headless / ELECTRON_RUN_AS_NODE): the pure model behind the chat view's
// right-hand panel (@shared/side-panel), plus the registry facts the relocation rests on — the
// terminal is no longer a rail destination, and the rail's view registry has exactly the views
// that remain. R3 (design handoff 2026-09-03): three panes, one dock, ⌘1/⌘2/⌘3, and the session
// list collapses for the wide panes only. The real-app half (the WebContentsView's rect is ZERO while the panel is collapsed
// or showing the terminal; the pty keeps its pid across a switch) is the CDP probe's job:
// scripts/browser-pane-probe.mjs and scripts/terminal-app-probe.mjs.
//
// Run: npm run smoke:side-panel
import {
  CONVERSATION_MIN_WIDTH,
  DEFAULT_PANEL_STATE,
  PANEL_DEFAULT_WIDTH,
  PANEL_DIVIDER_WIDTH,
  PANEL_MIN_WIDTH,
  PANEL_PANES,
  PANEL_WIDTH_KEY,
  paneForChord,
  panesSharingWidth,
  widthGroupRepresentatives,
  fitPanelWidth,
  isPanelPane,
  parsePanelState,
  parsePanelWidth,
  canDock,
  DOCK_VIEWS,
  paneInfo,
  panelWidthKey,
  showSessions,
  RAIL_WIDTH,
  SESSION_LIST_WIDTH,
  togglePane,
  fitSessionListWidth,
  SESSION_LIST_MIN_WIDTH,
  SESSION_LIST_MAX_WIDTH
} from '@shared/side-panel'
import { NAV_VIEWS, flattenNavTree, resolveView, DEFAULT_VIEW } from '@shared/views'
import { SHORTCUTS } from '@shared/commands'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

let failures = 0
let checks = 0
function assert(cond: boolean, what: string): void {
  checks++
  console.log(`[smoke] ${cond ? 'PASS' : 'FAIL'}  ${what}`)
  if (!cond) failures++
}

console.log('[smoke] === side panel: toggle semantics ===')
{
  const closed = DEFAULT_PANEL_STATE
  assert(closed.open === false && closed.pane === 'browser', 'collapsed by default, browser first')
  const b = togglePane(closed, 'browser')
  assert(b.open && b.pane === 'browser', 'toggle browser from closed → open on browser')
  const t = togglePane(b, 'terminal')
  assert(t.open && t.pane === 'terminal', 'toggle terminal while the browser shows → SWITCH to terminal (still open)')
  const again = togglePane(t, 'terminal')
  assert(!again.open && again.pane === 'terminal', 'toggle the showing pane → close; it remembers the pane')
  const reopen = togglePane(again, 'browser')
  assert(reopen.open && reopen.pane === 'browser', 'toggle the other pane while closed → open on that pane')
  // Identity AND ORDER, as a literal: MainView dispatches ⌘n by POSITION into this array, so the
  // order is a contract, not a detail. A bare count would not have caught a pane INSERTED rather
  // than appended — which renumbers every chord already in the user's fingers.
  assert(PANEL_PANES.map((p) => p.id).join(' ') === 'inspector browser terminal progress', 'the dock is inspector · browser · terminal · progress, in that order — new panes are APPENDED')
  assert(PANEL_PANES.map((p) => p.shortcut).join(' ') === '⌘1 ⌘2 ⌘3 ⌘4', 'the chords are ⌘1 / ⌘2 / ⌘3 / ⌘4 in dock order')
  // THE CROSS-CHECK a count can never do: the shortcut string a human typed must agree with the
  // array position MainView actually dispatches by. Not a tautology — one side is hand-written
  // data, the other is the index. This catches a pane given a non-positional chord (count still
  // right, ⌘n dead) and a pane inserted rather than appended (count still right, chords renumbered).
  assert(PANEL_PANES.every((p, i) => p.shortcut === `⌘${i + 1}`), 'each pane\'s declared chord is ⌘<its 1-based dock position>')
  assert(PANEL_PANES.every((p) => paneForChord(String(PANEL_PANES.indexOf(p) + 1)) === p.id), 'and the chord resolver agrees with that position for every pane')
  assert(paneForChord('0') === null && paneForChord(String(PANEL_PANES.length + 1)) === null && paneForChord('x') === null, 'an unregistered digit stays inert — no pane, no throw')
  assert(new Set(PANEL_PANES.map((p) => p.shortcut)).size === PANEL_PANES.length, 'the chords are distinct')
  const i = togglePane(closed, 'inspector')
  assert(i.open && i.pane === 'inspector', 'toggle inspector from closed → open on inspector')
  assert(paneInfo('inspector').defaultWidth === 300 && paneInfo('browser').defaultWidth === 392 && paneInfo('terminal').defaultWidth === 392, 'R3 widths: 300 inspector, 392 browser + terminal')
  assert(!paneInfo('inspector').collapsesSessions && paneInfo('browser').collapsesSessions && paneInfo('terminal').collapsesSessions, 'browser + terminal collapse the session list; the inspector does not')
  // Measured, not copied: with this false a 900px window leaves the conversation 294px, under the
  // 380 declared below. `showSessions` only collapses when the room actually runs out, so this
  // costs nothing at a wide window.
  assert(paneInfo('progress').collapsesSessions, 'progress collapses the session list rather than squeezing the thread')
  assert(PANEL_PANES.filter((p) => !p.collapsesSessions).map((p) => p.id).join(' ') === 'inspector', 'the inspector is the ONLY pane that never yields the list — its known narrow-width cost is not inherited')
  assert(showSessions('chat', closed) && showSessions('chat', i) && !showSessions('chat', b) && !showSessions('chat', t) && !showSessions('mission', closed), 'showSessions is DERIVED: chat view, and no list-collapsing pane showing')
  assert(panelWidthKey('browser') === panelWidthKey('terminal') && panelWidthKey('inspector') !== panelWidthKey('browser'), 'browser + terminal share one width; the inspector keeps its own')
  // ── THE WIDTH BRANCH. Dragging a pane's divider must move THAT pane and only its declared
  // group. The shape this replaces — `pane === 'inspector' ? … : …` — put every new pane in the
  // browser+terminal row: the divider looked dead and silently resized two other panes, with no
  // compile error and no assertion anywhere. These are the assertions.
  assert(new Set(PANEL_PANES.map((p) => panelWidthKey(p.id))).size === new Set(PANEL_PANES.map((p) => p.widthGroup)).size, 'one settings row per width GROUP — no two groups collide on a key')
  assert(panelWidthKey('progress') !== panelWidthKey('browser') && panelWidthKey('progress') !== panelWidthKey('inspector'), 'the new pane has its OWN width row — it does not land in the browser+terminal one')
  assert(panesSharingWidth('progress').join(' ') === 'progress', 'dragging progress moves progress and NOTHING else')
  assert(panesSharingWidth('browser').join(' ') === 'browser terminal' && panesSharingWidth('terminal').join(' ') === 'browser terminal', 'browser and terminal still move together, both ways round')
  assert(panesSharingWidth('inspector').join(' ') === 'inspector', 'the inspector still moves alone')
  assert(PANEL_PANES.every((p) => panesSharingWidth(p.id).includes(p.id)), 'every pane is in its own moving set — a divider always moves the pane it belongs to')
  assert(panelWidthKey('browser') === PANEL_WIDTH_KEY, 'the shared group keeps the UNSUFFIXED key, so an existing profile does not lose its dragged width')
  const reps = widthGroupRepresentatives()
  assert(reps.length === new Set(PANEL_PANES.map((p) => p.widthGroup)).size, 'hydration reads exactly one row per width group')
  assert(new Set(reps.flatMap((r) => panesSharingWidth(r))).size === PANEL_PANES.length, 'and those reads between them cover EVERY pane — none starts at its default forever')
  // 2026-09-03: the dock may sit beside a coding run too. Being thrown back to the chat to get a
  // shell is the same "control here, pane over there" defect R3 names about the rail.
  assert(canDock('chat') && canDock('coding') && canDock('loop-manager'), 'the dock opens beside the thread AND a coding run')
  assert(!canDock('mission') && !canDock('config') && !canDock('files'), 'every other surface still routes to the chat — there is nothing there to sit beside')
  assert(DOCK_VIEWS.length === 3, 'exactly three dockable surfaces (adding one is a decision, not a default)')
  assert(showSessions('coding', b) === false && showSessions('coding', closed) === false, 'the session list is a CHAT thing — a coding run never grows one')
  // R3's REASON is "the thread keeps its reading width", so the collapse is conditional on there
  // actually being a squeeze. Wide window: the list stays. Narrow: it yields. No measurement
  // available: it yields, because the conservative answer is the one R3 asks for.
  const wide = { viewport: 1360, dock: 392 }
  const narrow = { viewport: 900, dock: 392 }
  assert(showSessions('chat', b, wide) === true, 'wide window + browser dock → the list STAYS (nothing to protect)')
  assert(showSessions('chat', b, narrow) === false, 'narrow window + browser dock → the list yields so the thread keeps its minimum')
  assert(showSessions('chat', b) === false, 'no measurement → yield (conservative, matches R3 as written)')
  assert(showSessions('chat', i, narrow) === true, 'the inspector never collapses the list, however narrow')
  assert(showSessions('chat', closed, narrow) === true, 'a closed dock never collapses the list')
  {
    // The boundary is exactly CONVERSATION_MIN_WIDTH, not a rounded guess.
    const exact = RAIL_WIDTH + SESSION_LIST_WIDTH + 392 + PANEL_DIVIDER_WIDTH + CONVERSATION_MIN_WIDTH
    assert(showSessions('chat', b, { viewport: exact, dock: 392 }) === true, `at exactly the fitting width (${exact}px) the list stays`)
    assert(showSessions('chat', b, { viewport: exact - 1, dock: 392 }) === false, 'one pixel narrower and it yields')
  }
  for (const p of PANEL_PANES) {
    assert(SHORTCUTS.some((s) => s.keys.startsWith(p.shortcut) && /pane/.test(s.does)), `the shortcut sheet lists ${p.shortcut} for the ${p.label.toLowerCase()} pane`)
  }
}

console.log('[smoke] === side panel: persistence parsing ===')
{
  assert(isPanelPane('browser') && isPanelPane('terminal') && isPanelPane('inspector') && !isPanelPane('chat') && !isPanelPane(null), 'isPanelPane accepts the three panes only')
  const s1 = parsePanelState('1', 'terminal')
  assert(s1.open && s1.pane === 'terminal', 'parsePanelState reads open + pane')
  const s2 = parsePanelState('0', 'browser')
  assert(!s2.open && s2.pane === 'browser', 'parsePanelState reads closed')
  const s3 = parsePanelState('garbage', 'nope')
  assert(!s3.open && s3.pane === 'browser', 'garbage → the default (closed, browser) — never a throw')
  const s4 = parsePanelState(null, undefined)
  assert(!s4.open && s4.pane === 'browser', 'absent → the default')
  assert(parsePanelWidth('480') === 480 && parsePanelWidth('480.6') === 481, 'parsePanelWidth reads an integer (rounding)')
  assert(parsePanelWidth('') === null && parsePanelWidth(null) === null && parsePanelWidth('abc') === null && parsePanelWidth('-5') === null && parsePanelWidth('0') === null, 'unreadable / non-positive widths → null (caller uses the default)')
}

console.log('[smoke] === side panel: width fitting ===')
{
  const room = 1200 // conversation + panel share this much
  assert(fitPanelWidth(PANEL_DEFAULT_WIDTH, room) === PANEL_DEFAULT_WIDTH, `the default width fits in ${room}px of room`)
  assert(fitPanelWidth(100, room) === PANEL_MIN_WIDTH, `narrower than the minimum → ${PANEL_MIN_WIDTH}`)
  assert(fitPanelWidth(5000, room) === room - PANEL_DIVIDER_WIDTH - CONVERSATION_MIN_WIDTH, `wider than the room → the conversation keeps ${CONVERSATION_MIN_WIDTH}px (after the ${PANEL_DIVIDER_WIDTH}px divider)`)
  const tiny = fitPanelWidth(PANEL_DEFAULT_WIDTH, 500)
  assert(tiny === PANEL_MIN_WIDTH, `a window too small for both → the panel's minimum wins (${tiny})`)
  assert(fitPanelWidth(Number.NaN, room) === PANEL_DEFAULT_WIDTH && fitPanelWidth(-1, room) === PANEL_DEFAULT_WIDTH, 'NaN / negative desired → the default width')
  assert(fitPanelWidth(444.4, room) === 444, 'fractional desired → rounded')
  assert(fitPanelWidth(Number.NaN, room, 'inspector') === 300 && fitPanelWidth(100, room, 'inspector') === 260, 'the inspector fits to ITS default (300) and minimum (260)')
  assert(PANEL_MIN_WIDTH < PANEL_DEFAULT_WIDTH && CONVERSATION_MIN_WIDTH > 0, 'constants are ordered sanely')
}

console.log('[smoke] === the registry: the terminal is a pane, not a destination ===')
{
  assert(!NAV_VIEWS.some((v) => (v.id as string) === 'terminal'), 'NAV_VIEWS has no terminal view')
  assert(!flattenNavTree().some((id) => (id as string) === 'terminal'), 'the rail tree reaches no terminal leaf')
  assert(resolveView('terminal') === DEFAULT_VIEW, 'a persisted "terminal" view id (pre-panel) resolves to the default view, not a phantom')
  assert(!NAV_VIEWS.some((v) => (v.id as string) === 'browser'), 'the browser was never a view and still is not')
}

console.log('[smoke] === the dock and the surfaces are sized by their row, not by the viewport ===')
// A viewport-height box inside the app overshoots by the 38px window chrome (the chrome is stacked
// ABOVE the app in #root, so .shell, .view-area and .layout are all vh - 38) and .view-area clips
// it: every dock pane and every view that uses a surface lost its bottom 38px. This pins the source;
// scripts/dock-fit-probe.mjs measures the real window, which is the half a regex cannot see.
{
  const css = readFileSync(join(process.cwd(), 'src/renderer/src/styles.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
  const decls = (selector: string): string => {
    const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const m = new RegExp('(?:^|\\n)' + esc + ' \\{([^}]*)\\}').exec(css)
    return m ? m[1] : ''
  }
  const dock = decls('.side-panel')
  const surface = decls('.surface')
  assert(/height:\s*100%/.test(dock) && !/height:\s*100vh/.test(dock), '.side-panel is the height of its row (100%), never 100vh — a viewport-height dock overshoots by the window chrome and loses its bottom 38px')
  assert(/height:\s*100%/.test(surface) && !/height:\s*100vh/.test(surface), '.surface is the height of its view area (100%), never 100vh — five views lost their bottom 38px to the clip')
}

console.log('[smoke] === session list: width fitting ===')
{
  // The list is resizable. Its fit has three bounds; each check below breaks if one bound is lost.
  const W = 1600 // a laptop-ish window, no dock
  assert(fitSessionListWidth(SESSION_LIST_WIDTH, W) === SESSION_LIST_WIDTH, `the default (${SESSION_LIST_WIDTH}) fits in a ${W}px window`)
  assert(fitSessionListWidth(360, W) === 360, 'a dragged width inside every bound is kept exactly')
  assert(fitSessionListWidth(120, W) === SESSION_LIST_MIN_WIDTH, `narrower than the minimum → ${SESSION_LIST_MIN_WIDTH}`)
  assert(fitSessionListWidth(5000, 4000) === SESSION_LIST_MAX_WIDTH, `a huge window still caps the list at ${SESSION_LIST_MAX_WIDTH}`)
  {
    // The conversation keeps its minimum beside the list: exactly at the boundary, and one px past.
    const w = 900
    const most = w - RAIL_WIDTH - CONVERSATION_MIN_WIDTH
    assert(fitSessionListWidth(5000, w) === most, `in a ${w}px window the list stops where the conversation would drop under ${CONVERSATION_MIN_WIDTH} (${most}px)`)
    assert(fitSessionListWidth(most, w) === most && fitSessionListWidth(most + 1, w) === most, 'the boundary is exact: at it, kept; one px over, fitted back')
  }
  {
    // ...and beside an open dock, whose footprint comes off the same room. 1300px so the dock, not
    // the cap, is the binding bound (at 1400 the room is 566 and the 520 cap decides instead).
    const w = 1300
    const dock = 392 + PANEL_DIVIDER_WIDTH
    const most = w - RAIL_WIDTH - dock - CONVERSATION_MIN_WIDTH
    assert(fitSessionListWidth(5000, w, dock) === most && most < SESSION_LIST_MAX_WIDTH, `an open dock shrinks the list's room (${most}px in ${w}px)`)
    assert(fitSessionListWidth(5000, w, 0) === SESSION_LIST_MAX_WIDTH, 'the same window with the dock closed gives the room back')
  }
  assert(fitSessionListWidth(400, 500) === SESSION_LIST_MIN_WIDTH, 'a window too small for list + conversation → the list minimum (the dock rule collapses it instead)')
  assert(fitSessionListWidth(Number.NaN, W) === SESSION_LIST_WIDTH && fitSessionListWidth(-3, W) === SESSION_LIST_WIDTH, 'NaN / negative desired → the default')
  assert(fitSessionListWidth(333, 0) === 333 && fitSessionListWidth(5000, Number.NaN) === SESSION_LIST_MAX_WIDTH, 'unknown viewport → only the fixed bounds apply')
  assert(fitSessionListWidth(301.6, W) === 302, 'fractional desired → rounded')
  {
    // showSessions must use the list's REAL width: a wide list can force the collapse at a window
    // width where the default list would have stayed.
    const b = { open: true, pane: 'browser' as const }
    const w = RAIL_WIDTH + SESSION_LIST_WIDTH + 392 + PANEL_DIVIDER_WIDTH + CONVERSATION_MIN_WIDTH
    assert(showSessions('chat', b, { viewport: w, dock: 392, list: SESSION_LIST_WIDTH }) === true, 'at the default list width the list stays (same as before)')
    assert(showSessions('chat', b, { viewport: w, dock: 392, list: SESSION_LIST_WIDTH + 1 }) === false, 'one px wider list in the same window → it yields')
    assert(showSessions('chat', b, { viewport: w, dock: 392 }) === true, 'list omitted → the default width is assumed (old callers unchanged)')
  }
}

// Derived: the pane-count assertions below scale with the registry, so a literal here would go
// stale on the next pane and sit red on main — the scar this repo already carries. nav-smoke does
// the same for NAV_VIEWS.
const EXPECTED = 74 + PANEL_PANES.length
if (checks !== EXPECTED) {
  console.error(`[smoke] FAIL — ran ${checks} checks, expected ${EXPECTED} (a section was skipped, or a check was added without bumping EXPECTED)`)
  failures++
}
console.log(`\n[smoke] side-panel: ${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`} (${checks} checks)`)
process.exit(failures === 0 ? 0 : 1)
