import { useSyncExternalStore } from 'react'
import type { StallRecord } from '@shared/attention'

// Stall registry (renderer-wide module singleton) — ChatShell's reply watchdog reports here so
// Mission Control / the tray HUD can surface "the agent went quiet" beyond the open thread.
// Deliberately NOT React context: the reporter (ChatShell) and the readers (Mission, HUD) live in
// different subtrees, and a stall must survive the reporter unmounting (switching views).

let stalls: StallRecord[] = []
const subs = new Set<() => void>()
function emit(): void {
  subs.forEach((fn) => fn())
}

/** The reply watchdog fired for a session: send accepted, no assistant activity. Idempotent. */
export function reportStall(sessionId: string): void {
  if (stalls.some((s) => s.sessionId === sessionId)) return
  stalls = [...stalls, { sessionId, since: Date.now() }]
  emit()
}

/** Assistant activity arrived (or the user resent / dismissed) — the session is no longer stalled. */
export function clearStall(sessionId: string): void {
  if (!stalls.some((s) => s.sessionId === sessionId)) return
  stalls = stalls.filter((s) => s.sessionId !== sessionId)
  emit()
}

export function useStalls(): StallRecord[] {
  return useSyncExternalStore(
    (cb) => {
      subs.add(cb)
      return () => subs.delete(cb)
    },
    () => stalls
  )
}
