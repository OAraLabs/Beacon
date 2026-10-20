/**
 * Composer-controls smoke (headless / ELECTRON_RUN_AS_NODE) — the pure logic behind the model
 * switcher + Agent|Chat toggle, where it would actually break:
 *   - model select → the right daemon call (preset → POST {key}; default/local → DELETE clear)
 *   - mode → the optional send field (agent omits it → byte-identical; chat → mode:chat)
 *   - per-session mode memory (Level 2): remembered within a launch, every session resets to Agent
 *     on a fresh launch (no cross-launch persistence)
 *   - attachment honesty: attachments + Chat are mutually exclusive (the daemon's chat_upload path
 *     ignores mode), so the indicator never shows Chat while a send actually runs Agent
 *   - outbox honesty: an offline-queued send replays in the mode it was composed in
 * FAIL-LOUD: count-guarded; a thrown error exits non-zero. (Beacon has no component-test framework,
 * so the React wiring is the macOS eyes-on walk; the decision logic is proven here.)
 */
import {
  modelSelectAction,
  modeSendField,
  resolveSessionMode,
  currentOption,
  isDefaultOption,
  attachDisabledInMode,
  chatOptionDisabled,
  forceSearchSendField,
  forceSearchDisabled,
  optionKind,
  optionUnavailableReason,
  backendHealthBadge,
  groupOptions,
  switchFailureMessage,
  type ChatMode,
  type ModelOption
} from '@shared/composer-controls'

let failures = 0
let checks = 0
function assert(cond: boolean, label: string): void {
  checks++
  console.log(`[composer-smoke] ${cond ? 'PASS' : 'FAIL'}  ${label}`)
  if (!cond) failures++
}

if (
  typeof modelSelectAction !== 'function' ||
  typeof modeSendField !== 'function' ||
  typeof resolveSessionMode !== 'function' ||
  typeof currentOption !== 'function' ||
  typeof isDefaultOption !== 'function' ||
  typeof attachDisabledInMode !== 'function' ||
  typeof chatOptionDisabled !== 'function'
) {
  console.error('[composer-smoke] FAIL — required @shared/composer-controls exports missing. Refusing to vacuously pass.')
  process.exit(1)
}

const FIXED = 38

function main(): void {
  // ── model select → daemon call ──
  assert(JSON.stringify(modelSelectAction('claude', 'local')) === JSON.stringify({ method: 'POST', body: { key: 'claude' } }), 'preset key → POST {key}')
  const gpt = modelSelectAction('gpt', 'local')
  assert(gpt.method === 'POST' && gpt.body?.key === 'gpt', 'another preset → POST carrying its own key')
  assert(JSON.stringify(modelSelectAction('local', 'local')) === JSON.stringify({ method: 'DELETE' }), 'default/local key → DELETE (clear override)')
  assert(modelSelectAction('local', 'local').body === undefined, 'DELETE carries no body')

  // ── mode → send-payload field ──
  assert(JSON.stringify(modeSendField('agent')) === '{}', 'agent → no mode field (byte-identical default)')
  assert(JSON.stringify(modeSendField('chat')) === JSON.stringify({ mode: 'chat' }), 'chat → mode=chat')

  // ── per-session mode memory (Level 2) ──
  assert(resolveSessionMode({}, 's1') === 'agent', 'empty memory → agent default')
  assert(resolveSessionMode({ s1: 'chat' }, 's1') === 'chat', 'remembered chat → chat (sticks within a launch)')
  assert(resolveSessionMode({ s1: 'chat' }, 's2') === 'agent', 'a different session → agent (per-session, not global)')
  const freshLaunch: Record<string, ChatMode> = {} // a fresh app launch = a fresh empty map
  assert(
    resolveSessionMode(freshLaunch, 's1') === 'agent' && resolveSessionMode(freshLaunch, 's2') === 'agent',
    'fresh launch resets EVERY session to agent (no cross-launch persistence)'
  )

  // ── current option + default detection ──
  const cat: ModelOption[] = [
    { key: 'local', label: 'Local', is_default: true },
    { key: 'claude', label: 'Claude', model: 'claude-sonnet-4-5' }
  ]
  assert(currentOption(cat, 'claude')?.label === 'Claude', 'currentOption resolves the active option by key')
  assert(currentOption(cat, null) === null, 'currentOption(null) → null')
  assert(isDefaultOption(cat[0], 'local') === true, 'is_default option detected as the default')
  assert(isDefaultOption(cat[1], 'local') === false, 'a preset is not the default')

  // ── attachment honesty: the indicator must never show Chat while a send runs Agent ──
  // The daemon's chat_upload path ignores mode (always Agent), so attachments + Chat are made
  // mutually exclusive in the composer rather than silently sending Agent under a Chat indicator.
  assert(attachDisabledInMode('chat') === true, 'Chat mode → attach disabled (cannot stage files in Chat)')
  assert(attachDisabledInMode('agent') === false, 'Agent mode → attach enabled')
  assert(chatOptionDisabled(0) === false, 'no files staged → Chat option available')
  assert(chatOptionDisabled(2) === true, 'files staged → Chat option disabled (cannot switch to Chat)')
  assert(
    attachDisabledInMode('chat') && chatOptionDisabled(1),
    'mutual exclusion: Chat blocks attach AND staged files block Chat → "Chat + attachment" is unreachable (no lie)'
  )

  // ── outbox honesty: an offline-queued send replays in the mode it was composed in ──
  const chatPayload = JSON.parse(JSON.stringify({ message: 'hi', idempotency_key: 'k', client_msg_id: 'c', ...modeSendField('chat') }))
  assert(chatPayload.mode === 'chat', 'offline Chat send → outbox payload carries mode=chat → replays as Chat')
  const agentPayload = JSON.parse(JSON.stringify({ message: 'hi', idempotency_key: 'k', client_msg_id: 'c', ...modeSendField('agent') }))
  assert(agentPayload.mode === undefined, 'offline Agent send → outbox payload omits mode → replays as Agent (byte-identical)')

  // ── force-search (one-shot): field only when armed + Agent; Chat locks the control ──
  const fsArmed = forceSearchSendField(true, 'agent') as { tool_choice?: { tool: string } }
  assert(fsArmed.tool_choice?.tool === 'web_search', 'armed + Agent → send carries tool_choice {tool: web_search}')
  assert(Object.keys(forceSearchSendField(false, 'agent')).length === 0, 'disarmed → NO tool_choice field (byte-identical send)')
  assert(Object.keys(forceSearchSendField(true, 'chat')).length === 0, 'armed but Chat mode → field suppressed (no-tools turn cannot force)')
  assert(forceSearchDisabled('chat') === true, 'Chat mode → force-search control locked (mode-honest)')
  assert(forceSearchDisabled('agent') === false, 'Agent mode → force-search control available')
  const fsOutbox = JSON.parse(JSON.stringify({ message: 'hi', idempotency_key: 'k', client_msg_id: 'c', ...forceSearchSendField(true, 'agent') }))
  assert(fsOutbox.tool_choice?.tool === 'web_search', 'offline armed send → outbox payload carries tool_choice → replays forced')

  // ── Local backend rows (Prometheus PR 389/390): the same `available` field answers a different
  //    question per kind, and the switcher must say the RIGHT reason and surface a refused switch.
  const rows: ModelOption[] = [
    { key: 'local', label: 'Local', is_default: true, available: true, auth: null, backend: 'local', health: { ok: true, probed: true, stale: false, n_ctx: 32768, latency_ms: 83 }, vision: true },
    { key: '4090', label: '4090 · Qwen3.6-27B', provider: 'llama_cpp', model: '/models/Qwen3.6-27B.gguf', available: false, auth: null, backend: '4090', health: { ok: false, probed: true, error: 'ConnectError: connection refused' } },
    { key: 'mini', label: 'mini · qwen2.5:14b-instruct', provider: 'ollama', available: true, auth: null, backend: 'mini', health: { ok: true, probed: true, stale: true, n_ctx: 32768, latency_ms: 14 }, vision: false },
    { key: 'fresh', label: 'fresh', provider: 'ollama', available: false, auth: null, backend: 'fresh', health: { probed: false } },
    { key: 'claude', label: 'Claude', provider: 'anthropic', available: false, auth: null },
    { key: 'qwen', label: 'Qwen', provider: 'qwen', available: true, auth: 'api_key' }
  ]
  assert(optionKind(rows[0], 'local') === 'default', 'the default row is kind=default even though it carries backend:"local"')
  assert(optionKind(rows[1], 'local') === 'backend' && optionKind(rows[4], 'local') === 'cloud', 'a row with a backend name is a backend; a cloud preset is cloud')
  assert(optionUnavailableReason(rows[1], 'local') === 'down — ConnectError: connection refused', 'a down backend names the probe error, NOT "key missing"')
  assert(optionUnavailableReason(rows[4], 'local') === 'key missing', 'a cloud row without a credential still says "key missing"')
  assert(optionUnavailableReason(rows[2], 'local') === null, 'a reachable backend has no unavailable reason')
  assert(backendHealthBadge(rows[0]) === '32k · vision · 83 ms', 'health badge = window · vision · latency')
  assert(backendHealthBadge(rows[2]) === '32k · 14 ms', 'a stale probe is not a status (0.4.8, @shared/backend-health): no "stale" in the badge (and no vision when false)')
  assert(backendHealthBadge(rows[3]) === 'not probed', 'a never-probed backend says "not probed"')
  assert(backendHealthBadge(rows[5]) === null, 'cloud rows carry no health badge')
  const grouped = groupOptions(rows, 'local')
  assert(grouped.local.map((o) => o.key).join(',') === 'local,4090,mini,fresh' && grouped.cloud.map((o) => o.key).join(',') === 'claude,qwen', 'grouping: default + backends first, cloud after, daemon order kept')
  const refused = new Error('HTTP 503: POST /api/sessions/s1/model — {"error":"backend \'4090\' is down: connect timeout","backend":"4090","health":{"ok":false}}')
  assert(switchFailureMessage(refused, '4090') === "Could not switch to 4090: backend '4090' is down: connect timeout", 'a refused switch surfaces the daemon\'s reason, not the raw HTTP line')

  if (checks !== FIXED) {
    console.error(`[composer-smoke] FAIL — ran ${checks} checks but expected ${FIXED} (a section skipped or a check added without bumping FIXED).`)
    failures++
  }
  console.log('\n[composer-smoke] ===================== RESULT =====================')
  console.log(`[composer-smoke] checks=${checks} expected=${FIXED} failures=${failures}`)
  console.log(`[composer-smoke] outcome: ${failures === 0 ? 'PASS ✓ (model select + mode field + per-session memory wiring decisions hold)' : `FAIL ✗ (${failures})`}`)
  console.log('[composer-smoke] ===================================================')
  process.exit(failures === 0 ? 0 : 1)
}

try {
  main()
} catch (err) {
  console.error('[composer-smoke] FAILED (threw before completing — loud, not a silent skip):', err)
  process.exit(1)
}
