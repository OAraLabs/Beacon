import { rejectedKeyLine } from '@shared/this-computer'
import { useEffect, useState, type CSSProperties } from 'react'
import type { ConnectionStatus } from '@shared/ipc'
import { mismatchCard } from '@shared/pin-mismatch'

// "Can't reach Prometheus" — the way out when the saved Prometheus doesn't answer (0.3.1 Part A, R3).
// Before this, an unreachable or wrongly saved address opened the app on empty panels, and the only
// controls were a Reconnect inside the 26px rail chip's popover, which nobody new would find.
//
// It waits a few seconds before showing: a sleep/wake redial or a daemon restart is a blip, not a
// reason to put a card in front of someone. Fixed at the top-left of the main column, clear of the
// right-hand panel's native views (they draw over the page) and under the settings modal (z 70).

const SHOW_AFTER_MS = 4_000
/** For the words that name this computer: "this Mac" on macOS, "this computer" elsewhere. */
const PLATFORM = window.beacon?.platform ?? ''

const card: CSSProperties = {
  position: 'fixed',
  top: 46,
  left: 84,
  zIndex: 60,
  maxWidth: 420,
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  padding: '10px 12px',
  borderRadius: 10,
  border: '1px solid var(--c-err)',
  background: 'var(--bg-elev)',
  color: 'var(--text)',
  boxShadow: 'var(--elev-2)',
  fontSize: 12
}
const btn: CSSProperties = {
  fontSize: 12,
  padding: '5px 10px',
  borderRadius: 6,
  border: '1px solid var(--border)',
  background: 'var(--bg-input)',
  color: 'var(--text)',
  cursor: 'pointer',
  font: 'inherit'
}

/** The host part of the status's `host:port` label. The full address, not the "Local" short name:
 *  this card is where someone checks what Beacon is actually trying to reach. */
function hostOf(gateway: string | null): string {
  return (gateway ?? '').replace(/:\d+$/, '') || 'the saved address'
}

export function UnreachableBanner({ onChangeConnection, onConnectAgain }: { onChangeConnection: () => void; onConnectAgain: () => void }) {
  const [status, setStatus] = useState<ConnectionStatus>({ state: 'idle', gateway: null })
  const [downSince, setDownSince] = useState<number | null>(null)
  const [copied, setCopied] = useState(false)
  const [, tick] = useState(0)

  useEffect(() => {
    const b = window.beacon
    if (!b) return
    void b.connection.status().then(setStatus).catch(() => undefined)
    return b.connection.onStatus(setStatus)
  }, [])

  // Down = the socket has failed at least once and hasn't come back. 'connecting' alone isn't down
  // (every dial passes through it); 'idle' means there is no connection to be down.
  useEffect(() => {
    if (status.state === 'connected' || status.state === 'idle') setDownSince(null)
    else if (status.state === 'reconnecting' || status.state === 'failed') setDownSince((t) => t ?? Date.now())
  }, [status.state])

  useEffect(() => {
    if (downSince === null) return
    const left = SHOW_AFTER_MS - (Date.now() - downSince)
    if (left <= 0) return
    const t = setTimeout(() => tick((n) => n + 1), left)
    return () => clearTimeout(t)
  }, [downSince])

  // A pinned Prometheus that answered with another key (docs/MULTI-COMPUTER-v0.4.md §3.4) is not a blip: shown at once, and
  // there is no "continue anyway". Beacon sent it nothing; the way on is connecting again (a new approval and a new code).
  // Plain to the internet: Beacon will not use this address at all (src/main/plain-public.ts), so there is nothing to wait out and
  // nothing to try again; the words say what to do instead.
  if (status.refused)
    return (
      <div className="unreachable-banner" role="alert" style={card} data-testid="plain-public-card">
        <div style={{ fontWeight: 600 }}>{`Beacon won't connect to ${hostOf(status.gateway)} without encryption.`}</div>
        <div style={{ color: 'var(--text-dim)', lineHeight: 1.4 }}>{status.refused}</div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button style={btn} onClick={onChangeConnection}>
            Change connection…
          </button>
        </div>
      </div>
    )
  const wrong = mismatchCard(status)
  if (wrong)
    return (
      <div className="unreachable-banner" role="alert" style={card} data-testid="wrong-key-card">
        <div style={{ fontWeight: 600 }}>{wrong.title}</div>
        <div style={{ color: 'var(--text-dim)', lineHeight: 1.4 }}>{wrong.body}</div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button style={btn} onClick={onConnectAgain}>
            Connect again
          </button>
          <button
            style={btn}
            onClick={() =>
              void navigator.clipboard
                ?.writeText(wrong.details)
                .then(() => setCopied(true))
                .catch(() => undefined)
            }
          >
            {copied ? 'Copied' : 'Copy details'}
          </button>
        </div>
      </div>
    )
  if (downSince === null || Date.now() - downSince < SHOW_AFTER_MS) return null
  const host = hostOf(status.gateway)
  const rejected = status.state === 'failed'
  return (
    <div className="unreachable-banner" role="alert" style={card}>
      <div style={{ fontWeight: 600 }}>{`Can't reach Prometheus at ${host}.`}</div>
      <div style={{ color: 'var(--text-dim)', lineHeight: 1.4 }}>
        {rejected
          ? rejectedKeyLine(PLATFORM)
          : 'Check that its computer is on and Prometheus is running, or connect to a different one.'}
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <button style={btn} onClick={() => void window.beacon?.connection.reconnect()}>
          Try again
        </button>
        <button style={btn} onClick={onChangeConnection}>
          Change connection…
        </button>
      </div>
    </div>
  )
}
