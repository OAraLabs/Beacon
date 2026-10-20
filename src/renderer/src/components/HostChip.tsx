import { useEffect, useRef, useState } from 'react'
import { DEVICES_PATH } from '@shared/device-role'
import type { ConnectionStatus } from '@shared/ipc'
import { hostShortName } from '@shared/daemon-api'
import { LATENCY_WINDOW, medianMs, pushSample } from '@shared/gateway-latency'

// The host chip — ONE chip for state, host and distance: `● Local | 24ms`, full address in the
// tooltip. Used by the Chats thread header and, since 2026-09-07, by Mission's banner, which had
// been printing `Connected · 203.0.113.9:8010` in the clear. Same rules as the Chats header:
// the dot carries the state (so the word "Connected" is not spent on something you can see), the
// name is the short true identity, and the address lives where you want it the once you need it.
//
// It owns its own status subscription and latency sampler, so the two headers cannot drift. Only
// one view is mounted at a time, so the 15s sampler never runs twice.

const STATUS_LABEL: Record<ConnectionStatus['state'], string> = {
  idle: 'Idle',
  connecting: 'Connecting…',
  connected: 'Connected',
  reconnecting: 'Reconnecting…',
  failed: 'Disconnected'
}

/** How often the chip re-times the gateway. Slow on purpose: the number is context, not
 *  telemetry, and a chip that re-renders every second draws the eye to a fact that never moves. */
const LATENCY_POLL_MS = 15_000

export function HostChip() {
  const [status, setStatus] = useState<ConnectionStatus>({ state: 'idle', gateway: null })
  /** The MEDIAN of the last few timed round trips — see @shared/gateway-latency for why not the
   *  latest, and why not a mean. Null until a sample lands; the divider and value then appear. */
  const [latencyMs, setLatencyMs] = useState<number | null>(null)

  useEffect(() => {
    const b = window.beacon
    if (!b) return
    void b.connection.status().then(setStatus).catch(() => undefined)
    return b.connection.onStatus(setStatus)
  }, [])
  const limitedRef = useRef(false)
  limitedRef.current = status.role === 'limited'

  // Time the round trip to the gateway. `/api/status` is the cheapest route the daemon serves and
  // one the app hits anyway. A failed or timed-out call contributes NO sample: an error is not a
  // slow reply, and folding one in as a huge number makes a broken link look merely distant.
  useEffect(() => {
    const b = window.beacon
    if (!b) return
    let alive = true
    let window_: number[] = []
    const sample = async (): Promise<void> => {
      const t0 = performance.now()
      try {
        // An approved device may not read /api/status (Prometheus refuses it): it times GET /api/devices, which every device may.
        await b.daemon.get(limitedRef.current ? DEVICES_PATH : '/api/status')
      } catch {
        return
      }
      if (!alive) return
      window_ = pushSample(window_, performance.now() - t0, LATENCY_WINDOW)
      setLatencyMs(medianMs(window_))
    }
    // The first sample waits for the connection's status, so an approved device's first ping is one it may make.
    void b.connection
      .status()
      .then((st) => {
        limitedRef.current = st.role === 'limited'
      })
      .catch(() => undefined)
      .then(() => sample())
    const timer = setInterval(() => void sample(), LATENCY_POLL_MS)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [])

  return (
    <div
      className={`status host-chip status-${status.state}`}
      title={`${STATUS_LABEL[status.state]}${status.gateway ? ` · ${status.gateway}` : ''}`}
    >
      <span className="status-dot" />
      <span className="host-chip-name">{hostShortName(status.gateway)}</span>
      {latencyMs !== null ? (
        <>
          <span className="host-chip-div" aria-hidden />
          <span className="host-chip-lat">{latencyMs}ms</span>
        </>
      ) : null}
    </div>
  )
}
