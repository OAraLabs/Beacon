import { Fragment, useCallback, useEffect, useState, type CSSProperties } from 'react'
import {
  ACTIVITY_PAGE_SIZE,
  activityPath,
  coerceActivity,
  deviceOptions,
  roomOptions,
  timelineRows,
  type ActivityEntry,
  type ActivityFilter,
  type EntryView,
  type ResultGlyph,
  type TimelineRow
} from '@shared/home-activity'
import { COLLAPSE_AFTER } from '@shared/home-approval'
import type { TouchDevice } from '@shared/home-devices'
import { unavailableLine } from '@shared/home-devices'
import { Icon } from './Icon'
import { HomeTierBadge } from './HomeTierBadge'
import { useHomeCapability } from '../home-capability-store'

// Integrations → Home → Activity: every Home action Prometheus took or was refused, newest first
// (docs/HA-UI-DATA-CONTRACT.md §3.3). Read only. It has a route to read and nothing that changes anything:
// no controls for the entries, no way to alter the record. What it shows is the daemon's account: who asked
// (your chat, a schedule, a background task), what was asked for, what the server's re-read says the device
// really became, and how it was approved. A refused call is on it too, marked Refused, with the server's reason.
//
// A result is a word and a shape (✓ Confirmed, ⚠ Not confirmed, ✕ Failed, ⊘ Refused), never colour alone.

const b = window.beacon

const card: CSSProperties = { background: 'var(--c-base)', border: '1px solid var(--c-line)', borderRadius: 10, padding: 14 }
const dim: CSSProperties = { color: 'var(--c-text-dim)', fontSize: 12 }
// Disabled is a visible state: one flag drives the prop and the look (see the other panels' btn).
const btn = (disabled = false): CSSProperties => ({ padding: '4px 10px', borderRadius: 6, cursor: disabled ? 'not-allowed' : 'pointer', fontSize: 12, border: '1px solid var(--c-line)', background: 'var(--c-inset)', color: disabled ? 'var(--c-text-faint)' : 'var(--c-text)', font: 'inherit' })
const select: CSSProperties = { background: 'var(--c-inset)', border: '1px solid var(--c-line)', borderRadius: 6, padding: '4px 8px', color: 'var(--c-text)', font: 'inherit', fontSize: 12, maxWidth: 220 }
const link: CSSProperties = { background: 'transparent', border: 'none', padding: 0, font: 'inherit', fontSize: 11.5, color: 'var(--lapis-text)', cursor: 'pointer' }

const NONE: ActivityFilter = { device: '', room: '', tier: 'all' }

const resultColor = (g: ResultGlyph): string => (g === 'check' ? 'var(--c-ok-text)' : g === 'warn' ? 'var(--c-warn-text)' : g === 'cross' ? 'var(--c-err-text)' : 'var(--lapis-text)')

function ResultChip({ glyph, word }: { glyph: ResultGlyph; word: string }) {
  return (
    <span style={{ color: resultColor(glyph), display: 'inline-flex', alignItems: 'center', gap: 5, fontWeight: 600, fontSize: 12, whiteSpace: 'nowrap', flexShrink: 0 }} data-testid="activity-result" data-glyph={glyph}>
      {glyph === 'refused' ? (
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
          <circle cx="12" cy="12" r="9" />
          <path d="m5.6 5.6 12.8 12.8" />
        </svg>
      ) : (
        <Icon name={glyph === 'check' ? 'check' : glyph === 'warn' ? 'warning' : 'x'} size={13} />
      )}
      {word}
    </span>
  )
}

function Entry({ v, compact = false }: { v: EntryView; compact?: boolean }) {
  return (
    <div style={{ padding: compact ? '4px 0 4px 14px' : '8px 0', borderTop: '1px solid var(--c-line)' }} data-testid="activity-entry" data-result={v.result} data-device={v.deviceName}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span style={{ ...dim, fontFamily: 'var(--font-mono, monospace)', minWidth: 62 }}>{v.when}</span>
        <HomeTierBadge tier={v.tier} />
        <span style={{ fontSize: 13, flex: '1 1 160px', minWidth: 0, overflowWrap: 'anywhere' }}>
          {v.deviceName}
          {v.room ? <span style={{ ...dim, marginLeft: 6 }}>{v.room}</span> : null}
        </span>
        <ResultChip glyph={v.resultGlyph} word={v.resultWord} />
      </div>
      <div style={{ ...dim, marginTop: 4, display: 'flex', gap: '2px 14px', flexWrap: 'wrap', overflowWrap: 'anywhere' }}>
        <span data-testid="activity-asked-by">{v.askedBy}</span>
        <span>
          Asked for <span style={{ fontFamily: 'var(--font-mono, monospace)', color: 'var(--c-text)' }}>{v.requested}</span>
        </span>
        {v.resulting !== null ? (
          <span>
            Became <span style={{ fontFamily: 'var(--font-mono, monospace)', color: 'var(--c-text)' }} data-testid="activity-resulting">{v.resulting}</span>
          </span>
        ) : null}
        <span data-testid="activity-approval">{v.approval}</span>
      </div>
      {v.reason ? (
        <div style={{ fontSize: 12, marginTop: 4, overflowWrap: 'anywhere' }} data-testid="activity-reason">
          Why: {v.reason}
        </div>
      ) : null}
    </div>
  )
}

export function HomeActivity({ devices }: { devices: TouchDevice[] | null }) {
  const capable = useHomeCapability() // nothing of Home shows, or is asked for, unless this Prometheus advertises it
  const [filter, setFilter] = useState<ActivityFilter>(NONE)
  const [entries, setEntries] = useState<ActivityEntry[] | null>(null)
  const [nextBefore, setNextBefore] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [more, setMore] = useState(false)
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set())
  const [now, setNow] = useState(() => Date.now())

  const load = useCallback(async (f: ActivityFilter): Promise<void> => {
    try {
      const page = coerceActivity(await b.daemon.get(activityPath(f)))
      if (!page) throw new Error('The activity list was not understood.')
      setEntries(page.entries)
      setNextBefore(page.nextBefore)
      setErr(null)
      setNow(Date.now())
    } catch (e) {
      setErr(unavailableLine(e).text)
    }
  }, [])

  useEffect(() => {
    if (!capable) return
    setEntries(null)
    setOpen(new Set())
    void load(filter)
  }, [filter, load, capable])

  const older = async (): Promise<void> => {
    if (!nextBefore) return
    setMore(true)
    try {
      const page = coerceActivity(await b.daemon.get(activityPath(filter, { before: nextBefore })))
      if (!page) throw new Error('The activity list was not understood.')
      setEntries((cur) => [...(cur ?? []), ...page.entries])
      setNextBefore(page.nextBefore)
      setErr(null)
    } catch (e) {
      setErr(unavailableLine(e).text)
    } finally {
      setMore(false)
    }
  }

  if (!capable) return null

  const rows: TimelineRow[] = entries ? timelineRows(entries, open, now) : []
  const filtered = filter.device !== '' || filter.room !== '' || filter.tier !== 'all'
  const toggle = (id: string): void =>
    setOpen((cur) => {
      const next = new Set(cur)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  return (
    <section style={card} aria-labelledby="home-activity-title" data-testid="home-activity">
      <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 1, color: 'var(--c-text-faint)', marginBottom: 8 }} id="home-activity-title">
        Activity
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10, alignItems: 'center' }}>
        <select aria-label="Device" style={select} value={filter.device} onChange={(e) => setFilter({ ...filter, device: e.target.value })}>
          <option value="">Any device</option>
          {deviceOptions(devices ?? []).map((o) => (
            <option key={o.id} value={o.id}>{o.label}</option>
          ))}
        </select>
        <select aria-label="Room" style={select} value={filter.room} onChange={(e) => setFilter({ ...filter, room: e.target.value })}>
          <option value="">Any room</option>
          {roomOptions(devices ?? []).map((r) => (
            <option key={r} value={r}>{r}</option>
          ))}
        </select>
        <select aria-label="Tier" style={select} value={filter.tier} onChange={(e) => setFilter({ ...filter, tier: e.target.value as ActivityFilter['tier'] })}>
          <option value="all">Any tier</option>
          <option value="ordinary">Ordinary</option>
          <option value="sensitive">Sensitive</option>
          <option value="critical">Critical</option>
        </select>
        {filtered ? <button style={btn()} onClick={() => setFilter(NONE)}>Show everything</button> : null}
        <button style={{ ...btn(), marginLeft: 'auto' }} onClick={() => void load(filter)}>Refresh</button>
      </div>

      {err ? <div style={{ fontSize: 12, color: 'var(--c-err-text)' }} role="alert">{err}</div> : null}
      {entries === null && !err ? <div style={dim}>loading…</div> : null}
      {entries && entries.length === 0 ? <div style={dim} data-testid="activity-empty">{filtered ? 'Nothing matches these filters.' : 'No Home actions yet.'}</div> : null}

      {rows.map((r, i) => (
        <Fragment key={r.kind === 'batch' ? `b:${r.batchId}:${i}` : `e:${r.view.id}`}>
          {i === 0 || rows[i - 1].day !== r.day ? <h3 style={{ fontSize: 12, fontWeight: 600, margin: '12px 0 2px' }} data-testid="activity-day">{r.day}</h3> : null}
          {r.kind === 'entry' ? (
            <Entry v={r.view} />
          ) : (
            <div style={{ padding: '8px 0 2px', borderTop: '1px solid var(--c-line)' }} data-testid="activity-batch" data-batch={r.batchId}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 13, flex: 1 }}>{r.summary}</span>
                <span style={dim}>{r.shown[0].askedBy}</span>
                <ResultChip glyph={r.tone === 'confirmed' ? 'check' : r.tone === 'failed' ? 'cross' : r.tone === 'refused' ? 'refused' : 'warn'} word={r.tone === 'confirmed' ? 'Confirmed' : r.tone === 'failed' ? 'Some failed' : r.tone === 'refused' ? 'Refused' : 'Some not confirmed'} />
              </div>
              {r.shown.map((v) => (
                <Entry key={v.id} v={v} compact />
              ))}
              {r.moreLabel ? (
                <button style={{ ...link, margin: '4px 0 0 14px' }} onClick={() => toggle(r.batchId)} aria-expanded={false} data-testid="activity-more">
                  {r.moreLabel}
                </button>
              ) : open.has(r.batchId) && r.entries.length > COLLAPSE_AFTER ? (
                <button style={{ ...link, margin: '4px 0 0 14px' }} onClick={() => toggle(r.batchId)} aria-expanded={true} data-testid="activity-more">
                  Show fewer
                </button>
              ) : null}
            </div>
          )}
        </Fragment>
      ))}

      {nextBefore && entries ? (
        <div style={{ marginTop: 12 }}>
          <button style={btn(more)} onClick={() => void older()} disabled={more} data-testid="activity-older">
            {more ? 'Loading…' : `Show older (${ACTIVITY_PAGE_SIZE} more)`}
          </button>
        </div>
      ) : null}
    </section>
  )
}
