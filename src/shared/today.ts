// Today: the everyday home (@shared/ui-mode). Pure model, shared by the view and the smoke.
//
// THREE QUESTIONS, and nothing else: is anything waiting on me (the attention queue Mission
// already composes, @shared/attention), what happened since I last looked, and what is coming up
// (the scheduled jobs, @shared/background). This module is the middle one.
//
// "SINCE I LAST LOOKED" is a time this Beacon keeps for each Prometheus: when Today was last on
// screen. What happened is read from the daemon's own durable event log, so it covers the time
// Beacon was closed. Today that log has finished replies and finished or failed background tasks;
// it does not have scheduled runs (the daemon records none there yet), so those are not claimed.

import { eventRowTs, type EventRow } from './gateway-events'

/** Settings key: epoch ms Today was last on screen. Per-Prometheus (@shared/daemon-profiles):
 *  what happened is that Prometheus's, and so is when you last looked at it. */
export const TODAY_SEEN_KEY = 'today:seen:v1'

const DAY_MS = 24 * 60 * 60 * 1000
/** With nothing stored, "since" is the last day; and it never reaches further back than a week. */
export const TODAY_DEFAULT_SPAN_MS = DAY_MS
export const TODAY_MAX_SPAN_MS = 7 * DAY_MS

/** The moment "since you last looked" starts from, and whether it is a real last look or the
 *  default span (which the heading words differently). A stored time in the future is not believed. */
export function todaySince(stored: string | null | undefined, now: number): { since: number; looked: boolean } {
  const t = Number(stored)
  if (!stored || !Number.isFinite(t) || t <= 0 || t > now) return { since: now - TODAY_DEFAULT_SPAN_MS, looked: false }
  return { since: Math.max(t, now - TODAY_MAX_SPAN_MS), looked: true }
}

export type TodayRowKind = 'replies' | 'task-done' | 'task-failed'

export interface TodayRow {
  key: string
  kind: TodayRowKind
  /** The conversation this belongs to, when the event names one. */
  sessionId: string | null
  /** The line shown. */
  text: string
  /** A second, quieter line: the reply's opening words, or the task's error. */
  detail: string
  /** Newest event folded into this row, epoch ms. */
  ts: number
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const cut = (s: string, n: number): string => {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length > n ? `${t.slice(0, n - 1)}…` : t
}

/**
 * What happened after `since`, newest first, `max` rows at most.
 *
 * Replies are folded to ONE row per conversation ("3 replies in Trip planning"): a long exchange
 * is one thing that happened, not thirty. A conversation is named by its title; one with no title
 * is "a conversation", never its id. Tasks are a row each. Anything else in the log is not a
 * thing a person asked about, and is left out.
 */
export function todayRows(events: readonly EventRow[], since: number, titles: Readonly<Record<string, string>>, max = 8): TodayRow[] {
  const replies = new Map<string, { n: number; ts: number; detail: string }>()
  const rows: TodayRow[] = []
  for (const ev of events) {
    const ts = eventRowTs(ev.timestamp)
    if (ts <= since) continue
    const p = ev.payload ?? {}
    const sessionId = str(p.session_id) || null
    if (ev.signal_type === 'turn_completed') {
      const k = sessionId ?? ''
      const cur = replies.get(k)
      if (!cur) replies.set(k, { n: 1, ts, detail: cut(str(p.summary), 120) })
      else replies.set(k, { n: cur.n + 1, ts: Math.max(cur.ts, ts), detail: ts >= cur.ts ? cut(str(p.summary), 120) || cur.detail : cur.detail })
    } else if (ev.signal_type === 'task_completed' || ev.signal_type === 'task_failed') {
      const failed = ev.signal_type === 'task_failed'
      const what = cut(str(p.description) || str(p.title), 80)
      rows.push({
        key: `task:${String(ev.id ?? `${ts}:${rows.length}`)}`,
        kind: failed ? 'task-failed' : 'task-done',
        sessionId,
        text: what ? `${failed ? 'A task failed' : 'A task finished'}: ${what}` : failed ? 'A background task failed' : 'A background task finished',
        detail: failed ? cut(str(p.error), 120) : '',
        ts
      })
    }
  }
  for (const [k, r] of replies) {
    const title = k ? cut(titles[k] ?? '', 60) : ''
    const where = title ? `in ${title}` : 'in a conversation'
    rows.push({ key: `replies:${k}`, kind: 'replies', sessionId: k || null, text: `${r.n === 1 ? 'A reply' : `${r.n} replies`} ${where}`, detail: r.detail, ts: r.ts })
  }
  return rows.sort((a, z) => z.ts - a.ts).slice(0, max)
}

/** "5 minutes ago", "3 hours ago", "yesterday", "4 days ago". For the heading and each row. */
export function agoWords(ts: number, now: number): string {
  const s = Math.max(0, Math.round((now - ts) / 1000))
  if (s < 60) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m} minute${m === 1 ? '' : 's'} ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h} hour${h === 1 ? '' : 's'} ago`
  const d = Math.round(h / 24)
  return d === 1 ? 'yesterday' : `${d} days ago`
}

/** The middle section's heading. */
export function sinceHeading(looked: boolean, since: number, now: number): string {
  return looked ? `Since you last looked (${agoWords(since, now)})` : 'In the last day'
}
