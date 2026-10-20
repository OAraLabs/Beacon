// The Attention model (harness sprint #1) — ONE queue for everything blocked on the operator. Pure
// composition, no DOM/Electron: surfaces gather the sources (approvals from the daemon poll,
// stalls from ChatShell's reply watchdog, failed sends from the outbox) and this folds them into
// a ranked list. Consumers today: Mission Control's "needs you" card; the tray HUD reads the same
// model next (sprint #8).

import type { ApprovalRequest } from './ipc'

export interface StallRecord {
  sessionId: string
  /** epoch ms when the reply watchdog fired (send accepted, no assistant activity since). */
  since: number
}

export type AttentionItem =
  | { kind: 'approval'; key: string; approval: ApprovalRequest }
  | { kind: 'stall'; key: string; sessionId: string; since: number }
  | { kind: 'outbox'; key: string; failed: number }

/** Fold the three sources into one ranked queue: approvals first (the agent is BLOCKED on
 * consent), then stalled sessions (newest first), then the failed-send rollup. Pure. */
export function composeAttention(
  approvals: ApprovalRequest[],
  stalls: StallRecord[],
  outboxFailed: number
): AttentionItem[] {
  const items: AttentionItem[] = approvals.map((a) => ({ kind: 'approval', key: `ap-${a.requestId}`, approval: a }))
  for (const s of [...stalls].sort((x, y) => y.since - x.since)) {
    items.push({ kind: 'stall', key: `st-${s.sessionId}`, sessionId: s.sessionId, since: s.since })
  }
  if (outboxFailed > 0) items.push({ kind: 'outbox', key: 'outbox', failed: outboxFailed })
  return items
}
