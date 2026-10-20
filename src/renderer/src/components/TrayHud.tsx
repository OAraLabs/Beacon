import { useEffect, useState } from 'react'
import type { ApprovalRequest, ConnectionStatus } from '@shared/ipc'
import { fmtUptime, type AgentStatusDTO } from '@shared/daemon-api'
import { eventRowTs, type EventRow } from '@shared/gateway-events'

/** Menu-bar HUD (harness sprint #8) — the popover behind the Pulse tray icon: glanceable status
 * without summoning the window. Hash-routed like QuickCapture (#hud → this, decided in main.tsx);
 * the window is created/positioned by main (tray click), hidden on blur/Esc, never destroyed.
 * Reads the SAME surfaces Mission does: connection, /api/status, approvals, outbox, last event.
 * (Stalled sessions live in the main window's renderer store — surfacing them here needs a small
 * main-process mirror; deliberate follow-up, not silently faked.) */

const MONO = 'var(--font-mono, ui-monospace, Menlo, monospace)'
const POLL_MS = 5_000

function rel(ms: number): string {
  const s = Math.floor((Date.now() - ms) / 1000)
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  return `${Math.floor(m / 60)}h ago`
}

const STATE_DOT: Record<ConnectionStatus['state'], string> = {
  connected: 'var(--c-ok)',
  connecting: 'var(--c-warn)',
  reconnecting: 'var(--c-warn)',
  failed: 'var(--c-err)',
  idle: 'var(--c-idle)'
}

export function TrayHud() {
  const [conn, setConn] = useState<ConnectionStatus>({ state: 'idle', gateway: null })
  const [status, setStatus] = useState<AgentStatusDTO | null>(null)
  const [approvals, setApprovals] = useState<ApprovalRequest[]>([])
  const [outboxFailed, setOutboxFailed] = useState(0)
  const [lastEvent, setLastEvent] = useState<{ label: string; ts: number } | null>(null)

  useEffect(() => {
    const b = window.beacon
    if (!b) return
    const load = (): void => {
      void b.connection.status().then(setConn).catch(() => undefined)
      // An approved device may not read /api/status (Prometheus refuses it), so it is not asked, and the line below says so plainly.
      void b.connection
        .status()
        .then((c) => (c.role === 'limited' ? null : b.daemon.get('/api/status').then((d) => setStatus((d as AgentStatusDTO) ?? null))))
        .catch(() => setStatus(null))
      void b.approvals.list().then(setApprovals).catch(() => undefined)
      void b.outbox.status().then((o) => setOutboxFailed(o.failed)).catch(() => undefined)
      void b.events
        .recent(1)
        .then((rows: EventRow[]) => {
          const r = rows[0]
          if (r) setLastEvent({ label: r.signal_type ?? 'event', ts: eventRowTs(r.timestamp) })
        })
        .catch(() => undefined)
    }
    load()
    const iv = setInterval(load, POLL_MS)
    const offStatus = b.connection.onStatus(setConn)
    const onKey = (e: KeyboardEvent): void => {
      // Destroys the HUD window (a renderer window.close() bypasses main's cancelable 'close' —
      // measured, Electron 33); the next tray click recreates it. Fine for a transient popover:
      // it holds no view and no pty, so destroy-and-recreate is the cheaper, fresher lifecycle.
      if (e.key === 'Escape') window.close()
    }
    window.addEventListener('keydown', onKey)
    return () => {
      clearInterval(iv)
      offStatus()
      window.removeEventListener('keydown', onKey)
    }
  }, [])

  const needs = approvals.length + (outboxFailed > 0 ? 1 : 0)

  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column', padding: '14px 16px 12px', gap: 12, boxSizing: 'border-box' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ width: 8, height: 8, borderRadius: '50%', background: STATE_DOT[conn.state], flex: 'none' }} />
        <span style={{ fontFamily: 'var(--font-display)', fontSize: 17, fontWeight: 600, color: 'var(--c-text)' }}>Beacon</span>
        <span style={{ marginLeft: 'auto', fontFamily: MONO, fontSize: 10, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--c-text-faint)' }}>
          {conn.state}
        </span>
      </div>

      {conn.role === 'limited' ? (
        <div style={{ fontSize: 11, color: 'var(--c-text-dim)', lineHeight: 1.4 }}>Approved device: Prometheus&apos;s model and status are for its owner.</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
          <span style={{ fontFamily: MONO, fontSize: 12, color: 'var(--c-text-dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {status?.model ?? '—'}
          </span>
          <span style={{ fontFamily: MONO, fontSize: 10, color: 'var(--c-text-faint)' }}>
            {status ? `${status.provider ?? '—'} · up ${fmtUptime(status.uptime_seconds)}` : 'daemon unreachable'}
          </span>
        </div>
      )}

      <div
        style={{
          border: '1px solid var(--c-line)',
          borderColor: needs > 0 ? 'var(--c-amber)' : 'var(--c-line)',
          borderRadius: 'var(--r-3)',
          padding: '10px 12px',
          display: 'flex',
          alignItems: 'baseline',
          gap: 8
        }}
      >
        <span style={{ fontFamily: MONO, fontSize: 20, fontVariantNumeric: 'tabular-nums', color: needs > 0 ? 'var(--c-amber)' : 'var(--c-text)' }}>{needs}</span>
        <span style={{ fontSize: 12, color: 'var(--c-text-dim)' }}>
          need{needs === 1 ? 's' : ''} you
          {approvals.length > 0 ? ` · ${approvals.length} approval${approvals.length === 1 ? '' : 's'}` : ''}
          {outboxFailed > 0 ? ` · ${outboxFailed} failed send${outboxFailed === 1 ? '' : 's'}` : ''}
        </span>
      </div>

      <div style={{ fontFamily: MONO, fontSize: 10, color: 'var(--c-text-faint)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {lastEvent ? `last: ${lastEvent.label} · ${rel(lastEvent.ts)}` : 'no recent signals'}
      </div>

      <button
        style={{
          marginTop: 'auto',
          font: 'inherit',
          fontSize: 13,
          padding: '8px 12px',
          borderRadius: 'var(--r-2)',
          border: '1px solid var(--c-line)',
          background: 'var(--c-inset)',
          color: 'var(--c-text)',
          cursor: 'pointer'
        }}
        onClick={() => window.beacon?.capture.openMain('')}
      >
        Open Beacon
      </button>
    </div>
  )
}
