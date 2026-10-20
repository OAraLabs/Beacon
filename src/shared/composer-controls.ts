// Composer controls (model switcher + Agent|Chat toggle) — pure logic shared by the renderer
// components and the headless smoke. No React, no DOM. Both controls are UI over already-live
// daemon APIs: the per-session model REST (Prometheus #71) and the per-message `mode` field on
// the chat send path (Prometheus #72), and the force-search toggle's per-call tool_choice
// (Prometheus #76/#77, live; Beacon #21 — see forceSearchSendField below).

/** Per-message tool directive surfaced in the composer. Agent = today's default (byte-identical). */
export type ChatMode = 'agent' | 'chat'

/** One option in the model-switcher dropdown (the GET /api/models catalog shape, Prometheus #71).
 *  `auth` (Prometheus #102) says which credential the provider would use — "subscription" |
 *  "api_key" | null; absent on older daemons. Display logic lives in model-auth.ts. */
export interface ModelOption {
  key: string
  label: string
  provider?: string
  model?: string
  is_default?: boolean
  available?: boolean
  auth?: string | null
  /** Registry name when this row is a LOCAL BACKEND (Prometheus PR 390): "local" on the default
   *  row, "4090"/"mini" on configured boxes, absent on cloud rows and on older daemons. For these
   *  rows `available` means REACHABLE (the registry's last probe), not "credential present". */
  backend?: string | null
  /** The registry's last probe of that box — why it is (un)available, its reported window. */
  health?: BackendHealth | null
  /** The served model file, when the daemon knows it (backend rows). */
  detail?: string | null
  /** Detected (backend rows) or declared (cloud rows) vision capability. Absent = false. */
  vision?: boolean
}

/** `health` on a backend row / an entry of `/api/status.backends` (Prometheus PR 389). */
export interface BackendHealth {
  ok?: boolean
  /** false = the daemon never asked this box (distinct from down). */
  probed?: boolean
  /** The TTL lapsed since the last probe. */
  stale?: boolean
  n_ctx?: number | null
  latency_ms?: number | null
  error?: string | null
  changed_at?: string | null
  probed_at?: string | null
}

export type OptionKind = 'default' | 'backend' | 'cloud'

/** What kind of row this is, because the SAME field answers different questions per kind:
 *  `available` is a credential check on a cloud row and a reachability check on a backend row. */
export function optionKind(option: ModelOption, defaultKey: string): OptionKind {
  if (isDefaultOption(option, defaultKey)) return 'default'
  if (typeof option.backend === 'string' && option.backend.length > 0) return 'backend'
  return 'cloud'
}

/** The reason an option cannot be selected right now, or null. A down backend says WHY (the
 *  probe's error) — never "key missing", which was the cloud assumption baked into the switcher. */
export function optionUnavailableReason(option: ModelOption, defaultKey: string): string | null {
  if (option.available !== false) return null
  const kind = optionKind(option, defaultKey)
  if (kind === 'cloud') return 'key missing'
  const err = option.health?.error
  return err ? `down — ${err}` : 'down'
}

/** The compact health badge for a backend row: reported window · vision · latency, and "not probed" when the daemon never asked.
 *  Not "stale": that is when it was checked, not how it is (@shared/backend-health), and a stale reading is checked again. */
export function backendHealthBadge(option: ModelOption): string | null {
  if (typeof option.backend !== 'string' || !option.backend) return null
  const h = option.health
  if (!h) return null
  if (h.probed === false) return 'not probed'
  if (h.ok === false) return 'down'
  const parts: string[] = []
  if (typeof h.n_ctx === 'number' && h.n_ctx > 0) parts.push(`${Math.round(h.n_ctx / 1024)}k`)
  if (option.vision) parts.push('vision')
  if (typeof h.latency_ms === 'number') parts.push(`${Math.round(h.latency_ms)} ms`)
  return parts.length ? parts.join(' · ') : null
}

/** Split the catalogue for the dropdown: the boxes you own first (default + backends), then cloud.
 *  Order within each group is the daemon's. */
export function groupOptions(models: ModelOption[], defaultKey: string): { local: ModelOption[]; cloud: ModelOption[] } {
  const local: ModelOption[] = []
  const cloud: ModelOption[] = []
  for (const o of models) (optionKind(o, defaultKey) === 'cloud' ? cloud : local).push(o)
  return { local, cloud }
}

/** One vendor/box and every version of it, in menu order. */
export interface OptionGroup {
  /** The preset or backend name — the part of the key before the first colon. */
  id: string
  /** What to show as the heading: "Claude", "Qwen", "mini". */
  label: string
  options: ModelOption[]
}

/** The vendor name to head a group with.
 *
 * The daemon labels a row `"<Vendor> · <model>"` when a preset offers more than one
 * version and `"<Vendor>"` when it offers one, so the vendor is the part before the
 * separator. Backends label as `"<box> · <model>"` and take the same path. Falls back
 * to the group id, which is always present and never wrong — a missing label must not
 * produce a blank heading. */
function groupLabel(id: string, options: ModelOption[]): string {
  const bare = options.find((o) => o.key === id) ?? options[0]
  const head = (bare?.label ?? '').split(' · ')[0]?.trim()
  return head && head.length > 0 ? head : id
}

/** Split a catalog key into (preset, model) on the FIRST colon only. A model name may
 * contain colons — `gpu_ollama:qwen2.5:7b-instruct` — and must round-trip. */
export function splitOptionKey(key: string): { preset: string; model: string | null } {
  const i = key.indexOf(':')
  return i < 0 ? { preset: key, model: null } : { preset: key.slice(0, i), model: key.slice(i + 1) }
}

/** Group a flat option list by vendor/box, PRESERVING the daemon's order.
 *
 * WHY: the catalog used to be roughly one row per provider; Prometheus PR 542 gave every
 * preset its own versions, and the cloud half became a ~28-row flat scroll with each
 * vendor's models adjacent but unmarked. Sorting is deliberately NOT applied — the daemon
 * already emits each preset's default first, and re-sorting here would bury it.
 *
 * Group order is first-appearance, so the daemon stays the thing that decides what leads. */
export function groupByVendor(models: ModelOption[]): OptionGroup[] {
  const byId = new Map<string, ModelOption[]>()
  for (const o of models) {
    const { preset } = splitOptionKey(o.key)
    const list = byId.get(preset)
    if (list) list.push(o)
    else byId.set(preset, [o])
  }
  return [...byId].map(([id, options]) => ({ id, label: groupLabel(id, options), options }))
}

/** Is a vendor heading worth drawing? One group is not an organisation — heading a list
 * that has nothing to distinguish itself from adds a line and says nothing. */
export function vendorHeadingsHelp(groups: OptionGroup[]): boolean {
  return groups.length > 1
}

/** A human message for a failed switch. The main-process REST client throws
 *  `HTTP <status>: <method> <path> — <body>`; a backend key that failed its pre-switch probe is a
 *  503 whose body carries the probe's error (Prometheus PR 390), which is the one thing the user
 *  needs to read. Never the bare `[object Object]`, never silence. */
export function switchFailureMessage(err: unknown, key: string): string {
  const msg = err instanceof Error ? err.message : String(err ?? '')
  const status = msg.match(/HTTP (\d{3})/)?.[1]
  const body = msg.match(/\{[\s\S]*\}\s*$/)?.[0]
  let detail = ''
  if (body) {
    try {
      const parsed = JSON.parse(body) as { error?: unknown }
      if (typeof parsed.error === 'string') detail = parsed.error
    } catch {
      /* not JSON — fall through to the raw tail */
    }
  }
  if (status === '401') return `Could not switch to ${key}: not authorized (check the daemon token).`
  if (detail) return `Could not switch to ${key}: ${detail}`
  if (status) return `Could not switch to ${key}: the daemon answered HTTP ${status}.`
  return `Could not switch to ${key}: ${msg || 'no response'}`
}

/** GET /api/models response. `default_key` is the "Local/Default" option (selecting it clears). */
export interface ModelCatalog {
  models: ModelOption[]
  default_key: string
}

/** Selecting an option → the daemon call to make. The default/local key CLEARS the per-session
 *  override (DELETE /api/sessions/{id}/model); any preset key SETS it (POST {key}). */
export function modelSelectAction(key: string, defaultKey: string): { method: 'POST' | 'DELETE'; body?: { key: string } } {
  return key === defaultKey ? { method: 'DELETE' } : { method: 'POST', body: { key } }
}

/** Per-message mode → the optional send-payload field. Agent omits `mode` entirely so the agent
 *  path stays byte-identical to today; only Chat carries `mode: 'chat'` (Piece-2's no-tools turn). */
export function modeSendField(mode: ChatMode): { mode?: 'chat' } {
  return mode === 'chat' ? { mode: 'chat' } : {}
}

/** Force-search (per-message, one-shot): armed + Agent mode → the send carries
 *  `tool_choice: {tool: "web_search"}` (Prometheus #76: forced FIRST round, then the turn relaxes
 *  to auto — #77 semantics). Chat mode is a no-tools turn, so an armed toggle is inert there and
 *  the UI must disable it (mode-honest, same guardrail as attachments-in-Chat). Disarmed / absent
 *  → no field at all (byte-identical default send). */
export function forceSearchSendField(armed: boolean, mode: ChatMode): { tool_choice?: { tool: 'web_search' } } {
  return armed && mode === 'agent' ? { tool_choice: { tool: 'web_search' } } : {}
}

/** Whether the force-search toggle is selectable: Chat turns carry no tools, so forcing one is a
 *  contradiction — the control locks (with a reason) rather than lying. */
export function forceSearchDisabled(mode: ChatMode): boolean {
  return mode === 'chat'
}

/** Per-session mode memory (Level 2): the session's remembered choice, else the Agent default.
 *  The memory map is in-memory renderer state — a fresh app launch starts empty, so every session
 *  resets to Agent on relaunch (no cross-launch persistence, by decision). */
export function resolveSessionMode(memory: Record<string, ChatMode>, sessionId: string): ChatMode {
  return memory[sessionId] ?? 'agent'
}

/** The currently-selected option from the catalog (for label + highlight), or null if not found. */
export function currentOption(models: ModelOption[], currentKey: string | null | undefined): ModelOption | null {
  if (!currentKey) return null
  return models.find((o) => o.key === currentKey) ?? null
}

/** Whether a catalog option is the default/local one (selecting it clears the override). */
export function isDefaultOption(option: ModelOption, defaultKey: string): boolean {
  return option.is_default === true || option.key === defaultKey
}

// Attachments are Agent-only. The daemon's chat_upload path dispatches its turn WITHOUT a mode
// (always Agent — ws_server.py `_handle_send_message(session_id, user_text)`), so threading `mode`
// through an attachment send would need a daemon change (out of scope here). To keep the mode
// indicator honest instead, these two predicates make attachments and Chat MUTUALLY EXCLUSIVE in
// the composer: you can't attach while in Chat, and you can't switch to Chat while files are
// staged. Together they make a "Chat + attachment" send unreachable, so the indicator never shows
// Chat while a send actually runs Agent.

/** Attach button is disabled in Chat mode (you can only stage files in Agent mode). */
export function attachDisabledInMode(mode: ChatMode): boolean {
  return mode === 'chat'
}

/** The Chat toggle option is disabled while files are staged (an attachment send must be Agent). */
export function chatOptionDisabled(pendingFileCount: number): boolean {
  return pendingFileCount > 0
}

/**
 * The composer chip's model label: **`local · qwen2.5-32b`** — the host, then the model.
 *
 * `Local` alone (what the chip used to show) repeats the host chip in the header and omits the one
 * thing worth checking before you press Send: WHICH model is about to answer. The order is
 * deliberate — the model name is the information, the host is the qualifier on it.
 *
 * The model field is frequently a PATH, because a local backend reports the file it loaded
 * (`/home/demo/models/Qwen3.8-27B-UD-Q4_K_XL.gguf`, measured against the live daemon
 * 2026-09-03). A 46-character absolute path does not belong in a 24px chip, so it is reduced to
 * its basename with the weights extension dropped. Nothing is invented: when neither a host nor a
 * model name is known, the catalog's own label is used unchanged.
 */
export function modelFileName(model: string): string {
  const base = model.split('/').filter(Boolean).pop() ?? model
  return base.replace(/\.(gguf|safetensors|bin|pt|ggml)$/i, '')
}

export function composerModelLabel(option: ModelOption | null, fallback?: string): string {
  const host = option?.backend?.trim() || option?.provider?.trim() || ''
  const raw = option?.detail?.trim() || option?.model?.trim() || ''
  const name = raw ? modelFileName(raw) : ''
  if (host && name) return `${host} · ${name}`
  if (name) return name
  return option?.label ?? fallback ?? '—'
}
