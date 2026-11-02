import { useSyncExternalStore } from 'react'
import type { InstanceSummary } from '@shared/ipc'

// Every Prometheus Beacon keeps (docs/MULTI-PROMETHEUS.md §5), for the sidebar list and the name in the window title, the composer and
// the unreachable banner. A module singleton, not context: the readers live in different subtrees, and the list must outlive MainView,
// which remounts on every switch. Read again whenever main says a row changed or the connection Beacon is on changes.

let list: InstanceSummary[] = []
let started = false
const subs = new Set<() => void>()

async function read(): Promise<void> {
  const next = await window.beacon?.instances.list().catch(() => null)
  if (!next) return
  list = next
  subs.forEach((fn) => fn())
}

function start(): void {
  if (started || !window.beacon) return
  started = true
  window.beacon.instances.onChanged(() => void read())
  window.beacon.connection.onStatus(() => void read())
  void read()
}

export function useInstances(): InstanceSummary[] {
  return useSyncExternalStore(
    (cb) => {
      start()
      subs.add(cb)
      return () => subs.delete(cb)
    },
    () => list
  )
}
