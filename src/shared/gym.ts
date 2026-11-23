// The gym dashboard: a read-only view of a Prometheus fine-tuning gym's status (Activity › Gym).
//
// The gym's status service answers one JSON document, `gym-status/2`, of counts, times and identifiers. Beacon reads it, never
// writes to it, and this phase has no control that changes anything on the gym.
//
// THREE RULES THIS MODULE HOLDS, so the panel cannot break them:
//   1. Tailscale only. The address must be an http(s) URL, and every address its host resolves to must be a Tailscale one
//      (`tailscaleOnly`). Main resolves, checks, and connects to the checked address (src/main/gym-status.ts). The token is
//      sent only after that check, to that address.
//   2. No text from the gym is shown. The service promises numbers, times, enums and identifiers only; Beacon does not rely on
//      the promise. `parseGymStatus` keeps numbers, times, booleans, and short identifiers with no spaces (`slug`),
//      and drops anything else, so a trace, a prompt or a task's wording cannot reach the screen even if one were served.
//      Sentences on screen are Beacon's own, chosen by an identifier (`codeWords`).
//   3. The schema lives here and nowhere else. The panel draws `GymStatus`; only `parseGymStatus` knows the wire's field names.
//
// STRICT, BY NAME. `gym-status/2` names everything generically (`train_host`, `serve_host`, `reference_model`), so the parser
// reads exactly the keys the schema lists and nothing by shape: a key it does not list is ignored, a host it does not list
// is not a host. No computer's or model's own name is served, so the words for them on screen are Beacon's (`codeWords`).
// Version 1 named the owner's computers in its keys and is not read: a document that is not `gym-status/2` is not a status.
//
// The schema only grows within a version (new fields, new enum values): an unknown key is ignored, an unknown enum value is
// drawn as the identifier it is, or as "other" or "not reported" where only a known set makes sense.
//
// No Node/Electron imports (same rule as the rest of src/shared).
import { hostScope } from './plain-lan'

export const GYM_SCHEMA = 'gym-status/2'
/** The path asked when the address names only a computer and a port. */
export const GYM_STATUS_PATH = '/v2/status'
/** Where main keeps the address (a settings row; this Beacon's, whichever Prometheus is open). The token is NOT a setting: it is
 *  kept in its own file, encrypted with a key the OS keychain holds (src/main/credentials.ts). */
export const GYM_ADDRESS_KEY = 'gym:address:v1'
/** How often the open panel asks again. The service builds a snapshot every 60 s and allows 30 requests a minute. */
export const GYM_POLL_MS = 30_000
/** The most of an answer main reads. A full status is a few hundred kilobytes at most; more than this is not a status. */
export const GYM_MAX_BYTES = 4_194_304

// ── the address and the token ───────────────────────────────────────────────────────────────────────────────────────────────
export const GYM_ADDRESS_COPY = {
  notUrl: 'That is not an address Beacon can use. It should look like http://name-of-the-computer:18097.',
  credentials: 'Leave the user name and password out of the address.',
  extras: 'Leave out anything after a ? or # in the address.',
  notTailscale: 'Beacon only reads the gym over Tailscale. Use the computer’s Tailscale name or its Tailscale address.',
  noResolve: 'Beacon couldn’t find that computer. Check the name, and that Tailscale is running on this computer.',
  badToken: 'That doesn’t look like a token: it should be one run of letters, digits and symbols with no spaces.',
  noKeychain: 'Beacon couldn’t reach this computer’s keychain, so the token was not kept.'
} as const

export type GymAddress = { ok: true; url: string; host: string } | { ok: false; reason: string }

/** The address as typed, made into the URL main will ask: http or https, no credentials, no query, no fragment. A bare computer
 *  and port gets the status path. */
export function gymAddress(raw: string): GymAddress {
  const text = raw.trim()
  let u: URL
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text}`)
  } catch {
    return { ok: false, reason: GYM_ADDRESS_COPY.notUrl }
  }
  if ((u.protocol !== 'http:' && u.protocol !== 'https:') || u.hostname === '') return { ok: false, reason: GYM_ADDRESS_COPY.notUrl }
  if (u.username !== '' || u.password !== '') return { ok: false, reason: GYM_ADDRESS_COPY.credentials }
  if (u.search !== '' || u.hash !== '' || text.includes('?') || text.includes('#')) return { ok: false, reason: GYM_ADDRESS_COPY.extras }
  if (u.pathname === '/' || u.pathname === '') u.pathname = GYM_STATUS_PATH
  return { ok: true, url: u.toString(), host: u.hostname.replace(/^\[|\]$/g, '') }
}

/** The one address to connect to, when EVERY address the host resolves to is a Tailscale one; otherwise why not. A host written
 *  as an address resolves to itself. A name is judged by where it resolves, never by how it looks: a name ending .ts.net that
 *  resolves somewhere else is refused like any other. */
export function tailscaleOnly(addresses: readonly string[]): { ok: true; address: string } | { ok: false; reason: string } {
  if (addresses.length === 0) return { ok: false, reason: GYM_ADDRESS_COPY.noResolve }
  if (addresses.some((a) => hostScope(a) !== 'tailscale')) return { ok: false, reason: GYM_ADDRESS_COPY.notTailscale }
  return { ok: true, address: addresses[0] }
}

/** A token as it may go in a request header: one run of visible ASCII, 16 to 512 long. Anything else (a space, a line break,
 *  a quote from a careless paste) is refused rather than sent. */
export function gymToken(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const t = raw.trim()
  return /^[\x21-\x7e]{16,512}$/.test(t) ? t : null
}

// ── the status, as the panel draws it ───────────────────────────────────────────────────────────────────────────────────────
export type GymSeverity = 'info' | 'warn' | 'critical'
export type GymServiceState = 'up' | 'degraded' | 'down' | 'unknown'
export type GymTone = 'ok' | 'warn' | 'err' | 'idle'
/** [x, y] in x order. */
export type GymSeries = [number, number][]
export interface GymCount {
  id: string
  n: number
}

export interface GymSource {
  id: string
  host: string | null
  ok: boolean
  ageS: number | null
  error: string | null
}
export interface GymRoundNow {
  id: string
  base: string | null
  phase: string
  phaseSince: number | null
  decision: string | null
  /** True when this is the last round on its base: a fail stops there. */
  stopAfter: boolean | null
  trainRows: number | null
  valRows: number | null
}
export interface GymTraining {
  run: string | null
  host: string | null
  status: string
  step: number | null
  total: number | null
  epoch: number | null
  epochs: number | null
  tokensPerS: number | null
  eta: number | null
  updatedAt: number | null
  windowStopAt: number | null
  /** [step, loss] each. */
  valLoss: GymSeries
  probeLoss: GymSeries
  trainLoss: GymSeries
  checkpoints: number
}
export interface GymPostTrain {
  status: string
  outcome: string | null
  currentStep: string | null
  /** The candidate the current step is for: `final` or `epoch1`; null is a step both share, or the same-recipe base. */
  currentCandidate: string | null
  /** The newest of the pipeline's state and its log: the last time it was heard from. */
  updatedAt: number | null
  stepsDone: number | null
  stepsTotal: number | null
  steps: { id: string; status: string }[]
  candidates: { id: string; step: number | null; valLoss: number | null; probeLoss: number | null }[]
}
export type GymBarKind = 'min_delta_pts' | 'max_drop_pts' | 'non_inferior_paired' | 'min_value_pts' | 'other'
export type GymCriterionStatus = 'pass' | 'fail' | 'underpowered' | 'info' | 'other'
export interface GymCriterion {
  id: string
  status: GymCriterionStatus
  bar: { kind: GymBarKind; pts: number | null }
  basePts: number | null
  candidatePts: number | null
  deltaPts: number | null
  ciLowPts: number | null
  ciHighPts: number | null
  n: number | null
}
export interface GymReplaySet {
  /** The set's own key in the document (an identifier). */
  set: string
  faPass: number | null
  faN: number | null
  tcPass: number | null
  tcN: number | null
}
export interface GymScorecard {
  round: string
  run: string | null
  candidate: string
  quant: string | null
  vs: string | null
  verdict: 'pass' | 'fail' | null
  /** The owner's three-way rule, where the gym applies it: pass, shadow, fail. */
  outcome: string | null
  selected: boolean | null
  promoted: boolean | null
  criteria: GymCriterion[]
  replay: GymReplaySet[]
}
export interface GymTaskset {
  name: string
  rows: number | null
  held: boolean | null
  /** Self-BLEU-4 over a sample: lower means more varied. */
  selfBleu4: number | null
  selfBleu4WithEarlier: number | null
  dupOfEarlierShare: number | null
  seedsUsed: number | null
  perSeedMean: number | null
  perSeedMax: number | null
}
export interface GymData {
  pool: { updatedAt: number | null; rowsTotal: number | null; derivedRows: number | null; bySource: GymCount[] } | null
  /** [day, examples in the pool], a point a day. */
  poolGrowth: GymSeries
  /** Added over the days served, by source, largest first. */
  poolAdded: GymCount[]
  tasksets: GymTaskset[]
  dataset: {
    name: string | null
    round: string | null
    builtAt: number | null
    trainRows: number | null
    valRows: number | null
    toolCallShare: number | null
    tokensP50: number | null
    tokensP90: number | null
    perSeedCap: number | null
    seedsOverCap: number | null
    bySource: GymCount[]
    byArea: GymCount[]
    byCategory: GymCount[]
    parts: { name: string; trainRows: number | null }[]
  } | null
  history: { round: string; trainRows: number | null; valRows: number | null; toolCallShare: number | null }[]
}
export interface GymGenWindow {
  hours: number | null
  rows: number | null
  rowsPerHour: number | null
  keepRate: number | null
  byTeacherPerHour: GymCount[]
}
export interface GymGeneration {
  last24h: GymGenWindow | null
  sinceRoundStart: GymGenWindow | null
  activeRuns: { teacher: string; taskset: string | null; tasksDone: number | null; tasksTotal: number | null; rows: number | null; tasksPerHour: number | null }[]
  judge24h: { calls: number | null; pass: number | null; fail: number | null } | null
}
export interface GymUsage {
  attempts: number | null
  ok: number | null
  inputTokens: number | null
  cachedInputTokens: number | null
  outputTokens: number | null
  errors: number
}
export interface GymTokenPlan {
  state: string
  since: number | null
  usage24h: GymUsage | null
  usage7d: GymUsage | null
  concurrency: { limit: number | null; max: number | null } | null
}
export interface GymService {
  id: string
  state: GymServiceState
  /** Not up, and meant not to be. Only ever what the gym says, and never true of something that is up. */
  planned: boolean
  /** Why it is not up, as the gym's identifier (`train_window`, `not_answering`…), or null. */
  reason: string | null
  /** When a planned stop ends, or null. */
  until: number | null
}
export interface GymHost {
  id: string
  reachable: boolean | null
  bootAt: number | null
  /** False: it restarted and nobody told the gym why. */
  bootExplained: boolean | null
  disk: { mount: string; freeGib: number | null; totalGib: number | null }[]
  gpu: { tempC: number | null; powerW: number | null; powerLimitW: number | null; utilPct: number | null; vramUsedMib: number | null; vramTotalMib: number | null; at: number | null } | null
  /** [time, °C] and [time, W], five-minute maxima. */
  gpuTemp: GymSeries
  gpuPower: GymSeries
  failedUnits: number | null
  gpuRole: string | null
  window: { open: boolean; mode: string | null; job: string | null; openedAt: number | null; endsAt: number | null; deadmanAt: number | null; noSwapsFlag: boolean | null } | null
  services: GymService[]
  lastRestoreAt: number | null
  lastRestoreOk: boolean | null
  watchdog: { lastCheck: number | null; lastOk: boolean | null; consecutiveFails: number | null } | null
}
export interface GymLastNight {
  date: string | null
  windows: { host: string | null; openedAt: number | null; closedAt: number | null; restoreOk: boolean | null }[]
  teacher: { tasks: number | null; kept: number | null; rows: number | null } | null
  training: { stepFrom: number | null; stepTo: number | null } | null
  gpu: { maxTempC: number | null; maxPowerW: number | null } | null
  nightWatch: string
  /** Each computer's own night-watch check, where the gym gives them. */
  nightWatchHosts: { host: string; result: string; steps: number | null; problems: number | null; checkedAt: number | null }[]
  alerts: number | null
}
export interface GymAlert {
  kind: string
  host: string | null
  since: number | null
  severity: GymSeverity
  count: number | null
  /** The service an outage alert is about, or null. */
  service: string | null
}
export interface GymEvent {
  at: number
  kind: string
  host: string | null
  round: string | null
  value: number | null
  ok: boolean | null
}
export interface GymStatus {
  generatedAt: number
  sources: GymSource[]
  round: GymRoundNow | null
  training: GymTraining | null
  postTrain: GymPostTrain | null
  scorecards: GymScorecard[]
  data: GymData | null
  generation: GymGeneration | null
  tokenPlan: GymTokenPlan | null
  hosts: GymHost[]
  schedule: { at: number; kind: string; host: string | null }[]
  lastNight: GymLastNight | null
  alerts: GymAlert[]
  /** Newest first. */
  timeline: GymEvent[]
}

/** What main answers the panel. `sample`: read from a fixture file in a non-release build, not from a gym. */
export type GymRead =
  | { kind: 'unset' }
  | { kind: 'refused'; reason: string }
  | { kind: 'unreachable' }
  | { kind: 'no-token' }
  | { kind: 'denied'; why: 'token' | 'device' | 'rate' }
  | { kind: 'unreadable'; detail: string }
  | { kind: 'shown'; status: GymStatus; readAt: number; sample: boolean }

/** What the page is told about the settings: the address, and only WHETHER there is a token. The token never goes to the page. */
export interface GymSettings {
  address: string
  hasToken: boolean
}

/** What the connection form says about itself. */
export const GYM_FORM_COPY = {
  noAddress: 'The address is empty. Fill in where the gym’s status is.',
  noAddressSaved: 'The address is empty. Fill in where the gym’s status is, or use “Forget this gym” to stop using it.',
  tokenForgotten: 'The token you had saved was for the previous address, so Beacon forgot it. Paste the token for this gym.',
  setUpFirst: 'Set up the connection below first.'
} as const

/** Why Save must not go ahead, or null. Save never clears the address: an empty address field is a missing field, said so by
 *  name, whatever else was typed. (Saving it used to "work": the address was cleared, a typed token was kept with nowhere to
 *  send it, and the form said nothing.) Clearing on purpose is its own action, "Forget this gym". */
export function gymFormProblem(form: { address: string; savedAddress: string }): string | null {
  if (form.address.trim() !== '') return null
  return form.savedAddress.trim() !== '' ? GYM_FORM_COPY.noAddressSaved : GYM_FORM_COPY.noAddress
}

export const GYM_READ_COPY = {
  unset: 'Beacon doesn’t know where your gym is yet.',
  unreachable: 'Beacon couldn’t reach the gym. Check that Tailscale is running here and that the gym’s computer is on.',
  noToken: 'The gym needs a token for this computer. Make one on the gym’s computer and paste it below.',
  deniedToken: 'The gym didn’t accept this computer’s token. It may have been replaced or taken back: make a new one on the gym’s computer and paste it below.',
  deniedDevice: 'The gym doesn’t know this computer as one of yours. Add it to the gym’s list of your devices, then try again.',
  deniedRate: 'The gym is being asked too often. Beacon will try again shortly.',
  unreadable: 'The gym answered, but not with a status Beacon can read.',
  sample: 'Sample data, not a gym.'
} as const

// ── reading the wire ────────────────────────────────────────────────────────────────────────────────────────────────────────
const SLUG = /^[a-z0-9][a-z0-9_.:-]{0,39}$/
/** An identifier: lower-case letters, digits and _ . : - with no spaces, at most 40 long (the schema's own pattern). The only
 *  kind of string from the gym that is kept. */
export function slug(v: unknown): string | null {
  return typeof v === 'string' && SLUG.test(v) ? v : null
}
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const bool = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null)
const obj = (v: unknown): Record<string, unknown> | null => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null)
const list = (v: unknown, max: number): unknown[] => (Array.isArray(v) ? v.slice(0, max) : [])
/** A calendar day (YYYY-MM-DD) as its local noon in epoch milliseconds, or null. */
function dayOf(v: unknown): number | null {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return null
  const t = new Date(`${v}T12:00:00`).getTime()
  return Number.isNaN(t) ? null : t
}
/** A time: an ISO string with a clock in it, as epoch milliseconds, or null. */
function time(v: unknown): number | null {
  if (typeof v !== 'string' || v.length > 40 || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v)) return null
  const t = Date.parse(v)
  return Number.isNaN(t) ? null : t
}
function oneOf<T extends string>(v: unknown, all: readonly T[], otherwise: T): T {
  return all.includes(v as T) ? (v as T) : otherwise
}
/** A map of identifier to number, as rows, largest first. A key that is not an identifier is dropped with its number. */
function counts(v: unknown, max = 200): GymCount[] {
  const out: GymCount[] = []
  for (const [k, n] of Object.entries(obj(v) ?? {}).slice(0, 5000)) {
    const id = slug(k)
    const x = num(n)
    if (id !== null && x !== null) out.push({ id, n: x })
  }
  return out.sort((a, b) => b.n - a.n).slice(0, max) // sorted first, so a cap keeps the largest
}
/** `[{<x>, <y>}]` as [x, y] rows in x order; a row missing either is dropped. */
function series(v: unknown, x: string, y: string, xIsTime: boolean, max: number): GymSeries {
  const out: GymSeries = []
  for (const raw of list(v, max)) {
    const r = obj(raw)
    const a = xIsTime ? time(r?.[x]) : num(r?.[x])
    const b = num(r?.[y])
    if (a !== null && b !== null) out.push([a, b])
  }
  return out.sort((p, q) => p[0] - q[0])
}

function parseRound(v: unknown): GymRoundNow | null {
  const r = obj(v)
  const id = slug(r?.id)
  if (!r || id === null) return null
  const ds = obj(r.dataset)
  return { id, base: slug(r.base), phase: slug(r.phase) ?? 'unknown', phaseSince: time(r.phase_since), decision: slug(r.decision), stopAfter: bool(r.stop_after), trainRows: num(ds?.train_rows), valRows: num(ds?.val_rows) }
}

function parseTraining(v: unknown): GymTraining | null {
  const t = obj(v)
  if (!t) return null
  return {
    run: slug(t.run),
    host: slug(t.host),
    status: slug(t.status) ?? 'unknown',
    step: num(t.step),
    total: num(t.total_steps),
    epoch: num(t.epoch),
    epochs: num(t.epochs),
    tokensPerS: num(t.tokens_per_s),
    eta: time(t.eta),
    updatedAt: time(t.updated_at),
    windowStopAt: time(t.window_stop_at),
    valLoss: series(t.val_loss, 'step', 'loss', false, 400),
    probeLoss: series(t.probe_loss, 'step', 'loss', false, 400),
    trainLoss: series(t.train_loss, 'step', 'loss', false, 400),
    checkpoints: list(t.checkpoints, 1000).length
  }
}

function parsePostTrain(v: unknown): GymPostTrain | null {
  const p = obj(v)
  if (!p) return null
  const steps: GymPostTrain['steps'] = []
  for (const raw of list(p.steps, 80)) {
    const s = obj(raw)
    const id = slug(s?.id)
    if (s && id !== null) steps.push({ id, status: slug(s.status) ?? 'unknown' })
  }
  const candidates: GymPostTrain['candidates'] = []
  for (const raw of list(p.candidates, 32)) {
    const c = obj(raw)
    const id = slug(c?.id)
    if (c && id !== null) candidates.push({ id, step: num(c.step), valLoss: num(c.val_loss), probeLoss: num(c.probe_loss) })
  }
  return { status: slug(p.status) ?? 'unknown', outcome: slug(p.outcome), currentStep: slug(p.current_step), currentCandidate: slug(p.current_candidate), updatedAt: time(p.updated_at), stepsDone: num(p.steps_done), stepsTotal: num(p.steps_total), steps, candidates }
}

function parseScorecards(v: unknown): GymScorecard[] {
  const out: GymScorecard[] = []
  // No cap the schema does not set would be safe here: the newest rounds come last. 2000 is far past any real gym.
  for (const raw of list(v, 2000)) {
    const c = obj(raw)
    const round = slug(c?.round)
    const candidate = slug(c?.candidate)
    if (!c || round === null || candidate === null) continue
    const criteria: GymCriterion[] = []
    for (const rawK of list(c.criteria, 30)) {
      const k = obj(rawK)
      const id = slug(k?.id)
      if (!k || id === null) continue
      const bar = obj(k.bar)
      criteria.push({
        id,
        status: oneOf<GymCriterionStatus>(k.status, ['pass', 'fail', 'underpowered', 'info'], 'other'),
        bar: { kind: oneOf<GymBarKind>(bar?.kind, ['min_delta_pts', 'max_drop_pts', 'non_inferior_paired', 'min_value_pts'], 'other'), pts: num(bar?.pts) },
        basePts: num(k.base_pts),
        candidatePts: num(k.candidate_pts),
        deltaPts: num(k.delta_pts),
        ciLowPts: num(k.ci_low_pts),
        ciHighPts: num(k.ci_high_pts),
        n: num(k.n)
      })
    }
    const replay: GymReplaySet[] = []
    for (const [setName, rawS] of Object.entries(obj(c.reference_replay) ?? {}).slice(0, 8)) {
      const st = obj(rawS)
      const set = slug(setName)
      if (st && set !== null) replay.push({ set, faPass: num(st.fa_pass), faN: num(st.fa_n), tcPass: num(st.tc_pass), tcN: num(st.tc_n) })
    }
    const verdict = slug(c.verdict)
    out.push({
      round,
      run: slug(c.run),
      candidate,
      quant: slug(c.quant),
      vs: slug(c.vs),
      verdict: verdict === 'pass' || verdict === 'fail' ? verdict : null,
      outcome: slug(c.outcome),
      selected: bool(c.selected),
      promoted: bool(c.promoted),
      criteria,
      replay
    })
  }
  return out
}

function parseData(v: unknown): GymData | null {
  const d = obj(v)
  if (!d) return null
  const pool = obj(d.pool)
  const ds = obj(d.dataset)
  const tasksets: GymTaskset[] = []
  for (const raw of list(d.tasksets, 500)) {
    const t = obj(raw)
    const name = slug(t?.name)
    if (!t || name === null) continue
    tasksets.push({
      name,
      rows: num(t.rows),
      held: bool(t.held),
      selfBleu4: num(t.self_bleu4),
      selfBleu4WithEarlier: num(t.self_bleu4_with_earlier),
      dupOfEarlierShare: num(t.dup_of_earlier_share),
      seedsUsed: num(t.seeds_used),
      perSeedMean: num(t.per_seed_mean),
      perSeedMax: num(t.per_seed_max)
    })
  }
  const parts: { name: string; trainRows: number | null }[] = []
  for (const raw of list(ds?.parts, 200)) {
    const p = obj(raw)
    const name = slug(p?.name)
    if (p && name !== null) parts.push({ name, trainRows: num(p.train_rows) })
  }
  const history: GymData['history'] = []
  for (const raw of list(d.history, 500)) {
    const h = obj(raw)
    const round = slug(h?.round)
    if (h && round !== null) history.push({ round, trainRows: num(h.train_rows), valRows: num(h.val_rows), toolCallShare: num(h.tool_call_share) })
  }
  const poolGrowth: GymSeries = []
  const added = new Map<string, number>()
  for (const raw of list(d.pool_history, 400)) {
    const h = obj(raw)
    const at = dayOf(h?.date)
    if (!h || at === null) continue
    const total = num(h.total)
    if (total !== null) poolGrowth.push([at, total])
    for (const c of counts(h.added_by_source)) added.set(c.id, (added.get(c.id) ?? 0) + c.n)
  }
  poolGrowth.sort((a, b) => a[0] - b[0])
  return {
    poolGrowth,
    poolAdded: [...added].map(([id, n]) => ({ id, n })).sort((a, b) => b.n - a.n),
    pool: pool ? { updatedAt: time(pool.updated_at), rowsTotal: num(pool.rows_total), derivedRows: num(pool.max_derived_rows), bySource: counts(pool.rows_by_source) } : null,
    tasksets,
    dataset: ds
      ? {
          name: slug(ds.name),
          round: slug(ds.round),
          builtAt: time(ds.built_at),
          trainRows: num(ds.train_rows),
          valRows: num(ds.val_rows),
          toolCallShare: num(ds.tool_call_share),
          tokensP50: num(ds.tokens_p50),
          tokensP90: num(ds.tokens_p90),
          perSeedCap: num(ds.per_seed_cap),
          seedsOverCap: num(ds.seeds_over_cap),
          bySource: counts(ds.by_source),
          byArea: counts(ds.by_area),
          byCategory: counts(ds.by_category),
          parts
        }
      : null,
    history
  }
}

function parseGenWindow(v: unknown): GymGenWindow | null {
  const w = obj(v)
  return w ? { hours: num(w.hours), rows: num(w.rows), rowsPerHour: num(w.rows_per_hour), keepRate: num(w.keep_rate), byTeacherPerHour: counts(w.by_teacher_per_hour) } : null
}
function parseGeneration(v: unknown): GymGeneration | null {
  const g = obj(v)
  if (!g) return null
  const activeRuns: GymGeneration['activeRuns'] = []
  for (const raw of list(g.active_runs, 20)) {
    const r = obj(raw)
    const teacher = slug(r?.teacher)
    if (r && teacher !== null) activeRuns.push({ teacher, taskset: slug(r.taskset), tasksDone: num(r.tasks_done), tasksTotal: num(r.tasks_total), rows: num(r.rows), tasksPerHour: num(r.tasks_per_hour) })
  }
  const j = obj(g.judge_24h)
  return { last24h: parseGenWindow(g.last_24h), sinceRoundStart: parseGenWindow(g.since_round_start), activeRuns, judge24h: j ? { calls: num(j.calls), pass: num(j.pass), fail: num(j.fail) } : null }
}

function parseUsage(v: unknown): GymUsage | null {
  const u = obj(v)
  if (!u) return null
  return { attempts: num(u.attempts), ok: num(u.ok), inputTokens: num(u.input_tokens), cachedInputTokens: num(u.cached_input_tokens), outputTokens: num(u.output_tokens), errors: counts(u.errors).reduce((n, e) => n + e.n, 0) }
}
function parseTokenPlan(v: unknown): GymTokenPlan | null {
  const t = obj(v)
  if (!t) return null
  const c = obj(t.concurrency)
  return { state: slug(t.state) ?? 'unknown', since: time(t.since), usage24h: parseUsage(t.usage_24h), usage7d: parseUsage(t.usage_7d), concurrency: c ? { limit: num(c.limit), max: num(c.max) } : null }
}

/** The hosts the schema lists, in the order the panel draws them. Nothing else under `hosts` is a host. */
export const GYM_HOSTS = ['train_host', 'serve_host'] as const

function parseServices(v: unknown): GymService[] {
  const out: GymService[] = []
  for (const raw of list(v, 20)) {
    const sv = obj(raw)
    const id = slug(sv?.id)
    if (!sv || id === null) continue
    const state = oneOf<GymServiceState>(sv.state, ['up', 'degraded', 'down', 'unknown'], 'unknown')
    // Planned only when the gym says exactly `true` of something that is not up: a missing flag, a string, or a service that
    // is up is never planned, so a real outage is never drawn as an expected one.
    const planned = (state === 'down' || state === 'degraded') && sv.planned === true
    out.push({ id, state, planned, reason: state === 'up' ? null : slug(sv.reason), until: planned ? time(sv.until) : null })
  }
  return out
}

function parseHosts(v: unknown): GymHost[] {
  const all = obj(v) ?? {}
  const out: GymHost[] = []
  for (const id of GYM_HOSTS) {
    const h = obj(all[id])
    if (!h) continue
    const w = obj(h.window)
    const window = w ? { open: w.open === true, mode: slug(w.mode), job: slug(w.job), openedAt: time(w.opened_at), endsAt: time(w.ends_at), deadmanAt: time(w.deadman_at), noSwapsFlag: bool(w.no_swaps_flag) } : null
    const biz = obj(h.business)
    const disk: GymHost['disk'] = []
    for (const rawD of list(h.disk, 8)) {
      const d = obj(rawD)
      const mount = slug(d?.mount)
      if (d && mount !== null) disk.push({ mount, freeGib: num(d.free_gib), totalGib: num(d.total_gib) })
    }
    const g = obj(h.gpu)
    const wd = obj(h.watchdog)
    out.push({
      id,
      reachable: bool(h.reachable),
      bootAt: time(h.boot_at),
      bootExplained: bool(h.boot_explained),
      disk,
      gpu: g ? { tempC: num(g.temp_c), powerW: num(g.power_w), powerLimitW: num(g.power_limit_w), utilPct: num(g.util_pct), vramUsedMib: num(g.vram_used_mib), vramTotalMib: num(g.vram_total_mib), at: time(g.at) } : null,
      gpuTemp: series(h.gpu_history_24h, 'at', 'temp_c', true, 600),
      gpuPower: series(h.gpu_history_24h, 'at', 'power_w', true, 600),
      failedUnits: num(h.failed_units),
      gpuRole: slug(h.gpu_role),
      window,
      services: parseServices(h.services),
      lastRestoreAt: time(biz?.last_restore_at),
      lastRestoreOk: bool(biz?.last_restore_ok),
      watchdog: wd ? { lastCheck: time(wd.last_check), lastOk: bool(wd.last_ok), consecutiveFails: num(wd.consecutive_fails) } : null
    })
  }
  return out
}

function parseLastNight(v: unknown): GymLastNight | null {
  const l = obj(v)
  if (!l) return null
  const windows: GymLastNight['windows'] = []
  for (const raw of list(l.windows, 12)) {
    const w = obj(raw)
    if (w) windows.push({ host: slug(w.host), openedAt: time(w.opened_at), closedAt: time(w.closed_at), restoreOk: bool(w.restore_ok) })
  }
  const t = obj(l.teacher)
  const tr = obj(l.training)
  const g = obj(l.gpu_train_host)
  const nightWatchHosts: GymLastNight['nightWatchHosts'] = []
  for (const raw of list(l.night_watch_hosts, 4)) {
    const n = obj(raw)
    const host = slug(n?.host)
    if (n && host !== null) nightWatchHosts.push({ host, result: slug(n.result) ?? 'unknown', steps: num(n.steps), problems: num(n.problems), checkedAt: time(n.checked_at) })
  }
  return {
    date: typeof l.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(l.date) ? l.date : null,
    windows,
    teacher: t ? { tasks: num(t.tasks), kept: num(t.kept), rows: num(t.rows) } : null,
    training: tr ? { stepFrom: num(tr.step_from), stepTo: num(tr.step_to) } : null,
    gpu: g ? { maxTempC: num(g.max_temp_c), maxPowerW: num(g.max_power_w) } : null,
    nightWatch: slug(l.night_watch) ?? 'unknown',
    nightWatchHosts,
    alerts: num(l.alerts)
  }
}

/** A status document as the panel draws it, or null when it is not one (wrong schema, no time). A section the gym could not
 *  build is null or empty, as it sends it; a string that is not an identifier is dropped, with whatever row needed it. */
export function parseGymStatus(json: unknown): GymStatus | null {
  const d = obj(json)
  if (!d || d.schema !== GYM_SCHEMA) return null
  const generatedAt = time(d.generated_at)
  if (generatedAt === null) return null
  const sources: GymSource[] = []
  for (const raw of list(obj(d.service)?.sources, 60)) {
    const s = obj(raw)
    const id = slug(s?.id)
    if (s && id !== null) sources.push({ id, host: slug(s.host), ok: s.ok === true, ageS: num(s.age_s), error: slug(s.error) })
  }
  const schedule: GymStatus['schedule'] = []
  for (const raw of list(d.schedule, 50)) {
    const e = obj(raw)
    const at = time(e?.at)
    const kind = slug(e?.kind)
    if (e && at !== null && kind !== null) schedule.push({ at, kind, host: slug(e.host) })
  }
  schedule.sort((a, b) => a.at - b.at)
  const alerts: GymAlert[] = []
  for (const raw of list(d.alerts, 50)) {
    const a = obj(raw)
    const kind = slug(a?.kind)
    if (a && kind !== null) alerts.push({ kind, host: slug(a.host), since: time(a.since), severity: oneOf<GymSeverity>(a.severity, ['info', 'warn', 'critical'], 'warn'), count: num(a.count), service: slug(a.service) })
  }
  const rank: Record<GymSeverity, number> = { critical: 0, warn: 1, info: 2 }
  alerts.sort((a, b) => rank[a.severity] - rank[b.severity] || (b.since ?? 0) - (a.since ?? 0))
  const timeline: GymEvent[] = []
  for (const raw of list(d.timeline, 500)) {
    const e = obj(raw)
    const at = time(e?.at)
    const kind = slug(e?.kind)
    if (e && at !== null && kind !== null) timeline.push({ at, kind, host: slug(e.host), round: slug(e.round), value: num(e.value), ok: bool(e.ok) })
  }
  timeline.sort((a, b) => b.at - a.at)
  return {
    generatedAt,
    sources,
    round: parseRound(d.round),
    training: parseTraining(d.training),
    postTrain: parsePostTrain(d.post_train),
    scorecards: parseScorecards(d.scorecards),
    data: parseData(d.data),
    generation: parseGeneration(d.generation),
    tokenPlan: parseTokenPlan(d.token_plan),
    hosts: parseHosts(d.hosts),
    schedule,
    lastNight: parseLastNight(d.last_night),
    alerts,
    timeline
  }
}

// ── words ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// Beacon's words for the identifiers the schema lists. One it doesn't know (a new enum value, a run's or a source's name) is
// shown as the identifier itself, spaced: honest, and it cannot be a sentence somebody else wrote.
const WORDS: Record<string, string> = {
  unknown: 'Not reported',
  // the two computers, and what runs on them (no names are served: these are Beacon's words)
  train_host: 'Training computer',
  serve_host: 'Serving computer',
  business_model: 'Business model',
  tunnel: 'Tunnel',
  reference_model: 'Reference model',
  daemon: 'Prometheus',
  voice: 'Voice',
  // round phase, decision
  data: 'Gathering data',
  building: 'Building the dataset',
  training: 'Training',
  post_train: 'After-training checks',
  gating: 'Running the gate',
  decided: 'Decided',
  closed: 'Closed',
  idle: 'Idle',
  pending: 'Not decided yet',
  pass: 'Pass',
  shadow: 'Shadow mode',
  fail: 'Fail',
  promoted: 'Promoted',
  rejected: 'Rejected',
  // training and post-train status
  not_started: 'Not started',
  running: 'Running',
  paused: 'Paused between windows',
  done: 'Done',
  failed: 'Failed',
  stopped: 'Stopped',
  waiting: 'Waiting',
  not_armed: 'Not armed',
  completed: 'Completed',
  skipped: 'Skipped',
  // gate criteria and comparisons
  tool_task_success: 'Tool-call task success',
  longctx_32k: 'Long-context recall, 32k',
  longctx_64k: 'Long-context recall, 64k',
  longctx_128k: 'Long-context recall, 128k',
  longctx_256k: 'Long-context recall, 256k',
  longctx_pooled: 'Long-context recall, pooled',
  injection_resistance: 'Injection resistance',
  owner_follow: 'Following the owner’s instructions',
  sanity: 'Sanity score',
  underpowered: 'Too few samples to say',
  info: 'For information',
  same_recipe_base: 'against the base model, same recipe',
  base9b_pinned: 'against the pinned base model',
  pinned_majority: 'against the pinned baseline, best of three',
  // token plan
  ok: 'OK',
  // windows
  nightly: 'Nightly',
  continuous: 'Continuous',
  teacher: 'Teacher',
  train: 'Training',
  self_replay: 'Self-replay',
  none: 'None',
  eval: 'Evaluation',
  // schedule
  serve_window_start: 'Serving computer’s window opens',
  serve_window_end: 'Serving computer’s window closes',
  teacher_night: 'Teacher night starts',
  teacher_end: 'Teacher night ends',
  train_window_start: 'Training window opens',
  train_window_end: 'Training window closes',
  cont_runner_stop: 'The runner checkpoints and stops',
  cont_end: 'Continuous window ends',
  deadman: 'Dead-man switch',
  heartbeat: 'Morning heartbeat',
  night_watch_arm: 'Night watch arms',
  night_watch_check: 'Night watch checks',
  rearm_nightly: 'Nightly windows re-arm',
  train_eta: 'Training expected to finish',
  post_train_eta: 'After-training checks expected to finish',
  // alerts
  train_host_unreachable: 'The training computer can’t be reached',
  business_down_outside_window: 'The business model is down outside a window',
  restore_failed: 'A restore failed',
  no_swaps_flag: 'The no-swaps flag is set',
  failed_units: 'Background jobs have failed',
  unexpected_reboot: 'Restarted unexpectedly',
  token_plan_paused: 'Token plan paused (quota)',
  token_plan_stopped: 'Token plan stopped: needs you',
  disk_low: 'Disk space low',
  night_watch_fail: 'Night watch failed',
  train_stalled: 'Training has stalled',
  post_train_failed: 'After-training checks failed',
  gpu_hot: 'GPU running hot',
  source_stale: 'A source is out of date',
  source_unreadable: 'A source couldn’t be read',
  reference_model_unhealthy: 'The reference model isn’t healthy',
  service_down: 'A service is down unexpectedly',
  // timeline
  window_opened: 'Window opened',
  window_closed: 'Window closed',
  business_down: 'Business model taken down',
  business_restored: 'Business model restored',
  rehearsal_pass: 'Restore rehearsal passed',
  rehearsal_fail: 'Restore rehearsal failed',
  deadman_fired: 'Dead-man switch fired',
  host_boot: 'Restarted',
  train_host_reachable: 'The training computer is reachable again',
  token_plan_ok: 'Token plan OK again',
  train_started: 'Training started',
  train_stopped: 'Training stopped',
  train_resumed: 'Training resumed',
  train_done: 'Training finished',
  train_failed: 'Training failed',
  post_train_started: 'After-training checks started',
  post_train_step_done: 'An after-training step finished',
  post_train_done: 'After-training checks finished',
  gate_result: 'Gate result',
  teacher_night_done: 'Teacher night finished',
  build_done: 'Dataset built',
  night_watch_ok: 'Night watch passed',
  no_swaps_flag_set: 'No-swaps flag set',
  no_swaps_flag_cleared: 'No-swaps flag cleared',
  notify_failed: 'A notification couldn’t be sent',
  // source errors
  missing: 'missing',
  unreadable: 'couldn’t be read',
  ssh_failed: 'the computer couldn’t be reached',
  timeout: 'timed out',
  schema: 'not in the expected shape',
  refused: 'refused'
}
/** A table's own entry, or undefined: never something inherited (`constructor`, `toString`), which an identifier can spell. */
function own<T>(table: Record<string, T>, k: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(table, k) ? table[k] : undefined
}
/** Beacon's words for an identifier it knows; any other is shown exactly as it is, underscores and all, so it reads as the
 *  identifier it is and never as words somebody chose. */
export function codeWords(code: string): string {
  return own(WORDS, code) ?? code
}

/** A disk, by where it is mounted. Its own table: `data` is also a round's phase, and the two must not share words. */
const MOUNT_WORDS: Record<string, string> = { home: 'home', data: 'data', wd_archive: 'archive' }
export function mountWords(mount: string): string {
  return own(MOUNT_WORDS, mount) ?? mount
}

// ── Now: which phase is the live one ────────────────────────────────────────────────────────────────────────────────────────
/** The round phases after training. From one of these on, the live card is the after-training checks, not Training. */
const AFTER_TRAINING = new Set(['post_train', 'gating', 'decided', 'closed'])
export type GymActive = 'training' | 'post_train'
/** Which card leads Now: the after-training checks once the round is past training (and the gym reports them), else Training. */
export function activePhase(s: Pick<GymStatus, 'round' | 'postTrain'>): GymActive {
  return s.round !== null && AFTER_TRAINING.has(s.round.phase) && s.postTrain !== null ? 'post_train' : 'training'
}

/** Running or stopped, said in words with a mark that is not colour alone. `outcome` is the pipeline's own word, when it has one. */
export function runStatus(status: string, outcome: string | null): { tone: GymTone; mark: string; text: string } {
  switch (status) {
    case 'running':
      return { tone: 'ok', mark: '▸', text: 'Running' }
    case 'done':
      return { tone: 'ok', mark: '✓', text: 'Done' }
    case 'waiting':
      return { tone: 'idle', mark: '·', text: 'Waiting' }
    case 'paused':
      return { tone: 'idle', mark: '·', text: 'Paused between windows' }
    case 'not_started':
      return { tone: 'idle', mark: '·', text: 'Not started' }
    case 'not_armed':
      return { tone: 'idle', mark: '·', text: 'Not armed' }
    case 'stopped':
    case 'failed': {
      // Failed and stopped both read "Stopped"; the pipeline's word for why follows when it adds something.
      const why = outcome ?? (status === 'failed' ? 'failed' : null)
      return { tone: 'err', mark: '■', text: why !== null && why !== 'stopped' ? `Stopped · ${codeWords(why).toLowerCase()}` : 'Stopped' }
    }
    default:
      return { tone: 'idle', mark: '·', text: codeWords(status) }
  }
}

/** True once a pipeline has ended, one way or another. A finished run is working on nothing and is not waiting to be heard from. */
export function runFinished(status: string): boolean {
  return status === 'done' || status === 'stopped' || status === 'failed'
}

/** The candidate a step is for, in words. (null, a step both share or the same-recipe base, is not worded: there is nothing to
 *  say about which candidate, so no row is drawn for it.) */
export function candidateWords(candidate: string): string {
  if (candidate === 'final') return 'the final candidate'
  if (candidate === 'epoch1') return 'the epoch 1 candidate'
  return candidate
}

/** The rows an after-training card shows besides its run status. Running or waiting: what it is on, which candidate, and when it was
 *  last heard from. Finished (done, stopped, failed): none of those, which are about work in flight, and read as something stuck;
 *  instead when it finished (the newest of its state and its log, which for a finished run is when it ended) and how. */
export function postTrainFacts(p: GymPostTrain, now: number): { label: string; text: string }[] {
  const rows: { label: string; text: string }[] = []
  if (!runFinished(p.status)) {
    if (p.currentStep !== null) rows.push({ label: 'Now on', text: p.currentStep })
    if (p.currentCandidate !== null) rows.push({ label: 'Working on', text: candidateWords(p.currentCandidate) })
    rows.push({ label: 'Last heard from', text: p.updatedAt !== null ? fmtAgo(p.updatedAt, now) : 'Not reported' })
  } else {
    if (p.updatedAt !== null) rows.push({ label: 'Finished', text: fmtAgo(p.updatedAt, now) })
    if (p.outcome !== null) rows.push({ label: 'Outcome', text: codeWords(p.outcome) })
  }
  return rows
}

/** One line for a Training card that is finished: how it ended, how many steps, and where validation loss stands. It carries no
 *  "last heard from": a finished card is not waiting to be heard from. */
export function trainingSummary(t: GymTraining, p: GymPostTrain | null): string {
  const word = t.status === 'done' ? 'Training done' : t.status === 'stopped' || t.status === 'failed' ? 'Training stopped' : 'Training'
  const steps = t.step ?? t.total
  const short = (id: string): string => (id === 'final' ? 'val' : id === 'epoch1' ? 'ep1' : id)
  const val = (p?.candidates ?? []).filter((c) => c.valLoss !== null)
  const ordered = [...val.filter((c) => c.id === 'final'), ...val.filter((c) => c.id === 'epoch1'), ...val.filter((c) => c.id !== 'final' && c.id !== 'epoch1')]
  const fromCandidates = ordered.map((c) => `${short(c.id)} ${(c.valLoss as number).toFixed(3)}`)
  const last = t.valLoss.length > 0 ? t.valLoss[t.valLoss.length - 1][1] : null
  const vals = fromCandidates.length > 0 ? fromCandidates.join(' / ') : last !== null ? `val ${last.toFixed(3)}` : null
  return [word, steps !== null ? `${fmtCount(steps)} steps` : null, vals].filter(Boolean).join(' · ')
}

export const NIGHT_WORDS: Record<string, { tone: GymTone; text: string }> = {
  ok: { tone: 'ok', text: 'Night watch passed' },
  fail: { tone: 'err', text: 'Night watch failed' },
  not_armed: { tone: 'idle', text: 'Night watch wasn’t armed' },
  unknown: { tone: 'idle', text: 'Night watch didn’t report' }
}
/** The words for a night-watch result; one Beacon does not know reads as not reported. */
export function nightWords(result: string): { tone: GymTone; text: string } {
  return own(NIGHT_WORDS, result) ?? NIGHT_WORDS.unknown
}
/** Last night in one line: the night watch's own answer, unless a restore failed, which is worse than anything it says. */
export function nightHeadline(n: GymLastNight): { tone: GymTone; text: string } {
  if (n.windows.some((w) => w.restoreOk === false)) return { tone: 'err', text: 'A restore failed last night' }
  return nightWords(n.nightWatch)
}

/** Why a service is not up, in Beacon's words: the planned reasons (a window of the gym's) and the unplanned ones. */
const REASON_WORDS: Record<string, string> = {
  train_window: 'training window',
  post_train_window: 'after-training window',
  teacher_window: 'teacher window',
  self_replay_window: 'self-replay window',
  serve_window: 'serving computer’s window',
  maintenance_window: 'maintenance window',
  not_running: 'not running',
  health_failed: 'failed its health check',
  not_ready: 'not ready',
  not_answering: 'not answering',
  partly_running: 'only partly running'
}
/** One service, in words, with how loudly to say it. A planned stop is said plainly and quietly, with why and until when; a
 *  service that is down and was not meant to be is the loud one. `clock` writes a time. */
export function serviceLine(s: GymService, clock: (at: number) => string): { tone: GymTone; text: string } {
  if (s.state === 'up') return { tone: 'ok', text: 'Up' }
  if (s.state === 'unknown') return { tone: 'idle', text: 'Not reported' }
  const what = s.state === 'down' ? 'Down' : 'Partly working'
  const why = s.reason ? (own(REASON_WORDS, s.reason) ?? codeWords(s.reason)) : null
  if (!s.planned) return { tone: s.state === 'down' ? 'err' : 'warn', text: `${what} unexpectedly${why ? `: ${why}` : ''}` }
  return { tone: 'idle', text: `${what}, as planned${why ? `: ${why}` : ''}${s.until !== null ? ` until ${clock(s.until)}` : ''}` }
}
/** Every service on every host, counted by what matters first: is anything not up that should be. `planned` and `unexpected`
 *  count services that are down or only partly working; `unknown` counts the ones nobody could report on, which are never
 *  counted as up. */
export function servicesSummary(hosts: readonly GymHost[]): { total: number; up: number; planned: number; unexpected: number; unknown: number } {
  const all = hosts.flatMap((h) => h.services)
  const notUp = all.filter((s) => s.state === 'down' || s.state === 'degraded')
  return { total: all.length, up: all.filter((s) => s.state === 'up').length, planned: notUp.filter((s) => s.planned).length, unexpected: notUp.filter((s) => !s.planned).length, unknown: all.filter((s) => s.state === 'unknown').length }
}
/** The services in one line, worst first. Green only when every one is up. */
export function servicesHeadline(hosts: readonly GymHost[]): { tone: GymTone; text: string } | null {
  const v = servicesSummary(hosts)
  if (v.total === 0) return null
  const parts: string[] = []
  if (v.unexpected > 0) parts.push(`${v.unexpected} not up, unexpectedly`)
  if (v.planned > 0) parts.push(`${v.planned} not up, as planned`)
  if (v.unknown > 0) parts.push(`${v.unknown} not reported`)
  if (parts.length === 0) return { tone: 'ok', text: `All ${v.total} up` }
  if (v.unexpected === 0 && v.unknown === 0) parts.push('nothing unexpected')
  return { tone: v.unexpected > 0 ? 'err' : v.unknown > 0 ? 'warn' : 'idle', text: parts.join('; ') }
}

// ── Rounds: which scorecards are on screen ──────────────────────────────────────────────────────────────────────────────────
// The gym serves one scorecard for every round × candidate × quantisation × comparison. Side by side that is dozens of columns,
// so the panel shows one slice at a time, grouped by round. The default slice is the one the gate is decided on: the gate's
// quantisation, against the base model on the same recipe, and each round's kept candidate.
export const GYM_GATE_QUANT = 'q4_k_m'
export const GYM_GATE_VS = 'same_recipe_base'
/** `kept`: each round's kept candidate (the one the gym selected or promoted). `all`: no narrowing. Otherwise an id. */
export interface GymRoundsFilter {
  quant: string
  vs: string
  candidate: string
}
export interface GymRoundGroup {
  round: string
  cards: GymScorecard[]
  /** True when `kept` was asked for and this round has no kept candidate, so all of its candidates are shown instead. */
  noneKept: boolean
}
/** The reference model's column: the schema's own candidate name for it. It has replay counts to read the others against
 *  and is not a candidate. (A real candidate with no criteria read is still a candidate, and keeps its verdict.) */
export const GYM_REFERENCE = 'reference_model'
export const isReferenceCard = (c: GymScorecard): boolean => c.candidate === GYM_REFERENCE
const distinct = (xs: (string | null)[]): string[] => [...new Set(xs.filter((x): x is string => x !== null))].sort()
/** What each filter can be set to, from the scorecards served. */
export function roundsOptions(cards: readonly GymScorecard[]): { quants: string[]; vs: string[]; candidates: string[] } {
  const real = cards.filter((c) => !isReferenceCard(c))
  return { quants: distinct(real.map((c) => c.quant)), vs: distinct(real.map((c) => c.vs)), candidates: distinct(real.map((c) => c.candidate)) }
}
/** The slice to open on: the gate's quantisation and comparison where they are served (otherwise everything), kept candidates. */
export function defaultRoundsFilter(cards: readonly GymScorecard[]): GymRoundsFilter {
  const o = roundsOptions(cards)
  return { quant: o.quants.includes(GYM_GATE_QUANT) ? GYM_GATE_QUANT : 'all', vs: o.vs.includes(GYM_GATE_VS) ? GYM_GATE_VS : 'all', candidate: 'kept' }
}
/** r2 before r10: by the number in the round's id, then by the id. */
function roundOrder(a: string, b: string): number {
  const n = (x: string): number => Number(/\d+/.exec(x)?.[0] ?? Number.NaN)
  return (Number.isNaN(n(a)) ? Infinity : n(a)) - (Number.isNaN(n(b)) ? Infinity : n(b)) || a.localeCompare(b)
}
/** The scorecards a filter leaves, grouped by round in round order. A round that the filter leaves with no candidate is not
 *  shown. The reference model's cards come last as a group of their own, whatever round the gym files them under and
 *  whatever the candidate and comparison filters say (they are what the others are read against); only the quantisation
 *  narrows them. */
export function groupScorecards(cards: readonly GymScorecard[], f: GymRoundsFilter): GymRoundGroup[] {
  const out: GymRoundGroup[] = []
  const candidates = cards.filter((c) => !isReferenceCard(c))
  for (const round of [...new Set(candidates.map((c) => c.round))].sort(roundOrder)) {
    const sliced = candidates.filter((c) => c.round === round && (f.quant === 'all' || c.quant === f.quant) && (f.vs === 'all' || c.vs === f.vs))
    const kept = sliced.filter((c) => c.selected === true || c.promoted === true)
    const noneKept = f.candidate === 'kept' && kept.length === 0 && sliced.length > 0
    const shown = f.candidate === 'all' ? sliced : f.candidate === 'kept' ? (kept.length > 0 ? kept : sliced) : sliced.filter((c) => c.candidate === f.candidate)
    if (shown.length > 0) out.push({ round, cards: shown, noneKept })
  }
  const refs = cards.filter((c) => isReferenceCard(c) && (f.quant === 'all' || c.quant === null || c.quant === f.quant))
  if (out.length > 0 && refs.length > 0) out.push({ round: GYM_REFERENCE, cards: refs, noneKept: false })
  return out
}

/** A gate bar, in words: what the change against the base has to be. */
export function barWords(bar: GymCriterion['bar']): string {
  const p = bar.pts === null ? null : fmtPts(bar.pts, false)
  if (bar.kind === 'min_delta_pts') return p === null ? 'must gain' : `must gain at least ${p}`
  if (bar.kind === 'max_drop_pts') return p === null ? 'must not drop' : bar.pts === 0 ? 'must not drop at all' : `may drop at most ${p}`
  if (bar.kind === 'non_inferior_paired') return 'must not be worse (paired test)'
  if (bar.kind === 'min_value_pts') return p === null ? 'must reach a floor' : `must reach ${p}`
  return 'other'
}
/** Where a bar sits on the change-against-base scale, in points, or null when it is not a point on that scale. */
export function barAt(bar: GymCriterion['bar']): number | null {
  if (bar.pts === null) return null
  return bar.kind === 'min_delta_pts' ? bar.pts : bar.kind === 'max_drop_pts' ? -bar.pts : null
}
/** One scale for a criterion across every scorecard beside it, so the same change sits at the same place in each column: it
 *  spans every change, confidence interval and bar in the row, and always holds zero. */
export function deltaDomain(row: readonly (GymCriterion | undefined)[]): { min: number; max: number } {
  const xs = [0]
  for (const c of row) {
    if (!c) continue
    for (const x of [c.deltaPts, c.ciLowPts, c.ciHighPts, barAt(c.bar)]) if (x !== null) xs.push(x)
  }
  const lo = Math.min(...xs)
  const hi = Math.max(...xs)
  const pad = Math.max((hi - lo) * 0.08, 0.5)
  return { min: lo - pad, max: hi + pad }
}
/** A point on a domain, as a percent along the track. */
export function along(x: number, d: { min: number; max: number }): number {
  return d.max > d.min ? Math.min(100, Math.max(0, ((x - d.min) / (d.max - d.min)) * 100)) : 50
}

// ── numbers ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
export function fmtCount(n: number): string {
  return Math.round(n).toLocaleString('en-US')
}
/** A large count, short: 343.2M, 4.4M, 39,966. */
export function fmtBig(n: number): string {
  return Math.abs(n) >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : Math.abs(n) >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : fmtCount(n)
}
export function fmtDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds))
  if (s < 60) return `${s} s`
  const m = Math.round(s / 60)
  if (m < 60) return `${m} min`
  const h = Math.floor(m / 60)
  if (h < 48) return m % 60 === 0 ? `${h} h` : `${h} h ${m % 60} min`
  return `${Math.round(h / 24)} days`
}
export function fmtGib(gib: number): string {
  return gib >= 1024 ? `${(gib / 1024).toFixed(1)} TiB` : gib >= 10 ? `${Math.round(gib)} GiB` : `${gib.toFixed(1)} GiB`
}
/** Points, to one decimal; `signed` writes a change (+7.6, −11.7, with a real minus sign). */
export function fmtPts(n: number, signed = true): string {
  // The sign is the sign of what is WRITTEN: a change that rounds to 0.0 is written "0.0", not "−0.0" or "+0.0".
  const v = Math.abs(n).toFixed(1)
  const zero = Number(v) === 0
  return `${zero ? '' : signed ? (n > 0 ? '+' : '−') : n < 0 ? '−' : ''}${v} pts`
}
export function fmtShare(x: number): string {
  return `${(x * 100).toFixed(x * 100 >= 10 || x === 0 ? 0 : 1)}%`
}
/** How long ago, in words ("just now", "4 min ago", "3 h ago", "2 days ago"). */
export function fmtAgo(at: number, now: number): string {
  const s = Math.max(0, (now - at) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.round(s / 60)} min ago`
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`
  const d = Math.round(s / 86_400)
  return `${d} day${d === 1 ? '' : 's'} ago`
}
/** A status older than this is said to be old, next to its age: the service builds one every minute. */
export const GYM_STALE_MS = 10 * 60_000
export function isStale(status: GymStatus, now: number): boolean {
  return now - status.generatedAt > GYM_STALE_MS
}

/** A share of a whole, as a width in percent, kept on the bar. */
export function share(part: number, whole: number): number {
  return whole > 0 ? Math.min(100, Math.max(0, (part / whole) * 100)) : 0
}

/** Where a line must lift its pen: the indexes that start a new stretch, because the reading before is much further away than
 *  readings usually are (over four times the typical spacing). A GPU is logged only while a window is open; joining the last
 *  reading of one window to the first of the next would draw hours that were never measured. */
export function gapStarts(series: readonly (readonly [number, number])[]): Set<number> {
  const out = new Set<number>()
  if (series.length < 3) return out
  const steps = series.slice(1).map((p, i) => p[0] - series[i][0]).sort((a, b) => a - b)
  const typical = steps[Math.floor(steps.length / 2)]
  if (typical <= 0) return out
  for (let i = 1; i < series.length; i++) if (series[i][0] - series[i - 1][0] > typical * 4) out.add(i)
  return out
}

/** The points of a line chart in a width × height box (y grows downward, as in SVG), with what the y scale ran over. Fewer than
 *  two points: no line. */
export function linePoints(series: readonly (readonly [number, number])[], width: number, height: number, pad = 2): { points: [number, number][]; min: number; max: number } | null {
  if (series.length < 2) return null
  const xs = series.map((p) => p[0])
  const ys = series.map((p) => p[1])
  const x0 = Math.min(...xs)
  const x1 = Math.max(...xs)
  const min = Math.min(...ys)
  const max = Math.max(...ys)
  const sx = x1 > x0 ? (width - 2 * pad) / (x1 - x0) : 0
  const sy = max > min ? (height - 2 * pad) / (max - min) : 0
  return { points: series.map((p) => [pad + (p[0] - x0) * sx, max > min ? height - pad - (p[1] - min) * sy : height / 2]), min, max }
}
