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
}

const SLUG = /^[a-z0-9][a-z0-9-]{0,31}$/
/** A workspace id: the daemon builds `ws-<id>.<region>…` from it, so one valid hostname label once prefixed: no dots or slashes,
 *  no leading/trailing hyphen, at most 60 characters (the daemon checks again, more strictly if it likes). */
const WORKSPACE_ID = /^[a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])?$/

/** Whether the daemon serves plans: `capabilities.plans` is a number >= 1. Anything else is today's key-only rows. */
export function plansSupported(catalog: unknown): boolean {
  const caps = (catalog as { capabilities?: unknown } | null)?.capabilities
  const n = caps && typeof caps === 'object' ? (caps as Record<string, unknown>).plans : undefined
  return typeof n === 'number' && n >= 1
}

/**
 * A service's plans, checked, or null. A plan whose id isn't a plain slug, or whose fields are the wrong type, is dropped; a list
 * without exactly one default is not trusted at all (null), and neither is an empty one: the row then stays key-only, as today.
 */
export function servicePlans(svc: ProviderKeyServiceDTO): PlanDTO[] | null {
  if (!Array.isArray(svc.plans)) return null
  const plans: PlanDTO[] = []
  for (const raw of svc.plans as unknown[]) {
    const p = raw as Record<string, unknown> | null
    if (!p || typeof p.id !== 'string' || !SLUG.test(p.id) || typeof p.label !== 'string' || !p.label.trim()) continue
    if (plans.some((x) => x.id === p.id)) continue // a duplicate id: the first one stands
    plans.push({
      id: p.id,
      label: p.label.trim(),
      subscription: p.subscription === true,
      terms: typeof p.terms === 'string' && p.terms.trim() ? p.terms.trim() : null,
      default: p.default === true,
      custom: p.custom === true
    })
  }
  if (plans.length === 0 || plans.filter((p) => p.default).length !== 1) return null
  return plans
}

/** The regions a workspace plan can be in: the catalog's top-level `workspace_regions`, slugs only. */
export function workspaceRegions(catalog: unknown): string[] {
  const r = (catalog as { workspace_regions?: unknown } | null)?.workspace_regions
  return Array.isArray(r) ? r.filter((x): x is string => typeof x === 'string' && SLUG.test(x)) : []
}

/** prometheus.yaml pins this provider's endpoint: the daemon refuses a plan change (409), so Beacon offers none. */
export function planPinned(svc: ProviderKeyServiceDTO): boolean {
  return (svc as { plan_pinned_in_config?: unknown }).plan_pinned_in_config === true
}

/** The daemon's notes about unattended routes running on a subscription plan: shown, never blocking. */
export function planWarnings(svc: ProviderKeyServiceDTO): string[] {
  const w = (svc as { warnings?: unknown }).warnings
  return Array.isArray(w) ? w.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).map((x) => x.trim().slice(0, 300)).slice(0, 5) : []
}

/** The plan a service is on: a listed id; 'custom' for an endpoint that matches none (or an id the list lacks, never guessed);
 *  the default's id when the daemon says nothing; null with no trusted list. */
export function currentPlanId(svc: ProviderKeyServiceDTO): string | null {
  const plans = servicePlans(svc)
  if (!plans) return null
  // No `plan` from a daemon that set an endpoint: treat it as custom, so nothing clears a hand-set endpoint without the confirm.
  if (typeof svc.plan !== 'string') return svc.endpoint_set === true ? 'custom' : plans.find((p) => p.default)!.id
  if (svc.plan === 'custom') return 'custom'
  return plans.some((p) => p.id === svc.plan) ? svc.plan : 'custom'
}

/** The row's "via …" words: the subscription plan's name once its key is saved ("Token Plan"), "a custom endpoint" for one, else
 *  null (today's chip: "configured" / "via API key"). */
export function planChipText(svc: ProviderKeyServiceDTO): string | null {
  const current = currentPlanId(svc)
  if (current === null) return null
  const keyed = svc.env_vars.every((v) => v.set)
  if (current === 'custom') return keyed ? 'a custom endpoint' : null // no key: today's "no key" chip says what matters
  const plan = servicePlans(svc)!.find((p) => p.id === current)
  return keyed && plan?.subscription ? plan.label : null
}

export type PlanPayload = { values: Record<string, string>; plan: string; workspace?: { id: string; region: string }; replace_custom?: true }
export type KeyOrPlanPayload = PlanPayload | { values: Record<string, string> }

/**
 * The PUT body for the sheet. Built ONLY from what the person picked and typed (the never-prefill rule of @shared/model-keys).
 * - Staying on the plan it is on (a custom endpoint included): a typed key alone is {values}, as today; nothing typed, nothing.
 * - Any plan change (a workspace's id or region included) is saved WITH its key: a plan's host takes only that plan's key, and the
 *   daemon refuses a plan alone (400). So a plan change with no key typed is 'needs-key', and the saved key is never moved.
 * - A plan the daemon did not list: refused. A workspace id that isn't one hostname label, or a region not in the catalog's list:
 *   refused. Moving off a custom endpoint needs the person's confirm (`replaceCustom`), which the daemon also insists on (409).
 * Never a URL.
 */
export function buildPlanPayload(input: {
  svc: ProviderKeyServiceDTO
  typed: Record<string, string>
  plan: string
  workspace?: { id: string; region: string }
  regions?: string[]
  replaceCustom?: boolean
  /** The plan is pinned in prometheus.yaml (planPinned): only a new key for the current plan, never a plan or workspace change. */
  pinned?: boolean
}): { ok: true; payload: KeyOrPlanPayload } | { ok: false; reason: 'nothing' | 'unknown' | 'workspace' | 'custom' | 'needs-key' } {
  const plans = servicePlans(input.svc)
  const values: Record<string, string> = {}
  for (const v of input.svc.env_vars) {
    const t = (input.typed[v.name] ?? '').trim()
    if (t) values[v.name] = t
  }
  const current = currentPlanId(input.svc)
  const typedKey = Object.keys(values).length > 0
  if (input.pinned) return typedKey ? { ok: true, payload: { values } } : { ok: false, reason: 'nothing' }
  const plan = plans?.find((p) => p.id === input.plan)
  const workspaceGiven = !!plan?.custom && !!((input.workspace?.id ?? '').trim() || input.workspace?.region)
  if (plans && input.plan === current && !workspaceGiven) return typedKey ? { ok: true, payload: { values } } : { ok: false, reason: 'nothing' }
  if (!plans || !plan) return { ok: false, reason: 'unknown' }
  let workspace: { id: string; region: string } | undefined
  if (plan.custom) {
    const ws = input.workspace
    const id = ws?.id.trim().toLowerCase() ?? ''
    if (!ws || !WORKSPACE_ID.test(id) || !(input.regions ?? []).includes(ws.region)) return { ok: false, reason: 'workspace' }
    workspace = { id, region: ws.region }
  }
  if (!typedKey) return { ok: false, reason: 'needs-key' }
  if (current === 'custom' && !input.replaceCustom) return { ok: false, reason: 'custom' }
  return {
    ok: true,
    payload: {
      values,
      plan: plan.id,
      ...(workspace ? { workspace } : {}),
      ...(current === 'custom' ? { replace_custom: true as const } : {})
    }
  }
}

/** Whether a failed PUT is the daemon asking to confirm replacing a custom endpoint (its 409). The renderer gets Electron's wrapper
 *  ("Error invoking remote method 'daemon:write': Error: HTTP 409: …"), stripped first, the way the other readers do. */
export function isCustomConflict(message: string): boolean {
  const bare = message.replace(/^Error invoking remote method '[^']*': (?:Error: )?/, '')
  return /^HTTP 409\b/.test(bare)
}
