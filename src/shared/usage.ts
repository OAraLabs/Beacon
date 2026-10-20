// Pure usage/cost model — shared by the Config tab and the headless smoke. No DOM.
//
// The daemon half (Prometheus #283) exists because a zero cost had four different meanings and
// one value. `qwen3.8-max` carried 89M input tokens — 57% of everything the box ever spent —
// through a flat Token Plan and rendered as $0.00 for months. This module's one job is to keep
// those four meanings apart on the way to the screen.
//
// THE RULE, and everything else here serves it: a null cost is NEVER rendered as a dollar figure.
// `cost_usd: null` means "no dollar amount applies or is known", which is a different fact from
// `cost_usd: 0` ("metered, and genuinely nothing spent"). A UI that prints $0.00 for both
// recreates the exact defect the endpoint was built to end.

export type BillingMode = 'local' | 'subscription' | 'metered' | 'unknown'

export interface UsageModelRow {
  model: string
  billing: BillingMode
  billingReason: string
  runs: number
  inputTokens: number
  outputTokens: number
  cachedInputTokens: number
  /** null unless billing === 'metered'. Never coerce this to 0. */
  costUsd: number | null
  firstSeen: string | null
  lastSeen: string | null
}

export interface UsageTotals {
  runs: number
  inputTokens: number
  outputTokens: number
  costUsd: number
  /** Input tokens the dollar figure actually accounts for. */
  costCoversInputTokens: number
  /** 0–1. The honest headline: "$19.59 covering 4% of tokens". */
  costCoversShare: number
}

export interface UsageReport {
  trackingSince: string | null
  windowDays: number | null
  totals: UsageTotals
  coverage: Partial<Record<BillingMode, { models: number; inputTokens: number; outputTokens: number }>>
  models: UsageModelRow[]
  daily: { day: string; inputTokens: number; outputTokens: number; runs: number }[]
}

export const EMPTY_USAGE: UsageReport = {
  trackingSince: null,
  windowDays: null,
  totals: { runs: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, costCoversInputTokens: 0, costCoversShare: 0 },
  coverage: {},
  models: [],
  daily: []
}

const num = (v: unknown, d = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : d)
const str = (v: unknown, d = ''): string => (typeof v === 'string' ? v : d)

const MODES: BillingMode[] = ['local', 'subscription', 'metered', 'unknown']
function mode(v: unknown): BillingMode {
  return MODES.includes(v as BillingMode) ? (v as BillingMode) : 'unknown'
}

/**
 * Daemon payload → report. Defensive; a malformed payload yields EMPTY_USAGE rather than throwing.
 *
 * The one place this is deliberately NOT tolerant: `cost_usd` keeps null as null. Coercing a
 * missing number to 0 is the whole bug, so an absent or non-numeric cost stays null and the row
 * renders its reason instead.
 */
export function parseUsage(data: unknown): UsageReport {
  if (!data || typeof data !== 'object') return EMPTY_USAGE
  const d = data as Record<string, unknown>
  const t = (d.totals ?? {}) as Record<string, unknown>
  const rawModels = Array.isArray(d.models) ? d.models : []
  const rawDaily = Array.isArray(d.daily) ? d.daily : []
  const rawCoverage = (d.coverage ?? {}) as Record<string, Record<string, unknown>>

  const coverage: UsageReport['coverage'] = {}
  for (const [k, v] of Object.entries(rawCoverage)) {
    if (!v || typeof v !== 'object') continue
    coverage[mode(k)] = {
      models: num(v.models),
      inputTokens: num(v.input_tokens),
      outputTokens: num(v.output_tokens)
    }
  }

  return {
    trackingSince: typeof d.tracking_since === 'string' ? d.tracking_since : null,
    windowDays: typeof d.window_days === 'number' ? d.window_days : null,
    totals: {
      runs: num(t.runs),
      inputTokens: num(t.input_tokens),
      outputTokens: num(t.output_tokens),
      costUsd: num(t.cost_usd),
      costCoversInputTokens: num(t.cost_covers_input_tokens),
      costCoversShare: num(t.cost_covers_share)
    },
    coverage,
    models: rawModels
      .filter((r): r is Record<string, unknown> => !!r && typeof r === 'object')
      .map((r) => ({
        model: str(r.model),
        billing: mode(r.billing),
        billingReason: str(r.billing_reason),
        runs: num(r.runs),
        inputTokens: num(r.input_tokens),
        outputTokens: num(r.output_tokens),
        cachedInputTokens: num(r.cached_input_tokens),
        // null stays null — see the module note.
        costUsd: typeof r.cost_usd === 'number' && Number.isFinite(r.cost_usd) ? r.cost_usd : null,
        firstSeen: typeof r.first_seen === 'string' ? r.first_seen : null,
        lastSeen: typeof r.last_seen === 'string' ? r.last_seen : null
      })),
    daily: rawDaily
      .filter((r): r is Record<string, unknown> => !!r && typeof r === 'object')
      .map((r) => ({
        day: str(r.day),
        inputTokens: num(r.input_tokens),
        outputTokens: num(r.output_tokens),
        runs: num(r.runs)
      }))
  }
}

/** 89042118 → "89.0M". Token counts are read for magnitude, not for their last digit. */
export function fmtTokens(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '—'
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`
  return String(n)
}

/** Sub-cent costs are real when a model is cheap; below a tenth of a cent, say so rather than $0.00. */
export function fmtUsd(n: number): string {
  if (!Number.isFinite(n)) return '—'
  if (n === 0) return '$0.00'
  if (n < 0.001) return '<$0.001'
  if (n < 1) return `$${n.toFixed(3)}`
  return `$${n.toFixed(2)}`
}

/**
 * What belongs in a row's cost column. THE guard: a null cost never becomes a dollar figure —
 * it becomes the reason there isn't one, so "on a flat plan" and "spent nothing" stay
 * distinguishable at a glance.
 */
export function costCell(row: Pick<UsageModelRow, 'costUsd' | 'billing'>): { text: string; isMoney: boolean } {
  if (row.costUsd === null) {
    return {
      text: row.billing === 'subscription' ? 'on a plan' : row.billing === 'local' ? 'no bill' : 'unpriced',
      isMoney: false
    }
  }
  return { text: fmtUsd(row.costUsd), isMoney: true }
}

export const BILLING_LABEL: Record<BillingMode, string> = {
  local: 'local',
  subscription: 'plan',
  metered: 'metered',
  unknown: 'unknown'
}

/**
 * The headline, phrased so it cannot mislead. A dollar total that silently covers 4% of the
 * traffic is the failure this whole feature exists to prevent, so the share is part of the
 * sentence rather than a detail below it.
 */
export function coverageSentence(totals: UsageTotals): string {
  if (totals.inputTokens === 0) return 'No usage recorded yet.'
  const pct = Math.round(totals.costCoversShare * 100)
  if (pct >= 99) return `${fmtUsd(totals.costUsd)} across ${fmtTokens(totals.inputTokens)} input tokens.`
  return `${fmtUsd(totals.costUsd)} — but that covers only ${pct}% of ${fmtTokens(
    totals.inputTokens
  )} input tokens. The rest ran locally or on a flat plan.`
}

// ── Windows ──────────────────────────────────────────────────────────────────────────────────
// "What did my cloud keys cost this month" was the original question, and an all-time total
// answers a different one: it is interesting once and then static. The daemon already accepts
// ?days=N, so the client half is a selector.
//
// 30 days is the DEFAULT because it is the question that was actually asked. Whether 7 is the
// more useful default is a thing to learn from use rather than to guess now — the selector exists
// so that answer arrives cheaply.

export interface UsageWindow {
  id: string
  label: string
  /** null = all time (no ?days param at all). */
  days: number | null
}

export const USAGE_WINDOWS: UsageWindow[] = [
  { id: '7', label: '7 days', days: 7 },
  { id: '30', label: '30 days', days: 30 },
  { id: 'all', label: 'All time', days: null }
]

export const DEFAULT_USAGE_WINDOW = '30'

/** The endpoint path for a window. All-time sends NO parameter rather than days=0. */
export function usagePath(days: number | null): string {
  return days === null || !Number.isFinite(days) || days <= 0 ? '/api/usage' : `/api/usage?days=${Math.floor(days)}`
}

/**
 * What the window means for the reader. A window shorter than the data is a filter; a window
 * LONGER than the data would silently imply history that does not exist, so it says so instead.
 */
export function windowNote(win: UsageWindow, trackingSince: string | null): string {
  if (win.days === null) return trackingSince ? `All time · since ${trackingSince.slice(0, 10)}` : 'All time'
  if (!trackingSince) return `Last ${win.days} days`
  const startedMs = Date.parse(trackingSince)
  const windowStartMs = Date.now() - win.days * 86_400_000
  if (Number.isFinite(startedMs) && startedMs > windowStartMs) {
    return `Last ${win.days} days — but accounting only starts ${trackingSince.slice(0, 10)}`
  }
  return `Last ${win.days} days`
}
