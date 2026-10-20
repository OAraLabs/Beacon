// Pure edit/branch model (B4, daemon: Prometheus #352). Shared by ChatShell and the smoke. No DOM.
//
// There is no "branch" in the data model and deliberately so: LCM is linear, and the daemon
// answers an edit by COPYING history into a new session up to the point before the edited
// message. So the client's job is not to draw a tree — it is to (1) pick the right fork point,
// (2) send the edited text into the session that comes back, and (3) make the relationship
// visible afterwards. Nothing here pretends the log is anything other than linear.

import { isOperatorTurn } from './provenance'

export interface ForkOrigin {
  originSession: string
  originRowid: number
  createdAt: number
}

export interface ForkResult {
  sessionId: string
  originSession: string
  originRowid: number
  copied: number
}

/** POST body for a fork. The daemon names the new session unless one is supplied. */
export function forkBody(atRowid: number): { at_rowid: number } {
  return { at_rowid: atRowid }
}

export function parseForkResult(data: unknown): ForkResult | null {
  if (!data || typeof data !== 'object') return null
  const d = data as Record<string, unknown>
  const sessionId = typeof d.session_id === 'string' ? d.session_id : ''
  if (!sessionId) return null
  return {
    sessionId,
    originSession: typeof d.origin_session === 'string' ? d.origin_session : '',
    originRowid: typeof d.origin_rowid === 'number' ? d.origin_rowid : 0,
    copied: typeof d.copied === 'number' ? d.copied : 0
  }
}

/** GET /api/sessions/{id}/fork → where this session came from, or null when it was not forked. */
export function parseForkOrigin(data: unknown): ForkOrigin | null {
  if (!data || typeof data !== 'object') return null
  const o = (data as Record<string, unknown>).origin
  if (!o || typeof o !== 'object') return null
  const r = o as Record<string, unknown>
  const originSession = typeof r.origin_session === 'string' ? r.origin_session : ''
  if (!originSession) return null
  return {
    originSession,
    originRowid: typeof r.origin_rowid === 'number' ? r.origin_rowid : 0,
    createdAt: typeof r.created_at === 'number' ? r.created_at : 0
  }
}

export interface ForkableRow {
  /** Stable render key. */
  key: string
  role: string
  /** Durable rowid, or null for an optimistic row that has not been persisted yet. */
  rowId: number | null
  /** Who wrote it (@shared/provenance). A machine turn with the user role is not the operator's. */
  provenance?: string | null
}

/**
 * The rowid to fork AT when editing `key`: the last DURABLE row before it.
 *
 * The edited message must not be copied — the fork is the conversation as it stood just before
 * it. Optimistic rows (rowId null) are skipped because they do not exist on the daemon yet and
 * cannot bound a copy.
 *
 * Returns null when there is nothing durable before the target, which is the FIRST-MESSAGE case:
 * a fork of nothing is not a fork, and the daemon rightly 404s on it. The caller must disable the
 * affordance rather than send a request that cannot succeed.
 */
export function forkPointBefore(rows: ForkableRow[], key: string): number | null {
  const idx = rows.findIndex((r) => r.key === key)
  if (idx < 0) return null
  for (let i = idx - 1; i >= 0; i--) {
    const id = rows[i].rowId
    if (typeof id === 'number' && id > 0) return id
  }
  return null
}

/**
 * Whether a row may be edited into a branch. USER rows only: editing what the agent said would
 * fabricate a history that never happened, and the daemon copies rows verbatim — it has no way to
 * tell an invented assistant turn from a real one afterwards.
 */
export function canEditIntoBranch(rows: ForkableRow[], key: string): boolean {
  const row = rows.find((r) => r.key === key)
  if (!row || !isOperatorTurn(row)) return false
  return forkPointBefore(rows, key) !== null
}

/** Why the affordance is unavailable, for the tooltip. Never a bare disabled control. */
export function editUnavailableReason(rows: ForkableRow[], key: string): string | null {
  const row = rows.find((r) => r.key === key)
  if (!row) return 'this message is not in the loaded history'
  if (!isOperatorTurn(row)) return 'only your own messages can be edited into a branch'
  if (forkPointBefore(rows, key) === null)
    return 'this is the first message — there is nothing before it to branch from'
  return null
}

/** The banner on a forked session. Says WHERE from and HOW MUCH came with it. */
export function forkBanner(origin: ForkOrigin, originTitle?: string): string {
  const who = originTitle && originTitle.trim() ? originTitle.trim() : origin.originSession
  return `Branched from ${who}`
}
