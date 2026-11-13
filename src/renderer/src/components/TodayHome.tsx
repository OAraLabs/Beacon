import { useEffect, useRef, useState } from 'react'
import type { ApprovalDecision, ApprovalRequest } from '@shared/ipc'
import type { ViewId } from '@shared/views'
import { composeAttention } from '@shared/attention'
import { fmtCountdown, nextRuns, parseCron, type CronJob } from '@shared/background'
import type { EventRow } from '@shared/gateway-events'
import { TODAY_SEEN_KEY, agoWords, sinceHeading, todayRows, todaySince } from '@shared/today'
import { clearStall, useStalls } from '../attention-store'
import { FirstFlightCard } from './FirstFlightCard'
import { Icon } from './Icon'

// Today: the home in everyday mode (@shared/ui-mode, @shared/today). Three questions, top to
// bottom: is anything waiting on me, what happened since I last looked, what is coming up. The
// one primary action is New chat. Mission is the same view in full mode and is untouched.
//
// Each section says which kind of empty it is. "Nothing is waiting" is a fact Beacon knows; a
// section whose data could not be read says that instead, because a blank there would claim the
// opposite.

const REFRESH_MS = 60_000

export function TodayHome({
  approvals,
  onResolveApproval,
  onNewChat,
  onOpenView,
  onOpenSession,
  titles
}: {
  approvals: ApprovalRequest[]
  onResolveApproval: (id: string, decision: ApprovalDecision) => void
  onNewChat: () => void
  onOpenView: (v: ViewId) => void
  onOpenSession: (id: string) => void
  /** Conversation id → the name shown in the sidebar. */
  titles: Record<string, string>
}) {
  const stalls = useStalls()
  const [outboxFailed, setOutboxFailed] = useState(0)
  // null = not read yet; 'unread' = the read failed (an approved device may not be allowed it).
  const [events, setEvents] = useState<EventRow[] | 'unread' | null>(null)
  const [cron, setCron] = useState<CronJob[] | 'unread' | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const [seen, setSeen] = useState<{ since: number; looked: boolean } | null>(null)
  const mountedAt = useRef(Date.now())

  // "Since you last looked" starts from when Today was last on screen, and leaving it is what
  // moves that forward, so what you have just read is not shown as new next time.
  useEffect(() => {
    const b = window.beacon
    let alive = true
    void (b ? b.settings.get(TODAY_SEEN_KEY).catch(() => null) : Promise.resolve(null)).then((raw) => {
      if (alive) setSeen(todaySince(raw, mountedAt.current))
    })
    return () => {
      alive = false
      void b?.settings.set(TODAY_SEEN_KEY, String(Date.now())).catch(() => undefined)
    }
  }, [])

  useEffect(() => {
    const b = window.beacon
    if (!b) return
    let alive = true
    const load = (): void => {
      setNow(Date.now())
      void b.outbox
        .status()
        .then((s) => alive && setOutboxFailed(s.failed ?? 0))
        .catch(() => undefined)
      void b.events
        .recent(200)
        .then((rows) => alive && setEvents(Array.isArray(rows) ? rows : 'unread'))
        .catch(() => alive && setEvents('unread'))
      void b.daemon
        .get('/api/cron')
        .then((d) => alive && setCron(d == null ? 'unread' : parseCron(d)))
        .catch(() => alive && setCron('unread'))
    }
    load()
    const t = setInterval(load, REFRESH_MS)
    window.addEventListener('focus', load)
    return () => {
      alive = false
      clearInterval(t)
      window.removeEventListener('focus', load)
    }
  }, [])

  const attention = composeAttention(approvals, stalls, outboxFailed)
  const rows = seen && Array.isArray(events) ? todayRows(events, seen.since, titles) : []
  const upcoming = Array.isArray(cron) ? nextRuns(cron, 3) : []
  const nameOf = (id: string): string => titles[id]?.trim() || 'a conversation'

  return (
    <div className="today">
      <div className="today-inner">
        <header className="today-head">
          <div>
            <h1 className="today-title">Today</h1>
            <p className="today-date">{new Date(now).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}</p>
          </div>
          <button className="today-new" onClick={onNewChat}>
            New chat
          </button>
        </header>

        <FirstFlightCard onOpenView={onOpenView} />

        <section className="today-card" aria-labelledby="today-needs">
          <h2 id="today-needs" className="today-h">
            Needs you{attention.length > 0 ? <span className="today-count">{attention.length}</span> : null}
          </h2>
          {attention.length === 0 ? (
            <p className="today-empty">Nothing is waiting on you.</p>
          ) : (
            <ul className="today-list">
              {attention.slice(0, 6).map((item) =>
                item.kind === 'approval' ? (
                  <li key={item.key} className="today-row">
                    <div className="today-row-text">
                      <span className="today-row-main">Your assistant is waiting for your OK: {item.approval.toolName}</span>
                      {item.approval.description ? <span className="today-row-detail">{item.approval.description}</span> : null}
                    </div>
                    {/* Only the action that grants nothing lasting, named as such. Anything that
                        outlives this one call is read and chosen on the full approval card. */}
                    <button className="today-btn" onClick={() => onResolveApproval(item.approval.requestId, { kind: 'approve', scope: 'once' })}>
                      Approve once
                    </button>
                    <button className="today-btn today-btn-quiet" onClick={() => onResolveApproval(item.approval.requestId, { kind: 'deny' })}>
                      Deny
                    </button>
                  </li>
                ) : item.kind === 'stall' ? (
                  <li key={item.key} className="today-row">
                    <div className="today-row-text">
                      <span className="today-row-main">No reply yet in {nameOf(item.sessionId)}</span>
                      <span className="today-row-detail">You sent a message {agoWords(item.since, now)} and nothing has come back.</span>
                    </div>
                    <button className="today-btn" onClick={() => onOpenSession(item.sessionId)}>
                      Open
                    </button>
                    <button className="today-btn today-btn-quiet" onClick={() => clearStall(item.sessionId)}>
                      Dismiss
                    </button>
                  </li>
                ) : (
                  <li key={item.key} className="today-row">
                    <div className="today-row-text">
                      <span className="today-row-main">
                        {item.failed} message{item.failed === 1 ? '' : 's'} could not be sent
                      </span>
                      <span className="today-row-detail">Beacon kept {item.failed === 1 ? 'it' : 'them'} and will send when it can reach Prometheus.</span>
                    </div>
                    <button className="today-btn" onClick={() => void window.beacon?.connection.reconnect()}>
                      Try now
                    </button>
                  </li>
                )
              )}
            </ul>
          )}
        </section>

        <section className="today-card" aria-labelledby="today-since">
          <h2 id="today-since" className="today-h">
            {seen ? sinceHeading(seen.looked, seen.since, now) : 'Since you last looked'}
          </h2>
          {events === 'unread' ? (
            <p className="today-empty">Beacon could not read what happened. It may not be connected, or this Beacon may not be allowed to see it.</p>
          ) : events === null || seen === null ? (
            <p className="today-empty">Reading…</p>
          ) : rows.length === 0 ? (
            <p className="today-empty">Nothing new.</p>
          ) : (
            <ul className="today-list">
              {rows.map((r) => (
                <li key={r.key} className="today-row">
                  <span className={`today-mark${r.kind === 'task-failed' ? ' is-bad' : ''}`} aria-hidden>
                    <Icon name={r.kind === 'replies' ? 'chat' : 'activity'} size={13} />
                  </span>
                  <div className="today-row-text">
                    <span className="today-row-main">{r.text}</span>
                    {r.detail ? <span className="today-row-detail">{r.detail}</span> : null}
                  </div>
                  <span className="today-when">{agoWords(r.ts, now)}</span>
                  {r.sessionId ? (
                    <button className="today-btn" onClick={() => onOpenSession(r.sessionId as string)}>
                      Open
                    </button>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="today-card" aria-labelledby="today-next">
          <h2 id="today-next" className="today-h">
            Coming up
          </h2>
          {cron === 'unread' ? (
            <p className="today-empty">Beacon could not read what is scheduled. It may not be connected, or this Beacon may not be allowed to see it.</p>
          ) : cron === null ? (
            <p className="today-empty">Reading…</p>
          ) : upcoming.length === 0 ? (
            <p className="today-empty">Nothing is scheduled.</p>
          ) : (
            <ul className="today-list">
              {upcoming.map((j) => (
                <li key={j.name} className="today-row">
                  <div className="today-row-text">
                    <span className="today-row-main">{j.name}</span>
                  </div>
                  <span className="today-when">{fmtCountdown(j.nextRun, now)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  )
}
