import { useSyncExternalStore, type CSSProperties, type ReactElement } from 'react'
import { OWNER_ONLY_COPY, ownerOnlyText, type DeviceRole } from '@shared/device-role'
import type { ConnectionStatus } from '@shared/ipc'

// ONE copy of the role for the whole page, so a view mounted later knows it at its first render. A per-component copy started at null
// in every new component, and its first effects asked Prometheus for the owner's routes before the role arrived (the probe's refusal
// recorder caught Mission doing it on every visit).
//   undefined  main has not answered yet (the first moments after the page loads): owner reads wait;
//   null       main does not know (no answer from GET /api/devices yet, or one it could not read): everything shows, as before;
//   a role     owner, or an approved device ('limited').
let current: DeviceRole | null | undefined = undefined
/** The words a refused connection carries (ConnectionStatus.refused: plain to the internet), or null. */
let refusedNow: string | null = null
const listeners = new Set<() => void>()
let started = false
function start(): void {
  if (started) return
  started = true
  const b = typeof window === 'undefined' ? undefined : window.beacon
  if (!b) return
  const set = (s: ConnectionStatus): void => {
    const next = s.role ?? null
    const refused = s.refused ?? null
    if (next === current && refused === refusedNow) return
    current = next
    refusedNow = refused
    for (const l of listeners) l()
  }
  void b.connection.status().then(set).catch(() => undefined)
  b.connection.onStatus(set)
}
const subscribe = (cb: () => void): (() => void) => {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

/** Owner of this Prometheus, or an approved device (ConnectionStatus.role, @shared/device-role); null when the connection does not know,
 *  undefined until main has answered at all. */
export function useDeviceRole(): DeviceRole | null | undefined {
  start()
  return useSyncExternalStore(subscribe, () => current)
}

/** The words when Beacon will not use the connection at all (plain to the internet), or null. Nothing is asked of it then, and a page
 *  shows a calm state, never the refusal as an error. */
export function useConnectionRefused(): string | null {
  start()
  return useSyncExternalStore(subscribe, () => refusedNow)
}

/** Settings, opened at "Make this Beacon an owner" (App listens for beacon:open-settings). */
export function openMakeOwner(): void {
  window.dispatchEvent(new CustomEvent('beacon:open-settings', { detail: { section: 'make-owner' } }))
}

// Sized to what it holds: as wide as its words need (at most 460) and as tall, never stretched by the page it sits in (it was the
// height of the whole view). The auto margins centre it on a page; alignSelf keeps a flex row from stretching it, and `flex: none`
// keeps a flex column from growing it (`.surface > *` gives every view `flex: 1`).
const box: CSSProperties = {
  flex: '0 0 auto',
  margin: '32px auto',
  width: 'fit-content',
  maxWidth: 460,
  height: 'fit-content',
  alignSelf: 'flex-start',
  boxSizing: 'border-box',
  padding: '18px 20px',
  borderRadius: 10,
  border: '1px solid var(--c-line)',
  background: 'var(--c-raise)',
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
  fontSize: 13,
  lineHeight: 1.5,
  color: 'var(--c-text)'
}
const button: CSSProperties = {
  alignSelf: 'flex-start',
  fontSize: 12,
  padding: '5px 12px',
  borderRadius: 6,
  border: '1px solid var(--c-line)',
  background: 'var(--c-base)',
  color: 'var(--c-text)',
  cursor: 'pointer',
  font: 'inherit'
}

/** In place of what an approved device may not see: what it is, that it is the owner's, and the way to become one. Nothing behind it is
 *  mounted, so nothing is asked that Prometheus would refuse. `compact` sits inside a page (Mission, Devices) rather than filling it. */
export function OwnerOnlyNote({ area, compact = false }: { area: string; compact?: boolean }): ReactElement {
  return (
    <div style={compact ? { ...box, margin: 0 } : box} data-testid="owner-only-note" data-area={area}>
      <div>{ownerOnlyText(area)}</div>
      <button style={button} onClick={openMakeOwner}>
        {OWNER_ONLY_COPY.button}
      </button>
    </div>
  )
}
