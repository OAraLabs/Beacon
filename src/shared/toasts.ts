// Toasts (match spec, step 19).
//
// The rule that decides whether one should exist at all: **only for things NOT VISIBLE on the
// current surface.** A background run finished while you were elsewhere; a host went unreachable;
// an export was written. Never for something the user can already see happening — a toast
// confirming a visible action is noise, and noise is how people learn to ignore the corner of the
// screen where the important ones appear.
//
// Pure: the stack's arithmetic, so a smoke can pin the cap and the dismissal rules.

import { snippetTitle } from './session-tree'

export type ToastKind = 'ok' | 'warn' | 'error'

export interface Toast {
  id: string
  kind: ToastKind
  message: string
  /** Optional action link. The label only — the handler lives with the caller. */
  actionLabel?: string
  /** Epoch ms it was raised, for auto-dismiss. */
  at: number
}

/** At most three (match spec). More than three and the stack is a log, which is a different thing. */
export const MAX_TOASTS = 3
export const AUTO_DISMISS_MS = 5000

/**
 * Add a toast, newest LAST (the stack grows upward from the bottom-right, so last = topmost).
 *
 * When the cap is reached the OLDEST goes, not the newest: the thing that just happened is the
 * thing the user has not seen yet. Dropping it to preserve a five-second-old message would be
 * exactly backwards.
 */
export function pushToast(stack: readonly Toast[], t: Toast): Toast[] {
  return [...stack, t].slice(-MAX_TOASTS)
}

export function dismissToast(stack: readonly Toast[], id: string): Toast[] {
  return stack.filter((t) => t.id !== id)
}

/**
 * The toasts that have aged out.
 *
 * ERRORS PERSIST until dismissed (match spec). An error that vanishes after five seconds is one
 * the user can miss entirely — and the ones worth raising at all are, by the rule above, about
 * things happening off-screen, so there is no second chance to notice them.
 */
export function expired(stack: readonly Toast[], now: number, ttl = AUTO_DISMISS_MS): string[] {
  return stack.filter((t) => t.kind !== 'error' && now - t.at >= ttl).map((t) => t.id)
}

/**
 * Should this be a toast at all?
 *
 * `visibleSurface` is where the user is looking. An event about the surface they are already on
 * is visible there, so it does not get one — the export note appears in the thread header, the
 * connection dot is in the rail, and repeating either in the corner is the noise the rule bans.
 */
export function shouldToast(eventSurface: string, visibleSurface: string): boolean {
  return eventSurface !== visibleSurface
}

/**
 * The reply toast's message — `Reply in “Symbiote Harvest Hermes Agent Skills”`.
 *
 * NEVER the session id. A notice exists to be read at a glance from the corner of the eye, and
 * `Reply in “24db2e10-a896-40eb-…”` is machine syntax where a name should be (R13). The id is
 * useful nowhere in a notice, so it appears nowhere in one.
 *
 * `displayTitle` is what the list already carries: main's cache resolves daemon title → first
 * user message → id (see cache/service.ts and sessionDisplayTitle), so by the time it reaches
 * the renderer the only way it can still BE the id is a session with no title and no user
 * message at all. That case gets words, not the id. A local rename outranks the served title,
 * because it is the name the user chose.
 *
 * Capped at 40 characters on a word boundary — a toast is one line, 320px wide.
 */
export function replyToastMessage(
  displayTitle: string | null | undefined,
  localOverride: string | null | undefined,
  id: string,
  max = 40
): string {
  const pick = (localOverride ?? '').trim() || (displayTitle ?? '').trim()
  if (!pick || pick === id) return 'Reply in an untitled conversation'
  return `Reply in “${snippetTitle(pick, max)}”`
}
