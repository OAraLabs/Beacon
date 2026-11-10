// Approving a device that asks to join (the phone-onboarding plan, desktop item 2). Prometheus makes every approved device an ordinary,
// scoped one ("chat-only"): no field on any route can ask for more. Owner powers are a separate, explicit grant, an owner code minted on
// the computer Prometheus runs on (`oara pair --owner`) and typed into the new device once: Beacon shows that command, it never tries
// to work around it. And when a device asks while Beacon isn't in front, a notification says so in Beacon's own words: the requester
// picks its device name, so neither that name nor its address goes into a system notification.
//
// No Node/Electron imports (same rule as the rest of src/shared).

import type { WaitingRequest } from './join-owner'

/** The command that mints an owner code (Prometheus's join-request contract §6), run on the computer that Prometheus runs on. */
export const OWNER_COMMAND = 'oara pair --owner'

/** How to make a device an owner, for the Prometheus Beacon is on: on this Mac, or on the computer it runs on. */
export function ownerSteps(o: { thisMac: boolean; instance: string }): { command: string; where: string; steps: string[] } {
  const where = o.thisMac ? 'in Terminal on this Mac' : `on the computer ${o.instance} runs on`
  return {
    command: OWNER_COMMAND,
    where,
    steps: [
      'Approve it here as chat-only first.',
      `Then, ${where}, run the command below. It prints eight digits, good for five minutes.`,
      'On the phone, choose Make this device an owner and type the eight digits.'
    ]
  }
}

/** A notification for requests Beacon hasn't told about yet, or null; and the requests now known (ended ones forgotten). */
export function joinNotice(
  known: ReadonlySet<string>,
  requests: WaitingRequest[],
  o: { focused: boolean; instance: string | null }
): { notice: { title: string; body: string } | null; known: ReadonlySet<string> } {
  const fresh = requests.filter((r) => !known.has(r.requestId))
  const now = new Set(requests.map((r) => r.requestId))
  if (fresh.length === 0 || o.focused) return { notice: null, known: now }
  const to = o.instance ? ` ${o.instance}` : ' your Prometheus'
  const who = fresh.length === 1 ? 'A device is' : `${fresh.length} devices are`
  return { notice: { title: 'A device wants to join', body: `${who} asking to join${to}. Open Beacon to check the four digits and approve it.` }, known: now }
}
