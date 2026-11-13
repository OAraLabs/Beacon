// A Home approval answered somewhere else (docs/HA-UI-DATA-CONTRACT.md §7, Q4): a chat app, or another computer. Its card must not
// sit there with live buttons for a question that already has an answer. It becomes "Answered on …", with no buttons.
//
// The resolved frame says which way it went (`resolution`) and may say where (`answered_on`, the daemon's own words). Beacon names
// a surface only when the daemon did; otherwise it says "elsewhere". A card that left the list with no frame to explain it (the
// poll noticed first) is "Answered elsewhere" with nothing invented about the answer.

import type { ApprovalRequest } from './ipc'

export type Resolution = 'approved' | 'denied' | 'expired'

export interface ResolvedFrame {
  requestId: string
  resolution: Resolution | null
  /** Where it was answered, in the daemon's words (cut to 80 characters). */
  answeredOn: string | null
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

export function coerceResolved(payload: unknown): ResolvedFrame | null {
  if (!isObj(payload) || typeof payload.request_id !== 'string' || payload.request_id.length === 0) return null
  const on = typeof payload.answered_on === 'string' ? payload.answered_on.trim().slice(0, 80) : ''
  return {
    requestId: payload.request_id,
    resolution: payload.resolution === 'approved' || payload.resolution === 'denied' || payload.resolution === 'expired' ? payload.resolution : null,
    answeredOn: on || null
  }
}

export function answeredView(r: { resolution: Resolution | null; answeredOn: string | null }): { title: string; detail: string | null } {
  if (r.resolution === 'expired') return { title: 'Expired', detail: 'Nobody answered before it expired.' }
  const title = r.answeredOn ? `Answered on ${r.answeredOn}` : 'Answered elsewhere'
  return { title, detail: r.resolution === 'approved' ? 'It was approved.' : r.resolution === 'denied' ? 'It was denied.' : null }
}

/** Home cards that were in `prev` and are gone from `next`, and were not answered by this Beacon (`mine`). Only Home cards: an ordinary approval just goes. */
export function droppedHomeApprovals(prev: ApprovalRequest[], next: ApprovalRequest[], mine: ReadonlySet<string>): ApprovalRequest[] {
  const still = new Set(next.map((a) => a.requestId))
  return prev.filter((a) => a.home !== undefined && !still.has(a.requestId) && !mine.has(a.requestId))
}
