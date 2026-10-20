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
