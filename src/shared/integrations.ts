// Control-surface integrations — pure contracts + logic (no React, no Node).
// Implements the GENERIC side of control-surface-integration-contract-v0.2.md
// (published in the integration provider's docs/): registry entries, manifest
// parsing, the four fixed view types, path guarding, health classification.
// ZERO integration-specific code lives anywhere in Beacon — everything renders
// from manifest data (the smoke grep-guards this file for provider names).
// Anti-overbuild: contract_version pinned at 1; unknown view types surface as
// visible "unsupported" markers, never silently dropped (loud-failure law).

export const SUPPORTED_CONTRACT_VERSION = 1

// ── Registry ────────────────────────────────────────────────────────────

/** One config-file-declared integration. Tokens NEVER live here (authRef only). */
export interface IntegrationEntry {
  id: string
  name: string
  baseUrl: string
  /** 'none' = unauthenticated; 'stored' = keyed safeStorage blob in main. */
  authRef: 'none' | 'stored'
  enabled: boolean
  /**
   * Per-integration settings a person writes into integrations.json, read by the code that knows that
   * integration (this registry does not, by design: integrations-smoke G1). Plain values only: a key
   * is an identifier, a value a string, a finite number or a boolean; anything else is dropped, and
   * at most MAX_OPTIONS keys are kept. Kept by the sanitizer, so a save never erases them.
   */
  options?: Record<string, string | number | boolean>
}

export const MAX_OPTIONS = 16

/** The sanitized options bag, or undefined when nothing usable is in it. */
export function sanitizeOptions(raw: unknown): Record<string, string | number | boolean> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const out: Record<string, string | number | boolean> = {}
  let n = 0
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (n >= MAX_OPTIONS) break
    if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(k)) continue
    const ok = typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v)) || (typeof v === 'string' && v.length <= 512)
    if (!ok) continue
    out[k] = v as string | number | boolean
    n += 1
  }
  return n > 0 ? out : undefined
}

/** Mirror of sanitizeProjects (@shared/loop): garbage in → clean list out. */
export function sanitizeIntegrations(raw: unknown): IntegrationEntry[] {
  if (!Array.isArray(raw)) return []
  const out: IntegrationEntry[] = []
  const seen = new Set<string>()
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue
    const o = r as Record<string, unknown>
    const id = typeof o.id === 'string' ? o.id.trim() : ''
    const baseUrl = typeof o.baseUrl === 'string' ? o.baseUrl.trim().replace(/\/+$/, '') : ''
    if (!id || !/^[a-z0-9][a-z0-9_-]*$/i.test(id) || seen.has(id)) continue
    if (!/^https?:\/\//.test(baseUrl)) continue
    seen.add(id)
    out.push({
      id,
      name: typeof o.name === 'string' && o.name.trim() ? o.name.trim() : id,
      baseUrl,
      authRef: o.authRef === 'stored' ? 'stored' : 'none',
      enabled: o.enabled !== false,
      ...(sanitizeOptions(o.options) ? { options: sanitizeOptions(o.options) } : {}),
    })
  }
  return out
}

/** Sibling of isAllowedDaemonPath: integration paths are relative to the
 *  entry's own baseUrl — leading slash, no traversal, no smuggled schemes. */
export function isAllowedIntegrationPath(path: string): boolean {
  return path.startsWith('/') && !path.includes('..') && !path.includes('://')
}

// ── Manifest (contract §2) ──────────────────────────────────────────────

export type ViewType = 'vitals' | 'browser' | 'controls' | 'events'
export const VIEW_TYPES: readonly ViewType[] = ['vitals', 'browser', 'controls', 'events']

export interface ManifestView {
  type: string // kept raw so unsupported types can be SHOWN as unsupported
  title: string
  endpoint?: string
  searchable?: boolean
  poll_seconds?: number
  transport?: 'ws' | 'poll'
  ws_path?: string
  poll_endpoint?: string
}

/** What an integration says it can DO, as opposed to what it can show.
 *
 * Optional by design: an integration that predates this field is not broken,
 * it simply declares nothing. Making it required would turn a purely additive
 * field into a breaking change — and Beacon DISABLES an integration whose
 * contract_version it does not recognise, so voice would go dark on any
 * middleware not updated in lockstep. */
export interface ManifestCapability {
  id: string
  title: string
  detail?: string
}

export interface IntegrationManifest {
  contract_version: number
  integration: { id: string; name: string; description?: string }
  health_endpoint: string
  views: ManifestView[]
  capabilities: ManifestCapability[]
}

/** Garbage in → empty list out. A malformed capability is DROPPED rather than
 * failing the manifest: a decorative field must never cost an integration its
 * views. */
export function sanitizeCapabilities(raw: unknown): ManifestCapability[] {
  if (!Array.isArray(raw)) return []
  const out: ManifestCapability[] = []
  const seen = new Set<string>()
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue
    const o = r as Record<string, unknown>
    const id = typeof o.id === 'string' ? o.id.trim() : ''
    const title = typeof o.title === 'string' ? o.title.trim() : ''
    if (!id || !title || seen.has(id)) continue
    seen.add(id)
    out.push({ id, title, detail: typeof o.detail === 'string' ? o.detail.trim() : undefined })
  }
  return out
}

export type ManifestProblem =
  | { kind: 'version'; got: number; want: number }
  | { kind: 'shape'; detail: string }

/** Parse + validate a manifest. Contract-version mismatch is a LOUD problem
 *  that disables the integration (the loud-failure law applies to contracts). */
export function parseManifest(raw: unknown): { manifest: IntegrationManifest | null; problem: ManifestProblem | null } {
  if (!raw || typeof raw !== 'object')
    return { manifest: null, problem: { kind: 'shape', detail: 'manifest is not an object' } }
  const o = raw as Record<string, unknown>
  const version = typeof o.contract_version === 'number' ? o.contract_version : -1
  if (version !== SUPPORTED_CONTRACT_VERSION)
    return { manifest: null, problem: { kind: 'version', got: version, want: SUPPORTED_CONTRACT_VERSION } }
  const integ = (o.integration ?? {}) as Record<string, unknown>
  if (typeof integ.id !== 'string' || typeof integ.name !== 'string')
    return { manifest: null, problem: { kind: 'shape', detail: 'integration.id/name missing' } }
  const views = Array.isArray(o.views) ? (o.views as ManifestView[]) : []
  const cleanViews: ManifestView[] = []
  for (const v of views) {
    if (!v || typeof v !== 'object' || typeof v.title !== 'string' || typeof v.type !== 'string') continue
    for (const key of ['endpoint', 'ws_path', 'poll_endpoint'] as const) {
      const p = (v as unknown as Record<string, unknown>)[key]
      if (typeof p === 'string' && !isAllowedIntegrationPath(p))
        return { manifest: null, problem: { kind: 'shape', detail: `view "${v.title}" has illegal path in ${key}` } }
    }
    cleanViews.push(v)
  }
  return {
    manifest: {
      contract_version: version,
      integration: { id: integ.id, name: integ.name, description: typeof integ.description === 'string' ? integ.description : undefined },
      health_endpoint: typeof o.health_endpoint === 'string' && isAllowedIntegrationPath(o.health_endpoint) ? o.health_endpoint : '/health',
      views: cleanViews,
      capabilities: sanitizeCapabilities(o.capabilities),
    },
    problem: null,
  }
}

export function isSupportedViewType(t: string): t is ViewType {
  return (VIEW_TYPES as readonly string[]).includes(t)
}

// ── View payload shapes (contract §3) ───────────────────────────────────

export interface VitalsPayload {
  sections: { title: string; rows: { label: string; value: string; status: 'ok' | 'warn' | 'error' | null; detail?: string | null }[] }[]
}
export interface BrowserPayload {
  columns: { key: string; label: string }[]
  rows: Record<string, unknown>[]
  total: number
}
export interface ControlsPayload {
  controls: { id: string; label: string; description?: string; method: string; endpoint: string; confirm: boolean; danger?: boolean }[]
}
export interface EventsPayload {
  events: Record<string, unknown>[]
  cursor: number | string
}

/** Defensive coercions: a bad payload must never white-screen a renderer. */
export function asVitals(raw: unknown): VitalsPayload {
  const o = (raw ?? {}) as Record<string, unknown>
  return { sections: Array.isArray(o.sections) ? (o.sections as VitalsPayload['sections']) : [] }
}
export function asBrowser(raw: unknown): BrowserPayload {
  const o = (raw ?? {}) as Record<string, unknown>
  return {
    columns: Array.isArray(o.columns) ? (o.columns as BrowserPayload['columns']) : [],
    rows: Array.isArray(o.rows) ? (o.rows as BrowserPayload['rows']) : [],
    total: typeof o.total === 'number' ? o.total : 0,
  }
}
export function asControls(raw: unknown): ControlsPayload {
  const o = (raw ?? {}) as Record<string, unknown>
  const list = Array.isArray(o.controls) ? (o.controls as ControlsPayload['controls']) : []
  return { controls: list.filter((c) => c && typeof c.endpoint === 'string' && isAllowedIntegrationPath(c.endpoint)) }
}
export function asEvents(raw: unknown): EventsPayload {
  const o = (raw ?? {}) as Record<string, unknown>
  return {
    events: Array.isArray(o.events) ? (o.events as EventsPayload['events']) : [],
    cursor: typeof o.cursor === 'number' || typeof o.cursor === 'string' ? o.cursor : 0,
  }
}

// ── Health classification (mirrors connectionTestLabel semantics) ───────

export type IntegrationHealth =
  | { state: 'ok'; degraded: { component: string; reason: string }[] }
  | { state: 'degraded'; degraded: { component: string; reason: string }[] }
  | { state: 'error'; detail: string }
  | { state: 'disabled' }
  | { state: 'version-mismatch'; got: number; want: number }

/** 401s must present as a NAMED auth failure, never a mysteriously empty view
 *  (loud-failure law). Works on the load-bearing 'HTTP <status>:' prefix. */
export function isAuthFailure(detail: string): boolean {
  return /HTTP 401\b/.test(detail)
}

export function classifyHealth(raw: unknown): IntegrationHealth {
  const o = (raw ?? {}) as Record<string, unknown>
  const degraded = Array.isArray(o.degraded) ? (o.degraded as { component: string; reason: string }[]) : []
  if (o.status === 'ok') return { state: 'ok', degraded }
  if (o.status === 'degraded') return { state: 'degraded', degraded }
  return { state: 'error', detail: typeof o.status === 'string' ? o.status : 'unrecognized health payload' }
}

/** Snapshot main sends the renderer per entry (no tokens, no raw errors lost). */
export interface IntegrationStatus {
  entry: IntegrationEntry
  manifest: IntegrationManifest | null
  problem: ManifestProblem | null
  health: IntegrationHealth | { state: 'unreachable'; detail: string }
}
