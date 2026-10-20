import { NOT_ENCRYPTED_NOTICE } from '@shared/plain-lan'
import { useEffect, useState, type CSSProperties } from 'react'
import type { ConnectionStatus, OutboxStatus } from '@shared/ipc'
import { connIndicatorView } from '@shared/daemon-api'
import { Icon } from './Icon'

// Global connection indicator (Slice 1) — lives in the NavRail FOOT so the link state is visible
// from EVERY view, not just Chat. The dot mirrors the WS state; the amber lock appears when REST
// calls are being 401'd (ConnectionStatus.restAuth) — the WS is unauthenticated, so "connected"
// alone can lie about a rejected token. Click → popover with gateway, outbox, Reconnect + Settings.
//
// PRESENTATION (design handoff R1, 2026-09-03): the foot is "the host identity chip and health dot".
// So this renders a 26px round chip carrying a short identity for the host, with the state dot
// beneath it — replacing the old dot + "ONLINE" word. The popover is unchanged: same gateway,
// outbox, Reconnect and Settings, same click target, just a smaller and quieter trigger.

/**
 * A SHORT, TRUE identity for the gateway host — never an invented one.
 *
 * The prototype shows "NX" because its mock host is named NOX. We have no host NAME: the renderer
 * only ever sees `host:port` (a name is not carried on ConnectionStatus). So: a named host gives
 * its first two letters, and a bare IP gives its last octet, which is the fragment that actually
 * distinguishes two boxes on one subnet. Neither is a guess, and the full address is in the title.
 */
export function hostChipLabel(gateway: string | null | undefined): string {
  const host = (gateway ?? '').split('/').pop()?.split(':')[0]?.trim() ?? ''
  if (!host) return '··'
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return host.split('.')[3]
  const letters = host.replace(/[^a-z0-9]/gi, '')
  return letters ? letters.slice(0, 2).toUpperCase() : '··'
}

const OUTBOX_POLL_MS = 10_000

const pop: CSSProperties = {
  position: 'fixed',
  left: 72,
  bottom: 10,
  zIndex: 60,
  width: 248,
  background: 'var(--bg-elev)',
  border: '1px solid var(--border)',
  borderRadius: 10,
  padding: 12,
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  fontSize: 12,
  color: 'var(--text)',
  boxShadow: 'var(--elev-2)'
}
const popBtn = (warn = false): CSSProperties => ({
  flex: 1,
  fontSize: 12,
  padding: '6px 10px',
  borderRadius: 6,
  border: `1px solid ${warn ? 'var(--c-amber)' : 'var(--border)'}`,
  background: warn ? 'var(--c-amber-soft)' : 'var(--bg-input)',
  color: warn ? 'var(--c-amber)' : 'var(--text)',
  cursor: 'pointer',
  font: 'inherit'
})

function since(ms?: number): string {
  if (!ms) return ''
  const s = Math.floor((Date.now() - ms) / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  return `${Math.floor(m / 60)}h`
}

export function ConnectionIndicator() {
  const [status, setStatus] = useState<ConnectionStatus>({ state: 'idle', gateway: null })
  const [outbox, setOutbox] = useState<OutboxStatus>({ pending: 0, failed: 0 })
  const [open, setOpen] = useState(false)

  useEffect(() => {
    const b = window.beacon
    if (!b) return
    b.connection.status().then(setStatus).catch(() => undefined)
    const off = b.connection.onStatus(setStatus)
    const pollOutbox = (): void => {
      void b.outbox.status().then(setOutbox).catch(() => undefined)
    }
    pollOutbox()
    const id = setInterval(pollOutbox, OUTBOX_POLL_MS)
    return () => {
      off()
      clearInterval(id)
    }
  }, [])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  const v = connIndicatorView(status)
  const queued = outbox.pending + outbox.failed

  return (
    <>
      <div className="rail-foot-rule" aria-hidden />
      <button
        className="host-chip-btn"
        onClick={() => setOpen((o) => !o)}
        title={`${status.gateway ?? 'no gateway'} — ${v.short}${v.authBad ? ' · token rejected (401)' : ''}${status.notEncrypted ? ` · ${NOT_ENCRYPTED_NOTICE}` : ''}${queued > 0 ? ` · ${queued} queued` : ''}`}
        aria-label={`Connection status: ${v.short}${status.gateway ? ` (${status.gateway})` : ''}`}
        aria-expanded={open}
      >
        {/* `.rail-host`, NOT `.host-chip` — the thread header owns that name for a different
            control, and two components sharing one class meant whichever block came last in the
            stylesheet styled both. */}
        <span className="rail-host">{hostChipLabel(status.gateway)}</span>
        <span className={`status-${status.state}`} style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
          <span className="status-dot" />
          {v.authBad ? (
            <span style={{ color: 'var(--c-amber)', display: 'inline-flex' }} aria-hidden>
              <Icon name="lock" size={10} />
            </span>
          ) : null}
          {queued > 0 ? <span style={{ color: 'var(--c-warn-text)', fontSize: 9, lineHeight: 1 }}>{queued}</span> : null}
        </span>
      </button>

      {open ? (
        <>
          <div style={{ position: 'fixed', inset: 0, zIndex: 59 }} onClick={() => setOpen(false)} />
          <div style={pop} role="dialog" aria-label="Connection details">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
              <span className={`status-${status.state}`} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontWeight: 600 }}>
                <span className="status-dot" />
                {v.short}
              </span>
              <span style={{ color: 'var(--text-dim)', fontSize: 11 }}>
                {status.since ? `for ${since(status.since)}` : ''}
                {status.state === 'reconnecting' && status.attempt ? ` · try ${status.attempt}` : ''}
              </span>
            </div>
            <div style={{ color: 'var(--text-dim)', fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={status.gateway ?? ''}>
              {status.gateway ?? 'no gateway configured'}
            </div>

            {status.notEncrypted ? (
              <div data-testid="not-encrypted-notice" style={{ color: 'var(--c-amber)', fontSize: 12, lineHeight: 1.4 }}>
                {NOT_ENCRYPTED_NOTICE}
              </div>
            ) : null}

            {v.authBad ? (
              <div style={{ border: '1px solid var(--c-amber)', background: 'var(--c-amber-soft)', color: 'var(--c-amber)', borderRadius: 6, padding: '6px 9px', fontSize: 12, lineHeight: 1.4 }}>
                The gateway is rejecting the token (401). REST reads/writes are failing even though the
                event stream may still flow.
              </div>
            ) : null}

            {queued > 0 ? (
              <div style={{ color: 'var(--text-dim)', fontSize: 12 }}>
                Outbox: {outbox.pending} pending{outbox.failed > 0 ? ` · ${outbox.failed} failed` : ''}
              </div>
            ) : null}

            <div style={{ display: 'flex', gap: 6 }}>
              <button style={popBtn()} onClick={() => void window.beacon?.connection.reconnect()}>
                Reconnect
              </button>
              <button
                style={popBtn(v.authBad)}
                onClick={() => {
                  setOpen(false)
                  window.dispatchEvent(new CustomEvent('beacon:open-settings', { detail: { section: 'connection' } })) // the address and key, open
                }}
              >
                Open Settings
              </button>
            </div>
          </div>
        </>
      ) : null}
    </>
  )
}
