import { useEffect } from 'react'
import { needsRecheck, recheckDue, type HealthLike } from '@shared/backend-health'

// One table for the whole page: Mission and Config › Models can both be showing the same server, and neither may ask more often than
// RECHECK_MIN_MS between them.
const lastAsked = new Map<string, number>()
const inFlight = new Set<string>()

/** For an owner: ask Prometheus to check again each server whose reading is stale or was never taken (the owner route POST
 *  /api/backends/<name>/probe), at most every RECHECK_MIN_MS per server, then `reload` so the row shows what the check found. */
export function useBackendRecheck(rows: ReadonlyArray<{ name: string; health: HealthLike | null | undefined }>, enabled: boolean, reload: () => void): void {
  const due = [...new Set(rows.filter((r) => needsRecheck(r.health)).map((r) => r.name))].sort().join('\n')
  useEffect(() => {
    const b = window.beacon
    if (!b || !enabled || !due) return
    const now = Date.now()
    const ask = due.split('\n').filter((n) => !inFlight.has(n) && recheckDue(lastAsked.get(n), now))
    if (ask.length === 0) return
    for (const n of ask) {
      lastAsked.set(n, now)
      inFlight.add(n)
    }
    void Promise.allSettled(ask.map((n) => b.daemon.write(`/api/backends/${encodeURIComponent(n)}/probe`, undefined, 'POST'))).then(() => {
      for (const n of ask) inFlight.delete(n)
      reload()
    })
  }, [due, enabled, reload])
}
