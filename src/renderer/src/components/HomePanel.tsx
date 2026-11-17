import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'
import {
  GRANTS_PATH,
  HOME_DEVICES_PATH,
  HOME_STATUS_PATH,
  askOnceBody,
  askOnceDialog,
  askOncePath,
  coerceDevices,
  coerceGrants,
  coerceStatus,
  deviceRowView,
  filterDevices,
  grantRowView,
  groupByRoom,
  revokeDialog,
  revokePath,
  statusLine,
  statusTone,
  unavailableLine,
  writeFailureLine,
  type HomeGrantRow,
  type HomeStatus,
  type TierFilter,
  type TouchDevice
} from '@shared/home-devices'
import { Icon } from './Icon'
import { HomeTierBadge } from './HomeTierBadge'
import { useDialogFocus } from './useDialogFocus'
import { HomeActivity } from './HomeActivity'
import { useHomeCapability } from '../home-capability-store'

// Integrations → Home: what Prometheus can touch in the house (docs/HA-UI-DATA-CONTRACT.md §3.2).
//
// An oversight screen, not a remote control: there is no on/off for any device here, because Home Assistant
// already has one and Prometheus's gate and log would be bypassed by a second. Each device offers "Open in
// Home Assistant" for that. What this screen does offer is the agent's side of the house: the connection,
// every device with its tier, "Ask once" for a Sensitive device (the next approval for it may offer Always
// allow; nothing is granted by the click), and the list of everything always allowed, with Revoke, first,
// because it is the main trust control.
//
// Everything arrives through the daemon (the Home routes and the approval grants), read through the daemon
// bridge; this file never names a Home Assistant address. Tiers are a word and a shape, never colour alone.

const b = window.beacon

const card: CSSProperties = { background: 'var(--c-base)', border: '1px solid var(--c-line)', borderRadius: 10, padding: 14 }
const cardTitle: CSSProperties = { fontSize: 11, textTransform: 'uppercase', letterSpacing: 1, color: 'var(--c-text-faint)', marginBottom: 8, display: 'flex', gap: 8, alignItems: 'baseline' }
const dim: CSSProperties = { color: 'var(--c-text-dim)', fontSize: 12 }
const btn = (primary = false): CSSProperties => ({ padding: '4px 10px', borderRadius: 6, cursor: 'pointer', fontSize: 12, border: `1px solid ${primary ? 'var(--c-arc)' : 'var(--c-line)'}`, background: 'var(--c-inset)', color: 'var(--c-text)', font: 'inherit' })
const link: CSSProperties = { color: 'var(--lapis-text)', fontSize: 12, textDecoration: 'underline', whiteSpace: 'nowrap' }
const dot = (color: string): CSSProperties => ({ display: 'inline-block', width: 8, height: 8, borderRadius: 4, background: color, flexShrink: 0 })

const REFRESH_MS = 15_000
const FILTERS: { id: TierFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'ordinary', label: 'Ordinary' },
  { id: 'sensitive', label: 'Sensitive' },
  { id: 'critical', label: 'Critical' }
]

type Dialog = { kind: 'ask-once'; device: TouchDevice; enabled: boolean } | { kind: 'revoke'; grant: HomeGrantRow }

function Confirm({ title, body, confirmLabel, busy, error, onConfirm, onCancel }: { title: string; body: string; confirmLabel: string; busy: boolean; error: string | null; onConfirm: () => void; onCancel: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  useDialogFocus(ref, onCancel)
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 72, background: 'var(--c-scrim)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        data-testid="home-dialog"
        style={{ width: 'min(440px, 94vw)', background: 'var(--c-raise)', border: '1px solid var(--c-line)', borderRadius: 12, padding: 18, display: 'flex', flexDirection: 'column', gap: 12 }}
      >
        <div style={{ fontSize: 14, fontWeight: 600 }}>{title}</div>
        <div style={{ fontSize: 13, color: 'var(--c-text-dim)', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{body}</div>
        {error ? <div role="alert" style={{ fontSize: 12, color: 'var(--c-err-text)', overflowWrap: 'anywhere' }}>{error}</div> : null}
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button style={btn()} onClick={onCancel}>Cancel</button>
          <button style={btn(true)} onClick={onConfirm} disabled={busy}>{busy ? 'Working…' : confirmLabel}</button>
        </div>
      </div>
    </div>
  )
}

function OpenLink({ url, label = 'Open in Home Assistant' }: { url: string | null; label?: string }) {
  return url ? (
    <a href={url} target="_blank" rel="noopener noreferrer" style={link} data-testid="home-open" data-url={url}>
      {label}
    </a>
  ) : (
    <span style={{ ...dim, fontSize: 11 }} data-testid="home-open-none" title="Prometheus did not send a link for this one">No link</span>
  )
}

export function HomePanel() {
  const capable = useHomeCapability() // the same rule as the Integrations row: no Home unless this Prometheus advertises it
  const [status, setStatus] = useState<HomeStatus | null>(null)
  const [unavailable, setUnavailable] = useState<{ kind: string; text: string } | null>(null)
  const [devices, setDevices] = useState<TouchDevice[] | null>(null)
  const [devicesErr, setDevicesErr] = useState<string | null>(null)
  const [grants, setGrants] = useState<HomeGrantRow[] | null>(null)
  const [grantsErr, setGrantsErr] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [tier, setTier] = useState<TierFilter>('all')
  const [dialog, setDialog] = useState<Dialog | null>(null)
  const [busy, setBusy] = useState(false)
  const [writeErr, setWriteErr] = useState<string | null>(null)
  const [section, setSection] = useState<'devices' | 'activity'>('devices')

  const load = useCallback(async (): Promise<void> => {
    // The status decides whether there is a Home at all: a 404 or a 403 here is said in words and the rest is not asked.
    try {
      const s = coerceStatus(await b.daemon.get(HOME_STATUS_PATH))
      if (!s) throw new Error('Home status was not understood')
      setStatus(s)
      setUnavailable(null)
    } catch (e) {
      setUnavailable(unavailableLine(e))
      return
    }
    await Promise.all([
      b.daemon.get(HOME_DEVICES_PATH).then(
        (raw) => {
          const d = coerceDevices(raw)
          if (d) { setDevices(d.devices); setDevicesErr(null) } else setDevicesErr('The device list was not understood.')
        },
        (e) => setDevicesErr(unavailableLine(e).text)
      ),
      b.daemon.get(GRANTS_PATH).then(
        (raw) => { setGrants(coerceGrants(raw)); setGrantsErr(null) },
        (e) => setGrantsErr(unavailableLine(e).text)
      )
    ])
  }, [])

  useEffect(() => {
    if (!capable) return
    void load()
    const t = setInterval(() => void load(), REFRESH_MS)
    return () => clearInterval(t)
  }, [load, capable])

  const close = useCallback(() => {
    setDialog(null)
    setWriteErr(null)
    setBusy(false)
  }, [])

  const confirm = async (): Promise<void> => {
    if (!dialog) return
    setBusy(true)
    setWriteErr(null)
    try {
      if (dialog.kind === 'ask-once') await b.daemon.write(askOncePath(dialog.device.id), askOnceBody(dialog.enabled), 'PUT')
      else await b.daemon.write(revokePath(dialog.grant.id), undefined, 'DELETE')
      close()
      await load()
    } catch (e) {
      setBusy(false)
      setWriteErr(writeFailureLine(e))
    }
  }

  if (!capable) return null

  if (unavailable) {
    return (
      <div style={card} data-testid="home-unavailable" data-kind={unavailable.kind} role="status">
        <div style={cardTitle}>Home</div>
        <div style={{ fontSize: 13 }}>{unavailable.text}</div>
      </div>
    )
  }

  const shown = devices ? filterDevices(devices, { query, tier }) : []
  const groups = groupByRoom(shown)
  const tone = status ? statusTone(status) : null
  const toneDot = tone === 'ok' ? 'var(--online)' : tone === 'warn' ? 'var(--c-warn)' : 'var(--c-err)'
  const toneText = tone === 'ok' ? 'var(--c-ok-text)' : tone === 'warn' ? 'var(--c-warn-text)' : 'var(--c-err-text)'
  const dlg = dialog ? (dialog.kind === 'ask-once' ? askOnceDialog(dialog.device, dialog.enabled) : revokeDialog(dialog.grant)) : null

  return (
    <>
      <div style={{ ...card, display: 'flex', alignItems: 'center', gap: 10 }} data-testid="home-status" data-state={status?.state ?? 'loading'}>
        {status ? (
          <>
            <span style={dot(toneDot)} aria-hidden />
            <span style={{ flex: 1, fontSize: 13, color: toneText }} role="status">{statusLine(status)}</span>
            <OpenLink url={status.openUrl} label="Open Home Assistant" />
          </>
        ) : (
          <span style={dim}>Checking Home Assistant…</span>
        )}
      </div>

      <div role="tablist" aria-label="Home" style={{ display: 'flex', gap: 6 }}>
        {([['devices', 'What it can touch'], ['activity', 'Activity']] as const).map(([id, label]) => (
          <button
            key={id}
            role="tab"
            id={`home-tab-${id}`}
            aria-selected={section === id}
            aria-controls={`home-panel-${id}`}
            tabIndex={section === id ? 0 : -1}
            style={{ ...btn(section === id), background: section === id ? 'var(--c-arc-soft)' : 'var(--c-inset)' }}
            onClick={() => setSection(id)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
                e.preventDefault()
                const next = id === 'devices' ? 'activity' : 'devices'
                setSection(next)
                document.getElementById(`home-tab-${next}`)?.focus()
              }
            }}
          >
            {label}
          </button>
        ))}
      </div>

      {section === 'activity' ? (
        <div role="tabpanel" id="home-panel-activity" aria-labelledby="home-tab-activity">
          <HomeActivity devices={devices} />
        </div>
      ) : (
        <div role="tabpanel" id="home-panel-devices" aria-labelledby="home-tab-devices" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* The main trust control, so it comes first and is never collapsed. */}
      <section style={card} aria-labelledby="home-always-title" data-testid="home-always">
        <div style={cardTitle}>
          <span id="home-always-title">Always allowed</span>
          {grants ? <span style={{ letterSpacing: 0, textTransform: 'none', color: 'var(--ink4)' }}>{grants.length}</span> : null}
        </div>
        {grantsErr ? <div style={{ fontSize: 12, color: 'var(--c-err-text)' }}>{grantsErr}</div> : null}
        {grants && grants.length === 0 ? <div style={dim}>Nothing is always allowed.</div> : null}
        {(grants ?? []).map((g, i) => {
          const v = grantRowView(g)
          return (
            <div key={`${v.id}:${i}`} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 0', borderTop: i ? '1px solid var(--c-line)' : 'none' }} data-testid="home-grant">
              <HomeTierBadge tier={v.tier} />
              <div style={{ flex: 1, minWidth: 0 }}>
                {v.devicesLabel ? <div style={{ fontSize: 13 }}>{v.devicesLabel}</div> : null}
                <div style={{ ...dim, overflowWrap: 'anywhere' }}>{v.describes}</div>
                {v.createdAt ? <div style={{ ...dim, fontSize: 11 }}>Allowed {new Date(v.createdAt).toLocaleDateString()}</div> : null}
              </div>
              {v.canRevoke ? (
                <button style={btn()} onClick={() => setDialog({ kind: 'revoke', grant: g })} aria-label={`Revoke ${v.devicesLabel ?? v.describes}`}>Revoke</button>
              ) : (
                <span style={{ ...dim, fontSize: 11 }}>Can’t be revoked from here</span>
              )}
            </div>
          )
        })}
      </section>

      <section style={card} aria-labelledby="home-devices-title" data-testid="home-devices">
        <div style={cardTitle}>
          <span id="home-devices-title">Devices</span>
          {devices ? <span style={{ letterSpacing: 0, textTransform: 'none', color: 'var(--ink4)' }}>{shown.length === devices.length ? devices.length : `${shown.length} of ${devices.length}`}</span> : null}
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10, alignItems: 'center' }}>
          <input
            type="search"
            aria-label="Search devices"
            placeholder="Search by name or room"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            style={{ flex: '1 1 200px', minWidth: 160, background: 'var(--c-inset)', border: '1px solid var(--c-line)', borderRadius: 6, padding: '5px 8px', color: 'var(--c-text)', font: 'inherit', fontSize: 12 }}
          />
          <div role="group" aria-label="Filter by tier" style={{ display: 'flex', gap: 6 }}>
            {FILTERS.map((f) => (
              <button
                key={f.id}
                style={{ ...btn(tier === f.id), background: tier === f.id ? 'var(--c-arc-soft)' : 'var(--c-inset)' }}
                aria-pressed={tier === f.id}
                onClick={() => setTier(f.id)}
                data-testid={`home-filter-${f.id}`}
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>
        {devicesErr ? <div style={{ fontSize: 12, color: 'var(--c-err-text)' }}>{devicesErr}</div> : null}
        {devices === null && !devicesErr ? <div style={dim}>loading…</div> : null}
        {devices && devices.length === 0 ? <div style={dim}>Home Assistant has no devices Prometheus can see.</div> : null}
        {devices && devices.length > 0 && shown.length === 0 ? <div style={dim}>No devices match.</div> : null}
        {groups.map((g) => (
          <div key={g.label} style={{ marginTop: 8 }} data-testid="home-room" data-room={g.label}>
            <div style={{ fontSize: 12, fontWeight: 600, margin: '4px 0' }}>
              {g.label} <span style={{ ...dim, fontWeight: 400 }}>{g.devices.length}</span>
            </div>
            {g.devices.map((d) => {
              const v = deviceRowView(d)
              return (
                <div key={d.id} style={{ padding: '5px 0', borderTop: '1px solid var(--c-line)' }} data-testid="home-device" data-tier={v.tier} data-name={v.name}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', minWidth: 0 }}>
                    <HomeTierBadge tier={v.tier} />
                    <span style={{ fontSize: 13, flex: '1 1 160px', minWidth: 0, overflowWrap: 'anywhere' }}>
                      {v.name}
                      {d.kind ? <span style={{ ...dim, marginLeft: 6 }}>{d.kind}</span> : null}
                    </span>
                    <span style={{ ...dim, fontFamily: 'var(--font-mono, monospace)', minWidth: 70 }} data-testid="home-device-state">{v.stateText}</span>
                    {v.readOnly ? (
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12 }} data-testid="home-readonly">
                        <Icon name="lock" size={12} /> Read only
                      </span>
                    ) : v.askOnce === 'offer' ? (
                      <button style={btn()} onClick={() => setDialog({ kind: 'ask-once', device: d, enabled: true })} aria-label={`Ask once for ${v.name}`}>Ask once…</button>
                    ) : v.askOnce === 'on' ? (
                      <>
                        <span style={{ fontSize: 12, color: 'var(--c-text)' }} data-testid="home-askonce-on">Ask once on</span>
                        <button style={btn()} onClick={() => setDialog({ kind: 'ask-once', device: d, enabled: false })} aria-label={`Ask every time for ${v.name}`}>Ask every time…</button>
                      </>
                    ) : null}
                    <OpenLink url={v.openUrl} />
                  </div>
                  {v.note ? <div style={{ ...dim, fontSize: 11, marginTop: 3 }}>{v.note}</div> : null}
                </div>
              )
            })}
          </div>
        ))}
      </section>

        </div>
      )}

      {dialog && dlg ? <Confirm title={dlg.title} body={dlg.body} confirmLabel={dlg.confirmLabel} busy={busy} error={writeErr} onConfirm={() => void confirm()} onCancel={close} /> : null}
    </>
  )
}
