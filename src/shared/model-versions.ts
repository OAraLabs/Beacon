// Per-provider VERSION lists for Config → Models (Prometheus #542).
//
// The daemon's catalog stopped being one model per provider. GET /api/models now
// carries every selectable version as its own entry: the bare preset key is the
// default (`qwen`), alternates are `preset:model` (`qwen:qwen3.8-flash`). Nine
// presets now offer 1–5 versions each.
//
// Config → Models rendered only `svc.default_model`, a single string, so the
// alternates existed, were selectable from the composer, and were invisible on the
// page a user opens to ask "what can I run?". This module is the data half of the
// fix: it turns the catalog body into "versions, per provider".
//
// DISPLAY ONLY. Picking here does not switch anything — there is no daemon
// endpoint that writes `slash_commands.<key>.model`, so a "saved default" would be
// a lie. What a pick CAN honestly do is tell you how to use it, which is why
// `usageHint` exists.
//
// Pure, like @shared/model-auth: no React, no fetch. Asserted by
// scripts/model-versions-smoke.mjs, because Beacon has no DOM test framework.

/** One selectable model for a provider. */
export type ModelVersion = {
  /** The catalog key to send to the daemon: `qwen` or `qwen:qwen3.8-flash`. */
  key: string
  /** The model itself: `qwen3.8-flash`. */
  model: string
  /** True for the provider's default — the bare preset key. */
  isDefault: boolean
}

/** Split a catalog key into (preset, model). The separator is the FIRST colon only:
 * a model name may contain colons (`gpu_ollama:qwen3.5:9b`) and must round-trip. */
export function splitCatalogKey(key: string): { preset: string; model: string | null } {
  const i = key.indexOf(':')
  return i < 0 ? { preset: key, model: null } : { preset: key.slice(0, i), model: key.slice(i + 1) }
}

/** preset id → its versions, default first, from a raw GET /api/models body.
 *
 * Defensive by the same rule as catalogAuthBadges: a wrong-shape or old-daemon
 * body yields {}, so every caller degrades to "no picker", never a crash. A
 * provider the catalog does not mention (the WAN/Kling media services) simply has
 * no entry. */
export function catalogVersions(data: unknown): Record<string, ModelVersion[]> {
  const models = (data as { models?: unknown } | null)?.models
  if (!Array.isArray(models)) return {}
  const out: Record<string, ModelVersion[]> = {}
  for (const m of models) {
    const e = (m ?? {}) as Record<string, unknown>
    if (typeof e.key !== 'string' || e.key.length === 0) continue
    if (typeof e.model !== 'string' || e.model.length === 0) continue
    const { preset, model } = splitCatalogKey(e.key)
    const row: ModelVersion = { key: e.key, model: e.model, isDefault: model === null }
    const list = (out[preset] ??= [])
    // Default first — it is the one the bare `/qwen` gives you, and the one the
    // row already showed before this picker existed.
    if (row.isDefault) list.unshift(row)
    else list.push(row)
  }
  return out
}

/** The versions for one provider, or [] when the catalog says nothing about it. */
export function versionsFor(
  index: Record<string, ModelVersion[]>,
  serviceId: string
): ModelVersion[] {
  return index[serviceId] ?? []
}

/** Is there an actual CHOICE to present? One version is not a choice, and a
 * dropdown holding a single item is worse than the plain string it replaced. */
export function hasVersionChoice(versions: ModelVersion[]): boolean {
  return versions.length > 1
}

/** How to actually use a picked version — the honest payoff for a display-only
 * picker. The slash command IS the preset id, and a bare `/qwen` means "the
 * default", so the default renders without a model argument. */
export function usageHint(serviceId: string, v: ModelVersion): string {
  return v.isDefault ? `/${serviceId}` : `/${serviceId} ${v.model}`
}

/** The daemon's own words on the catalog being defaults rather than limits
 * (`catalog_note.summary`, added in Prometheus #542), or null on an older daemon.
 * Rendered verbatim: the daemon is the thing that knows whether the list is
 * closed, and it says it is not. */
export function catalogNoteSummary(data: unknown): string | null {
  const note = (data as { catalog_note?: unknown } | null)?.catalog_note
  const summary = (note as { summary?: unknown } | null)?.summary
  return typeof summary === 'string' && summary.length > 0 ? summary : null
}
