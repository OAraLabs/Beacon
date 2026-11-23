// Activity › Gym › Promote and Roll back: the contract with the gym's CONTROL service, and Beacon's words for it.
//
// These are the first actions in Beacon that change something on the gym. The read side (./gym.ts) never writes and its
// transport only ever GETs; this side is separate on purpose: its own address, its own token (a write token, never the read
// token), its own transport (src/main/gym-control.ts), and a confirmation that only main can release.
//
// THE PROTOCOL (two steps, so that what was confirmed is exactly what is done):
//   1. PLAN   POST <control>/v1/promote/plan {candidate}   or   POST <control>/v1/rollback/plan {}     (a dry run: changes nothing)
//             answers the plan: what is serving now, what will, every setting that changes, which computers are touched, what
//             restarts, the gate's result, and `refusal` when the service will not do it.
//   2. APPLY  POST <control>/v1/apply {plan_id, plan_hash}   (single use, expires; the service refuses with 409 if what the plan
//             was made from has changed). It answers {op_id} at once: the work takes minutes and is read, not waited for:
//             GET <control>/v1/ops/<op_id>.
//
// The rehearsal model: the thing promoted is an archived model labelled as a rehearsal stand-in, onto a separate rehearsal
// instance. Beacon makes no claim about that of its own. What a plan lists as touched and restarted is all the confirmation
// says; anything the gym says about what was left alone is shown only after the fact, from the operation's answer.
//
// No Node/Electron imports (same rule as the rest of src/shared).
import { codeWords, gymTime as time, slug, type GymPromotion } from './gym'
import type { DeviceRole } from './device-role'

/** Where main keeps the control service's address (a settings row: this Beacon's, whichever Prometheus is open). The write
 *  token is NOT a setting: its own sealed file (src/main/index.ts), never the read token's. */
export const GYM_CONTROL_ADDRESS_KEY = 'gym:control-address:v1'
export const GYM_CONTROL_PATHS = {
  capabilities: '/v1/capabilities',
  promote: '/v1/promote/plan',
  rollback: '/v1/rollback/plan',
  apply: '/v1/apply',
  op: (id: string): string => `/v1/ops/${id}`
} as const
/** The most of an answer main reads from the control service. A plan is a few kilobytes. */
export const GYM_CONTROL_MAX_BYTES = 262_144
/** How far ahead a plan's expiry may be. A service that says "valid for a day" is not the one this was written against. */
export const GYM_PLAN_MAX_AGE_MS = 15 * 60_000
/** The most settings a plan may list. A confirmation shows every one, so a plan with more is refused rather than cut short. */
export const GYM_PLAN_MAX_CHANGES = 60
/** How often the open panel reads a running operation. */
export const GYM_OP_POLL_MS = 2_000

export type GymControlAction = 'promote' | 'rollback'
export const isControlAction = (v: unknown): v is GymControlAction => v === 'promote' || v === 'rollback'

// ── the address and the settings ───────────────────────────────────────────────────────────────────────────────────────────
export const GYM_CONTROL_COPY = {
  notUrl: 'That is not an address Beacon can use. It should look like http://name-of-the-computer:18098.',
  credentials: 'Leave the user name and password out of the address.',
  extras: 'Leave out anything after the port: no path, ? or #.',
  notTailscale: 'Beacon only controls the gym over Tailscale. Use the computer’s Tailscale name or its Tailscale address.',
  noResolve: 'Beacon couldn’t find that computer. Check the name, and that Tailscale is running on this computer.',
  badToken: 'That doesn’t look like a token: it should be one run of letters, digits and symbols with no spaces.',
  noKeychain: 'Beacon couldn’t reach this computer’s keychain, so the token was not kept.'
} as const

export type GymControlAddress = { ok: true; url: string; host: string } | { ok: false; reason: string }

/** The control service's address as typed, made into the URL main will use: http or https, a computer and a port, nothing else.
 *  (The read side's address names a document; this one names a service, and every path is Beacon's own.) */
export function gymControlAddress(raw: string): GymControlAddress {
  const text = raw.trim()
  let u: URL
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text}`)
  } catch {
    return { ok: false, reason: GYM_CONTROL_COPY.notUrl }
  }
  if ((u.protocol !== 'http:' && u.protocol !== 'https:') || u.hostname === '') return { ok: false, reason: GYM_CONTROL_COPY.notUrl }
  if (u.username !== '' || u.password !== '') return { ok: false, reason: GYM_CONTROL_COPY.credentials }
  if (u.search !== '' || u.hash !== '' || text.includes('?') || text.includes('#') || (u.pathname !== '/' && u.pathname !== '')) return { ok: false, reason: GYM_CONTROL_COPY.extras }
  return { ok: true, url: u.origin, host: u.hostname.replace(/^\[|\]$/g, '') }
}

/** What the page is told about the control settings: the address, and only WHETHER there is a token. */
export interface GymControlSettings {
  address: string
  hasToken: boolean
}

// ── a plan ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────
/** A value in a plan's list of changes: a number, a yes or no, an identifier, or nothing. Never a sentence. */
export type GymChangeValue = number | boolean | string | null
export interface GymModelRef {
  model: string
  recipe: string | null
  round: string | null
}
export interface GymChange {
  /** The setting's name, in segments (a name can be longer than an identifier may be). */
  path: string[]
  from: GymChangeValue
  to: GymChangeValue
}
export interface GymPlan {
  planId: string
  planHash: string
  expiresAt: number
  action: GymControlAction
  from: GymModelRef
  to: GymModelRef
  changes: GymChange[]
  touches: { host: string; what: string }[]
  restarts: string[]
  gate: { verdict: 'pass' | 'fail' | null; held: boolean }
  rollbackAvailable: boolean
  /** The candidate a promote is for (null for a roll back). */
  candidate: string | null
  candidateSha256: string | null
  /** Non-null: the service will not do this, and says why. There is nothing to confirm then. */
  refusal: string | null
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const HEX64 = /^[0-9a-f]{64}$/
/** A value that names a computer or an address, however it was spelled: never shown, so never accepted. */
export function addressLike(s: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(s) || /(^|\.)(local|lan|internal|localhost|home|ts\.net)$/.test(s) || /^[0-9a-f:]*:[0-9a-f:]*$/.test(s) && s.includes('::')
}
function value(v: unknown): { ok: true; v: GymChangeValue } | { ok: false } {
  if (v === null) return { ok: true, v: null }
  if (typeof v === 'boolean') return { ok: true, v }
  if (typeof v === 'number') return Number.isFinite(v) ? { ok: true, v } : { ok: false }
  const s = slug(v)
  return s !== null && !addressLike(s) ? { ok: true, v: s } : { ok: false }
}
function modelRef(v: unknown): GymModelRef | null {
  if (!isObj(v)) return null
  const model = slug(v.model)
  if (model === null || addressLike(model)) return null
  const recipe = v.recipe === null || v.recipe === undefined ? null : slug(v.recipe)
  const round = v.round === null || v.round === undefined ? null : slug(v.round)
  if ((v.recipe != null && recipe === null) || (v.round != null && round === null)) return null
  return { model, recipe, round }
}
/** A plan as the service sent it, or null when it is not one Beacon can show IN FULL. A confirmation must never leave something
 *  out, so unlike the status (which draws what it can) a plan is all or nothing: one setting that is not read cleanly, one
 *  computer that is not one of the two, and Beacon has no plan. Whether the plan is the one that was asked for is checked
 *  where it was asked (main), and whether it has expired where it is used. */
export function parseGymPlan(json: unknown): GymPlan | null {
  if (!isObj(json)) return null
  const planId = slug(json.plan_id)
  const planHash = typeof json.plan_hash === 'string' && HEX64.test(json.plan_hash) ? json.plan_hash : null
  const expiresAt = time(json.expires_at)
  const action = isControlAction(json.action) ? json.action : null
  const from = modelRef(json.from)
  const to = modelRef(json.to)
  if (planId === null || planHash === null || expiresAt === null || action === null || from === null || to === null) return null
  if (!Array.isArray(json.changes) || json.changes.length > GYM_PLAN_MAX_CHANGES) return null
  const changes: GymChange[] = []
  for (const raw of json.changes) {
    if (!isObj(raw) || !Array.isArray(raw.path) || raw.path.length < 1 || raw.path.length > 8) return null
    const path: string[] = []
    for (const seg of raw.path) {
      const s = slug(seg)
      if (s === null || addressLike(s)) return null
      path.push(s)
    }
    const a = value(raw.from)
    const b = value(raw.to)
    if (!a.ok || !b.ok) return null
    changes.push({ path, from: a.v, to: b.v })
  }
  if (!Array.isArray(json.touches) || json.touches.length > 16) return null
  const touches: GymPlan['touches'] = []
  for (const raw of json.touches) {
    const what = isObj(raw) ? slug(raw.what) : null
    if (!isObj(raw) || (raw.host !== 'train_host' && raw.host !== 'serve_host') || what === null || addressLike(what)) return null
    touches.push({ host: raw.host, what })
  }
  if (!Array.isArray(json.restarts) || json.restarts.length > 16) return null
  const restarts: string[] = []
  for (const raw of json.restarts) {
    const s = slug(raw)
    if (s === null || addressLike(s)) return null
    restarts.push(s)
  }
  const g = json.gate
  if (!isObj(g) || (g.verdict !== 'pass' && g.verdict !== 'fail' && g.verdict !== null) || typeof g.held !== 'boolean') return null
  if (typeof json.rollback_available !== 'boolean') return null
  const candidate = json.candidate === null || json.candidate === undefined ? null : slug(json.candidate)
  const sha = json.candidate_sha256 === null || json.candidate_sha256 === undefined ? null : typeof json.candidate_sha256 === 'string' && HEX64.test(json.candidate_sha256) ? json.candidate_sha256 : 'bad'
  if ((json.candidate != null && candidate === null) || sha === 'bad') return null
  // A promote is for a named, verified candidate; a roll back is for the recorded "before" and names none.
  if (action === 'promote' && json.refusal == null && (candidate === null || sha === null)) return null
  const refusal = json.refusal === null || json.refusal === undefined ? null : slug(json.refusal)
  if (json.refusal != null && refusal === null) return null
  return { planId, planHash, expiresAt, action, from, to, changes, touches, restarts, gate: { verdict: g.verdict, held: g.held }, rollbackAvailable: json.rollback_available, candidate, candidateSha256: sha, refusal }
}

// ── what the service can do ─────────────────────────────────────────────────────────────────────────────────────────────────
export interface GymCapabilities {
  promote: boolean
  rollback: boolean
  /** The archived models Promote may be asked for, by name. The service advertises them: there is no free target. */
  candidates: string[]
}
export function parseGymCapabilities(json: unknown): GymCapabilities | null {
  if (!isObj(json) || typeof json.promote !== 'boolean' || typeof json.rollback !== 'boolean' || !Array.isArray(json.candidates) || json.candidates.length > 32) return null
  const candidates: string[] = []
  for (const raw of json.candidates) {
    const s = slug(raw)
    if (s === null || addressLike(s)) return null
    candidates.push(s)
  }
  return { promote: json.promote, rollback: json.rollback, candidates }
}

// ── an operation ────────────────────────────────────────────────────────────────────────────────────────────────────────────
export type GymOpStatus = 'running' | 'done' | 'failed' | 'stopped' | 'unknown'
export const GYM_OP_STATUSES: readonly GymOpStatus[] = ['running', 'done', 'failed', 'stopped', 'unknown']
export interface GymOp {
  status: GymOpStatus
  step: string | null
  at: number
  outcome: string | null
  /** What the gym says about the rehearsal's own files and the real daemon, after the fact; null: not said. */
  beforeMatch: boolean | null
  realUntouched: boolean | null
}
export function parseGymOp(json: unknown): GymOp | null {
  if (!isObj(json)) return null
  const status = GYM_OP_STATUSES.find((s) => s === json.status)
  const at = time(json.at)
  if (status === undefined || at === null) return null
  const id = (v: unknown): string | null | undefined => (v === null || v === undefined ? null : slug(v) ?? undefined)
  const step = id(json.step)
  const outcome = id(json.outcome)
  if (step === undefined || outcome === undefined) return null
  const yn = (v: unknown): boolean | null | undefined => (v === null || v === undefined ? null : typeof v === 'boolean' ? v : undefined)
  const beforeMatch = yn(json.before_match)
  const realUntouched = yn(json.real_untouched)
  if (beforeMatch === undefined || realUntouched === undefined) return null
  return { status, step, at, outcome, beforeMatch, realUntouched }
}
export const opFinished = (s: GymOpStatus): boolean => s !== 'running'

/** What apply answers: the operation's name. */
export function parseApplied(json: unknown): string | null {
  return isObj(json) ? slug(json.op_id) : null
}

// ── what main answers the page ──────────────────────────────────────────────────────────────────────────────────────────────
export type GymRunResult =
  | { kind: 'busy' }
  | { kind: 'not-owner' }
  | { kind: 'unset' }
  | { kind: 'no-token' }
  | { kind: 'refused'; reason: string }
  | { kind: 'unreachable' }
  | { kind: 'denied'; why: 'token' | 'device' | 'rate' }
  | { kind: 'unreadable' }
  /** The service said no to this plan, in a word (no confirmation was shown, nothing was done). */
  | { kind: 'plan-refused'; refusal: string }
  /** The candidate asked for is not one the service offers. */
  | { kind: 'not-offered' }
  | { kind: 'cancelled' }
  /** The plan ran out while it was on screen. Nothing was done. */
  | { kind: 'expired' }
  /** The service says the state is not what the plan was made from (409). Nothing was done. */
  | { kind: 'changed' }
  /** The plan was confirmed and the service took it: the operation is running. */
  | { kind: 'started'; action: GymControlAction }
  /** The plan was confirmed and sent, and no clear answer came back: it may or may not have started. Never retried. */
  | { kind: 'unknown'; action: GymControlAction }

export type GymOpRead =
  | { kind: 'none' }
  | { kind: 'unreachable' }
  | { kind: 'unreadable' }
  | { kind: 'denied'; why: 'token' | 'device' | 'rate' }
  | { kind: 'shown'; action: GymControlAction; op: GymOp }

// ── Beacon's words ──────────────────────────────────────────────────────────────────────────────────────────────────────────
export const GYM_CONTROL_WORDS = {
  promoteTitle: 'Promote the rehearsal model',
  rollbackTitle: 'Roll back the rehearsal model',
  promoteButton: 'Promote',
  rollbackButton: 'Roll back',
  cancel: 'Cancel',
  nowServing: 'Serving now',
  willServe: 'Will serve',
  noChanges: 'No settings change.',
  settings: 'Settings that change',
  computers: 'Computers touched',
  restarts: 'Restarts',
  nothingRestarts: 'Nothing restarts.',
  gate: 'The gate’s result',
  rollbackYes: 'Rolling back afterwards: possible.',
  rollbackNo: 'Rolling back afterwards: not possible.',
  expires: 'This plan is good until',
  none: 'none',
  nothing: 'nothing'
} as const

const REFUSALS: Record<string, string> = {
  target_not_allowed: 'The gym won’t promote to that place.',
  candidate_never_promote_to_real: 'That model is marked as never to be promoted for real.',
  shadow_report_missing: 'There is no shadow report for it yet.',
  memory_floor: 'There isn’t enough free memory for it right now.',
  disk_floor: 'There isn’t enough free disk space for it right now.',
  operation_running: 'Another operation is still running.',
  instance_busy: 'The rehearsal instance is busy.',
  already_promoted: 'It is already promoted.',
  nothing_to_roll_back: 'There is nothing to roll back.',
  files_changed_since_capture: 'A file changed since the promotion was recorded. Rolling back needs a decision on the gym’s computer, not here.',
  verification_failed: 'The gym couldn’t verify the model.'
}
/** The gym's reason for refusing, in Beacon's words; one Beacon has no words for is shown as the identifier it is. */
export function refusalWords(code: string): string {
  return Object.prototype.hasOwnProperty.call(REFUSALS, code) ? REFUSALS[code] : `The gym refused (${code}).`
}

const OP_STATUS_WORDS: Record<GymOpStatus, { tone: 'ok' | 'warn' | 'err' | 'idle'; text: string }> = {
  running: { tone: 'warn', text: 'Running' },
  done: { tone: 'ok', text: 'Done' },
  failed: { tone: 'err', text: 'Failed' },
  stopped: { tone: 'err', text: 'Stopped' },
  unknown: { tone: 'warn', text: 'Not known' }
}
export function opWords(op: GymOp, action: GymControlAction): { tone: 'ok' | 'warn' | 'err' | 'idle'; text: string } {
  const w = OP_STATUS_WORDS[op.status]
  const what = action === 'promote' ? 'Promote' : 'Roll back'
  return { tone: w.tone, text: `${what}: ${w.text.toLowerCase()}${op.step ? ` · ${codeWords(op.step)}` : ''}${op.outcome ? ` · ${codeWords(op.outcome)}` : ''}` }
}
/** What the gym says afterwards about the files it did not change, in Beacon's words, only when it said so. */
export function opAfterFacts(op: GymOp): string[] {
  const out: string[] = []
  if (op.beforeMatch !== null) out.push(op.beforeMatch ? 'The rehearsal instance’s files match what was recorded before.' : 'The rehearsal instance’s files do NOT match what was recorded before.')
  if (op.realUntouched !== null) out.push(op.realUntouched ? 'The gym reports the real daemon was left untouched.' : 'The gym does NOT report the real daemon as untouched.')
  return out
}

export const GYM_RUN_COPY = {
  busy: 'Another Promote or Roll back is already waiting for you.',
  notOwner: 'Only the owner of this Prometheus can promote or roll back.',
  unset: 'Beacon doesn’t know where the gym’s control service is yet.',
  noToken: 'Promote and Roll back need a write token for this computer. Make one on the gym’s computer and paste it below.',
  unreachable: 'Beacon couldn’t reach the gym’s control service. Nothing was changed.',
  deniedToken: 'The control service didn’t accept this computer’s write token. Nothing was changed.',
  deniedDevice: 'The control service doesn’t know this computer as one of yours. Nothing was changed.',
  deniedRate: 'The control service is being asked too often. Nothing was changed. Try again shortly.',
  unreadable: 'The control service answered, but not with a plan Beacon can show in full, so nothing was done.',
  notOffered: 'The gym doesn’t offer that model to promote.',
  cancelled: 'Cancelled. Nothing was changed.',
  expired: 'The plan ran out before it was confirmed. Nothing was changed. Ask again for a fresh one.',
  changed: 'The gym changed while the plan was on screen, so it was not applied. Nothing was changed. Look at the gym and ask again.',
  started: 'Sent. The gym is doing it now.',
  unknown: 'Beacon sent the confirmed plan and didn’t get a clear answer, so it can’t say whether it started. It will not send it again. Look at the gym’s status in the Now view before doing anything else.'
} as const

/** The sentence for a result that is not a success, or null (`started`, `cancelled` say theirs through the same table). */
export function runWords(r: GymRunResult): string {
  switch (r.kind) {
    case 'busy':
      return GYM_RUN_COPY.busy
    case 'not-owner':
      return GYM_RUN_COPY.notOwner
    case 'unset':
      return GYM_RUN_COPY.unset
    case 'no-token':
      return GYM_RUN_COPY.noToken
    case 'refused':
      return r.reason
    case 'unreachable':
      return GYM_RUN_COPY.unreachable
    case 'denied':
      return r.why === 'token' ? GYM_RUN_COPY.deniedToken : r.why === 'device' ? GYM_RUN_COPY.deniedDevice : GYM_RUN_COPY.deniedRate
    case 'unreadable':
      return GYM_RUN_COPY.unreadable
    case 'plan-refused':
      return `${refusalWords(r.refusal)} Nothing was changed.`
    case 'not-offered':
      return GYM_RUN_COPY.notOffered
    case 'cancelled':
      return GYM_RUN_COPY.cancelled
    case 'expired':
      return GYM_RUN_COPY.expired
    case 'changed':
      return GYM_RUN_COPY.changed
    case 'started':
      return GYM_RUN_COPY.started
    case 'unknown':
      return GYM_RUN_COPY.unknown
  }
}

// ── the confirmation ────────────────────────────────────────────────────────────────────────────────────────────────────────
const showValue = (v: GymChangeValue): string => (v === null ? GYM_CONTROL_WORDS.none : typeof v === 'boolean' ? (v ? 'yes' : 'no') : String(v))
const modelLine = (m: GymModelRef): string => `${m.model}${m.recipe || m.round ? ` (${[m.recipe ? `recipe ${m.recipe}` : '', m.round ? `round ${m.round}` : ''].filter(Boolean).join(', ')})` : ''}`
const GATE_WORDS = { pass: 'passed', fail: 'failed', none: 'no verdict' } as const

/** The words of the confirmation, built from the plan MAIN received and nothing else. It lists what the plan lists, in full,
 *  and no more: no reassurance about what is not touched (the gym's own statement of that is shown only afterwards). */
export function confirmationText(plan: GymPlan, clock: (at: number) => string): { title: string; button: string; detail: string } {
  const W = GYM_CONTROL_WORDS
  const lines: string[] = []
  lines.push(`${W.nowServing}: ${modelLine(plan.from)}`)
  lines.push(`${W.willServe}: ${modelLine(plan.to)}`)
  lines.push('')
  if (plan.changes.length === 0) lines.push(W.noChanges)
  else {
    lines.push(`${W.settings} (${plan.changes.length}):`)
    for (const c of plan.changes) lines.push(`  ${c.path.join(' › ')}: ${showValue(c.from)} → ${showValue(c.to)}`)
  }
  lines.push('')
  lines.push(`${W.computers}: ${plan.touches.length === 0 ? W.nothing : plan.touches.map((t) => `${codeWords(t.host)} (${codeWords(t.what)})`).join(', ')}`)
  lines.push(plan.restarts.length === 0 ? W.nothingRestarts : `${W.restarts}: ${plan.restarts.map(codeWords).join(', ')}`)
  const verdict = plan.gate.verdict === 'pass' ? GATE_WORDS.pass : plan.gate.verdict === 'fail' ? GATE_WORDS.fail : GATE_WORDS.none
  lines.push(`${W.gate}: ${verdict}${plan.gate.held ? ' (held)' : ''}`)
  lines.push(plan.rollbackAvailable ? W.rollbackYes : W.rollbackNo)
  lines.push('')
  lines.push(`${W.expires} ${clock(plan.expiresAt)}.`)
  const promote = plan.action === 'promote'
  return { title: promote ? W.promoteTitle : W.rollbackTitle, button: promote ? W.promoteButton : W.rollbackButton, detail: lines.join('\n') }
}

// ── which buttons are drawn, and which can be pressed ──────────────────────────────────────────────────────────────────────
export interface GymButton {
  enabled: boolean
  /** Why it can't be pressed, in Beacon's words; '' when it can. */
  why: string
}
export interface GymControlView {
  /** False: no buttons at all (not the owner, or nothing is set up). */
  shown: boolean
  /** The reason nothing is drawn, for the one line that says how to get it; '' when shown. */
  setup: string
  promote: GymButton
  rollback: GymButton
  candidates: string[]
}
export const GYM_BUTTON_COPY = {
  notOwner: 'Only the owner of this Prometheus can promote or roll back.',
  setUp: 'Set up the control service below to promote or roll back.',
  stale: 'The status is old, so Promote waits for a fresh one.',
  noStatus: 'There is no status to go on yet.',
  noCandidates: 'The gym offers no model to promote.',
  running: 'An operation is running.',
  waiting: 'Waiting for your answer.'
} as const
const RUNNING_STATES = new Set(['promoting', 'rolling_back'])

/** What the Rehearsal model card draws. PROMOTE needs a fresh status (it picks a model from what the gym offers, and decides
 *  on what is serving now), at least one model on offer, and nothing running. ROLL BACK does not need a fresh status: when a
 *  host is down is when it may be needed, and its own plan re-reads the gym and refuses if there is nothing to roll back.
 *  Neither is ever drawn for a device that is not the owner. */
export function controlView(i: { role: DeviceRole | null; configured: boolean; promotion: GymPromotion | null; stale: boolean; opRunning: boolean; waiting: boolean }): GymControlView {
  const off = (setup: string): GymControlView => ({ shown: false, setup, promote: { enabled: false, why: setup }, rollback: { enabled: false, why: setup }, candidates: [] })
  if (i.role !== 'owner') return off(GYM_BUTTON_COPY.notOwner)
  if (!i.configured) return off(GYM_BUTTON_COPY.setUp)
  const candidates = i.promotion?.candidates ?? []
  const running = i.opRunning || (i.promotion !== null && RUNNING_STATES.has(i.promotion.state))
  const block = running ? GYM_BUTTON_COPY.running : i.waiting ? GYM_BUTTON_COPY.waiting : ''
  const promoteWhy = block || (i.promotion === null ? GYM_BUTTON_COPY.noStatus : i.stale ? GYM_BUTTON_COPY.stale : candidates.length === 0 ? GYM_BUTTON_COPY.noCandidates : '')
  return { shown: true, setup: '', promote: { enabled: promoteWhy === '', why: promoteWhy }, rollback: { enabled: block === '', why: block }, candidates }
}
