/**
 * Phase-5a panels smoke (headless / ELECTRON_RUN_AS_NODE). Proves the PURE gateway-event aggregation
 * the ToolCallFeed / Activity panels ride on — no display, no live socket: tool_call_start→end pairing
 * + latency, activity categorization + summary, /api/events/recent row mapping, the REST method's
 * URL + limit + bearer, the generic write bridge (method/url/body/bearer + path guard), and the Tier-1
 * activity controls' pure helpers (fetch override, model: step5-smoke).
 */
import {
  reduceToolCalls,
  fmtLatency,
  toolCallsFromApi,
  mergeToolCalls,
  categorize,
  toActivityItem,
  activityFromRow,
  activitySessions,
  filterActivity,
  activityToJson,
  type ActivityCategory,
  type ActivityItem,
  type GatewayEvent,
  type ToolCallRecord
} from '@shared/gateway-events'
import { RestClient } from './connection/rest'
import { resolveView, NAV_VIEWS, DEFAULT_VIEW } from '@shared/views'
import { isAllowedDaemonPath, fmtUptime, tokenPct, CONFIG_TABS, asList, joinFilePath, parentFilePath, breadcrumbs, fmtBytes, mergeSkillPins, cronFormReady, cronJobStatus, groupStoriesByStatus, nextStoryPosition, STORY_COLUMNS, httpStatusFromError, isAuthError, nextToken, connectionTestLabel, type StoryDTO, successPct, ratePct, rateColor } from '@shared/daemon-api'
import { previewTitle } from '@shared/preview'
import { buildSessionTree, isSubagent, parentKeyOf, sessionDisplayTitle, snippetTitle } from '@shared/session-tree'

let failures = 0
function assert(cond: boolean, label: string): void {
  console.log(`[smoke] ${cond ? 'PASS' : 'FAIL'}  ${label}`)
  if (!cond) failures++
}
const ev = (type: string, payload: Record<string, unknown>, ts: number): GatewayEvent => ({ type, payload, ts })

async function main(): Promise<void> {
  // ── 1. tool_call_start → pending; tool_call_end → paired + latency ──────────
  console.log('[smoke] === 1. tool-call pairing + latency ===')
  let calls: ToolCallRecord[] = []
  calls = reduceToolCalls(calls, ev('tool_call_start', { call_id: 'c1', tool_name: 'sessions_list', inputs: { a: 1 } }, 1000))
  assert(calls.length === 1 && calls[0].callId === 'c1' && calls[0].success === undefined, 'start → 1 pending record')
  assert(calls[0].toolName === 'sessions_list', 'start carries tool_name')
  calls = reduceToolCalls(calls, ev('tool_call_end', { call_id: 'c1', success: true, result: 'ok' }, 1450))
  assert(calls.length === 1 && calls[0].success === true && calls[0].result === 'ok', 'end pairs by call_id → success+result')
  assert(calls[0].latencyMs === 450, `latency = end.ts − start.ts when no latency_ms (got ${calls[0].latencyMs})`)

  let c2 = reduceToolCalls([], ev('tool_call_start', { call_id: 'c2', tool_name: 't' }, 0))
  c2 = reduceToolCalls(c2, ev('tool_call_end', { call_id: 'c2', success: false, error: 'boom', latency_ms: 99 }, 5000))
  assert(c2[0].success === false && c2[0].error === 'boom' && c2[0].latencyMs === 99, 'end: error + daemon latency_ms wins over computed')

  const c3 = reduceToolCalls([], ev('tool_call_end', { call_id: 'c3', success: true }, 10))
  assert(c3.length === 1 && c3[0].callId === 'c3' && c3[0].success === true, 'end-before-start → synthesized record (nothing lost)')

  // ── 2. categorize ──────────────────────────────────────────────────────────
  console.log('\n[smoke] === 2. categorize ===')
  assert(categorize('chat_message') === 'message', 'chat_* → message')
  assert(categorize('tool_call_end') === 'tool', 'tool_call_* → tool')
  assert(categorize('agent_state') === 'agent', 'agent_state → agent')
  assert(
    categorize('sentinel_signal') === 'signal' && categorize('dream_complete') === 'signal' && categorize('skill_created') === 'signal',
    'sentinel / dream / skill → signal'
  )
  assert(categorize('whatever') === 'system', 'unknown → system')

  // ── 3. activity item summary + session ──────────────────────────────────────
  console.log('\n[smoke] === 3. activity item ===')
  const a1 = toActivityItem(ev('tool_call_end', { call_id: 'c1', tool_name: 'grep', success: false, error: 'x', session_id: 'desktop:smoke' }, 2000))
  assert(a1.category === 'tool' && a1.sessionId === 'desktop:smoke', 'activity: category + session_id')
  assert(a1.summary.startsWith('✗') && a1.summary.includes('grep'), `activity summary for failed tool (got "${a1.summary}")`)
  const a2 = toActivityItem(ev('agent_state', { state: 'thinking' }, 3000))
  assert(a2.summary === 'agent thinking', 'activity summary for agent_state')

  // ── 4. /api/events/recent row → ActivityItem (timestamp s → ms) ─────────────
  console.log('\n[smoke] === 4. event-row backfill mapping ===')
  const item = activityFromRow({ id: 7, timestamp: 1_700_000_000, signal_type: 'memory_updated', payload: { note: 'x' }, source_subsystem: 'sentinel' })
  assert(item.type === 'memory_updated' && item.category === 'signal', 'row signal_type → type + category')
  assert(item.ts === 1_700_000_000_000, `row timestamp s → ms (got ${item.ts})`)
  // The live daemon serializes timestamp as an ISO STRING (live-walk finding 2026-06-10).
  const iso = activityFromRow({ id: 8, timestamp: '2026-06-10T14:29:26.197555+00:00', signal_type: 'dream_complete', payload: {} })
  assert(iso.ts === Date.parse('2026-06-10T14:29:26.197555+00:00'), `ISO-string timestamp → ms (got ${iso.ts})`)
  assert(activityFromRow({ id: 9, timestamp: 'garbage', signal_type: 'x', payload: {} }).ts === 0, 'unparseable timestamp → 0, not NaN')

  // ── 4b. GET /api/tools/recent rows → seeded TOOL CALLS (Tool Feed backfill) ─
  // The feed used to open empty every launch — live frames only — beside a telemetry card showing
  // the daemon's lifetime total_calls. It could NOT be seeded from the /api/events/recent tail the
  // activity feed uses: tool_call_* frames are WS fan-out (ws_server.broadcast persists nothing),
  // and no tool_call signal is ever emitted onto the SignalBus, so signal_events has none.
  console.log('\n[smoke] === 4b. tool-call backfill from /api/tools/recent ===')
  const apiRows = [
    { call_id: 'a1', timestamp: 1_756_200_000.5, tool_name: 'bash', success: true, latency_ms: 500, inputs: { command: 'ls' } },
    { call_id: 'a2', timestamp: 1_756_100_000, tool_name: 'read_file', success: false, latency_ms: 12, error_type: 'ValidationError', error_detail: 'bad path' }
  ]
  const fromApi = toolCallsFromApi(apiRows)
  assert(fromApi.length === 2 && fromApi[0].callId === 'a1', 'rows map 1:1, order preserved (daemon sends newest-first)')
  assert(fromApi[0].success === true && fromApi[0].latencyMs === 500, 'success + latency carry over')
  assert((fromApi[0].inputs as { command?: string })?.command === 'ls', 'inputs come straight off parsed_tool_call')
  // timestamp is stamped at RECORD time (call end), so the start is that minus the latency.
  assert(fromApi[0].startedAt === 1_756_200_000_500 - 500, `startedAt = end − latency (got ${fromApi[0].startedAt})`)
  assert(fromApi[1].error === 'ValidationError: bad path', `error_type + error_detail joined (got "${fromApi[1].error}")`)
  assert(fromApi[1].success === false, 'a failed call stays failed, not pending')
  // A row with no call_id has no dedupe key against live frames — skip it rather than double up.
  assert(toolCallsFromApi([{ timestamp: 1, tool_name: 'bash', success: true }]).length === 0, 'row with no call_id is skipped')
  assert(toolCallsFromApi([{ call_id: 'x', tool_name: 'bash', success: true }])[0].startedAt === 0, 'missing timestamp → 0, not NaN')
  assert(toolCallsFromApi([]).length === 0, 'empty tail seeds nothing')
  assert(toolCallsFromApi(apiRows, 1).length === 1, 'cap honoured')

  // CAPTURED WIRE, not a hand-written guess: this is verbatim output from Prometheus's
  // GET /api/tools/recent?limit=5 (create_app + a real telemetry.db, three recorded calls, driven
  // through starlette's TestClient). Pins the cross-repo contract — nulls, empty-object inputs, and
  // float latency included, all of which a hand-authored fixture would quietly get wrong.
  const WIRE: unknown = [
    { call_id: 'c40cb724f3db479297f9bc1a65185b5a', timestamp: 1787796706.073367, model: 'local/default', tool_name: 'grep', success: true, retries: 0, latency_ms: 88.0, error_type: null, error_detail: null, inputs: null },
    { call_id: 'e7f099248c5247418bca13c7e3afb0b1', timestamp: 1787796706.073269, model: 'claude-opus-5', tool_name: 'sessions_list', success: false, retries: 0, latency_ms: 1503.2, error_type: 'CircuitBreakerOpen', error_detail: 'gemma circuit open', inputs: {} },
    { call_id: 'b1f2c3d4e5f6478899aabbccddeeff00', timestamp: 1787796706.073100, model: 'local/default', tool_name: 'bash', success: true, retries: 0, latency_ms: 0.4, error_type: null, error_detail: null, inputs: { command: 'systemd-run --user --on-active=10 --timer-property=X' } }
  ]
  const wired = toolCallsFromApi(asList(WIRE))
  assert(wired.length === 3, `captured wire seeds every row (got ${wired.length})`)
  assert(wired[0].toolName === 'grep' && wired[1].toolName === 'sessions_list', 'daemon order (newest-first) survives')
  assert(wired[1].success === false && wired[1].error === 'CircuitBreakerOpen: gemma circuit open', 'a real failed row keeps its error')
  // inputs: null (never parsed) must read as absent, while inputs: {} (parsed, no args) is NOT absent.
  assert(wired[0].inputs === undefined, 'null inputs → undefined')
  assert(typeof wired[1].inputs === 'object' && wired[1].inputs !== null, 'empty-object inputs survive as an object')
  assert(wired[2].latencyMs === 0.4, `sub-millisecond float latency survives (got ${wired[2].latencyMs})`)
  assert(wired.every((c) => Number.isFinite(c.startedAt) && c.startedAt > 0), 'every captured row gets a finite startedAt')

  // ── 4b-null. an UNMEASURED latency (null on the wire) renders as `—`, end to end ────
  // Prometheus schema v2 made `latency_ms` nullable so a call that never executed — denied,
  // failed validation, never ran — is stored as NULL, not 0.0 (Prometheus #307). PR #475 made
  // `/api/tools/recent` PASS that NULL through instead of collapsing it with `float(x or 0.0)`.
  // This pins the CONSUMER end of that cross-repo contract: null on the wire must survive
  // `toolCallsFromApi` → `undefined` → `fmtLatency` → `—`, and must NOT become 0ms.
  //
  // Why it was a gap: #85 fixed the renderer (`fmtLatency(0)` → `—`) and added the runtime guard
  // at gateway-events.ts:189, but NO smoke drove `latency_ms: null` through `toolCallsFromApi`.
  // The §11b assertions call `fmtLatency(undefined)` DIRECTLY, and every §4b fixture above has a
  // numeric latency. So the end-to-end path was true-but-unpinned: a refactor of line 189 to
  // `r.latency_ms ?? 0` would pass every existing assertion and silently reintroduce 0ms with the
  // Prometheus side green. This closes it. (RECURRING 4h: each end pins its own side.)
  console.log('\n[smoke] === 4b-null. unmeasured latency (null) renders as — end to end ===')
  const NULLWIRE: unknown = [
    { call_id: 'measured1', timestamp: 1787796706.0, tool_name: 'bash', success: true, latency_ms: 88.0, error_type: null, error_detail: null, inputs: null },
    { call_id: 'unmeasured1', timestamp: 1787796705.0, tool_name: 'read_file', success: false, latency_ms: null, error_type: 'validation_failed', error_detail: 'bad input', inputs: null },
    { call_id: 'genuinezero1', timestamp: 1787796704.0, tool_name: 'glob', success: true, latency_ms: 0.0, error_type: null, error_detail: null, inputs: null }
  ]
  const nullWired = toolCallsFromApi(asList(NULLWIRE))
  const byId = Object.fromEntries(nullWired.map((c) => [c.callId, c]))
  // null → undefined at the mapper, so the record carries NO number. THIS is the load-bearing
  // assertion: a `r.latency_ms ?? 0` refactor makes it FAIL (got 0). Mutation-verified.
  assert(byId['unmeasured1'].latencyMs === undefined,
    `a null latency_ms maps to undefined, not a number (got ${String(byId['unmeasured1'].latencyMs)})`)
  // Renders as the em dash, NOT 0ms. NOTE: this assertion alone would NOT catch a `?? 0`
  // collapse — #85 made `fmtLatency(0)` render `—` too, so the render is right either way. The
  // value assertion above is what actually pins the contract; this one pins the user-visible end.
  assert(fmtLatency(byId['unmeasured1'].latencyMs) === '\u2014',
    `unmeasured renders as — (got "${fmtLatency(byId['unmeasured1'].latencyMs)}")`)
  // A measured value still renders as a number — the guard didn't over-collapse.
  assert(byId['measured1'].latencyMs === 88 && fmtLatency(byId['measured1'].latencyMs) === '88ms',
    `a real latency still renders as a number (got ${fmtLatency(byId['measured1'].latencyMs)})`)
  // A GENUINE measured zero is still distinct from unmeasured on the wire: 0.0 → renders `—`
  // (#85: an exact zero means "never ran"), but it ARRIVES as 0.0, not null. Both render `—`;
  // the contract is that the daemon sends null for never-measured and 0.0 only if truly measured
  // as instant. Pinning the arrival keeps the two from being conflated by a future `?? 0`.
  assert(byId['genuinezero1'].latencyMs === 0,
    `a genuine 0.0 arrives as 0, distinct from null/undefined (got ${String(byId['genuinezero1'].latencyMs)})`)

  // ── 4c. seed merges UNDER live frames (backfill lands mid-stream) ───────────
  console.log('\n[smoke] === 4c. merge seed under live ===')
  const liveOnly: ToolCallRecord[] = [{ callId: 'L', toolName: 'grep', inputs: { q: 'x' }, success: true, startedAt: 9_000, latencyMs: 12 }]
  const seedOnly: ToolCallRecord[] = [{ callId: 'S', toolName: 'read', inputs: { p: 'f' }, success: true, startedAt: 1_000, latencyMs: 5 }]
  const union = mergeToolCalls(liveOnly, seedOnly)
  assert(union.length === 2 && union[0].callId === 'L', 'disjoint sets union, newest-first')
  // Same call in both: live saw only the END (synthesized: no inputs, startedAt = end ts).
  const liveEndOnly: ToolCallRecord[] = [{ callId: 'D', toolName: 'bash', inputs: undefined, success: false, error: 'boom', startedAt: 5_000 }]
  // The seed carries a CONFLICTING outcome, so this pins precedence rather than merely agreeing
  // with it — with seed-wins the success/error asserts below flip.
  const seedStart: ToolCallRecord[] = [{ callId: 'D', toolName: 'bash', inputs: { command: 'ls' }, success: true, result: 'stale', startedAt: 4_000 }]
  const merged = mergeToolCalls(liveEndOnly, seedStart)
  assert(merged.length === 1, `overlap dedupes by call_id (got ${merged.length})`)
  assert(merged[0].success === false, `live outcome wins over a conflicting seed (got ${merged[0].success})`)
  assert(merged[0].error === 'boom', 'live error survives the merge')
  assert(merged[0].result === 'stale', 'seed result fills the gap the live frame left')
  assert((merged[0].inputs as { command?: string })?.command === 'ls', 'seed fills inputs the live end frame lacked')
  assert(merged[0].startedAt === 4_000, `earlier (real) start wins over the synthesized one (got ${merged[0].startedAt})`)
  // eventRowTs returns 0 for an unparseable stamp — 0 must not beat a real start.
  const zeroed = mergeToolCalls([{ callId: 'Z', toolName: 't', inputs: undefined, startedAt: 7_000 }], [{ callId: 'Z', toolName: 't', inputs: { a: 1 }, startedAt: 0 }])
  assert(zeroed[0].startedAt === 7_000, `a 0 stamp does not win 'earliest' (got ${zeroed[0].startedAt})`)

  // ── 5. RestClient.listRecentEvents: URL + limit + bearer ────────────────────
  console.log('\n[smoke] === 5. listRecentEvents REST ===')
  const origFetch = globalThis.fetch
  let cap: { url: string; headers: Record<string, string> } = { url: '', headers: {} }
  globalThis.fetch = (async (url: unknown, init?: { headers?: Record<string, string> }) => {
    cap = { url: String(url), headers: init?.headers ?? {} }
    return new Response('[{"id":1,"timestamp":1700000000,"signal_type":"skill_created","payload":{}}]', {
      status: 200,
      headers: { 'content-type': 'application/json' }
    })
  }) as typeof fetch
  const rows = await new RestClient('http://gw', 'tok-EV').listRecentEvents(25)
  assert(rows.length === 1 && rows[0].signal_type === 'skill_created', 'listRecentEvents returns rows')
  assert(cap.url === 'http://gw/api/events/recent?limit=25', `URL carries limit (got ${cap.url})`)
  assert(cap.headers.Authorization === 'Bearer tok-EV', 'bearer attached')
  globalThis.fetch = origFetch

  // ── 6. nav-shell view registry + resolveView (switch logic) ─────────────────
  console.log('\n[smoke] === 6. nav views ===')
  assert(NAV_VIEWS[0].id === 'chat' && DEFAULT_VIEW === 'mission', 'chat is first in the registry; Mission is the default landing')
  assert(NAV_VIEWS.length === 17, 'seventeen views registered (Terminal is a dock pane; Devices is a Config tab)')
  assert(NAV_VIEWS[1].id === 'mission', 'mission control slots second (chat contract intact)')
  assert(NAV_VIEWS.some((v) => v.id === 'coding'), 'coding view registered (Phase C)')
  assert(NAV_VIEWS.some((v) => v.id === 'loop-manager') && resolveView('loop-manager') === 'loop-manager', 'loop-manager view registered + resolves')
  assert(NAV_VIEWS.some((v) => v.id === 'documents') && resolveView('documents') === 'documents', 'documents view registered + resolves')
  assert(resolveView('coding') === 'coding', 'coding id → itself')
  assert(resolveView('toolfeed') === 'toolfeed', 'known id → itself')
  assert(resolveView('bogus') === DEFAULT_VIEW && resolveView(null) === DEFAULT_VIEW, 'unknown / null → DEFAULT_VIEW (mission) fallback')

  // ── 7. daemon.get path guard + status helpers ───────────────────────────────
  console.log('\n[smoke] === 7. daemon-api helpers ===')
  assert(isAllowedDaemonPath('/api/status') && isAllowedDaemonPath('/api/lcm/desktop:smoke'), 'allows /api/ paths')
  assert(!isAllowedDaemonPath('/api/../etc') && !isAllowedDaemonPath('http://evil/api') && !isAllowedDaemonPath('/nope'), 'blocks traversal / scheme / non-api')
  assert(fmtUptime(0) === '0s' && fmtUptime(65) === '1m 5s' && fmtUptime(3700) === '1h 1m' && fmtUptime(90000) === '1d 1h', 'fmtUptime s/m/h/d')
  assert(tokenPct(12000, 24000) === 50 && tokenPct(99999, 24000) === 100 && tokenPct(5, 0) === 0, 'tokenPct clamp + zero-limit safe')

  // ── success rate: ONE definition, floored ──────────────────────────────────────────────────
  // Four call sites computed this independently and disagreed on the same data (197/200 shown as
  // both 98% and 99% within an hour). These pin the rule and, more importantly, the reason for it.
  assert(successPct(197, 200) === 98, `197/200 floors to 98, not 99 (got ${successPct(197, 200)})`)
  assert(successPct(199, 200) === 99, `199/200 floors to 99 — ROUNDING WOULD SAY 100% beside a visible err 1 (got ${successPct(199, 200)})`)
  assert(successPct(200, 200) === 100, '100% is reachable only when nothing failed')
  assert(successPct(0, 0) === null && successPct(5, 0) === null, 'no calls yet is null, NOT 0% success')
  assert(successPct(NaN, 10) === null, 'a non-finite count degrades to null rather than NaN%')
  assert(ratePct(0.985) === 98 && ratePct(0.995) === 99, 'a daemon 0–1 rate floors the same way')
  assert(ratePct(1) === 100 && ratePct(0) === 0, 'the ends of the rate range survive')
  assert(ratePct(undefined) === null && ratePct(Number.NaN) === null, 'a missing rate is null, not 0%')
  // The property that makes it ONE definition: both entry points agree on the same underlying data.
  assert(successPct(197, 200) === ratePct(197 / 200), 'counts and rate paths cannot drift apart')
  assert(
    rateColor(95) === 'var(--c-ok)' && rateColor(90) === 'var(--c-ok)' && rateColor(89) === 'var(--c-warn)',
    'the ok threshold is 90 and it is inclusive'
  )
  assert(rateColor(70) === 'var(--c-warn)' && rateColor(69) === 'var(--c-err)', 'the warn floor is 70, inclusive')
  assert(rateColor(null) !== 'var(--c-ok)', 'an unknown rate never renders as healthy')
  assert(asList([1, 2]).length === 2 && asList({ raw_yaml: 'x' }).length === 0 && asList(null).length === 0, 'asList coerces non-arrays to [] (Config tab-switch crash guard)')

  let capUrl = ''
  let capAuth: string | undefined
  globalThis.fetch = (async (url: unknown, init?: { headers?: Record<string, string> }) => {
    capUrl = String(url)
    capAuth = init?.headers?.Authorization
    return new Response('{"state":"idle"}', { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  const st = (await new RestClient('http://gw', 'tok-D').getDaemon('/api/status')) as { state: string }
  assert(st.state === 'idle' && capUrl === 'http://gw/api/status', `getDaemon hits the path (got ${capUrl})`)
  assert(capAuth === 'Bearer tok-D', 'getDaemon attaches bearer')
  let blocked = false
  try {
    await new RestClient('http://gw', null).getDaemon('/api/../secret')
  } catch {
    blocked = true
  }
  assert(blocked, 'getDaemon rejects a disallowed path before fetch')
  globalThis.fetch = origFetch

  // ── 8. session tree grouping (Sessions view) ────────────────────────────────
  console.log('\n[smoke] === 8. session tree ===')
  assert(isSubagent('agent:main:subagent:abc') && !isSubagent('agent:main:main'), 'isSubagent detects subagent ids')
  assert(parentKeyOf('agent:main:subagent:abc') === 'agent:main' && parentKeyOf('telegram:42') === 'telegram:42', 'parentKeyOf strips :subagent')
  const tree = buildSessionTree([
    { id: 'agent:main:main', lastActive: 100 },
    { id: 'agent:main:subagent:x', lastActive: 200 },
    { id: 'telegram:42', lastActive: 300 },
    { id: 'orphan:subagent:y', lastActive: 50 }
  ])
  const mainNode = tree.find((n) => n.session.id === 'agent:main:main')
  assert(!!mainNode && mainNode.children.length === 1 && mainNode.children[0].id === 'agent:main:subagent:x', 'subagent nests under its root')
  assert(tree[0].session.id === 'telegram:42', 'roots sorted by lastActive desc')
  assert(
    tree.some((n) => n.session.id === 'orphan:subagent:y'),
    'orphan subagent floats to top level'
  )

  // ── 9. config tabs: every tab path is an allowed daemon path ────────────────
  console.log('\n[smoke] === 9. config tabs ===')
  assert(CONFIG_TABS.length === 14, 'fourteen config tabs (+ Devices, + Skin — the plate belongs where you change it, not in every session header)')
  // A tab is either daemon-backed (its path must be allowed) or LOCAL-ONLY (path ''). Skin is the
  // second kind: the plate is a renderer setting, so fetching anything would only invent a way to
  // fail. The check keeps its teeth — a non-empty path that is not allowed still fails.
  assert(
    CONFIG_TABS.every((t) => t.path === '' || isAllowedDaemonPath(t.path)),
    'every daemon-backed config tab path is allowed; a local-only tab declares no path'
  )
  assert(CONFIG_TABS.filter((t) => t.path === '').length === 1 && CONFIG_TABS.find((t) => t.path === '')?.id === 'skin', 'exactly one local-only tab, and it is Skin (a pathless tab is a deliberate exception, not a typo)')
  assert(new Set(CONFIG_TABS.map((t) => t.id)).size === CONFIG_TABS.length, 'config tab ids are unique')
  assert(
    CONFIG_TABS.find((t) => t.id === 'grants')?.path === '/api/approvals/grants',
    'Grants tab reads the daemon grant list (revoke rides the same path + DELETE)'
  )

  // ── 10. files path helpers (Files view) ─────────────────────────────────────
  console.log('\n[smoke] === 10. files path helpers ===')
  assert(joinFilePath('', 'a.txt') === 'a.txt' && joinFilePath('notes', 'todo.txt') === 'notes/todo.txt', 'joinFilePath roots + nests')
  assert(parentFilePath('notes/todo.txt') === 'notes' && parentFilePath('a') === '' && parentFilePath('') === '', 'parentFilePath climbs to root')
  const bc = breadcrumbs('notes/sub')
  assert(bc.length === 3 && bc[0].name === 'workspace' && bc[0].path === '' && bc[2].path === 'notes/sub', 'breadcrumbs trail rooted at workspace')
  assert(fmtBytes(0) === '0 B' && fmtBytes(2048) === '2.0 KB' && fmtBytes(5 * 1024 * 1024) === '5.0 MB', 'fmtBytes B/KB/MB')
  assert(
    isAllowedDaemonPath('/api/files?path=notes%2Ftodo.txt') && isAllowedDaemonPath('/api/files/read?path=a.md'),
    'files query paths pass the daemon-path guard'
  )

  // ── 11. Hermes preview-pane title (final UI) ────────────────────────────────
  console.log('\n[smoke] === 11. preview title ===')
  assert(previewTitle({ kind: 'file', path: 'notes/todo.txt' }) === 'todo.txt', 'file → basename')
  assert(previewTitle({ kind: 'file', path: 'README.md' }) === 'README.md', 'file at root → name')
  assert(
    previewTitle({ kind: 'image', dataUrl: 'x' }) === 'image' && previewTitle({ kind: 'image', dataUrl: 'x', title: 'cat.png' }) === 'cat.png',
    'image → title or "image"'
  )
  assert(previewTitle({ kind: 'text', title: '🔧 grep', body: '…' }) === '🔧 grep', 'text → title')

  // ── 12. write bridge: RestClient.writeDaemon method + url + body + bearer + guard ──
  console.log('\n[smoke] === 11b. tool-call latency: a fast call is not a call that did not happen ===')
// Values measured against the live /api/tools/recent tail (200 rows, 2026-08-27): the floor was
// 0.140ms and EIGHT rows rendered as "0ms" under Math.round. See beacon #75.
assert(fmtLatency(0.14) === '<1ms', 'the live floor (0.140ms) renders as <1ms, not 0ms')
assert(fmtLatency(0.999) === '<1ms', 'just under a millisecond is still <1ms')
assert(fmtLatency(1) === '1ms', 'exactly 1ms is a real number, not <1ms')
// REVERSED from #83 on live evidence. All three zeros in the 200-row tail were
// `permission_denied` — tools the user declined, which never executed. The daemon times real
// work with time.monotonic() and never produced an exact 0.0; genuine fast calls were
// 0.18-0.59ms. So 0.0 is a placeholder for "no execution", not a measurement. See beacon #84.
assert(fmtLatency(0) === '\u2014', 'an exact zero is "never ran", not a duration')
assert(fmtLatency(undefined) === '\u2014', 'no latency renders as an em dash')
// Top-end formatting was verified unchanged in the same live pass.
assert(fmtLatency(293) === '293ms', 'whole milliseconds unchanged')
assert(fmtLatency(6100) === '6.1s', 'seconds unchanged')
assert(fmtLatency(28600) === '28.6s', 'tens of seconds unchanged')
// Garbage in must not render as a plausible duration.
assert(fmtLatency(-5) === '\u2014', 'a negative latency is not a duration')
assert(fmtLatency(NaN) === '\u2014', 'NaN is not "NaNms"')

// The OTHER zero source: the live WS path used to compute latency by subtracting timestamps, so
// two events in the same tick produced a 0 that meant "unmeasurable" and rendered as measured.
const _t0 = 1_756_200_000_000
const _start = { type: 'tool_call_start', ts: _t0, payload: { call_id: 'z1', tool_name: 'glob' } }
const _endSameTick = { type: 'tool_call_end', ts: _t0, payload: { call_id: 'z1', success: true } }
const _endLater = { type: 'tool_call_end', ts: _t0 + 7, payload: { call_id: 'z1', success: true } }
const _same = reduceToolCalls(reduceToolCalls([], _start as never), _endSameTick as never)
assert(_same[0].latencyMs === undefined, 'same-tick start/end is UNMEASURED, not zero')
assert(fmtLatency(_same[0].latencyMs) === '\u2014', 'and it renders as an em dash')
const _later = reduceToolCalls(reduceToolCalls([], _start as never), _endLater as never)
assert(_later[0].latencyMs === 7, 'a real elapsed gap is still measured')
assert(fmtLatency(_later[0].latencyMs) === '7ms', 'and still renders')

console.log('\n[smoke] === session row label: daemon title > snippet > id ===')
// Shapes captured from the live daemon after the Prometheus #308 backfill (205 sessions,
// 190 titled, ZERO equal to the id).
const REAL = 'Project Directory Structure Analysis'
const ID = 'ios:31db8132-6634-4646-a570-9f2c1a4b7e30'
assert(
  sessionDisplayTitle(REAL, 'list the files in this repo please', ID) === REAL,
  'a real daemon title WINS over the first-message snippet — the whole point of the change'
)
// The premise the old code was written for, and which must keep working: an older daemon (or
// this client's own `title ?? id` cache write) puts the id in that column.
assert(
  sessionDisplayTitle(ID, 'list the files in this repo please', ID) === 'list the files in this repo please',
  'a title that IS the id is an echo, not a title — fall through to the snippet'
)
assert(sessionDisplayTitle(null, 'hello there', ID) === 'hello there', 'no daemon title → snippet')
assert(sessionDisplayTitle('', 'hello there', ID) === 'hello there', 'an empty title is not a title')
assert(sessionDisplayTitle('   ', 'hello there', ID) === 'hello there', 'whitespace is not a title either')
// The 15 sessions the backfill correctly skipped have neither a title nor usable content.
assert(sessionDisplayTitle(null, '', ID) === ID, 'nothing usable → the id, never an empty label')
assert(sessionDisplayTitle(null, null, ID) === ID, 'and null content is empty-safe')
// A real title is used verbatim; only the snippet path truncates.
const LONG = 'x'.repeat(80)
assert(sessionDisplayTitle(LONG, 'snip', ID) === LONG, 'a served title is not truncated by the snippet cap')

// snippetTitle is the primitive sessionDisplayTitle's snippet path delegates to. It lived only in
// step4-smoke, behind ~10 live-daemon calls in a smoke CI SKIPS without a daemon — so these three
// pure assertions had zero CI coverage and a regression would land uncaught (beacon #87). They
// belong here: pure, always-run. The live step4 keeps its end-to-end auto-title check.
console.log('\n[smoke] === snippetTitle (the primitive sessionDisplayTitle delegates to) ===')
assert(snippetTitle('  a   lot\n of   whitespace  ') === 'a lot of whitespace', 'snippetTitle collapses whitespace')
assert(snippetTitle('x'.repeat(80)).length <= 49 && snippetTitle('x'.repeat(80)).endsWith('…'), 'snippetTitle caps long text')
assert(snippetTitle('') === '' && snippetTitle(null) === '', 'snippetTitle empty-safe')

console.log('\n[smoke] === 12. write bridge ===')
  let wcap: { url: string; method?: string; headers: Record<string, string>; body?: unknown } = { url: '', headers: {} }
  globalThis.fetch = (async (url: unknown, init?: { method?: string; headers?: Record<string, string>; body?: string }) => {
    wcap = { url: String(url), method: init?.method, headers: init?.headers ?? {}, body: init?.body }
    return new Response('{"ok":true,"profile":"symbiote"}', { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  const wres = (await new RestClient('http://gw', 'tok-W').writeDaemon('/api/profiles/active', { name: 'symbiote' }, 'PUT')) as {
    ok: boolean
    profile: string
  }
  assert(wres.ok === true && wres.profile === 'symbiote', 'writeDaemon returns the parsed JSON response')
  assert(wcap.method === 'PUT' && wcap.url === 'http://gw/api/profiles/active', `writeDaemon uses method + path (got ${wcap.method} ${wcap.url})`)
  assert(
    wcap.headers.Authorization === 'Bearer tok-W' && wcap.headers['Content-Type'] === 'application/json',
    'writeDaemon attaches bearer + json content-type'
  )
  assert(wcap.body === JSON.stringify({ name: 'symbiote' }), `writeDaemon serializes the JSON body (got ${String(wcap.body)})`)
  await new RestClient('http://gw', null).writeDaemon('/api/skills/x/pin')
  assert(
    wcap.method === 'POST' && wcap.body === undefined && wcap.headers['Content-Type'] === undefined,
    'writeDaemon defaults to POST + omits body/content-type when no body'
  )
  let wblocked = false
  try {
    await new RestClient('http://gw', null).writeDaemon('/api/../danger', {}, 'DELETE')
  } catch {
    wblocked = true
  }
  assert(wblocked, 'writeDaemon rejects a disallowed path before fetch')
  globalThis.fetch = origFetch

  // ── 13. activity controls helpers (Tier 1, pure) ────────────────────────────
  console.log('\n[smoke] === 13. activity helpers ===')
  const acts: ActivityItem[] = [
    { id: 'a', category: 'tool', type: 'tool_call_end', sessionId: 'desktop:1', summary: '✓ grep', ts: 10, payload: { x: 1 } },
    { id: 'b', category: 'message', type: 'chat_message', sessionId: 'telegram:2', summary: 'user: hi', ts: 20, payload: {} },
    { id: 'c', category: 'agent', type: 'agent_state', summary: 'agent idle', ts: 30, payload: {} }
  ]
  assert(JSON.stringify(activitySessions(acts)) === JSON.stringify(['desktop:1', 'telegram:2']), 'activitySessions: unique sorted ids (skips undefined)')
  assert(filterActivity(acts, { sessionId: 'telegram:2' }).length === 1, 'filterActivity by session id')
  assert(filterActivity(acts, { cats: new Set<ActivityCategory>(['tool']) }).length === 1, 'filterActivity by category set')
  assert(
    filterActivity(acts, { query: 'grep' }).length === 1 && filterActivity(acts, { query: 'AGENT_STATE' }).length === 1,
    'filterActivity by query (summary + type, case-insensitive)'
  )
  assert(
    filterActivity(acts, {}).length === 3 && filterActivity(acts, { cats: new Set(), query: '', sessionId: null }).length === 3,
    'filterActivity with empty opts returns all'
  )
  const actsJson = activityToJson(acts)
  assert(actsJson.startsWith('[\n') && JSON.parse(actsJson).length === 3, 'activityToJson → pretty, round-trippable JSON')

  // ── 14. skill pin merge (Tier 2, pure) ──────────────────────────────────────
  console.log('\n[smoke] === 14. skill pin merge ===')
  const mergedSkills = mergeSkillPins(
    [
      { name: 'manual_one', description: 'd', source: 'builtin' },
      { name: 'auto_two', source: 'auto' }
    ],
    { auto_two: { pinned: true, state: 'active' }, auto_three: { pinned: false, state: 'candidate' } }
  )
  const skillByName = (n: string): (typeof mergedSkills)[number] | undefined => mergedSkills.find((m) => m.name === n)
  assert(mergedSkills.length === 3, 'merge keeps base skills + appends auto-only pin entries')
  assert(skillByName('manual_one')?.pinnable === false, 'manual skill (no pin entry) is not pinnable')
  assert(
    skillByName('auto_two')?.pinnable === true && skillByName('auto_two')?.pinned === true && skillByName('auto_two')?.state === 'active',
    'auto skill carries pinned + state from the pin map'
  )
  assert(skillByName('auto_three')?.pinnable === true && skillByName('auto_three')?.source === 'auto', 'auto-only skill appended with source auto')

  // ── 15. cron form + job status helpers (Tier 3, pure) ───────────────────────
  console.log('\n[smoke] === 15. cron helpers ===')
  assert(cronFormReady({ name: 'n', schedule: '*/5 * * * *', command: 'echo' }), 'cronFormReady: valid 5-field schedule + non-empty fields')
  assert(!cronFormReady({ name: '  ', schedule: '*/5 * * * *', command: 'echo' }), 'cronFormReady: blank name rejected')
  assert(!cronFormReady({ name: 'n', schedule: '* * *', command: 'echo' }), 'cronFormReady: wrong field-count schedule rejected')
  assert(!cronFormReady({ name: 'n', schedule: '* * * * *', command: '' }), 'cronFormReady: blank command rejected')
  assert(cronJobStatus({ name: 'a', schedule: '* * * * *', command: 'x', enabled: false }).label === 'disabled', 'cronJobStatus: disabled')
  assert(cronJobStatus({ name: 'a', schedule: '* * * * *', command: 'x', last_status: 'failed' }).ok === false, 'cronJobStatus: failed → not ok')
  assert(cronJobStatus({ name: 'a', schedule: '* * * * *', command: 'x', last_status: 'success' }).label === 'ok', 'cronJobStatus: success → ok')
  assert(cronJobStatus({ name: 'a', schedule: '* * * * *', command: 'x' }).label === 'scheduled', 'cronJobStatus: never-run → scheduled')

  // ── 16. kanban board helpers (pure) ─────────────────────────────────────────
  console.log('\n[smoke] === 16. kanban helpers ===')
  const kStories: StoryDTO[] = [
    { id: '1', story_id: 'US-1', title: 'a', status: 'todo', priority: 'high', labels: [], position: 0 },
    { id: '2', story_id: 'US-2', title: 'b', status: 'todo', priority: 'low', labels: [], position: 1 },
    { id: '3', story_id: 'US-3', title: 'c', status: 'done', priority: 'medium', labels: [], position: 0 }
  ]
  const grouped = groupStoriesByStatus(kStories)
  assert(grouped.todo.length === 2 && grouped.done.length === 1 && grouped.blocked.length === 0, 'groupStoriesByStatus buckets by status')
  assert(STORY_COLUMNS.length === 4 && STORY_COLUMNS[0].id === 'todo' && STORY_COLUMNS[3].id === 'done', 'STORY_COLUMNS = the 4 board columns in order')
  assert(
    nextStoryPosition(kStories, 'todo') === 2 && nextStoryPosition(kStories, 'done') === 1 && nextStoryPosition(kStories, 'blocked') === 0,
    'nextStoryPosition appends past the column max (0 for an empty column)'
  )

  // ── 17. auth-error classification + token-update decision (connection settings) ──
  console.log('\n[smoke] === 17. auth classification + token decision ===')
  assert(httpStatusFromError(new Error('HTTP 401: GET /api/skills')) === 401, 'httpStatusFromError pulls 401 from a daemon error')
  assert(
    httpStatusFromError(new Error("Error invoking remote method 'daemon:get': Error: HTTP 401: GET /api/status")) === 401,
    'httpStatusFromError survives Electron IPC message wrapping'
  )
  assert(httpStatusFromError(new Error('blocked daemon path: /api/../x')) === null, 'no HTTP status → null (path-guard / network errors)')
  assert(isAuthError(new Error('HTTP 401: GET /api/files')) === true, 'isAuthError true on 401')
  assert(isAuthError(new Error('HTTP 403: x')) === false && isAuthError(new Error('HTTP 500: x')) === false, 'isAuthError false on non-401 (403 path-escape, 500)')
  assert(nextToken(null, { token: 'abc' }) === 'abc', 'nextToken: a new token is set')
  assert(nextToken('old', {}) === 'old' && nextToken('old', { token: '   ' }) === 'old', 'nextToken: blank field keeps current (no secret round-trip)')
  assert(nextToken('old', { clearToken: true }) === null, 'nextToken: clearToken wins → null')

  // getDaemon must surface a 401 as an isAuthError-classifiable throw (fetch override → 401)
  globalThis.fetch = (async () =>
    new Response('{"error":"unauthorized"}', { status: 401, headers: { 'content-type': 'application/json' } })) as typeof fetch
  let auth401: unknown = null
  try {
    await new RestClient('http://gw', 'badtok').getDaemon('/api/skills')
  } catch (e) {
    auth401 = e
  }
  assert(auth401 !== null && isAuthError(auth401), 'getDaemon throws a 401 that isAuthError recognizes (panels render Not-authorized)')
  globalThis.fetch = origFetch

  // ── 18. connection re-test label (Settings save → GET /api/status feedback) ──
  console.log('\n[smoke] === 18. connection test label ===')
  assert(connectionTestLabel(true, null) === 'Connected ✓', 'ok → Connected')
  assert(connectionTestLabel(false, 401) === '401 — token rejected', '401 → token rejected (distinct from unreachable)')
  assert(connectionTestLabel(false, 500).includes('500'), 'other HTTP code → surfaced')
  assert(connectionTestLabel(false, null) === 'Could not reach the gateway', 'no response → unreachable')

  console.log('\n[smoke] ===================== RESULT =====================')
  console.log(
    `[smoke] outcome: ${failures === 0 ? 'PASS ✓ (tool-calls, categorize, activity, REST read+write, activity controls, skill-pin, cron, board, auth)' : `FAIL ✗ (${failures})`}`
  )
  console.log('[smoke] ===================================================')
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('[smoke] FAILED:', err)
  process.exit(1)
})
