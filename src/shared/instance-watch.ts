// The Prometheus Beacon keeps but isn't on (docs/MULTI-PROMETHEUS.md §5, §7): how each one is doing, for its row in the sidebar,
// from a check every 60 seconds with its own key, after it has proved who it is. What a check's answer means, and how it reads on
// screen, is decided here; src/main/instance-watch.ts only asks.
//
// No Node/Electron imports (same rule as the rest of src/shared).

import { companyName, MAIN_MODEL_COPY } from './main-model'

/** How often a reachable Prometheus Beacon isn't on is checked, and how often one that can't be reached is. */
export const WATCH_EVERY_MS = 60_000
export const UNREACHABLE_EVERY_MS = 300_000

/** One row's state (§5). 'unknown': not checked yet. */
export type InstanceState = 'unknown' | 'connected' | 'unreachable' | 'key-refused' | 'different' | 'refused'

export interface InstanceHealth {
  state: InstanceState
  /** Which AI it's on, in Beacon's words ("Anthropic (Claude) · claude-sonnet"), or null when it didn't say. */
  ai: string | null
  /** When it was last reached, or when it first couldn't be (ms), for "Can't reach it since 3:12 pm". */
  since: number | null
}

export const UNKNOWN: InstanceHealth = { state: 'unknown', ai: null, since: null }

/** Providers that run on the person's own hardware: said as such, not by their id. */
const LOCAL = new Set(['llama_cpp', 'ollama', 'lmstudio', 'lm_studio', 'vllm', 'openai_compatible', 'local'])

/** Which AI, from /api/status's `provider` and `model`. */
export function aiLabel(provider: unknown, model: unknown): string | null {
  if (typeof provider !== 'string' || !provider) return null
  const who = LOCAL.has(provider) ? MAIN_MODEL_COPY.ownHardware : companyName(provider)
  return typeof model === 'string' && model ? `${who} · ${model}` : who
}

/** When to check again after this result. */
export function nextCheckMs(h: InstanceHealth): number {
  return h.state === 'unreachable' ? UNREACHABLE_EVERY_MS : WATCH_EVERY_MS
}
