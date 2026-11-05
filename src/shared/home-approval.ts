// The Home Assistant approval card's logic — pure (no React, no Node), so a smoke can hold it still.
// Contract: docs/HA-UI-DATA-CONTRACT.md §3.1.
//
// BEACON RENDERS, THE DAEMON DECIDES. The `home` object on an approval is the daemon's account of
// which devices a `ha_control_*` call touches, what each reads now and what the call would make it.
// Its wording is shown verbatim and nothing is re-derived here, with two exceptions that both lean
// the same way, toward asking more:
//
//   * a tier Beacon does not recognise, or none, is Sensitive (never Ordinary);
//   * a call is as strict as its strictest device (an "Ordinary" call that lists a Sensitive device
//     is a Sensitive call), so no lasting option is ever offered on the strength of a mislabelled one.
//
// A `home` that cannot be read (no devices, not an object) is dropped, and the approval renders as
// the generic card — which already shows the full description and arguments. Never a half-card.

import { approvalScopes } from './workers'

export type HomeTier = 'ordinary' | 'sensitive' | 'critical'

export interface HomeDevice {
  id: string
  name: string
  room: string | null
  tier: HomeTier
  /** "Ask once" is on for this device: the next approval for it may offer a lasting option. */
  relaxed: boolean
  /** What it reads now, or null when it could not be read. Never guessed. */
  current: string | null
  /** What the call would make it, in the daemon's words; null when the daemon did not say. */
  requested: string | null
  openUrl: string | null
}

export interface HomeApproval {
  /** The tier of THIS call (a thermostat is Ordinary inside its safe range and Sensitive outside it). */
  tier: HomeTier
  tierReason: string | null
  devices: HomeDevice[]
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null)

// ── tools ────────────────────────────────────────────────────────────────────

/** `mcp__{server}__ha_control_ordinary` / `…_sensitive`, whatever the server was registered as. */
export function isHomeToolName(name: string): boolean {
  return /(^|__)ha_control_(ordinary|sensitive)$/.test(name)
}

// ── tiers ────────────────────────────────────────────────────────────────────

const SEVERITY: Record<HomeTier, number> = { ordinary: 0, sensitive: 1, critical: 2 }

/** An unrecognised or missing tier is Sensitive. Exact, lower-case strings only: nothing is trusted loosely. */
export function coerceTier(raw: unknown): HomeTier {
  return raw === 'ordinary' || raw === 'sensitive' || raw === 'critical' ? raw : 'sensitive'
}

export type TierGlyph = 'circle' | 'triangle' | 'lock'

/** A tier is a WORD and a GLYPH before it is a colour: colour alone is never the signal. */
export function tierPresentation(tier: HomeTier): { word: string; glyph: TierGlyph } {
  switch (tier) {
    case 'ordinary': return { word: 'Ordinary', glyph: 'circle' }
    case 'sensitive': return { word: 'Sensitive', glyph: 'triangle' }
    default: return { word: 'Critical', glyph: 'lock' }
  }
}

/** The strictest of the call's tier and its devices'. */
export function effectiveTier(home: HomeApproval): HomeTier {
  return home.devices.reduce<HomeTier>((t, d) => (SEVERITY[d.tier] > SEVERITY[t] ? d.tier : t), home.tier)
}

// ── the wire → HomeApproval ──────────────────────────────────────────────────

function coerceDevice(raw: unknown): HomeDevice | null {
  if (!isObj(raw)) return null
  const id = str(raw.id)
  const name = str(raw.name)
  if (!id || !name) return null
  return {
    id,
    name,
    room: str(raw.room),
    tier: coerceTier(raw.tier),
    relaxed: raw.relaxed === true,
    current: str(raw.current),
    requested: str(raw.requested),
    openUrl: str(raw.open_url)
  }
}

/** The wire's `home` (snake_case) → HomeApproval, or undefined when there is nothing usable (→ the generic card). */
export function coerceHome(raw: unknown): HomeApproval | undefined {
  if (!isObj(raw) || !Array.isArray(raw.devices)) return undefined
  const devices = raw.devices.map(coerceDevice).filter((d): d is HomeDevice => d !== null)
  if (devices.length === 0) return undefined
  return { tier: coerceTier(raw.tier), tierReason: str(raw.tier_reason), devices }
}

// ── the card ─────────────────────────────────────────────────────────────────

/** A list longer than this collapses to this many rows and "and N more". */
export const COLLAPSE_AFTER = 5

export interface HomeRow {
  id: string
  name: string
  room: string | null
  tier: HomeTier
  tierWord: string
  /** "off → on, 60%". An unreadable current state says so; it is never guessed. */
  change: string
  currentUnknown: boolean
}

export interface HomeCardView {
  tier: HomeTier
  tierWord: string
  tierGlyph: TierGlyph
  tierReason: string | null
  title: string
  rows: HomeRow[]
  hiddenCount: number
  moreLabel: string | null
  /** False for a Critical call: Deny is all there is. */
  canApprove: boolean
  /** [verb, the daemon's extent text] — empty unless a lasting option is on offer (see lastingOffered). */
  lasting: [string, string][]
  /** The sentence shown in place of Approve on a Critical call. */
  criticalNote: string | null
}

export const CRITICAL_NOTE =
  "Critical devices can't be controlled from Prometheus, so this request should not have been made. Deny it; to use this device, use Home Assistant."

interface CardSource {
  home?: HomeApproval
  extents?: Record<string, string>
  onceOnly?: boolean
  workerTaskId?: string
}

/**
 * Is a lasting ("Always allow") option on offer? Only when ALL hold: the daemon sent an extent for it,
 * the call is not Critical, and the call is Ordinary, or Sensitive with "Ask once" on for every device.
 * Beacon never offers what the daemon's `extents` does not carry.
 */
function lastingOffered(a: CardSource, tier: HomeTier): [string, string][] {
  if (!a.home || tier === 'critical') return []
  if (tier === 'sensitive' && !a.home.devices.every((d) => d.relaxed)) return []
  return approvalScopes(a)
}

export function homeCardView(a: CardSource, expanded = false): HomeCardView {
  const home = a.home
  if (!home) throw new Error('homeCardView needs an approval that has home')
  const tier = effectiveTier(home)
  const { word, glyph } = tierPresentation(tier)
  const all: HomeRow[] = home.devices.map((d) => ({
    id: d.id,
    name: d.name,
    room: d.room,
    tier: d.tier,
    tierWord: tierPresentation(d.tier).word,
    change: `${d.current ?? 'current state unknown'} → ${d.requested ?? 'requested state not stated'}`,
    currentUnknown: d.current === null
  }))
  const collapse = !expanded && all.length > COLLAPSE_AFTER
  const rows = collapse ? all.slice(0, COLLAPSE_AFTER) : all
  const hiddenCount = all.length - rows.length
  const critical = tier === 'critical'
  return {
    tier,
    tierWord: word,
    tierGlyph: glyph,
    tierReason: home.tierReason,
    title: home.devices.length === 1 ? home.devices[0].name : `${home.devices.length} devices`,
    rows,
    hiddenCount,
    moreLabel: hiddenCount > 0 ? `and ${hiddenCount} more` : null,
    canApprove: !critical,
    lasting: lastingOffered(a, tier),
    criticalNote: critical ? CRITICAL_NOTE : null
  }
}

// ── the result: the server's re-read ─────────────────────────────────────────

export const homeActionPath = (requestId: string): string => `/api/home/actions/${encodeURIComponent(requestId)}`

/** About once a second for up to 20 s after Approve (the server re-reads for ~5 s), then "not yet known". */
export const RESULT_POLL_MS = 1000
export const RESULT_POLL_TRIES = 20

export type ResultKind = 'confirmed' | 'unconfirmed' | 'failed'

export interface HomeResultLine {
  deviceId: string
  name: string
  result: ResultKind
  observed: string | null
  /** The server's own sentence. Shown verbatim. */
  message: string | null
}

export interface HomeActionResult {
  state: 'pending' | 'done'
  results: HomeResultLine[]
}

export function coerceActionResult(raw: unknown): HomeActionResult | undefined {
  if (!isObj(raw)) return undefined
  const lines: HomeResultLine[] = (Array.isArray(raw.results) ? raw.results : []).filter(isObj).map((r) => ({
    deviceId: str(r.device_id) ?? '',
    name: str(r.name) ?? 'Device',
    // A result Beacon does not recognise is never success: it reads as not confirmed.
    result: r.result === 'confirmed' ? 'confirmed' : r.result === 'failed' ? 'failed' : 'unconfirmed',
    observed: str(r.observed),
    message: str(r.message)
  }))
  // Anything but an explicit "done" is still pending: a result is never declared early.
  return { state: raw.state === 'done' ? 'done' : 'pending', results: lines }
}

export type ResultTone = 'pending' | 'success' | 'warning' | 'error'

/** Worst line wins; a finished action with no lines says nothing was confirmed. */
export function resultTone(r: HomeActionResult): ResultTone {
  if (r.state === 'pending') return 'pending'
  if (r.results.some((l) => l.result === 'failed')) return 'error'
  if (r.results.length === 0 || r.results.some((l) => l.result === 'unconfirmed')) return 'warning'
  return 'success'
}

export type ResultGlyph = 'check' | 'warn' | 'cross'

export function resultLineView(l: HomeResultLine): { glyph: ResultGlyph; word: string; text: string } {
  const { glyph, word } =
    l.result === 'confirmed'
      ? { glyph: 'check' as const, word: 'Confirmed' }
      : l.result === 'failed'
        ? { glyph: 'cross' as const, word: 'Failed' }
        : { glyph: 'warn' as const, word: 'Not confirmed' }
  return { glyph, word, text: l.message ?? `${l.name}: ${word.toLowerCase()}` }
}
