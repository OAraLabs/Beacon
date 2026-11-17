import { useSyncExternalStore } from 'react'
import { STATUS_PATH, hasHomeCapability } from '@shared/home-capability'
import type { ConnectionStatus } from '@shared/ipc'

// ONE copy of "does the Prometheus Beacon is connected to advertise Home?" for the whole page (docs/HA-UI-DATA-CONTRACT.md §0), so
// the Integrations row, the approval card and the rest all agree, and a view mounted later knows it at its first render.
//
// False until the daemon has said yes, and false again at once when the connection moves to another Prometheus (its gateway
// changes) or the answer cannot be read: Home never shows on a guess. Read from the daemon's status through the bridge, and read
// again whenever the connection reports anything, at most once a second.

let current = false
let gateway: string | null | undefined
let lastRead = 0
let inflight = false
let started = false
const listeners = new Set<() => void>()

function set(next: boolean): void {
  if (next === current) return
  current = next
  for (const l of listeners) l()
}

/** Ask the daemon now (throttled to once a second; one request at a time). */
export function refreshHomeCapability(): void {
  const b = typeof window === 'undefined' ? undefined : window.beacon
  if (!b || inflight || Date.now() - lastRead < 1000) return
  inflight = true
  lastRead = Date.now()
  void b.daemon
    .get(STATUS_PATH)
    .then((s) => set(hasHomeCapability(s)), () => set(false))
    .finally(() => {
      inflight = false
    })
}

function start(): void {
  if (started) return
  started = true
  const b = typeof window === 'undefined' ? undefined : window.beacon
  if (!b) return
  const onStatus = (s: ConnectionStatus): void => {
    if (s.gateway !== gateway) {
      gateway = s.gateway
      set(false) // another Prometheus: what the last one advertised says nothing about this one
      lastRead = 0
    }
    if (s.role === 'limited') return set(false) // an approved device is refused the owner's status, and Home is the owner's
    refreshHomeCapability()
  }
  void b.connection.status().then(onStatus).catch(() => undefined)
  b.connection.onStatus(onStatus)
}

const subscribe = (cb: () => void): (() => void) => {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

/** True only while the connected Prometheus advertises Home. */
export function useHomeCapability(): boolean {
  start()
  return useSyncExternalStore(subscribe, () => current)
}
