// What a local model server's row says: Mission's Models card, Config › Models, the chat model menu (owner decision, 2026-10-18, for 0.4.8).
//
// Prometheus checks a local model's server once at boot (daemon.py probe_all) and calls the reading stale 60 s later
// (backend_probe.ttl_s); nothing re-checks it after that but an explicit probe. Beacon printed that as a status: "Local · default STALE"
// a minute after setup, for good (the film's take at 61 s). And on the Local row the daemon hard-codes available: true, so a server that
// was down read UP, then STALE, never DOWN; the failure was there all along in health.ok.
//
// So: a failed check (health.ok false, or available false) is DOWN, with one plain line; anything else is UP; never asked is "checking".
// Stale says WHEN the reading was taken, not HOW the server is: it is never shown, it only makes a check due (an owner's Beacon asks
// POST /api/backends/<name>/probe, at most every RECHECK_MIN_MS per server), and the time can go in a tooltip.
//
// No Node/Electron imports (same rule as the rest of src/shared).

export type BackendReading = { state: 'up' | 'down' | 'checking'; reason: string | null; checkedAt: string | null }

/** The health fields Prometheus sends (providers/backends.py as_dict, web/server.py _backend_health). */
export interface HealthLike {
  ok?: boolean
  probed?: boolean
  stale?: boolean
  error?: string | null
  probed_at?: string | null
}

export function backendReading(available: boolean | undefined, health: HealthLike | null | undefined): BackendReading {
  const checkedAt = health?.probed_at ?? null
  if (health && health.probed === false) return { state: 'checking', reason: null, checkedAt }
  if (available === false || (health && health.ok === false)) return { state: 'down', reason: plainCheckFailure(health?.error), checkedAt }
  return { state: 'up', reason: null, checkedAt }
}

/** A check again is due: the reading is stale, or was never taken. Nothing to check (no health) is never due. */
export function needsRecheck(health: HealthLike | null | undefined): boolean {
  if (!health) return false
  return health.probed === false || health.stale === true
}

/** The probe's error, as one plain line. The raw text (an exception name and its message) is for a tooltip at most. */
export function plainCheckFailure(error: string | null | undefined): string {
  const e = String(error ?? '')
  if (/timed out|timeout/i.test(e)) return "It didn't answer in time."
  if (/connect|refused|unreachable|resolve|no route|name or service/i.test(e)) return 'Nothing is answering at its address. Is it running?'
  return 'Its last check failed.'
}

/** At most one check per server in this long. */
export const RECHECK_MIN_MS = 30_000
export function recheckDue(last: number | undefined, now: number): boolean {
  return last === undefined || now - last >= RECHECK_MIN_MS
}

/** A row of /api/models, the fields the label needs. */
export interface CatalogRow {
  key: string
  label: string
  provider?: string
  model?: string
  backend?: string | null
}
/** Providers that run on a machine of the owner's (the daemon's LOCAL_PROVIDERS, and the local runtimes it can be pointed at). */
const LOCAL_RUNTIMES = new Set(['llama_cpp', 'ollama', 'lm_studio', 'vllm', 'stub'])

/** What to call the default row. Prometheus labels its primary model "Local" whatever it is (web/server.py _model_catalog), so a Path A
 *  Beacon (Anthropic, nothing local) read "Local · default". A primary on a cloud provider is named by its model instead: the matching
 *  cloud row's own label ("Claude · claude-sonnet-5"), else the model id. A local runtime, or a row without a provider and model, keeps
 *  the daemon's label. */
export function isCloudPrimary(row: Pick<CatalogRow, 'provider' | 'model'>): boolean {
  const provider = (row.provider ?? '').trim().toLowerCase()
  return !!provider && !!row.model?.trim() && !LOCAL_RUNTIMES.has(provider)
}
/** The cloud row for the same provider and model as a cloud primary, if the catalog has one. */
export function cloudTwin<T extends CatalogRow>(row: CatalogRow, all: readonly T[]): T | undefined {
  if (!isCloudPrimary(row)) return undefined
  return all.find((o) => o !== row && !o.backend && o.provider === row.provider && o.model === row.model)
}
export function defaultRowLabel(row: CatalogRow, all: readonly CatalogRow[]): string {
  if (!isCloudPrimary(row)) return row.label
  return cloudTwin(row, all)?.label ?? (row.model as string).trim()
}
