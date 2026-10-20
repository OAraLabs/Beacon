// Models Config tab (MODELS KEYS UI sprint) — pure data layer over the daemon's
// /api/providers/keys catalog. GET returns services with set/not-set BOOLEANS
// only (the daemon never sends key values, prefixes, or lengths); PUT
// {values: {ENV_VAR: "key"}} saves, an empty-string value clears. The response
// to a PUT is the same catalog shape, so the UI refreshes chips from it.
//
// Everything here is pure + headless-testable (model-keys-smoke.ts). The
// NEVER-PREFILL rule lives here as code: payloads are built ONLY from what the
// user typed — there is no value field anywhere in the DTOs to leak back in.

export interface ProviderKeyVarDTO {
  name: string
  set: boolean
}

export interface ProviderKeyServiceDTO {
  id: string
  label: string
  kind: string // 'llm' | 'image' | 'video' (unknown kinds tolerated)
  env_vars: ProviderKeyVarDTO[]
  docs_url?: string
  default_model?: string
}

export interface ProviderKeysCatalogDTO {
  services?: ProviderKeyServiceDTO[]
}

/** Card groups in display order — chat first (the friendliest), then media. */
export const KEY_KIND_GROUPS: { kind: string; label: string }[] = [
  { kind: 'llm', label: 'Chat models' },
  { kind: 'image', label: 'Image generation' },
  { kind: 'video', label: 'Video generation' }
]

/** Coerce an unknown daemon payload to a clean service list. Wrong-shape or
 * partial payloads degrade to [] / dropped entries — never a `.map` crash. */
export function coerceKeyServices(data: unknown): ProviderKeyServiceDTO[] {
  const services = (data as ProviderKeysCatalogDTO | null)?.services
  if (!Array.isArray(services)) return []
  return services.filter(
    (s): s is ProviderKeyServiceDTO =>
      !!s &&
      typeof s.id === 'string' &&
      s.id.length > 0 &&
      typeof s.label === 'string' &&
      Array.isArray(s.env_vars) &&
      s.env_vars.length > 0 &&
      s.env_vars.every((v) => !!v && typeof v.name === 'string' && v.name.length > 0)
  )
}

/** Group services for the card sections, KEY_KIND_GROUPS order. Unknown kinds
 * land in a trailing "Other" group (honest, not dropped). Empty groups omitted. */
export function groupKeyServices(
  services: ProviderKeyServiceDTO[]
): { kind: string; label: string; services: ProviderKeyServiceDTO[] }[] {
  const known = new Set(KEY_KIND_GROUPS.map((g) => g.kind))
  const groups = KEY_KIND_GROUPS.map((g) => ({
    ...g,
    services: services.filter((s) => s.kind === g.kind)
  }))
  const other = services.filter((s) => !known.has(s.kind))
  if (other.length > 0) groups.push({ kind: 'other', label: 'Other', services: other })
  return groups.filter((g) => g.services.length > 0)
}

export type KeyState = 'set' | 'partial' | 'unset'

/** A service is configured when EVERY env var is set (Kling needs its pair);
 * some-but-not-all is 'partial' so a half-keyed service never reads as done. */
export function serviceKeyState(svc: ProviderKeyServiceDTO): KeyState {
  const set = svc.env_vars.filter((v) => v.set).length
  if (set === 0) return 'unset'
  return set === svc.env_vars.length ? 'set' : 'partial'
}

/** Field label for one env var. Single-var services are simply "API key";
 * multi-var services derive from the var name (KLING_ACCESS_KEY → "Access key")
 * so a future pair-keyed service labels itself without a hardcoded map. */
export function envVarFieldLabel(svc: ProviderKeyServiceDTO, name: string): string {
  if (svc.env_vars.length === 1) return 'API key'
  const words = name.split('_').slice(1) // drop the vendor prefix token
  const text = (words.length > 0 ? words : [name]).join(' ').toLowerCase()
  return text.charAt(0).toUpperCase() + text.slice(1)
}

/** Build the save payload from what the user TYPED (trimmed), nothing else —
 * untouched fields are never sent, so existing keys can't be clobbered by the
 * blank (never-prefilled) inputs. Returns null when there is nothing to save. */
export function buildSavePayload(
  svc: ProviderKeyServiceDTO,
  typed: Record<string, string>
): { values: Record<string, string> } | null {
  const values: Record<string, string> = {}
  for (const v of svc.env_vars) {
    const t = (typed[v.name] ?? '').trim()
    if (t) values[v.name] = t
  }
  return Object.keys(values).length > 0 ? { values } : null
}

/** Build the explicit-clear payload: EVERY env var → "" (the daemon's
 * documented clear semantics — removes from the live env, blanks the file). */
export function buildClearPayload(svc: ProviderKeyServiceDTO): { values: Record<string, string> } {
  const values: Record<string, string> = {}
  for (const v of svc.env_vars) values[v.name] = ''
  return { values }
}

/** The PUT path for one service. */
export function keysPutPath(serviceId: string): string {
  return `/api/providers/keys/${encodeURIComponent(serviceId)}`
}

/** The catalog path (also the Config-tab registry entry). */
export const KEYS_CATALOG_PATH = '/api/providers/keys'
