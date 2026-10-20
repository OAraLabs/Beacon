// Provider auth-mode display (Prometheus PR #102) — pure data layer for the
// "how is this provider connected?" badges. GET /api/models entries (and the
// per-session GET /api/sessions/{id}/model) carry
//   auth: "subscription" | "api_key" | null
// — which credential the provider would ACTUALLY use right now (the daemon
// prefers a subscription over an API key when both exist). Old daemons omit
// the field entirely, so everything here degrades to "no badge", never a
// crash. Read-only display: the sign-in flow itself is the Models tab's
// XaiOAuthPanel (Beacon PR #31).

export type AuthMode = 'subscription' | 'api_key'

/** Defensive read of an entry's `auth` — old daemons / junk → null (no badge). */
export function coerceAuthMode(v: unknown): AuthMode | null {
  return v === 'subscription' || v === 'api_key' ? v : null
}

/** Subscription product names per provider — what the user actually bought.
 * Unlisted providers fall back to the plain word (honest, never wrong). */
const SUBSCRIPTION_NAMES: Record<string, string> = { xai: 'SuperGrok' }

/** The badge/caption for one catalog entry, or null for "show nothing"
 * (no credential, unknown auth, old daemon). */
export function authBadgeText(auth: AuthMode | null, provider?: string): string | null {
  if (auth === 'subscription') {
    const name = SUBSCRIPTION_NAMES[provider ?? '']
    return name ? `${name} subscription` : 'subscription'
  }
  return auth === 'api_key' ? 'API key' : null
}

/** Tooltip add-on for the current-model chip: ' · via SuperGrok subscription',
 * or '' when there is nothing to say (tooltips concatenate, so empty ≠ null). */
export function authTitleSuffix(auth: unknown, provider?: string): string {
  const text = authBadgeText(coerceAuthMode(auth), provider)
  return text ? ` · via ${text}` : ''
}

/** Catalog key → badge text from a raw GET /api/models body, for the Config →
 * Models tab (its /api/providers/keys service ids match the models-catalog
 * keys: 'xai' card ↔ 'xai' preset). Only entries WITH a badge appear, so
 * `index[svc.id]` is either a caption to render or undefined. Wrong-shape /
 * old-daemon bodies → {} (cards simply carry no badge). */
export function catalogAuthBadges(data: unknown): Record<string, string> {
  const models = (data as { models?: unknown } | null)?.models
  if (!Array.isArray(models)) return {}
  const index: Record<string, string> = {}
  for (const m of models) {
    const e = (m ?? {}) as Record<string, unknown>
    if (typeof e.key !== 'string' || e.key.length === 0) continue
    const text = authBadgeText(
      coerceAuthMode(e.auth),
      typeof e.provider === 'string' ? e.provider : undefined
    )
    if (text) index[e.key] = text
  }
  return index
}

/** The catalog path (same one the composer's model switcher reads). */
export const MODELS_CATALOG_PATH = '/api/models'
