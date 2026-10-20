import { IPC } from '@shared/ipc'
import { checkJoinRequest, platformFor, type BeginResult, type PollOutcome } from '@shared/join'
import type { ApproveRequest, DecideOutcome, WaitingRequest } from '@shared/join-owner'
import type { PairingWatcher } from './pairing/watcher'
import { defaultDeviceName } from './pairing/device-name'
import type { JoinSession } from './pairing/session'
import { handleFromShell } from './shell-windows'

// Joining IPC (v0.4.0 onboarding, path B): ask a computer to let this Mac connect, look at the wait, withdraw it. The page chooses
// the computer; everything that makes the request safe is here: the name this Mac asks under is main's, the key pair and the poll
// secret never leave the session, and the token that arrives is kept by main and is not in any answer.
export function registerJoinHandlers(session: JoinSession, watcher: PairingWatcher): void {
  handleFromShell(IPC.JOIN_BEGIN, async (_e, raw: unknown): Promise<BeginResult> => {
    const req = checkJoinRequest(raw)
    if (!req) return { ok: false, failure: { kind: 'refused' } }
    return session.begin(req, await defaultDeviceName(), platformFor(process.platform))
  })
  handleFromShell(IPC.JOIN_POLL, (): Promise<PollOutcome> => session.poll())
  handleFromShell(IPC.JOIN_CANCEL, async (): Promise<void> => session.cancel())
  // The owner's side: who is waiting, and the answer. The watcher checks every request itself (an id, exactly four digits) before asking the daemon.
  handleFromShell(IPC.PAIRING_LIST, (): WaitingRequest[] => watcher.current())
  handleFromShell(IPC.PAIRING_APPROVE, (_e, raw: unknown): Promise<DecideOutcome> => watcher.approve(raw as ApproveRequest))
  handleFromShell(IPC.PAIRING_DENY, (_e, requestId: unknown): Promise<DecideOutcome> => watcher.deny(requestId as string))
}
