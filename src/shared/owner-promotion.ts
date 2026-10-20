// Settings → "Make this Beacon an owner" (Prometheus #748). A Beacon on another computer, connected with the API token, can't approve a
// worker's request (Prometheus #744: the API token gets 401 not_a_person, because a model can read it). `oara pair --owner`, run on the
// computer Prometheus runs on, prints a one-time code (8 digits, 5 minutes, once); this Beacon trades it at POST /api/pair/owner for
// an owner device token of its own, which it keeps in place of the API token.
//
// What each answer means is decided here, against answers recorded from a real daemon (src/main/fixtures/owner_promotion_748.json).
// Only a 200 that says owner: true and carries a token is a promotion. Every failure of the code itself is one answer from Prometheus
// (401 invalid_code: wrong, expired, used, replaced, locked), so Beacon says one thing for all of them.
//
// No Node/Electron imports (same rule as the rest of src/shared).

export const OWNER_ROUTE = '/api/pair/owner'

export const OWNER_SETTINGS_COPY = {
  title: 'Make this Beacon an owner',
  body: "An owner Beacon can see and change everything on this Prometheus, and approve worker requests. On the computer running Prometheus, run {command} and type the code it shows here. It works once, within 5 minutes.",
  // The command itself: named, not paraphrased, and so not held to the plain-language list.
  command: 'oara pair --owner',
  codeLabel: 'One-time code',
  placeholder: '1234-5678',
  go: 'Make owner',
  going: 'Checking…',
  // Said to everyone it happens to: an approved device never typed a key (the 0.4.5 sweep, E4), so the old "not the one you typed in"
  // was wrong for most of them, and how it connects is not theirs to manage.
  done: 'This Beacon is now an owner. It can see and change everything on this Prometheus.',
  shape: 'The code is 8 digits, like 1234-5678.',
  wrongCode: "That code didn't work. It may have run out of time or been used already. Run the command again for a new one.",
  noKeys: "This Prometheus doesn't use keys, so there's nothing to change.",
  old: 'Update Prometheus to make this Beacon an owner.',
  wrongComputer: 'Another computer answered in place of your Prometheus, so Beacon sent it nothing.',
  notConnected: 'Connect to Prometheus first.',
  notKept: "Beacon couldn't save the new key, so it still connects the way it did.",
  failed: "That didn't work. Try again."
} as const

/** The eight digits of a code as typed, ignoring the hyphen and spaces it is shown with; null for anything else (as Prometheus does:
 *  ASCII digits only). */
export function normaliseOwnerCode(typed: string): string | null {
  const s = typed.replace(/[\s-]/g, '')
  return /^[0-9]{8}$/.test(s) ? s : null
}

export type Refused = { kind: 'refused'; message: string; detail: string }
export type RedeemRead = { kind: 'owner'; token: string; deviceId: string; name: string } | Refused
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const details = (status: number, body: unknown): string => `HTTP ${status}${body === null || body === undefined ? '' : ` ${JSON.stringify(body).slice(0, 400)}`}`

/** POST /api/pair/owner's answer. */
export function readRedeem(status: number, body: unknown): RedeemRead {
  const refuse = (message: string): Refused => ({ kind: 'refused', message, detail: details(status, body) })
  if (status === 200) {
    if (isObj(body) && body.owner === true && typeof body.token === 'string' && body.token.length > 0 && typeof body.device_id === 'string')
      return { kind: 'owner', token: body.token, deviceId: body.device_id, name: typeof body.name === 'string' ? body.name : '' }
    // A 200 that is not an owner promotion is never kept as one (it would replace the credential with something else).
    return refuse(OWNER_SETTINGS_COPY.failed)
  }
  const error = isObj(body) && typeof body.error === 'string' ? body.error : ''
  if (status === 401 && error === 'invalid_code') return refuse(OWNER_SETTINGS_COPY.wrongCode)
  if (status === 403 && error === 'pairing_unavailable') return refuse(OWNER_SETTINGS_COPY.noKeys)
  if (status === 404 || status === 405) return refuse(OWNER_SETTINGS_COPY.old)
  return refuse(OWNER_SETTINGS_COPY.failed)
}

export type OwnerOutcome = { kind: 'owner'; name: string } | Refused
