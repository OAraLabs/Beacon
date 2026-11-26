// A worker's request this Beacon may not approve (Prometheus #744). A worker's request is approved only with a person's credential, a
// device token; Beacon holding the API token (or talking to an open Prometheus) gets 401 not_a_person, and the request stays pending.
// The card then says so once, in place of Approve, and keeps Deny (denying needs no person's credential).
//
// No Node/Electron imports (same rule as the rest of src/shared).
import { isNotAPerson } from './daemon-api'

export const CANNOT_APPROVE_WORKER =
  "This Beacon can't approve worker requests yet. Approve it from Telegram with /approve, or from a Beacon set up as an owner device."

/** The line to show after Approve was refused, or null to show the refusal as before (it was not this one, or not a worker's). */
export function cannotApproveLine(approval: { workerTaskId?: string }, err: unknown): string | null {
  return approval.workerTaskId && isNotAPerson(err) ? CANNOT_APPROVE_WORKER : null
}

// A 200 that says "not answered". Prometheus answers POST /api/approvals/{id}/approve and /deny with 200 {ok, message} even when it
// found nothing to answer ("No pending request: <id>"): the request had already been answered (or the worker that asked had stopped),
// yet its listing can still come back from the poll. A client that read only the status took its card down, saw the poll put the same
// card back, and said nothing: eight approvals of one request, each "worked", none explained.

export const NOT_RESOLVED_CODE = 'not_resolved'

/** The `{ok:false, message}` a 200 carried, or null for a body that is anything else (an answer that did not say, an older Prometheus). */
export function readNotResolved(bodyText: string): string | null {
  let body: unknown
  try {
    body = JSON.parse(bodyText)
  } catch {
    return null
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null
  const o = body as { ok?: unknown; message?: unknown }
  if (o.ok !== false) return null
  return typeof o.message === 'string' ? o.message.slice(0, 200) : ''
}

export const NOT_PENDING_LINE =
  'Prometheus says nothing is waiting for this answer any more. It was most likely answered already, or the worker that asked has stopped. Minimize it; Prometheus drops it when it expires.'

/** The line for a request Prometheus did not take an answer for, or null when the error was not that. */
export function notResolvedLine(err: unknown): string | null {
  const msg = err instanceof Error ? err.message : String(err)
  const m = new RegExp(`HTTP 200 \\[${NOT_RESOLVED_CODE}\\]: POST \\S+ — ([\\s\\S]*)$`).exec(msg)
  if (!m) return null
  const said = m[1].trim()
  if (said === '' || /^No pending request/i.test(said)) return NOT_PENDING_LINE
  return `Prometheus did not take this answer: ${said}`
}
