// Setup-wizard state machine (Onboarding Phase 2) — PURE logic shared by the renderer's stepped
// wizard and the headless setup-wizard smoke. Step order, skip rules, per-step validation, and
// resume-from-configured detection all live HERE so they are testable without Electron/React.
//
// Two daemon situations drive the flow:
//   'setup'      — the daemon is in setup mode (paired via code); the wizard drives the WHOLE
//                  setup remotely: detect → configure → complete → poll → smoke → finish.
//   'configured' — a real daemon is already running; model shows what's active (display + the
//                  per-session switcher pointer — the daemon has NO global model-set path), and
//                  identity/gateways/apply are SKIPPED ("already configured").
//
// No Node/Electron imports here (same rule as shared/ipc.ts and shared/pairing.ts).

import { resumeAtTrade } from './model-setup'

export type WizardStepId =
  | 'welcome'
  | 'connect'
  | 'model'
  | 'identity'
  | 'gateways'
  | 'apply'
  | 'smoke'
  | 'finish'

/** Canonical step order — the rail renders exactly this. (SPRINT G3: the old
 * 'telegram' step is now 'gateways' — Telegram, Slack, and Discord in ONE
 * optional step.) */
export const WIZARD_STEPS: readonly WizardStepId[] = [
  'welcome',
  'connect',
  'model',
  'identity',
  'gateways',
  'apply',
  'smoke',
  'finish'
] as const

export const WIZARD_STEP_LABELS: Record<WizardStepId, string> = {
  welcome: 'Welcome',
  connect: 'Connect',
  model: 'Model',
  identity: 'Identity',
  gateways: 'Gateways',
  apply: 'Apply & wake',
  smoke: 'Smoke test',
  finish: 'First flight'
}

/** What kind of daemon the Connect step found. */
export type DaemonMode = 'unknown' | 'setup' | 'configured'

/** Everything the pure logic needs to know about the user's progress. The UI owns transient
 * fetch/busy state; THIS is only what step logic depends on. */
export interface WizardData {
  step: WizardStepId
  daemonMode: DaemonMode
  /** Connect succeeded (paired with a code, or token/no-auth connect saved). */
  connected: boolean
  /** Setup-mode daemon reported `configured: true` on connect — a half-done wizard to resume. */
  resumeConfigured: boolean
  /** Model choice (setup path only; 'configured' daemons manage models per-session). */
  provider: string
  baseUrl: string
  model: string
  /** Where the model runs (Prometheus #374 — the setup API's cloud branch). 'local' = a detected or
   * custom inference server (provider + base_url + model, re-probed by the daemon); 'cloud' = one of
   * the daemon's cloud presets (provider + model, NO base_url; the key goes to the daemon's env file). */
  backendKind: 'local' | 'cloud'
  /** Cloud only: the API key the user typed. Sent ONCE in the configure body, never stored on this side,
   * never echoed. Blank is allowed when the daemon already holds the key (cloudKeyPresent). */
  apiKey: string
  /** Cloud only: the daemon reported it already holds this provider's key (env or env file). */
  cloudKeyPresent: boolean
  /** Cloud only: the env var name the daemon reads the key from — shown so a blank key is explainable. */
  cloudKeyEnv: string
  /** Identity (setup path only). */
  agentName: string
  persona: string
  /** Gateways (all optional, setup path only — SPRINT G3). */
  telegramToken: string
  /** Slack is a token PAIR — both-or-neither (validated in validateStep). */
  slackBotToken: string
  slackAppToken: string
  /** Comma-separated channel IDs (optional whitelist). */
  slackChannels: string
  discordToken: string
  /** Comma-separated integer guild IDs (optional whitelist; blank = DMs-only). */
  discordGuildIds: string
  /** POST /api/setup/configure + /complete ran and the REAL daemon answered /api/status 200. */
  applied: boolean
  /** The chat round-trip smoke came back with a real assistant reply. */
  smokeOk: boolean
}

export function initialWizardData(): WizardData {
  return {
    step: 'welcome',
    daemonMode: 'unknown',
    connected: false,
    resumeConfigured: false,
    provider: '',
    baseUrl: '',
    model: '',
    backendKind: 'local',
    apiKey: '',
    cloudKeyPresent: false,
    cloudKeyEnv: '',
    agentName: 'Prometheus',
    persona: '',
    telegramToken: '',
    slackBotToken: '',
    slackAppToken: '',
    slackChannels: '',
    discordToken: '',
    discordGuildIds: '',
    applied: false,
    smokeOk: false
  }
}

export type StepStatus = 'enabled' | 'skipped'

/** Skip rules. On an ALREADY-CONFIGURED daemon the setup-writing steps don't apply — they render
 * in the rail as "already configured" and navigation hops over them. */
export function stepStatus(step: WizardStepId, data: Pick<WizardData, 'daemonMode'>): StepStatus {
  if (data.daemonMode === 'configured' && (step === 'identity' || step === 'gateways' || step === 'apply')) {
    return 'skipped'
  }
  return 'enabled'
}

/** The steps navigation actually visits, in order. */
export function activeSteps(data: Pick<WizardData, 'daemonMode'>): WizardStepId[] {
  return WIZARD_STEPS.filter((s) => stepStatus(s, data) === 'enabled')
}

export function nextStep(current: WizardStepId, data: Pick<WizardData, 'daemonMode'>): WizardStepId | null {
  const steps = activeSteps(data)
  const i = steps.indexOf(current)
  return i >= 0 && i + 1 < steps.length ? steps[i + 1] : null
}

export function prevStep(current: WizardStepId, data: Pick<WizardData, 'daemonMode'>): WizardStepId | null {
  const steps = activeSteps(data)
  const i = steps.indexOf(current)
  return i > 0 ? steps[i - 1] : null
}

/** Per-step gate for "Next". `null` = may advance; otherwise the honest reason it can't. */
export function validateStep(step: WizardStepId, data: WizardData): string | null {
  switch (step) {
    case 'welcome':
      return null
    case 'connect':
      return data.connected ? null : 'Connect to a daemon first.'
    case 'model':
      if (data.daemonMode === 'configured') return null // display-only — nothing to pick
      if (data.backendKind === 'cloud') {
        // Mirrors the daemon's rule (cloud_key_missing): a cloud provider with no key ANYWHERE is
        // refused, so gate it here too. A key the daemon already holds counts; the model may be
        // blank (the daemon fills the preset's default).
        if (!data.provider) return 'Pick a cloud provider.'
        return data.apiKey.trim() || data.cloudKeyPresent ? null : `Paste an API key, or set ${data.cloudKeyEnv || 'the provider key'} on the daemon first.`
      }
      return data.provider && data.baseUrl && data.model ? null : 'Pick a backend and a model.'
    case 'identity':
      return data.agentName.trim() ? null : 'Give your agent a name.'
    case 'gateways':
      // Every gateway is optional, but half a Slack pair can only produce a
      // gateway that can never start — the daemon 400s it, so gate it here
      // too (both-or-neither, mirrored client-side).
      return slackPairError(data)
    case 'apply':
      return data.applied ? null : 'Apply the configuration first.'
    case 'smoke':
      return null // verification, not a gate — a failed smoke may still proceed (honest state shown)
    case 'finish':
      return null
  }
}

// ── Gateways step (SPRINT G3) ──────────────────────────────────────────────
// Pure helpers shared by the renderer form and the headless smoke.

/** Slack both-or-neither rule. `null` = fine; otherwise the honest reason. */
export function slackPairError(
  data: Pick<WizardData, 'slackBotToken' | 'slackAppToken'>
): string | null {
  const bot = data.slackBotToken.trim()
  const app = data.slackAppToken.trim()
  if (bot && !app) return 'Slack needs BOTH tokens — add the app token (xapp-…), or clear the bot token.'
  if (app && !bot) return 'Slack needs BOTH tokens — add the bot token (xoxb-…), or clear the app token.'
  return null
}

/** Split a comma-separated ID list into clean entries ('' → []). */
export function splitIdList(raw: string): string[] {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

/** The gateway fields of the POST /api/setup/configure body — only what the
 * user actually filled in (the daemon treats absence as "not enabled"). */

/** One cloud preset as GET /api/setup/detect lists it (`cloud_providers`). `key_present` is a
 *  boolean about the daemon's env — the value is never sent to a client. */
export interface CloudPreset {
  provider: string
  api_key_env: string
  default_model: string
  key_present: boolean
}

/** The model half of the /api/setup/configure body — EXACTLY what the daemon's two branches read.
 *  Local: provider + base_url + model (the daemon re-probes base_url). Cloud: provider (+ model,
 *  only when chosen — blank lets the daemon apply the preset default) (+ api_key, only when typed
 *  — a blank key means "use the one you already hold"); NEVER base_url, which the daemon refuses
 *  as `unexpected_base_url`. Pure, headless-smoked, so the two branches cannot drift apart. */
export function modelConfigureFields(
  data: Pick<WizardData, 'backendKind' | 'provider' | 'baseUrl' | 'model' | 'apiKey'>
): Record<string, string> {
  if (data.backendKind === 'cloud') {
    const out: Record<string, string> = { provider: data.provider }
    if (data.model.trim()) out.model = data.model.trim()
    if (data.apiKey.trim()) out.api_key = data.apiKey.trim()
    return out
  }
  return { provider: data.provider, base_url: data.baseUrl, model: data.model }
}

export function gatewayConfigureFields(
  data: Pick<
    WizardData,
    'telegramToken' | 'slackBotToken' | 'slackAppToken' | 'slackChannels' | 'discordToken' | 'discordGuildIds'
  >
): Record<string, string | string[]> {
  const body: Record<string, string | string[]> = {}
  if (data.telegramToken.trim()) body.telegram_token = data.telegramToken.trim()
  if (data.slackBotToken.trim() && data.slackAppToken.trim()) {
    body.slack_bot_token = data.slackBotToken.trim()
    body.slack_app_token = data.slackAppToken.trim()
    const channels = splitIdList(data.slackChannels)
    if (channels.length > 0) body.slack_channels = channels
  }
  if (data.discordToken.trim()) {
    body.discord_token = data.discordToken.trim()
    const guilds = splitIdList(data.discordGuildIds)
    if (guilds.length > 0) body.discord_guild_ids = guilds
  }
  return body
}

/** Where to land after Connect succeeds — resume-from-configured detection.
 *
 * - configured daemon → 'model' (show active model; the writing steps are skipped)
 * - setup-mode daemon reporting `configured: true` (a half-done wizard: configure ran, complete
 *   didn't) → 'apply', so the user can finish the flip without re-answering everything
 * - fresh setup-mode daemon → 'model'
 */
export function stepAfterConnect(data: Pick<WizardData, 'daemonMode' | 'resumeConfigured'>): WizardStepId {
  if (data.daemonMode === 'setup' && data.resumeConfigured) return 'apply'
  return 'model'
}

/** What the saved Prometheus answered on GET /api/setup/status at launch (main's probe). */
export interface LaunchProbe {
  reachable: boolean
  setupMode: boolean
  configured: boolean
}

export type StartupRoute =
  | { kind: 'wizard' }
  | { kind: 'resume'; configured: boolean; paired: boolean }
  | { kind: 'trade' }
  | { kind: 'app' }

/** Setup or app, at launch. 0.3.0 asked only "is a connection saved?". Pairing saves one before
 * setup is finished, so quitting after pairing opened the main app on a Prometheus still in setup
 * mode, with no way back. Prometheus's own answer decides now:
 *
 * - nothing saved → the wizard, from the start;
 * - saved, and Prometheus says it's in setup mode → resume the wizard (past Connect when paired);
 * - saved, and anything else (configured, unreachable, not a Prometheus) → the app. An unreachable
 *   Prometheus is not a reason to throw someone back into setup; the app says it can't reach it
 *   and offers a way out.
 *
 * The rule needs no flag of its own, so 0.3.0 profiles route correctly with no migration.
 *
 * - except one (O9): the master token A-inst kept for Prometheus on this Mac, once it is out of setup mode (or not answering), is a
 *   trade still owed (@shared/model-setup resumeAtTrade): never the app with the master key. */
export function decideStartupRoute(input: { hasConnection: boolean; probe: LaunchProbe | null; hasCredential: boolean; credential?: string | null; thisMac?: boolean }): StartupRoute {
  if (!input.hasConnection) return { kind: 'wizard' }
  const setupMode = input.probe?.reachable === true && input.probe.setupMode
  if (resumeAtTrade({ credential: input.credential ?? null, setupMode, thisMac: input.thisMac === true })) return { kind: 'trade' }
  if (input.probe?.reachable === true && input.probe.setupMode) {
    return { kind: 'resume', configured: input.probe.configured, paired: input.hasCredential }
  }
  return { kind: 'app' }
}

/**
 * Whether a saved pairing is stale: the setup-mode Prometheus's answer to one authed GET /api/setup/detect made with it at launch.
 * A reinstalled Prometheus refuses the old pairing (401/403), and nothing past Connect can work with it. Any other answer, or none, is
 * not a refusal: resumed as before (the wizard still finds a stale pairing on its first authed call).
 */
export function pairingStale(answer: number | 'unreachable'): boolean {
  return answer === 401 || answer === 403
}

/** Whether a part-way setup resumes in the new first run, at A2 (@shared/onboarding resumeModel): on this Mac, paired, and the pairing
 *  still accepted. A refused one goes to the wizard's Connect instead, the only screen that can pair again. */
export function resumesHere(resume: { here?: boolean; paired: boolean; stale?: boolean } | undefined): boolean {
  return resume?.here === true && resume.paired && resume.stale !== true
}

/** The wizard's starting data for a resumed setup. Paired → straight to the step after Connect
 * (stepAfterConnect: 'apply' when configure already ran, else 'model'). Not paired → Connect, on
 * the pairing-code tab, which is the only way a setup-mode Prometheus lets anyone in. */
export function resumedWizardData(resume: { configured: boolean; paired: boolean; stale?: boolean }): WizardData {
  const base = initialWizardData()
  if (!resume.paired || resume.stale) return { ...base, step: 'connect' }
  return {
    ...base,
    connected: true,
    daemonMode: 'setup',
    resumeConfigured: resume.configured,
    step: stepAfterConnect({ daemonMode: 'setup', resumeConfigured: resume.configured })
  }
}

/** The line a resumed wizard shows above its step. */
export function resumeNotice(resume: { paired: boolean; stale?: boolean }, address: string | undefined): string {
  if (resume.stale) return STALE_PAIRING_LABEL
  const where = address ? ` with ${address}` : ''
  return resume.paired
    ? `Picking up where you left off${where}.`
    : `Picking up where you left off${where}: this Prometheus is still being set up, so pair with the 6-digit code from its terminal.`
}

/** Shown on Connect when the saved pairing is refused by a setup-mode Prometheus (it was set up
 * again, so the old pairing is gone). A setup-mode daemon mints one code per boot, so the honest
 * way forward is a restart for a new code. */
export const STALE_PAIRING_LABEL =
  'This Prometheus no longer accepts the pairing saved on this Mac. Pair again: restart `oara daemon` on its computer for a new code, then enter it here.'

/** Esc-able where safe: never while the step's work is one-way in flight (the UI passes `busy`),
 * and never off the first step. Esc = go back one step. */
export function escTarget(current: WizardStepId, data: Pick<WizardData, 'daemonMode'>, busy: boolean): WizardStepId | null {
  if (busy) return null
  if (current === 'apply' || current === 'finish') return null // apply may have half-written; finish is done
  return prevStep(current, data)
}

// ── Connect-step diagnosis ─────────────────────────────────────────────────────
// The tri-state (unreachable / auth rejected / connected) plus the fourth honest state the spec
// names: "daemon in setup mode" (GET /api/setup/status said setup_mode: true).

export type ConnectDiagnosis = 'unreachable' | 'auth-rejected' | 'connected' | 'setup-mode'

export function diagnoseConnect(probe: {
  /** GET /api/setup/status answered setup_mode:true (null = probe unreachable/not-setup). */
  setupMode: boolean | null
  /** connection.test's REST outcome, when it ran. */
  testOk: boolean
  testCode?: number
}): ConnectDiagnosis {
  if (probe.setupMode === true) return 'setup-mode'
  if (probe.testOk) return 'connected'
  if (probe.testCode === 401 || probe.testCode === 403) return 'auth-rejected'
  return 'unreachable'
}

export const CONNECT_DIAGNOSIS_LABELS: Record<ConnectDiagnosis, string> = {
  unreachable: 'Nothing answered at that address — check the host and that the daemon is running.',
  'auth-rejected': 'The daemon answered but rejected the token — check it (or pair with a code).',
  connected: 'Connected — this daemon is configured and running.',
  'setup-mode': 'This daemon is in SETUP MODE — pair with the 6-digit code from its terminal.'
}

// ── First-flight checklist (finish step → Mission home card) ──────────────────

export type FirstFlightItemId = 'send-message' | 'command-palette' | 'explore-panel'

export interface FirstFlightItem {
  id: FirstFlightItemId
  label: string
}

export const FIRST_FLIGHT_ITEMS: readonly FirstFlightItem[] = [
  { id: 'send-message', label: 'Send your agent a message' },
  { id: 'command-palette', label: 'Open the command palette (⌘K)' },
  { id: 'explore-panel', label: 'Explore a panel' }
] as const

/** b.settings keys (same persistence mechanism the other panels use). */
export const FIRST_FLIGHT_OFFERED_KEY = 'firstflight:offered'
export const FIRST_FLIGHT_DISMISSED_KEY = 'firstflight:dismissed'
export const FIRST_FLIGHT_DONE_KEY = 'firstflight:done'

/** Parse the persisted done-set (JSON array of item ids); junk → empty set, never a throw. */
export function parseFirstFlightDone(raw: string | null | undefined): Set<FirstFlightItemId> {
  if (!raw) return new Set()
  try {
    const arr = JSON.parse(raw) as unknown
    if (!Array.isArray(arr)) return new Set()
    const valid = new Set(FIRST_FLIGHT_ITEMS.map((i) => i.id as string))
    return new Set(arr.filter((x): x is FirstFlightItemId => typeof x === 'string' && valid.has(x)))
  } catch {
    return new Set()
  }
}

export function serializeFirstFlightDone(done: Set<FirstFlightItemId>): string {
  return JSON.stringify([...done])
}

/** The card shows only when the wizard offered it (a finished first run) and it wasn't dismissed —
 * existing users who never ran the wizard never see it (zero regression). */
export function firstFlightVisible(offered: string | null, dismissed: string | null): boolean {
  return offered === '1' && dismissed !== '1'
}
