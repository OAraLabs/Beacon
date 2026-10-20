// Chat home / landing logic (pure — no React, no DOM) so the renderer and the headless chat-home
// smoke share one source of truth. The Chat surface's "active target" is either a session id (a
// conversation is open) or null (the Home/landing — no real conversation). Launch restores the last
// session if it still exists, else shows Home; typing the first message on Home mints a session
// (the existing newChat → POST /api/sessions) and sends that message into it.

/** What the Chat surface is showing: a session id, or null = the Home/landing. */
export type ChatTarget = string | null

/** The Home/landing target (no active conversation). */
export const HOME: ChatTarget = null

/** Settings-store key holding the last real session id, for launch-restore (renderer-only, no IPC).
 *  Versioned so the persisted shape can evolve. */
export const LAST_SESSION_KEY = 'session:last:v1'

/** Launch resolution: restore the persisted last session IFF it still exists in the live list;
 *  otherwise Home. Covers first-run (no persisted id), no-session, and a stale/forgotten id. Pure. */
export function resolveLaunchTarget(
  persistedId: string | null | undefined,
  sessionIds: readonly string[]
): ChatTarget {
  return persistedId && sessionIds.includes(persistedId) ? persistedId : HOME
}

/** True when the surface is on the Home/landing (no conversation open). */
export function isHome(target: ChatTarget): boolean {
  return target === null
}

/** Orchestrates "type a first message on Home → start a conversation": trim-guard, mint a session
 *  (the existing newChat path), focus it, and hand the first message off to be sent INTO that new
 *  session. Deps are injected so this is unit-testable headlessly and free of React/DOM. Returns the
 *  minted session id, or null if the text was empty or creation failed (caller stays on Home).
 *
 *  The send itself is delegated to the conversation view (which owns the optimistic echo + idempotent
 *  client id and, crucially, has its stream subscription live before sending) — so `stageInitial`
 *  records "this session's first message" rather than firing a send that could race the subscription. */
export async function beginFromHome(
  rawText: string,
  deps: {
    createSession: () => Promise<string | null>
    open: (id: string) => void
    stageInitial: (id: string, text: string) => void
  }
): Promise<string | null> {
  const text = rawText.trim()
  if (!text) return null
  const id = await deps.createSession()
  if (!id) return null
  deps.open(id)
  deps.stageInitial(id, text)
  return id
}
