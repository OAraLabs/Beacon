// The Home activity timeline (Integrations → Home → Activity): the logic of the screen — pure (no React, no Node), so a
// smoke can hold it still. Contract: docs/HA-UI-DATA-CONTRACT.md §3.3.
//
// BEACON RENDERS, THE DAEMON DECIDES. Every entry is a Home action as the daemon recorded it: which device, under which
// tier, who asked, what was asked for, what the server's re-read says it really became, and how it was approved. Wording
// that comes from the daemon (the refusal reason, the requested and resulting states) is shown verbatim. The screen is read
// only by construction: it has a GET route and nothing that writes.
//
// Floors, both toward not claiming more than is known: an unknown tier is Sensitive, an unknown result is "not confirmed"
// (never success), and a refused call claims no resulting state.

import { coerceTier, COLLAPSE_AFTER, tierPresentation, type HomeTier } from './home-approval'
import type { TierFilter, TouchDevice } from './home-devices'

export const HOME_ACTIVITY_PATH = '/api/home/activity'
export const ACTIVITY_PAGE_SIZE = 50

export interface ActivityFilter {
  /** A device id, or '' for any. */
  device: string
  /** A room name, or '' for any. */
  room: string
  tier: TierFilter
}

/** The route for one page of the timeline, with the filters that are set. `before` is the daemon's cursor for older entries. */
export function activityPath(f: ActivityFilter, opts: { before?: string | null } = {}): string {
  const q = [`limit=${ACTIVITY_PAGE_SIZE}`]
  if (opts.before) q.push(`before=${encodeURIComponent(opts.before)}`)
  if (f.device) q.push(`device=${encodeURIComponent(f.device)}`)
  if (f.room) q.push(`room=${encodeURIComponent(f.room)}`)
  if (f.tier !== 'all') q.push(`tier=${encodeURIComponent(f.tier)}`)
  return `${HOME_ACTIVITY_PATH}?${q.join('&')}`
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null)

// ── the wire → entries ───────────────────────────────────────────────────────

export type InitiatorKind = 'chat' | 'schedule' | 'background_task' | 'unknown'
export type ActivityResult = 'confirmed' | 'unconfirmed' | 'failed' | 'refused'
export type ActivityApproval = 'approved_once' | 'approved_always' | 'auto_allowed' | 'denied' | 'expired' | 'not_asked' | 'unknown'

export interface ActivityEntry {
  id: string
  /** Epoch seconds. */
  at: number
  device: { id: string; name: string; room: string | null }
  tier: HomeTier
  tool: string | null
  action: string | null
  initiator: { kind: InitiatorKind; label: string | null }
  requested: string | null
  /** What the server's re-read says the device became; null when it could not be read, or the call never ran. */
  resulting: string | null
  result: ActivityResult
  approval: ActivityApproval
  /** The server's sentence for a refused call (or a failed one). Shown verbatim. */
  refusalReason: string | null
  /** Entries of one bulk call share it. */
  batchId: string | null
}

const INITIATORS: readonly string[] = ['chat', 'schedule', 'background_task']
const RESULTS: readonly string[] = ['confirmed', 'unconfirmed', 'failed', 'refused']
const APPROVALS: readonly string[] = ['approved_once', 'approved_always', 'auto_allowed', 'denied', 'expired', 'not_asked']

function coerceEntry(raw: unknown): ActivityEntry | null {
  if (!isObj(raw)) return null
  const id = str(raw.id)
  const at = typeof raw.at === 'number' && Number.isFinite(raw.at) ? raw.at : null
  const dev = isObj(raw.device) ? raw.device : null
  const name = dev ? str(dev.name) : null
  if (!id || at === null || !dev || !name) return null
  const init = isObj(raw.initiator) ? raw.initiator : {}
  return {
    id,
    at,
    device: { id: str(dev.id) ?? '', name, room: str(dev.room) },
    tier: coerceTier(raw.tier),
    tool: str(raw.tool),
    action: str(raw.action),
    initiator: { kind: INITIATORS.includes(init.kind as string) ? (init.kind as InitiatorKind) : 'unknown', label: str(init.label) },
    requested: str(raw.requested),
    resulting: str(raw.resulting),
    // A result Beacon does not recognise is never shown as success.
    result: RESULTS.includes(raw.result as string) ? (raw.result as ActivityResult) : 'unconfirmed',
    approval: APPROVALS.includes(raw.approval as string) ? (raw.approval as ActivityApproval) : 'unknown',
    refusalReason: str(raw.refusal_reason),
    batchId: str(raw.batch_id)
  }
}

/** One page, newest first (re-sorted here: the order is the screen's promise, not the wire's). */
export function coerceActivity(raw: unknown): { entries: ActivityEntry[]; nextBefore: string | null } | undefined {
  if (!isObj(raw) || !Array.isArray(raw.entries)) return undefined
  const entries = raw.entries.map(coerceEntry).filter((e): e is ActivityEntry => e !== null)
  entries.sort((a, z) => z.at - a.at) // stable: entries with the same time keep the daemon's order
  const cursor = typeof raw.next_before === 'number' ? String(raw.next_before) : str(raw.next_before)
  return { entries, nextBefore: cursor }
}

// ── the words ────────────────────────────────────────────────────────────────

export function initiatorWords(i: { kind: InitiatorKind; label: string | null }): string {
  const base = i.kind === 'chat' ? 'Your chat' : i.kind === 'schedule' ? 'A schedule' : i.kind === 'background_task' ? 'A background task' : 'Unknown'
  return i.label ? `${base} · ${i.label}` : base
}

export function approvalWords(a: ActivityApproval): string {
  switch (a) {
    case 'approved_once': return 'You approved it once'
    case 'approved_always': return 'You chose Always allow'
    case 'auto_allowed': return 'Allowed by a saved permission'
    case 'denied': return 'You denied it'
    case 'expired': return 'Approval expired'
    case 'not_asked': return 'No approval was asked for'
    default: return 'Approval not reported'
  }
}

export type ResultGlyph = 'check' | 'warn' | 'cross' | 'refused'

/** A result is a word and a shape, never colour alone: ✓ Confirmed, ⚠ Not confirmed, ✕ Failed, ⊘ Refused. */
export function resultView(e: Pick<ActivityEntry, 'result'>): { glyph: ResultGlyph; word: string } {
  switch (e.result) {
    case 'confirmed': return { glyph: 'check', word: 'Confirmed' }
    case 'failed': return { glyph: 'cross', word: 'Failed' }
    case 'refused': return { glyph: 'refused', word: 'Refused' }
    default: return { glyph: 'warn', word: 'Not confirmed' }
  }
}

// ── days ─────────────────────────────────────────────────────────────────────

const sameDay = (a: Date, b: Date): boolean => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()

/** "Today", "Yesterday", or a date. By the local calendar, not by 24-hour distance. */
export function dayLabel(atSec: number, nowMs: number): string {
  const at = new Date(atSec * 1000)
  const now = new Date(nowMs)
  if (sameDay(at, now)) return 'Today'
  if (sameDay(at, new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1))) return 'Yesterday'
  return at.toLocaleDateString(undefined, at.getFullYear() === now.getFullYear() ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' })
}

// ── one entry, as the timeline shows it ──────────────────────────────────────

export interface EntryView {
  id: string
  deviceName: string
  room: string | null
  tier: HomeTier
  tierWord: string
  action: string | null
  askedBy: string
  approval: string
  requested: string
  /** The real resulting state; null for a refused call, which claims none. */
  resulting: string | null
  resultWord: string
  resultGlyph: ResultGlyph
  result: ActivityResult
  /** The server's reason for a refusal (or a failure); a refusal with none says so. */
  reason: string | null
  when: string
  day: string
}

export function entryView(e: ActivityEntry, nowMs: number): EntryView {
  const r = resultView(e)
  return {
    id: e.id,
    deviceName: e.device.name,
    room: e.device.room,
    tier: e.tier,
    tierWord: tierPresentation(e.tier).word,
    action: e.action,
    askedBy: initiatorWords(e.initiator),
    approval: approvalWords(e.approval),
    requested: e.requested ?? 'not stated',
    resulting: e.result === 'refused' ? null : (e.resulting ?? 'could not be read'),
    resultWord: r.word,
    resultGlyph: r.glyph,
    result: e.result,
    reason: e.refusalReason ?? (e.result === 'refused' ? 'No reason was given.' : null),
    when: new Date(e.at * 1000).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }),
    day: dayLabel(e.at, nowMs)
  }
}

// ── rows: a bulk call is one group, collapsed past 5 ─────────────────────────

export type TimelineRow =
  | { kind: 'entry'; day: string; view: EntryView }
  | { kind: 'batch'; day: string; batchId: string; entries: ActivityEntry[]; shown: EntryView[]; hiddenCount: number; moreLabel: string | null; summary: string; tone: ActivityResult }

const SEVERITY: Record<ActivityResult, number> = { confirmed: 0, unconfirmed: 1, refused: 2, failed: 3 }

/** Entries of one bulk call that sit together become one group (a lone member, its siblings filtered away, is a plain entry). */
export function timelineRows(entries: ActivityEntry[], expanded: ReadonlySet<string>, nowMs: number): TimelineRow[] {
  const rows: TimelineRow[] = []
  for (let i = 0; i < entries.length; ) {
    const first = entries[i]
    let j = i + 1
    if (first.batchId) while (j < entries.length && entries[j].batchId === first.batchId) j++
    const group = entries.slice(i, j)
    if (!first.batchId || group.length < 2) {
      const view = entryView(first, nowMs)
      rows.push({ kind: 'entry', day: view.day, view })
    } else {
      const views = group.map((e) => entryView(e, nowMs))
      const open = expanded.has(first.batchId) || views.length <= COLLAPSE_AFTER
      const shown = open ? views : views.slice(0, COLLAPSE_AFTER)
      const hidden = views.length - shown.length
      rows.push({
        kind: 'batch',
        day: views[0].day,
        batchId: first.batchId,
        entries: group,
        shown,
        hiddenCount: hidden,
        moreLabel: hidden > 0 ? `and ${hidden} more` : null,
        summary: first.action ? `${group.length} devices · ${first.action}` : `${group.length} devices`,
        tone: group.reduce<ActivityResult>((t, e) => (SEVERITY[e.result] > SEVERITY[t] ? e.result : t), 'confirmed')
      })
    }
    i = j
  }
  return rows
}

// ── filter options, from the devices list ────────────────────────────────────

export function deviceOptions(devices: TouchDevice[]): { id: string; label: string }[] {
  return devices
    .map((d) => ({ id: d.id, label: d.room ? `${d.name} · ${d.room}` : d.name }))
    .sort((a, z) => a.label.localeCompare(z.label, undefined, { sensitivity: 'base' }))
}

export function roomOptions(devices: TouchDevice[]): string[] {
  return [...new Set(devices.map((d) => d.room).filter((r): r is string => r !== null))].sort((a, z) => a.localeCompare(z, undefined, { sensitivity: 'base' }))
}
