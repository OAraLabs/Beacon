/**
 * Setup-wizard smoke (headless / ELECTRON_RUN_AS_NODE) — Onboarding Phase 2.
 *
 * Proves the PURE wizard state machine the stepped first-run UI rides on, where it would actually
 * break:
 *   1. STEP ORDER — the canonical 8 steps, welcome→finish, every step labeled.
 *   2. SKIP RULES — an already-configured daemon skips identity/gateways/apply; navigation hops
 *      over skipped steps in BOTH directions (model→smoke and smoke→model).
 *   3. VALIDATION — every step's Next gate answers honestly (connect needs a connection, model
 *      needs picks only on the setup path, identity needs a name, apply needs the applied flag;
 *      SPRINT G3: the gateways step is skippable but gates a HALF Slack token pair).
 *   4. RESUME — a setup-mode daemon reporting configured:true lands on 'apply' (finish the flip
 *      without re-answering); fresh setup and configured daemons land on 'model'.
 *   5. ESC RULES — esc goes back one step, never while busy, never off apply/finish.
 *   6. CONNECT DIAGNOSIS — unreachable / auth-rejected / connected / setup-mode, distinct labels.
 *   7. FIRST FLIGHT — done-set parse/serialize round-trips, junk never throws, the card shows
 *      only when offered and not dismissed.
 *   9. LAUNCH ROUTE (0.3.1 Part A) — setup or app from what the saved Prometheus says, not from
 *      "is a connection saved?": setup mode resumes the wizard (past Connect only when paired),
 *      anything else (configured, unreachable, not a Prometheus) opens the app; and the resumed
 *      wizard's starting data agrees with stepAfterConnect.
 *   8. GATEWAY POST FIELDS (SPRINT G3) — gatewayConfigureFields builds exactly the
 *      /api/setup/configure body the daemon reads: only filled-in gateways, slack as a pair,
 *      comma lists split clean.
 *
 * The fetch/IPC side lives in the renderer + main (thin transport over these functions); the UI
 * walk is the macOS eyes-on debt, same as every other first-run change.
 *
 * FAIL-LOUD: every check increments `checks`; at the end `checks === FIXED` or the run FAILS.
 */
import {
  CONNECT_DIAGNOSIS_LABELS,
  FIRST_FLIGHT_ITEMS,
  WIZARD_STEPS,
  WIZARD_STEP_LABELS,
  activeSteps,
  diagnoseConnect,
  escTarget,
  firstFlightVisible,
  gatewayConfigureFields,
  initialWizardData,
  nextStep,
  parseFirstFlightDone,
  prevStep,
  serializeFirstFlightDone,
  slackPairError,
  splitIdList,
  stepAfterConnect,
  decideStartupRoute,
  resumedWizardData,
  resumeNotice,
  stepStatus,
  validateStep,
  type WizardData,
  modelConfigureFields
} from '@shared/setup-wizard'

let failures = 0
let checks = 0
function assert(cond: boolean, label: string): void {
  checks++
  console.log(`[setup-wizard-smoke] ${cond ? 'PASS' : 'FAIL'}  ${label}`)
  if (!cond) failures++
}

if (
  typeof initialWizardData !== 'function' ||
  typeof nextStep !== 'function' ||
  typeof validateStep !== 'function' ||
  typeof stepAfterConnect !== 'function' ||
  typeof decideStartupRoute !== 'function' ||
  typeof resumedWizardData !== 'function' ||
  typeof diagnoseConnect !== 'function'
) {
  console.error('[setup-wizard-smoke] FAIL — required @shared/setup-wizard exports missing. Refusing to vacuously pass.')
  process.exit(1)
}

const FIXED = 86

const setup = { daemonMode: 'setup' as const }
const configured = { daemonMode: 'configured' as const }

// ── 1. step order ── [5]
assert(WIZARD_STEPS.length === 8, 'contract: 8 steps')
assert(WIZARD_STEPS[0] === 'welcome', 'welcome first')
assert(WIZARD_STEPS[WIZARD_STEPS.length - 1] === 'finish', 'finish last')
assert(
  WIZARD_STEPS.join(',') === 'welcome,connect,model,identity,gateways,apply,smoke,finish',
  'canonical order pinned (G3: telegram step is now gateways)'
)
assert(WIZARD_STEPS.every((s) => (WIZARD_STEP_LABELS[s] ?? '').length > 0), 'every step labeled')

// ── 2. skip rules ── [8]
assert(WIZARD_STEPS.every((s) => stepStatus(s, setup) === 'enabled'), 'setup path: nothing skipped')
assert(stepStatus('identity', configured) === 'skipped', 'configured: identity skipped')
assert(stepStatus('gateways', configured) === 'skipped', 'configured: gateways skipped')
assert(stepStatus('apply', configured) === 'skipped', 'configured: apply skipped')
assert(stepStatus('model', configured) === 'enabled', 'configured: model still shown (display-only)')
assert(activeSteps(configured).length === 5, 'configured: 5 active steps')
assert(nextStep('model', configured) === 'smoke', 'configured: model → smoke (hops 3 skipped steps)')
assert(prevStep('smoke', configured) === 'model', 'configured: smoke → model going back')

// ── setup-path navigation ── [4]
assert(nextStep('model', setup) === 'identity', 'setup: model → identity')
assert(nextStep('smoke', setup) === 'finish', 'setup: smoke → finish')
assert(prevStep('welcome', setup) === null, 'welcome has no back')
assert(nextStep('finish', setup) === null, 'finish has no next')

// ── 3. validation ── [15]
const base: WizardData = { ...initialWizardData() }
assert(base.step === 'welcome' && base.daemonMode === 'unknown', 'initial data: welcome + unknown daemon')
assert(validateStep('welcome', base) === null, 'welcome: always advanceable')
assert(validateStep('connect', base) !== null, 'connect: gated until connected')
assert(validateStep('connect', { ...base, connected: true }) === null, 'connect: open once connected')
const picked = { ...base, daemonMode: 'setup' as const, provider: 'ollama', baseUrl: 'http://gpu:11434', model: 'qwen3:8b' }
assert(validateStep('model', { ...base, daemonMode: 'setup' }) !== null, 'model (setup): gated until picked')
assert(validateStep('model', picked) === null, 'model (setup): open once backend+model picked')
assert(validateStep('model', { ...base, daemonMode: 'configured' }) === null, 'model (configured): nothing to pick')
// Cloud branch (Prometheus #374): the daemon refuses a cloud provider with no key anywhere
// (cloud_key_missing) — the gate mirrors it; a key the daemon already holds counts; model may be blank.
const cloudNoKey = { ...base, daemonMode: 'setup' as const, backendKind: 'cloud' as const, provider: 'anthropic', baseUrl: '', model: '', apiKey: '', cloudKeyPresent: false, cloudKeyEnv: 'ANTHROPIC_API_KEY' }
assert(validateStep('model', cloudNoKey) !== null && /ANTHROPIC_API_KEY/.test(validateStep('model', cloudNoKey) ?? ''), 'model (cloud): gated without a key, names the env var')
assert(validateStep('model', { ...cloudNoKey, apiKey: 'dummy-key' }) === null, 'model (cloud): open with a typed key, blank model allowed')
assert(validateStep('model', { ...cloudNoKey, cloudKeyPresent: true }) === null, 'model (cloud): open when the daemon already holds the key')
assert(validateStep('model', { ...cloudNoKey, provider: '' }) !== null, 'model (cloud): gated until a provider is picked')
assert(validateStep('identity', { ...base, agentName: '  ' }) !== null, 'identity: blank name gated')
assert(validateStep('identity', { ...base, agentName: 'Prometheus' }) === null, 'identity: named → open')
assert(validateStep('gateways', base) === null, 'gateways: skippable when nothing entered')
assert(
  validateStep('gateways', { ...base, telegramToken: '123:abc', discordToken: 'tok' }) === null,
  'gateways: telegram/discord tokens alone are fine'
)
assert(validateStep('gateways', { ...base, slackBotToken: 'xoxb-x' }) !== null, 'gateways: half a Slack pair (bot only) gated')
assert(validateStep('gateways', { ...base, slackAppToken: 'xapp-x' }) !== null, 'gateways: half a Slack pair (app only) gated')
assert(
  validateStep('gateways', { ...base, slackBotToken: 'xoxb-x', slackAppToken: 'xapp-x' }) === null,
  'gateways: full Slack pair → open'
)
assert(validateStep('apply', base) !== null && validateStep('apply', { ...base, applied: true }) === null, 'apply: gated on the applied flag')

// ── 4. resume ── [3]
assert(stepAfterConnect({ daemonMode: 'setup', resumeConfigured: true }) === 'apply', 'resume: half-done wizard lands on apply')
assert(stepAfterConnect({ daemonMode: 'setup', resumeConfigured: false }) === 'model', 'fresh setup daemon lands on model')
assert(stepAfterConnect({ daemonMode: 'configured', resumeConfigured: false }) === 'model', 'configured daemon lands on model')

// ── 5. esc rules ── [4]
assert(escTarget('connect', setup, false) === 'welcome', 'esc on connect → welcome')
assert(escTarget('connect', setup, true) === null, 'esc while busy → nothing')
assert(escTarget('apply', setup, false) === null, 'esc on apply → nothing (may be half-written)')
assert(escTarget('finish', setup, false) === null, 'esc on finish → nothing (done)')

// ── 6. connect diagnosis ── [5]
assert(diagnoseConnect({ setupMode: true, testOk: false }) === 'setup-mode', 'setup_mode:true wins')
assert(diagnoseConnect({ setupMode: null, testOk: true }) === 'connected', 'test ok → connected')
assert(diagnoseConnect({ setupMode: null, testOk: false, testCode: 401 }) === 'auth-rejected', '401 → auth-rejected')
assert(diagnoseConnect({ setupMode: null, testOk: false }) === 'unreachable', 'no answer → unreachable')
assert(new Set(Object.values(CONNECT_DIAGNOSIS_LABELS)).size === 4, 'all four diagnosis labels distinct')

// ── 7. first flight ── [6]
assert(FIRST_FLIGHT_ITEMS.length === 3, 'contract: 3 checklist items')
const done = parseFirstFlightDone(serializeFirstFlightDone(new Set(['send-message'])))
assert(done.has('send-message') && done.size === 1, 'done set round-trips')
assert(parseFirstFlightDone('not json [').size === 0, 'junk done value → empty set, no throw')
assert(parseFirstFlightDone('["bogus-item"]').size === 0, 'unknown item ids filtered out')
assert(firstFlightVisible('1', null) && !firstFlightVisible('1', '1'), 'visible when offered, gone once dismissed')
assert(!firstFlightVisible(null, null), 'never offered (existing users) → never shown')

// ── 8. gateway POST fields (SPRINT G3) ── [11]
const noGw = gatewayConfigureFields(initialWizardData())
assert(Object.keys(noGw).length === 0, 'gateway fields: nothing filled → empty body (skip-all)')
const allGw = gatewayConfigureFields({
  ...initialWizardData(),
  telegramToken: ' 123:abc ',
  slackBotToken: 'xoxb-x',
  slackAppToken: 'xapp-x',
  slackChannels: 'C01, C02,, ',
  discordToken: 'dc-tok',
  discordGuildIds: ' 111 , 222 '
})
assert(allGw.telegram_token === '123:abc', 'gateway fields: telegram token trimmed')
assert(allGw.slack_bot_token === 'xoxb-x' && allGw.slack_app_token === 'xapp-x', 'gateway fields: slack pair present')
assert(JSON.stringify(allGw.slack_channels) === JSON.stringify(['C01', 'C02']), 'gateway fields: channel list split clean')
assert(allGw.discord_token === 'dc-tok', 'gateway fields: discord token present')
assert(JSON.stringify(allGw.discord_guild_ids) === JSON.stringify(['111', '222']), 'gateway fields: guild list split clean')
const halfGw = gatewayConfigureFields({ ...initialWizardData(), slackBotToken: 'xoxb-x', slackChannels: 'C01' })
assert(
  !('slack_bot_token' in halfGw) && !('slack_channels' in halfGw),
  'gateway fields: half a Slack pair sends NO slack fields (the daemon would 400)'
)
const dmOnly = gatewayConfigureFields({ ...initialWizardData(), discordToken: 'tok' })
assert(!('discord_guild_ids' in dmOnly), 'gateway fields: blank guild list omitted (DMs-only)')
assert(slackPairError(initialWizardData()) === null, 'slack pair rule: neither token → fine')
assert(JSON.stringify(splitIdList('')) === '[]', 'splitIdList: empty string → []')
assert(JSON.stringify(splitIdList(' a ,, b ')) === JSON.stringify(['a', 'b']), 'splitIdList: trims + drops empties')

// ── verdict ──
// ── 9. MODEL POST FIELDS (Prometheus #374) — one builder, two daemon branches ──
{
  const local = modelConfigureFields({ backendKind: 'local', provider: 'ollama', baseUrl: 'http://gpu:11434', model: 'qwen3:8b', apiKey: '' })
  assert(JSON.stringify(local) === JSON.stringify({ provider: 'ollama', base_url: 'http://gpu:11434', model: 'qwen3:8b' }), 'local body: provider + base_url + model, no api_key')
  const cloud = modelConfigureFields({ backendKind: 'cloud', provider: 'anthropic', baseUrl: 'http://stale', model: 'claude-sonnet-4-6', apiKey: 'dummy-key' })
  assert(!('base_url' in cloud), 'cloud body: NEVER base_url (the daemon refuses unexpected_base_url), even if a stale one lingers in state')
  assert(cloud.provider === 'anthropic' && cloud.model === 'claude-sonnet-4-6' && cloud.api_key === 'dummy-key', 'cloud body: provider + model + api_key when typed')
  const held = modelConfigureFields({ backendKind: 'cloud', provider: 'openai', baseUrl: '', model: '', apiKey: '  ' })
  assert(JSON.stringify(held) === JSON.stringify({ provider: 'openai' }), 'cloud body: blank model and blank key are OMITTED — the daemon fills the default and uses the key it holds')
  assert(modelConfigureFields({ backendKind: 'cloud', provider: 'qwen', baseUrl: '', model: ' qwen3.7-max ', apiKey: '' }).model === 'qwen3.7-max', 'cloud body: model trimmed')
  assert(initialWizardData().backendKind === 'local' && initialWizardData().apiKey === '' && initialWizardData().cloudKeyPresent === false, 'initial data: local, no key')
}

// ── 9. launch route (0.3.1 Part A) ── [15]
{
  const setupMode = { reachable: true, setupMode: true, configured: false }
  const route = (hasConnection: boolean, probe: Parameters<typeof decideStartupRoute>[0]['probe'], hasCredential: boolean) =>
    JSON.stringify(decideStartupRoute({ hasConnection, probe, hasCredential }))
  assert(route(false, null, false) === JSON.stringify({ kind: 'wizard' }), 'launch: nothing saved → the wizard')
  assert(route(false, setupMode, true) === JSON.stringify({ kind: 'wizard' }), 'launch: nothing saved → the wizard, whatever a probe says')
  assert(route(true, setupMode, true) === JSON.stringify({ kind: 'resume', configured: false, paired: true }), 'launch: saved + setup mode + credential → resume, paired (the 0.3.0 strand)')
  assert(route(true, { ...setupMode, configured: true }, true) === JSON.stringify({ kind: 'resume', configured: true, paired: true }), 'launch: carries configured:true through (resume at apply)')
  assert(route(true, setupMode, false) === JSON.stringify({ kind: 'resume', configured: false, paired: false }), 'launch: saved + setup mode + no credential → resume, unpaired (Quick connect saved only the address)')
  assert(route(true, { reachable: true, setupMode: false, configured: false }, true) === JSON.stringify({ kind: 'app' }), 'launch: a configured Prometheus → the app')
  assert(route(true, { reachable: false, setupMode: false, configured: false }, true) === JSON.stringify({ kind: 'app' }), 'launch: unreachable → the app (it says so), never back into setup')
  assert(route(true, null, true) === JSON.stringify({ kind: 'app' }), 'launch: no probe answer → the app')
  assert(route(true, { reachable: false, setupMode: true, configured: false }, true) === JSON.stringify({ kind: 'app' }), 'launch: setupMode without reachable is not trusted')

  const paired = resumedWizardData({ configured: false, paired: true })
  assert(paired.step === 'model' && paired.connected && paired.daemonMode === 'setup', 'resumed, paired, not configured → model, connected, setup mode')
  const half = resumedWizardData({ configured: true, paired: true })
  assert(half.step === stepAfterConnect({ daemonMode: 'setup', resumeConfigured: true }) && half.step === 'apply' && half.resumeConfigured, 'resumed, configure already ran → apply (agrees with stepAfterConnect)')
  const unpaired = resumedWizardData({ configured: true, paired: false })
  assert(unpaired.step === 'connect' && !unpaired.connected && unpaired.daemonMode === 'unknown', 'resumed, unpaired → connect, not connected (pairing is the only way in)')
  assert(validateStep('connect', unpaired) !== null, 'resumed, unpaired: Connect still gates Next until paired')
  assert(resumeNotice({ paired: true }, '10.0.0.5').startsWith('Picking up where you left off with 10.0.0.5'), 'resume notice names the address')
  assert(/pair/.test(resumeNotice({ paired: false }, undefined)) && !resumeNotice({ paired: false }, undefined).includes('undefined'), 'unpaired notice says to pair, and never prints "undefined"')
}

if (checks !== FIXED) {
  console.error(`[setup-wizard-smoke] FAIL — ran ${checks}/${FIXED} checks (a section was skipped)`)
  process.exit(1)
}
if (failures > 0) {
  console.error(`[setup-wizard-smoke] FAIL — ${failures}/${checks} checks failed`)
  process.exit(1)
}
console.log(`[setup-wizard-smoke] OK — ${checks}/${FIXED} checks passed`)
