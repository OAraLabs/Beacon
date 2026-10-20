// Read-only daemon DTOs (snake_case — AS THE DAEMON RETURNS THEM, so no per-field mapping) + tiny
// pure display helpers, for the Phase-5b panels (Status / Sessions / Config). Panels fetch via the
// scoped generic window.beacon.daemon.get(path); these types just shape what comes back.

export interface AgentStatusDTO {
  state?: string
  model?: string
  provider?: string
  profile?: string
  uptime_seconds?: number
  /** Every local inference backend the daemon knows and what each was last seen serving — the
   *  registry's cache (Prometheus PR 389). null = the daemon booted without a registry; absent =
   *  an older daemon. Keyed by registry name; "local" is the boot primary. */
  backends?: Record<string, BackendStatusDTO> | null
}

/** One entry of `/api/status.backends` / one row of `GET /api/backends`. */
export interface BackendStatusDTO {
  name?: string
  provider?: string
  base_url?: string
  ok?: boolean
  probed?: boolean
  stale?: boolean
  model?: string | null
  model_path?: string | null
  n_ctx?: number | null
  vision?: boolean | null
  latency_ms?: number | null
  probed_at?: string | null
  error?: string | null
  changed_at?: string | null
  loaded_models?: string[]
  available_models?: string[]
}

export interface ProfileDTO {
  name: string
  description?: string
  is_active?: boolean
}

export interface LcmStateDTO {
  session_id?: string
  total_tokens?: number
  /** Resolved context window. NULL is a real answer — see `limit_source`. */
  limit?: number | null
  /** Where `limit` came from: detected | config | model_override | cloud_default | unknown.
   *  A number without this is not interpretable: 32768 detected from the server and 32768
   *  copied from a config that happens to agree are different facts, and only the first
   *  survives a model swap. */
  limit_source?: string
  /** False when the daemon did NOT run an assembly — the zeros below are then placeholders,
   *  not measurements. Absent on older daemons, which is why callers test `=== false`. */
  assembled?: boolean
  /** Why nothing was assembled (lcm_engine_unwired | context_limit_unknown | assemble_failed). */
  reason?: string
  /** The two halves `total_tokens` is the sum of, when the daemon can vouch for them.
   *  NULL means "no split to draw" — either the daemon predates the fields, or its own
   *  check that fresh + summary === total failed. Never rendered as 0/0: an empty
   *  two-segment bar claims a measured breakdown of nothing. */
  fresh_tokens?: number | null
  summary_tokens?: number | null
  compression_ratio?: number
  fresh_count?: number
  summary_count?: number
}

export interface SentinelDTO {
  state?: string
  last_dream?: number | null
  dream_count?: number
  idle_since?: number | null
  /** Tail of the dream log (GET /api/sentinel) — shape varies; rendered defensively. */
  dream_log_tail?: unknown[]
}

/** One pending skill draft, AS THE DAEMON RETURNS IT (snake_case sidecar). The draft body
 * (the proposed SKILL.md) is fetched separately — GET /api/learning/skill-drafts/{id}. */
export interface SkillDraftDTO {
  draft_id: string
  source?: string
  name?: string | null
  title?: string
  description?: string
  step_count?: number
  parameter_count?: number
  created_at?: string
  provenance?: Record<string, unknown>
}

/** One per-tool telemetry row, extracted defensively from /api/telemetry's tools map (the daemon
 * aggregates by tool; field names vary across versions — pick what exists). Pure. */
export interface ToolStatRow {
  name: string
  calls?: number
  successRate?: number
  avgLatencyMs?: number
}

export function toolStatRows(tools: Record<string, unknown> | undefined): ToolStatRow[] {
  if (!tools) return []
  const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
  return Object.entries(tools).map(([name, raw]) => {
    const s = (raw ?? {}) as Record<string, unknown>
    const calls = num(s.calls) ?? num(s.total_calls) ?? num(s.count) ?? num(s.total)
    let successRate = num(s.success_rate) ?? num(s.overall_success_rate)
    if (successRate === undefined) {
      const ok = num(s.successes) ?? num(s.ok)
      if (ok !== undefined && calls) successRate = ok / calls
    }
    const avgLatencyMs = num(s.avg_latency_ms) ?? num(s.latency_ms) ?? num(s.avg_latency)
    return { name, calls, successRate, avgLatencyMs }
  })
}

/**
 * Guard for the generic daemon GET (window.beacon.daemon.get): only same-origin `/api/` paths, no
 * traversal, no scheme. The main process owns apiBase + token; the renderer only supplies the path,
 * so this keeps the passthrough read-only and same-origin (enforced again in the main handler).
 */
export function isAllowedDaemonPath(path: string): boolean {
  return typeof path === 'string' && path.startsWith('/api/') && !path.includes('..') && !path.includes('://')
}

/** Compact uptime: 3d 4h / 4h 5m / 5m 6s / 6s. */
export function fmtUptime(seconds?: number): string {
  const s = Math.max(0, Math.floor(seconds ?? 0))
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (d > 0) return `${d}d ${h}h`
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m ${s % 60}s`
  return `${s}s`
}

/**
 * Success rate as a whole percent — **floored, never rounded**, and the ONE definition of it.
 *
 * Four call sites computed this independently (tool feed, Mission, two in Config) and a fifth
 * lived outside the app entirely; all five were defensible and they disagreed, which is how
 * 197/200 got reported as both 98% and 99% on the same data in the same hour.
 *
 * Floor, not round, because rounding lets a rate reach a number the data does not support:
 * 199/200 rounds to **100%** and would render "success 100%" beside a visible "err 1". Flooring
 * can only reach 100 when there are genuinely no failures, so the headline number can never be
 * kinder to the agent than its own error count. The half-percent it costs is worth that.
 *
 * null (not 0) when there is nothing to divide — "no calls yet" is not "0% success".
 */
export function successPct(ok: number, total: number): number | null {
  if (!Number.isFinite(ok) || !Number.isFinite(total) || total <= 0) return null
  return Math.max(0, Math.min(100, Math.floor((ok / total) * 100)))
}

/** The same rule for a daemon-supplied 0–1 rate (telemetry's `success_rate`). */
export function ratePct(rate: number | null | undefined): number | null {
  if (typeof rate !== 'number' || !Number.isFinite(rate)) return null
  return Math.max(0, Math.min(100, Math.floor(rate * 100)))
}

/** The tool-call reading for Mission and Config › Telemetry: how many, and how many of them worked. */
export type ToolCallsReading = { kind: 'none' } | { kind: 'calls'; calls: number; pct: number | null }
// No calls is "none": there is no rate to show. Prometheus reports overall_success_rate 0 on a fresh daemon, and it read as a red
// "0% success" next to "0 tool calls" (filming Path B, 0.4.6). Calls made: the count, and the rate as reported (a real 0% stays 0%).
export function toolCallsReading(total: unknown, rate: number | null | undefined): ToolCallsReading {
  const calls = typeof total === 'number' && Number.isFinite(total) ? total : 0
  if (calls <= 0) return { kind: 'none' }
  return { kind: 'calls', calls, pct: ratePct(rate) }
}

/** One threshold set for "is this rate healthy". Was duplicated in two units — 90 and 0.9. */
export function rateColor(pct: number | null): string {
  if (pct === null) return 'var(--c-text-dim)'
  return pct >= 90 ? 'var(--c-ok)' : pct >= 70 ? 'var(--c-warn)' : 'var(--c-err)'
}

/** Context-window fill %, clamped to 0–100 and NaN-safe. */
export function tokenPct(total?: number, limit?: number | null): number {
  if (!limit || limit <= 0) return 0
  return Math.max(0, Math.min(100, Math.round(((total ?? 0) / limit) * 100)))
}

/** Context-window usage, with "we don't know" as a FIRST-CLASS answer.
 *
 *  `tokenPct` returns 0 for a missing limit, which renders as an empty bar — indistinguishable
 *  from "plenty of headroom" when the truth is "no window could be resolved". The daemon was
 *  taught not to fabricate a denominator (it now answers `limit: null, limit_source: "unknown"`);
 *  reintroducing the fabrication in the client would undo that one layer up.
 *
 *  Two distinct ways a reading is not real, and both must fall through to `unknown`:
 *    - `limit` absent/zero      → no denominator
 *    - `assembled === false`    → the daemon skipped assembly, so `total_tokens` is a placeholder
 *                                 rather than a measurement. `=== false` (not falsy) so an older
 *                                 daemon that omits the field is still treated as measured. */
/** The measured breakdown, when the daemon publishes one that reconstructs the total.
 *  `segments` is null for an unsegmented fill — NOT an array of zeros, which would draw
 *  as "all free space" on a context that may be full. */
export interface ContextSegments {
  /** Uncompacted tail messages. */
  freshPct: number
  /** Compacted summary nodes. */
  summaryPct: number
  freshTokens: number
  summaryTokens: number
}

export type ContextUsage =
  | {
      kind: 'known'
      pct: number
      total: number
      limit: number
      source: string
      segments: ContextSegments | null
    }
  | { kind: 'unknown'; reason: string }

export function contextUsage(lcm?: LcmStateDTO | null): ContextUsage {
  if (!lcm) return { kind: 'unknown', reason: 'no reading yet' }
  if (lcm.assembled === false)
    return { kind: 'unknown', reason: lcm.reason ?? 'not measured' }
  const limit = lcm.limit
  if (limit == null || limit <= 0)
    return { kind: 'unknown', reason: lcm.limit_source ?? 'unknown' }
  const total = lcm.total_tokens ?? 0
  return {
    kind: 'known',
    pct: Math.max(0, Math.min(100, Math.round((total / limit) * 100))),
    total,
    limit,
    source: lcm.limit_source ?? 'unknown',
    segments: contextSegments(lcm, limit)
  }
}

/** The fresh/summary split as percentages OF THE WINDOW, or null if not drawable.
 *
 *  Percentages are taken against `limit`, not against `total`, so the two segments occupy
 *  exactly the same width the unsegmented fill would have — the bar shows the split of the
 *  window, and the remainder is real free space.
 *
 *  Refused (null) whenever the numbers cannot be vouched for: either half absent, negative,
 *  or a sum that does not reconstruct the total. The daemon already applies this check, so
 *  this is a second, independent guard — the client draws the picture, so the client should
 *  not need to trust that the server got it right. */
/** Would both segments actually be VISIBLE in a track this wide?
 *
 *  A segment narrower than a pixel is painted as nothing, so a bar drawn from a real split can
 *  claim a composition it does not show: on the 58px rail, 373 fresh tokens in a 32768 window is
 *  0.66px — the segment silently disappears and the bar reads as all-summarised.
 *
 *  Flooring the thin segment to a visible minimum was the obvious fix and is worse. At this size
 *  the used portion is 3.9px total, so a 2px floor renders a true 83/17 split as 51/49 — a
 *  precise-looking picture of the wrong proportion. Bounded, disclosed in a tooltip nobody
 *  hovers, and still false.
 *
 *  So segmentation is used only where it is faithful. Below that the caller draws one
 *  unsegmented fill — which is not a loss: the breakdown is in the tooltip, and StatusPanel's
 *  bar is wide enough to segment honestly (both parts clear 3px there). The rail is the glance;
 *  Status is the detail.
 *
 *  @param trackPx  the drawable width the caller has, in CSS px.
 *  @param minPx    smallest segment that reliably paints. 1.5px, not 1: sub-pixel antialiasing
 *                  turns a 1px sliver into a barely-there tint on fractional-DPR displays. */
export function segmentsAreLegible(
  segments: ContextSegments,
  trackPx: number,
  minPx = 1.5
): boolean {
  const widths = [segments.summaryPct, segments.freshPct]
    .filter((pct) => pct > 0) // a genuinely absent half is not an invisible one
    .map((pct) => (pct / 100) * trackPx)
  return widths.every((w) => w >= minPx)
}

export function contextSegments(lcm: LcmStateDTO, limit: number): ContextSegments | null {
  const fresh = lcm.fresh_tokens
  const summary = lcm.summary_tokens
  if (fresh == null || summary == null) return null
  if (fresh < 0 || summary < 0) return null
  if (fresh + summary !== (lcm.total_tokens ?? 0)) return null
  if (limit <= 0) return null
  const clamp = (n: number): number => Math.max(0, Math.min(100, (n / limit) * 100))
  return {
    freshPct: clamp(fresh),
    summaryPct: clamp(summary),
    freshTokens: fresh,
    summaryTokens: summary
  }
}

/** Compact token count for a 66px rail: 2209 -> "2.2k", 32768 -> "33k", 1000000 -> "1M". */
export function fmtTokens(n: number): string {
  if (n < 1000) return String(n)
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`
  return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 1 : 0)}M`
}

/** Coerce an unknown daemon payload to an array — defends panels against a wrong-shape or stale
 * (mid-tab-switch) payload so a non-array never reaches `.map` and white-screens the view. */
export function asList<T>(data: unknown): T[] {
  return Array.isArray(data) ? (data as T[]) : []
}

// ── Auth / error classification (connection settings + fail-loud-on-401) ─────────

/** Pull an HTTP status out of a daemon error message. The REST helpers throw `HTTP <status>: …`, and
 * Electron IPC preserves the message text through its own wrapping, so this also works in the renderer.
 * Returns null when the error carries no HTTP status (a path-guard rejection, a network drop, etc.). */
export function httpStatusFromError(err: unknown): number | null {
  const msg = err instanceof Error ? err.message : String(err)
  const m = msg.match(/HTTP (\d{3})/)
  return m ? Number(m[1]) : null
}

/** True when a daemon read failed with 401 — the bearer token is missing/rejected, NOT "no data".
 * Drives the panels' distinct "Not authorized" state instead of a misleading empty result.
 * A not_a_person 401 is not one: the key was accepted, and the refusal is about who is asking. */
export function isAuthError(err: unknown): boolean {
  return httpStatusFromError(err) === 401 && !isNotAPerson(err)
}

/**
 * The daemon's stable refusal code in a response body: its `code`, or an `error` that is itself a code (`not_a_person`), else null.
 * Read from the WHOLE body: the thrown errors carry it cut to 200 characters, and a refusal can put its code after a long sentence
 * (Prometheus #744 puts it at about character 180). A REST helper that needs the code puts it in the message as `HTTP <status>
 * [<code>]: …`, which httpStatusFromError still reads.
 */
export function refusalCode(body: string): string | null {
  const isCode = (v: unknown): v is string => typeof v === 'string' && /^[a-z][a-z0-9_]*$/.test(v)
  try {
    const parsed: unknown = JSON.parse(body)
    if (!parsed || typeof parsed !== 'object') return null
    const { code, error } = parsed as { code?: unknown; error?: unknown }
    return isCode(code) ? code : isCode(error) ? error : null
  } catch {
    return null
  }
}

/** A 401 not_a_person (Prometheus #744): the credential was accepted, but it is not a person's, so it may not approve this. */
export function isNotAPerson(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return /HTTP 401 \[not_a_person\]:/.test(msg)
}

/**
 * The daemon's OWN sentence out of a thrown REST error, or null when there isn't one.
 *
 * WHY: several daemon refusals are already written as user-facing prose — the session-workspace
 * validator's five are the case this was added for ("the filesystem root cannot be a workspace",
 * "<p> is under denied path <d>"). Re-wording them in the client produces two vocabularies for one
 * rule and a client copy that goes stale the moment the daemon's does not. Render the daemon's.
 *
 * The REST helpers throw `HTTP <status>: <METHOD> <path> — <body>`, so the body is whatever follows
 * the first ` — `. Two ways this legitimately yields null, and BOTH must fall back to showing the
 * raw error rather than swallowing it:
 *   * the body is not JSON, or is JSON without a string `error`;
 *   * the body was TRUNCATED. `safeText` slices the response to 200 chars, so a long
 *     "<resolved> is under denied path <denied>" can arrive as invalid JSON. Half a sentence
 *     presented as the daemon's refusal is worse than the raw text, because it reads complete.
 */
export function daemonErrorSentence(err: unknown): string | null {
  const msg = err instanceof Error ? err.message : String(err)
  const i = msg.indexOf(' — ')
  if (i < 0) return null
  const body = msg.slice(i + 3).trim()
  if (!body) return null
  try {
    const parsed: unknown = JSON.parse(body)
    if (!parsed || typeof parsed !== 'object') return null
    const e = (parsed as { error?: unknown }).error
    return typeof e === 'string' && e.trim() ? e.trim() : null
  } catch {
    return null
  }
}

/** Decide the bearer token to persist from a Connection-Settings submission. Pure — the keychain write
 * is the caller's side effect. `clearToken` wins; a non-empty new token replaces; an empty field keeps
 * the current token (so the existing secret never has to be sent to the renderer just to preserve it). */
export function nextToken(current: string | null, form: { token?: string; clearToken?: boolean }): string | null {
  if (form.clearToken) return null
  const t = (form.token ?? '').trim()
  return t ? t : current
}

/** Human label for the Connection-Settings post-save re-test (GET /api/status). Pure. */
export function connectionTestLabel(ok: boolean, code: number | null): string {
  if (ok) return 'Connected ✓'
  if (code === 401) return '401 — token rejected'
  if (code) return `Gateway error (HTTP ${code})`
  return 'Could not reach the gateway'
}

/** Bearer to use for a no-save connection test: a typed token wins; useSavedToken === false means
 * "probe with no token" (previews Clear-token); otherwise fall back to the saved one. Pure. */
export function resolveTestToken(saved: string | null, req: { token?: string; useSavedToken?: boolean }): string | null {
  const typed = (req.token ?? '').trim()
  if (typed) return typed
  if (req.useSavedToken === false) return null
  return saved
}

/** Settings key (legacy): the makeover shipped WS auth as a capability flag while the daemon's
 * :8010 was still open. As of daemon `dbcce28` the WS REQUIRES first-frame auth whenever a token is
 * configured, so the socket always authenticates when a token exists — the flag is no longer a gate
 * (kept only so a stored '1'/'0' value still reads cleanly). */
export const SETTING_WS_AUTH = 'capability:ws-auth'

/** WS close code the daemon uses for an unauthenticated / failed-auth socket (mirrors HTTP 401).
 * The client keys its auth-failure UX off this exact code — a non-4401 close is a normal drop. */
export const WS_CLOSE_UNAUTHORIZED = 4401

/** The WS first-frame auth message. Token is TOP-LEVEL (not nested under payload) — that is the
 * shape the daemon validates (`msg["token"]`, ws_server.py). Sent once, immediately after open,
 * BEFORE any other frame. Pure. */
export function wsAuthFrame(token: string): { type: 'auth'; token: string } {
  return { type: 'auth', token }
}

/**
 * The capabilities this client declares on its subscribe frame. Sent right after auth so the daemon
 * knows what it may push. `computer-thumbnails` is the gate for per-step desktop thumbnails
 * (Prometheus#701, ws_server `_thumbnail_eligible` condition 3): a socket that does not declare it
 * NEVER receives a `computer_step_thumbnail`, because an old client renders an unknown frame kind's
 * whole payload into its exportable Activity feed — a picture of a desktop in a file a person can
 * copy off the machine. Declaring it is the client saying "I have a decoder and a render path for
 * this, and I will not leak it".
 *
 * A list, not a boolean: the daemon replaces the whole set on each subscribe, so this is the client's
 * complete declaration. Adding a capability here is additive and safe; an old daemon ignores a
 * capability it does not know.
 */
export const WS_CLIENT_CAPABILITIES: readonly string[] = ['computer-thumbnails']

/** The subscribe frame: declares this client's capabilities. No session filter (the firehose), which
 *  is what every client does today — this only adds the capability declaration the daemon reads. */
export function wsSubscribeFrame(capabilities: readonly string[] = WS_CLIENT_CAPABILITIES): {
  type: 'subscribe'; payload: { capabilities: string[] }
} {
  return { type: 'subscribe', payload: { capabilities: [...capabilities] } }
}

/** Collapse a ConnectionStatus into what the global NavRail indicator renders: a short state word
 * + whether the bearer is being rejected. A bad token shows up as REST 401 (`restAuth`) AND/OR a WS
 * 4401 (`wsAuth`); EITHER means the token is rejected, so the one indicator covers both transports.
 * Pure — typed structurally so it needs no import from ipc.ts. */
/**
 * The host chip's label (screen 1: `Local | 24ms`, with the address in the tooltip).
 *
 * The design's "Local" is a NAME; all the renderer is given is `host:port`. So: loopback reads
 * "Local", a named host gives its first label, and a bare IP gives the address without the port.
 * Never an invented name — the full value stays in the chip's title either way.
 */
/** The host part of a gateway, without scheme or port. '' when there is no gateway. */
function bareHost(gateway: string | null | undefined): string {
  const hostPort = (gateway ?? '').replace(/^\w+:\/\//, '').trim()
  return hostPort.split(':')[0] ?? ''
}

/**
 * Is this address a machine on the user's OWN network rather than someone's cloud?
 *
 * Loopback, RFC1918, and the 100.64/10 carrier-grade range — which is what a Tailscale tailnet
 * uses. A box on your tailnet is your infrastructure in every sense that matters here: you own
 * it, it is not a provider, and it is what this app already calls `local` when the model chip
 * says `local · qwen2.5-32b`. A PUBLIC address is deliberately excluded, because calling a
 * provider's endpoint "Local" would be false.
 */
export function isPrivateHost(host: string): boolean {
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return true
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (!m) return false
  const [a, b] = [Number(m[1]), Number(m[2])]
  if (a === 10 || a === 127) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 100 && b >= 64 && b <= 127) return true // CGNAT — a Tailscale tailnet lives here
  return false
}

/**
 * The header chip's label — a NAME you can read at a glance, never a truncated address.
 *
 * It used to return the raw IP for a bare address, which the 26px chip then clipped to
 * `100.104.1…`: the worst of both, neither readable nor usable. The full address was always in
 * the tooltip, so the chip's job is the short human answer to "which box am I talking to".
 * A private address is `Local`; a named host gives its first label; a PUBLIC address keeps its
 * number, because there "Local" would be a lie and the number is the only true short answer.
 */
export function hostShortName(gateway: string | null | undefined): string {
  const host = bareHost(gateway)
  if (!host) return 'No gateway'
  if (isPrivateHost(host)) return 'Local'
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) ? host : host.split('.')[0]
}

/**
 * The host's NAME, for the thread subtitle's `Prometheus · NOX host · 24 msgs`.
 *
 * Distinct from `hostShortName`, which is an IDENTITY for the header chip and falls back to the
 * raw address. This one returns a name or nothing: `Local` for loopback, the first DNS label for
 * a named host (`nox` from a fully-qualified tailnet name), and **null for a bare IP** — because the
 * subtitle is the one place the spec says the address must not appear. Nineteen characters of
 * Tailscale IP in the most prominent line is exactly what putting the IP in the tooltip was
 * meant to fix, so a nameless host drops the clause instead of printing the number.
 */
export function hostDisplayName(gateway: string | null | undefined): string | null {
  const host = bareHost(gateway)
  if (!host) return null
  // A private address HAS a name now — `Local` — so the subtitle reads `Prometheus · Local host`
  // instead of dropping the clause. A public bare IP still has none: the rule that keeps 19
  // characters of address out of the most prominent line has not changed.
  if (isPrivateHost(host)) return 'Local'
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return null
  const label = host.split('.')[0]
  return label ? label.toUpperCase() : null
}

export function connIndicatorView(s: {
  state: string
  attempt?: number
  restAuth?: string
  wsAuth?: string
}): {
  short: string
  authBad: boolean
} {
  const short =
    s.state === 'connected'
      ? 'Online'
      : s.state === 'connecting'
        ? 'Linking'
        : s.state === 'reconnecting'
          ? `Retry ${s.attempt ?? 1}`
          : s.state === 'failed'
            ? 'Offline'
            : 'Idle'
  return { short, authBad: s.restAuth === 'unauthorized' || s.wsAuth === 'unauthorized' }
}

// ── Config panel (read-only tabs) ──────────────────────────────────────────────

export interface SkillDTO {
  name: string
  description?: string
  source?: string
}

/** Auto-skill state from GET /api/skills/list (richer than /api/skills) — drives the pin toggle. Only
 * auto-skills (GEPA/SkillCreator output) appear here; manual skills are not pinnable. */
export interface SkillListDTO {
  name: string
  pinned?: boolean
  state?: string
  first_seen_at?: number
  last_modified?: number
  size_bytes?: number
  notes?: string
}

/** A skill row as the Config→Skills tab renders it: the base /api/skills entry decorated with pin
 * state. `pinnable` is true iff the daemon's /api/skills/list has an entry (auto-skills only). */
export interface MergedSkill {
  name: string
  description?: string
  source?: string
  pinned?: boolean
  state?: string
  pinnable: boolean
}

/** Merge the /api/skills base list with the /api/skills/list pin-state map (keyed by name). Auto-skills
 * present only in the pin map are appended with source 'auto'. Pure — drives Config→Skills + its smoke. */
export function mergeSkillPins(base: SkillDTO[], pins: Record<string, { pinned: boolean; state?: string }>): MergedSkill[] {
  const baseNames = new Set(base.map((s) => s.name))
  const merged: MergedSkill[] = base.map((s) => {
    const p = pins[s.name]
    return { name: s.name, description: s.description, source: s.source, pinned: p?.pinned, state: p?.state, pinnable: p !== undefined }
  })
  for (const name of Object.keys(pins)) {
    if (!baseNames.has(name)) merged.push({ name, source: 'auto', pinned: pins[name].pinned, state: pins[name].state, pinnable: true })
  }
  return merged
}
export interface TelemetryDTO {
  total_calls?: number
  overall_success_rate?: number
  tools?: Record<string, unknown>
}
export interface ConfigDTO {
  raw_yaml?: string
  parsed?: unknown
}
export interface WikiStatsDTO {
  page_count?: number
  entity_counts?: Record<string, number>
  last_compiled?: number | null
}
export interface MemorySnapshotDTO {
  entries?: string[]
  char_count?: number
  char_limit?: number
  entry_count?: number
  content?: string
}
export interface MemoryDTO {
  memory?: MemorySnapshotDTO | null
  user?: MemorySnapshotDTO | null
  error?: string
}

export interface ConfigTab {
  id: string
  label: string
  path: string
}

/** The Config view's tabs (each seeded by a GET against a daemon endpoint). Shared so the smoke can
 * assert every tab path is an allowed daemon path. */
export const CONFIG_TABS: ConfigTab[] = [
  // Models first — the friendliest tab (per-provider API keys + models overview).
  { id: 'models', label: 'Models', path: '/api/providers/keys' },
  // Connectors (PARITY-PLAN B1): the daemon's MCP servers. The endpoint is Prometheus#332 and
  // may not exist yet — the tab owns that state rather than showing a blank pane.
  { id: 'connectors', label: 'Connectors', path: '/api/mcp/servers' },
  { id: 'skills', label: 'Skills', path: '/api/skills' },
  { id: 'telemetry', label: 'Telemetry', path: '/api/telemetry' },
  // Usage sits beside Telemetry because they answer adjacent questions from different tables:
  // Telemetry is tool calls (tool_calls), Usage is tokens and money (subsystem_runs).
  { id: 'usage', label: 'Usage', path: '/api/usage' },
  { id: 'memory', label: 'Memory', path: '/api/memory/current' },
  { id: 'sentinel', label: 'Sentinel', path: '/api/sentinel' },
  { id: 'wiki', label: 'Wiki', path: '/api/wiki/stats' },
  { id: 'cron', label: 'Cron', path: '/api/cron' },
  { id: 'config', label: 'Config', path: '/api/config' },
  { id: 'profiles', label: 'Profiles', path: '/api/profiles' },
  // SPRINT-CONSENT Phase 2 — remembered approval grants, with revoke. A listing that shows what was
  // granted without offering removal is the write-only shape the sprint existed to fix, so the two
  // ship together. Lives as a Config tab rather than a nav view: NAV_VIEWS order/count is a pinned
  // contract (integrations-smoke) and every leaf must sit in exactly one NAV_TREE group, whereas
  // CONFIG_TABS is already the idiom for "a daemon endpoint rendered as a panel" and the scoped
  // daemon.get/daemon.write bridge covers both the read and the DELETE with no new plumbing.
  { id: 'grants', label: 'Grants', path: '/api/approvals/grants' },
  // Devices (2026-09-03): phone/tablet enrolment moved off the rail. You visit it to mint or
  // revoke a token and leave, which is a setting — so it belongs beside Connectors and Grants
  // rather than beside Files. The panel fetches its own rows; this seed GET only proves the
  // endpoint is reachable before the tab paints.
  { id: 'devices', label: 'Devices', path: '/api/devices' },
  // Skin (2026-09-03). The handoff is explicit that the plate label "belongs in Config, not the
  // header of every session" — so the picker lives here now. An EMPTY path means "this tab has no
  // daemon data": the skin is a local setting, and a pointless GET would only invent a way to fail.
  { id: 'skin', label: 'Skin', path: '' }
]

// ── Kanban (Board) — /api/projects + /api/stories (daemon-backed store) ──────────

export type StoryStatus = 'todo' | 'in_progress' | 'blocked' | 'done'
export type StoryPriority = 'low' | 'medium' | 'high'

export interface ProjectDTO {
  id: string
  name: string
  description?: string | null
  color?: string
  created_at?: number
  updated_at?: number
}

export interface StoryDTO {
  id: string
  project_id?: string | null
  story_id: string
  title: string
  description?: string | null
  status: StoryStatus
  priority: StoryPriority
  assigned_agent?: string | null
  blocked_reason?: string | null
  labels: string[]
  position: number
  session_key?: string | null
  dispatched_at?: number | null
  created_at?: number
  updated_at?: number
}

/** The four board columns, in order. */
export const STORY_COLUMNS: { id: StoryStatus; label: string }[] = [
  { id: 'todo', label: 'To Do' },
  { id: 'in_progress', label: 'In Progress' },
  { id: 'blocked', label: 'Blocked' },
  { id: 'done', label: 'Done' }
]

/** Bucket stories into the four board columns (caller's order preserved within each). Pure. */
export function groupStoriesByStatus(stories: StoryDTO[]): Record<StoryStatus, StoryDTO[]> {
  const cols: Record<StoryStatus, StoryDTO[]> = { todo: [], in_progress: [], blocked: [], done: [] }
  for (const s of stories) (cols[s.status] ?? cols.todo).push(s)
  return cols
}

/** Next position when appending a story to a column on drop (max position there + 1, else 0). Pure. */
export function nextStoryPosition(stories: StoryDTO[], status: StoryStatus): number {
  const inCol = stories.filter((s) => s.status === status)
  return inCol.length === 0 ? 0 : Math.max(...inCol.map((s) => s.position)) + 1
}

// ── Cron (Tier 3) — GET /api/cron + POST/PUT/DELETE + run-now ────────────────────

/**
 * A remembered approval grant, as `GET /api/approvals/grants` serves it.
 *
 * Typed from a REAL populated row (daemon fb73b28) rather than from prose — the scaffold this
 * replaces held out for exactly that, after two of this sprint's three shape guesses were wrong.
 * The captured row, verbatim:
 *
 *   {
 *     "kind": "path_prefix",
 *     "value": "/home/demo/beacon-walk/x.txt",
 *     "tool": "write_file",
 *     "scope": "until_restart",
 *     "id": "8e0b86627a49",
 *     "created_at": 1786914535.722956,
 *     "request_id": "1258b42c",
 *     "describes": "write_file on exactly /home/demo/beacon-walk/x.txt — until the daemon restarts"
 *   }
 *
 * ⚠ TWO VOCABULARIES, and they are not the same string. The APPROVE verb on the wire is
 * hyphenated (`until-restart`, `always here`); the STORED scope here is underscored
 * (`until_restart`, `persistent`). Beacon must not map between them — it renders `describes`
 * and passes verbs through untouched. The only place the two meet is the operator's screen.
 */
export interface GrantDTO {
  /** `path_prefix` | `command_prefix` | `tool` — the daemon's grant kinds. Not narrowed to a
   *  union: an unknown kind must render, not vanish, since a grant Beacon cannot name is
   *  precisely the one an operator most needs to see in order to revoke it. */
  kind?: string
  value?: string
  tool?: string
  /** Stored form: `until_restart` | `persistent`. Underscored — see above. */
  scope?: string
  /** Stable identity, minted at creation. The revoke key for DELETE /api/approvals/grants/{id}. */
  id?: string
  /** epoch SECONDS float, same unit as the approval payload's created_at. */
  created_at?: number
  /** Join key back to the approval that created it — the audit trail's join key too. */
  request_id?: string
  /**
   * The daemon's own description of this grant's extent. Rendered VERBATIM.
   *
   * This is the string the consent walk compares against the card's displayed extent. Beacon
   * never re-words it: if it is wrong, the daemon is wrong, and re-wording here would hide the
   * one signal that says so.
   */
  describes?: string
}

/** Is this grant persistent (survives restart, written to config) or until-restart only?
 *  Reads the STORED vocabulary, not the wire verb. Pure. */
export function grantIsPersistent(g: GrantDTO): boolean {
  return g.scope === 'persistent'
}

export interface CronJobDTO {
  name: string
  schedule: string
  command: string
  cwd?: string
  enabled?: boolean
  created_at?: string
  next_run?: string
  last_run?: string
  last_status?: string
}

/** Is the cron create-form submittable? All three fields non-empty + the schedule has the 5 whitespace-
 * separated fields a standard cron expression needs (light client check; the daemon does the full
 * croniter validation and returns 400 on a bad expression). Pure. */
export function cronFormReady(form: { name: string; schedule: string; command: string }): boolean {
  const fields = form.schedule.trim().split(/\s+/).filter(Boolean)
  return form.name.trim().length > 0 && form.command.trim().length > 0 && fields.length === 5
}

/** A cron job's display status (the badge in the Cron tab). Pure. */
export function cronJobStatus(job: CronJobDTO): { label: string; ok: boolean } {
  if (job.enabled === false) return { label: 'disabled', ok: false }
  if (job.last_status === 'failed' || job.last_status === 'timeout' || job.last_status === 'error') {
    return { label: job.last_status, ok: false }
  }
  if (job.last_status === 'success') return { label: 'ok', ok: true }
  return { label: 'scheduled', ok: true }
}

// ── Files panel (Phase 6) — GET /api/files (list) + /api/files/read (preview) ───

export interface FileEntry {
  name: string
  type: 'dir' | 'file'
  size?: number
  mtime?: number
}
export interface FileListDTO {
  path?: string
  entries?: FileEntry[]
}
export interface FileReadDTO {
  path?: string
  size?: number
  truncated?: boolean
  binary?: boolean
  content?: string
}

/** Append a child name to a workspace-relative dir path (root '' → just the name). Pure. */
export function joinFilePath(dir: string, name: string): string {
  return dir ? `${dir}/${name}` : name
}

/** Parent of a workspace-relative path ('' at the root). Pure. */
export function parentFilePath(p: string): string {
  const i = p.lastIndexOf('/')
  return i >= 0 ? p.slice(0, i) : ''
}

/** Breadcrumb trail for a path, rooted at the workspace. Pure. */
export function breadcrumbs(p: string): { name: string; path: string }[] {
  const crumbs = [{ name: 'workspace', path: '' }]
  let acc = ''
  for (const seg of p ? p.split('/') : []) {
    acc = acc ? `${acc}/${seg}` : seg
    crumbs.push({ name: seg, path: acc })
  }
  return crumbs
}

/** Human-readable byte size. Pure. */
export function fmtBytes(n?: number): string {
  const b = n ?? 0
  if (b < 1024) return `${b} B`
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`
  return `${(b / (1024 * 1024)).toFixed(1)} MB`
}
