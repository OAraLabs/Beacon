// Slash-command autocomplete for the chat composer (X3 — Telegram parity).
//
// The DAEMON side is already live and merged (Prometheus #59 general router, #61 steering
// group): a leading-slash chat message is routed through prometheus.web.slash_router and
// broadcast back as a normal assistant message — never run through the agent. This module is
// the pure Beacon-side model: the command catalog, the popup-open predicate, fuzzy matching,
// and the keyboard reducer. NO DOM/React imports — the headless smoke exercises it directly.
//
// Catalog source of truth: the daemon's tables in src/prometheus/gateway/commands.py —
//   * _FORMATTER_COMMANDS (17) + _SESSION_COMMANDS (4)  → web: true  (handled on the WS)
//   * slash_router.WEB_NATIVE_ONLY                       → web: false (Telegram-bound; the
//     daemon replies with an explicit "not on web" boundary message if typed anyway)
// A static catalog (not a GET /api/commands) is deliberate: Beacon must work against any
// daemon vintage, and the daemon's own boundary reply covers drift.

import { rankCommands } from './commands'

export interface SlashCommand {
  /** Command name without the slash. */
  name: string
  /** One-line description shown in the popup. */
  desc: string
  /**
   * False → the daemon REFUSES it on the web surface (`slash_router.WEB_NATIVE_ONLY`) and Beacon
   * gates it at the send site rather than sending it. This is a real mechanism, not a CSS class:
   * see `slashBoundary`. It must mirror the daemon's set exactly — `slash-parity-smoke` pins it.
   */
  web: boolean
  /** True → BEACON handles it; the text never reaches the daemon's slash router. See LOCAL below. */
  local?: boolean
  /**
   * True → the command DESTROYS state (clears context). The popup marks it and the send site
   * confirms before running it. A destructive command must never be tagged `web: false` to imply
   * it is inert here — that was the #126 lie: `/reset` wore a "Telegram" badge while actually
   * clearing the web session's context.
   */
  destructive?: boolean
}

/**
 * Commands Beacon runs itself.
 *
 * Everything else in the catalog mirrors a daemon table and is sent as a message for
 * `slash_router` to handle. `/search` cannot be: the daemon has no such command, because forcing
 * a web search is not something you ask the router to do — it is a flag on the NEXT turn
 * (`tool_choice: {tool: "web_search"}`, Prometheus #76/#77). The client is the only place that
 * knows about it.
 *
 * It exists because the composer's Search button is gone. The capability was supposed to MOVE to
 * `/search`, not disappear, and a spec line saying "it is forced with /search" does not force
 * anything on its own.
 */
export const LOCAL_SLASH = ['search', 'model', 'skin', 'export'] as const

/** The parity catalog, mirrored from the daemon's command tables (see header). */
export const SLASH_COMMANDS: SlashCommand[] = [
  // ── Beacon's own, handled here and never sent to the router ──
  { name: 'search', desc: 'Force a web search: /search <query>', web: true, local: true },
  { name: 'skin', desc: 'Switch plate: /skin nigredo', web: true, local: true },
  { name: 'export', desc: 'Export this transcript: /export markdown | json', web: true, local: true },
  // ── _FORMATTER_COMMANDS — side-effect-free, web: true ──
  { name: 'help', desc: 'List available commands', web: true },
  { name: 'status', desc: 'Model, uptime, tools, memory, queues', web: true },
  // `/model` alone still asks the daemon what it is running; `/model <name>` SWITCHES,
  // here in the client — parseLocalSlash only claims the form that carries an argument.
  { name: 'model', desc: 'Show the model, or switch: /model <name>', web: true },
  { name: 'context', desc: 'Context window usage', web: true },
  { name: 'skills', desc: 'list | show | pin | unpin | history', web: true },
  { name: 'memory', desc: 'show [user] | limits', web: true },
  { name: 'note', desc: 'Save a fact: /note <text>', web: true },
  // Item W. A real daemon command (gateway/commands.py `_sc_workspace`), absent from
  // slash_router.WEB_NATIVE_ONLY, so it is handled on this surface — and it was missing from this
  // catalog entirely while the Checkpoints panel's empty state told people to type it. The parity
  // pin in slash-smoke compares the two web:false SETS, so a command missing outright was invisible
  // to it. Not destructive: it changes a write boundary, it does not wipe state.
  { name: 'workspace', desc: 'This conversation’s working directory: /workspace <path> | clear', web: true },
  { name: 'wiki', desc: 'Wiki stats and recent entries', web: true },
  { name: 'sentinel', desc: 'SENTINEL subsystem status', web: true },
  { name: 'events', desc: 'Recent signal-bus events', web: true },
  { name: 'curator', desc: 'status | show | run [dry]', web: true },
  { name: 'health', desc: 'Diagnostic health (last 24h)', web: true },
  { name: 'notifications', desc: 'Notification mode', web: true },
  { name: 'anatomy', desc: 'Hardware, GPU, VRAM, infrastructure', web: true },
  { name: 'doctor', desc: 'Diagnostic health check', web: true },
  { name: 'profile', desc: 'Show agent profiles', web: true },
  { name: 'beacon', desc: 'Beacon daemon config', web: true },
  // ── _SESSION_COMMANDS — mutate the live session, web: true ──
  { name: 'steer', desc: 'Inject mid-turn guidance: /steer <text>', web: true },
  { name: 'queue', desc: 'Queue a follow-up turn: /queue <text>', web: true },
  { name: 'unqueue', desc: 'Drop the most recently queued prompt', web: true },
  { name: 'clearsteers', desc: 'Clear pending steers', web: true },
  // `/reset` and `/clear` are daemon _SESSION_COMMANDS (both → _sc_reset): they RUN on web and
  // clear the session's context, so they are web:true and destructive. Tagging them web:false was
  // the #126 lie — a "Telegram" badge implying they were inert here, while typing one wiped the
  // conversation. They are NOT in the daemon's WEB_NATIVE_ONLY refusal set; do not move them back.
  { name: 'reset', desc: 'Clear conversation context', web: true, destructive: true },
  { name: 'clear', desc: 'Clear the chat (alias of /reset)', web: true, destructive: true },
  // ── slash_router.WEB_NATIVE_ONLY — Telegram-bound ──
  { name: 'route', desc: 'Route a model for this session', web: false },
  { name: 'gepa', desc: 'GEPA status | run | history', web: false },
  { name: 'approve', desc: 'Approve a pending action', web: false },
  { name: 'deny', desc: 'Deny a pending action', web: false },
  { name: 'pending', desc: 'Pending approvals', web: false },
  { name: 'benchmark', desc: 'Model benchmark', web: false },
  { name: 'symbiote', desc: 'SYMBIOTE pipeline', web: false },
  { name: 'audit', desc: 'Audit subsystem', web: false },
  { name: 'press', desc: 'Press digest', web: false },
  { name: 'escalations', desc: 'Escalation queue', web: false },
  { name: 'voice', desc: 'Voice mode', web: false },
  { name: 'local', desc: 'Route to the local model', web: false },
  { name: 'claude', desc: 'Route to Claude', web: false },
  { name: 'gpt', desc: 'Route to GPT', web: false },
  { name: 'gemini', desc: 'Route to Gemini', web: false },
  { name: 'xai', desc: 'Route to xAI', web: false },
  { name: 'grok', desc: 'Route to Grok', web: false },
  { name: 'deepseek', desc: 'Route to DeepSeek', web: false },
  { name: 'kimi', desc: 'Route to Kimi', web: false },
  { name: 'glm', desc: 'Route to GLM', web: false },
  { name: 'mimo', desc: 'Route to MiMo', web: false },
  // The daemon lists qwen in WEB_NATIVE_ONLY alongside its nine siblings (it was added later,
  // #183-#186, and the catalog never picked it up — the parity pin below is what catches that).
  { name: 'qwen', desc: 'Route to Qwen', web: false },
  { name: 'tools', desc: 'Tool registry listing', web: false },
  { name: 'pairs', desc: 'Model pairing table', web: false },
  { name: 'start', desc: 'Start the session', web: false }
]

/** The popup is open while the draft is a single leading-slash token with no whitespace yet —
 *  `/`, `/st`, `/status` → open; `/status x` (args started), `` (empty), `hi /x` → closed. */
export function slashQuery(draft: string): string | null {
  const m = /^\/([a-zA-Z0-9_-]*)$/.exec(draft)
  return m ? m[1].toLowerCase() : null
}

/** Rank catalog entries for a popup query: fuzzy match (shared palette ranker) over `/name`,
 *  then web-available entries partitioned first (stable within each group). */
export function slashMatches(query: string, catalog: SlashCommand[] = SLASH_COMMANDS): SlashCommand[] {
  const ranked = rankCommands(catalog.map((c) => ({ ...c, label: `/${c.name}` })), `/${query}`)
  const web: SlashCommand[] = []
  const tel: SlashCommand[] = []
  for (const c of ranked) (c.web ? web : tel).push(c)
  return [...web, ...tel]
}

/** Inserting a completion: `/name` + trailing space, ready for arguments. */
export function slashCompletion(cmd: SlashCommand): string {
  return `/${cmd.name} `
}

export type SlashKeyAction =
  | { kind: 'move'; highlight: number }
  | { kind: 'insert'; highlight: number }
  | { kind: 'dismiss' }
  | { kind: 'none' }

/** Keyboard reducer for the popup (highlight clamps, wrap-around). `count` = visible matches. */
export function slashKey(action: 'up' | 'down' | 'enter' | 'tab' | 'escape', highlight: number, count: number): SlashKeyAction {
  if (count === 0) return { kind: 'none' }
  if (action === 'up') return { kind: 'move', highlight: highlight <= 0 ? count - 1 : highlight - 1 }
  if (action === 'down') return { kind: 'move', highlight: (highlight + 1) % count }
  if (action === 'enter' || action === 'tab') return { kind: 'insert', highlight: Math.min(highlight, count - 1) }
  if (action === 'escape') return { kind: 'dismiss' }
  return { kind: 'none' }
}

/**
 * Is this draft a Telegram-bound command typed on the web surface? (Prometheus audit P9.2, #126)
 *
 * Returns the matched catalog entry when the leading token names a command the catalog marks
 * `web: false` — i.e. one the daemon's `slash_router.WEB_NATIVE_ONLY` refuses on web. The send
 * site uses this to reply locally with the same boundary message the daemon would, INSTEAD of
 * sending it. This is what makes `web: false` a real gate rather than a CSS class: before, the
 * flag only added a `.slash-item-tel` style and a "Telegram" badge, nothing checked it before
 * send, so a command tagged Telegram-bound could still be fired at the daemon.
 *
 * Only a catalog-known `web:false` name is gated. Prose, web-native commands, Beacon-local
 * commands, and a leading token that is not a catalog command at all all return null and fall
 * through to the normal send path — this must not swallow ordinary messages.
 */
export function slashBoundary(draft: string, catalog: SlashCommand[] = SLASH_COMMANDS): SlashCommand | null {
  const m = /^\/([a-zA-Z0-9_-]+)/.exec(draft?.trim() ?? '')
  if (!m) return null
  const name = m[1].toLowerCase()
  const cmd = catalog.find((c) => c.name === name)
  // A known command the catalog marks Telegram-bound. (local commands are always web:true, so they
  // never land here; an unknown token returns null and is the daemon router's problem, not ours.)
  return cmd && cmd.web === false ? cmd : null
}

/** The boundary reply for a Telegram-bound command typed on web — the client-side twin of the
 *  daemon's `slash_router` message, so the operator gets the same answer whether the gate catches
 *  it here or (on an older catalog) the daemon does. */
export function slashBoundaryReply(cmd: SlashCommand): string {
  return `/${cmd.name} isn't available on the web chat surface — it runs on Telegram.`
}

/** The name of a DESTRUCTIVE web command this draft invokes (`/reset`, `/clear`), or null.
 *  Destructive commands wipe session state the client cannot restore, so the send site confirms
 *  before running one. Returns the bare command name (no slash) for the confirm dialog's copy. */
export function destructiveSlash(draft: string, catalog: SlashCommand[] = SLASH_COMMANDS): string | null {
  const m = /^\/([a-zA-Z0-9_-]+)/.exec(draft?.trim() ?? '')
  if (!m) return null
  const name = m[1].toLowerCase()
  const cmd = catalog.find((c) => c.name === name)
  return cmd?.destructive ? cmd.name : null
}

/** A draft Beacon handles itself, or null when it is anything else (prose, or a daemon command).
 *
 *  `/search when did the mini last deploy` → `{ command: 'search', text: 'when did …' }`.
 *  The command name must be followed by whitespace and at least one other character: `/search`
 *  alone is a half-typed command, not a search for nothing, and sending an empty turn to force a
 *  tool call on would be a turn the user never asked for. `/searching…` is prose and matches
 *  nothing — the boundary is the whitespace, not a prefix test.
 */
export function parseLocalSlash(draft: string): { command: string; text: string } | null {
  const m = /^\/([a-zA-Z0-9_-]+)[ \t]+([\s\S]+)$/.exec(draft ?? '')
  if (!m) return null
  const command = m[1].toLowerCase()
  if (!(LOCAL_SLASH as readonly string[]).includes(command)) return null
  const text = m[2].trim()
  return text ? { command, text } : null
}

/**
 * Resolve `/skin <plate>` to a real plate key.
 *
 * The KEYS are historical and the LABELS are current (`rvbedo` is GLAVCVM), so a person typing
 * what they can see in Config would otherwise miss. This accepts either, case-insensitively, and
 * returns null for anything else — the command then says what it did not understand rather than
 * silently leaving the plate alone, which looks identical to a broken command.
 */
export function resolveSkin(
  arg: string,
  themes: readonly string[],
  labels: Record<string, string>
): string | null {
  const q = (arg ?? '').trim().toLowerCase()
  if (!q) return null
  for (const t of themes) if (t.toLowerCase() === q) return t
  for (const t of themes) if ((labels[t] ?? '').toLowerCase() === q) return t
  return null
}

/**
 * What `/model <name>` resolved to.
 *
 * Ambiguity is its own outcome, carrying THE MATCHES — not a bare null. "Be more specific" with
 * nothing else to go on makes the user guess at what they were ambiguous between; naming both
 * turns a dead end into a one-word correction.
 */
export type ModelResolution =
  | { kind: 'ok'; key: string }
  | { kind: 'ambiguous'; matches: string[] }
  | { kind: 'none' }

/**
 * Resolve `/model <name>`: exact key or label first, then a unique case-insensitive substring.
 *
 * An EXACT match wins over a longer substring — `local` names a row exactly even though
 * `local-4090` also contains it, and anything else would make the precise name unusable. Two or
 * more substring matches and no exact one is AMBIGUOUS: picking the first would switch the model
 * to something the user did not name, and they would not find out until the reply came back.
 */
export function resolveModel(arg: string, options: readonly { key: string; label: string }[]): ModelResolution {
  const q = (arg ?? '').trim().toLowerCase()
  if (!q) return { kind: 'none' }
  const exact = options.find((o) => o.key.toLowerCase() === q || o.label.toLowerCase() === q)
  if (exact) return { kind: 'ok', key: exact.key }
  const partial = options.filter((o) => o.key.toLowerCase().includes(q) || o.label.toLowerCase().includes(q))
  if (partial.length === 1) return { kind: 'ok', key: partial[0].key }
  if (partial.length > 1) return { kind: 'ambiguous', matches: partial.map((o) => o.label) }
  return { kind: 'none' }
}
