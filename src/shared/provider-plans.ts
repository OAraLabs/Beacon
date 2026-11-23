// Subscription plans in Config → Models (.claude/private/handoff-provider-plans-contract.md; the daemon side is Prometheus's).
// A plan is a key that only works at its own endpoint (GLM Coding Plan, Kimi Code, Qwen's Token / Coding Plan). The daemon lists
// each provider's plans and saves key + plan together; Beacon picks a plan by its id and never sees or sends a URL. Everything is
// gated on GET /api/providers/keys `capabilities.plans >= 1`: a daemon without it gets today's key-only rows.
//
// Pure and headless-testable (smoke:provider-plans). No Node/Electron imports (same rule as the rest of src/shared).

import type { ProviderKeyServiceDTO } from './model-keys'

export interface PlanDTO {
  id: string
  label: string
  subscription: boolean
  /** The provider's usage terms in one line, shown as a label. Nothing is blocked by it. */
  terms: string | null
  default: boolean
  /** Built from an id the person gives (a workspace): needs `regions` to be offered. */
  custom: boolean
  regions?: string[]
}

/**
 * Whether the daemon serves plans.
 * TODAY: never. smoke:provider-plans is red against this on purpose.
 */
export function plansSupported(_catalog: unknown): boolean {
  return false
}

/** A service's plans, checked, or null (none, or a list Beacon can't trust: then the row is key-only, as today). TODAY: null. */
export function servicePlans(_svc: ProviderKeyServiceDTO): PlanDTO[] | null {
  return null
}

/** The plan a service is on: a listed id, 'custom', or null. TODAY: null. */
export function currentPlanId(_svc: ProviderKeyServiceDTO): string | null {
  return null
}

/** The row's "via …" words for a plan, or null to keep today's. TODAY: null. */
export function planChipText(_svc: ProviderKeyServiceDTO): string | null {
  return null
}

export type PlanPayload = { values?: Record<string, string>; plan: string; workspace?: { id: string; region: string }; replace_custom?: true }

/** The PUT body for a plan choice. TODAY: nothing is ever saved. */
export function buildPlanPayload(_input: {
  svc: ProviderKeyServiceDTO
  typed: Record<string, string>
  plan: string
  workspace?: { id: string; region: string }
  replaceCustom?: boolean
}): { ok: true; payload: PlanPayload } | { ok: false; reason: 'nothing' | 'unknown' | 'workspace' | 'custom' } {
  return { ok: false, reason: 'nothing' }
}

/** Whether a failed PUT is the daemon asking to confirm replacing a custom endpoint (409). TODAY: never. */
export function isCustomConflict(_message: string): boolean {
  return false
}
