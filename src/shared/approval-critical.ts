// Two rules about approval requests a Prometheus marks critical, kept pure so a headless smoke
// can run them through every sequence:
//
//   1. WHAT A PROMETHEUS ADVERTISES (`capStep`). Whether it lists `approval_critical` in its
//      `subscribed` reply is what decides how a request with no flag is read. The connection
//      feeds this the things that happen to it and keeps one timer for it.
//   2. WHO MAY APPROVE (`approveRefusal`). A critical request is approved from its full card and
//      from nowhere else. The window already offers nothing else; this is main refusing anyway,
//      so a surface that forgets the rule (or a new one that never learned it) cannot approve.
//
// No Node/Electron imports (same rule as the rest of src/shared).
import { answeredInApp } from './approval-push'
import type { ApprovalDecision } from './ipc'

/** How long a CONNECTED Prometheus that has never said has to say, before silence is taken for "no". */
export const APPROVAL_CRITICAL_WAIT_MS = 5000

export interface CapState {
  /** true: it advertises the flag. false: it said what it does and that is not among it, or was
   *  silent for the wait. null: it has never said. */
  value: boolean | null
  /** A `subscribed` reply has arrived on the connection now being made or in use. */
  said: boolean
  /** The silence of a connected Prometheus that has never said is being timed. The connection
   *  keeps a timer running exactly while this is true. */
  waiting: boolean
}

export const CAP_INITIAL: CapState = { value: null, said: false, waiting: false }

export type CapEvent =
  | 'attempt' // start(): the first try, a manual reconnect, a wake
  | 'dial' // the socket is about to dial again
  | 'connected'
  | 'left' // any state that is not 'connected'
  | 'stop'
  | 'expired' // the timer ran out
  | { said: boolean } // a `subscribed` reply: whether it lists the capability

/**
 * The next state. A wrong "no" hands back one-tap approval for requests that carry no flag, so
 * the rule is narrow on purpose:
 * - silence is timed only while connected, and only from "never said";
 * - a new attempt, a new dial, leaving 'connected' and stop all end the timing: time spent
 *   dialling, waiting on the network after a wake, or backing off is not the daemon's silence;
 * - silence never replaces an answer. A yes is withdrawn only by a reply that does not list it;
 * - a reply is always believed, whenever it comes.
 */
export function capStep(s: CapState, e: CapEvent): CapState {
  if (typeof e === 'object') return { value: e.said === true, said: true, waiting: false }
  switch (e) {
    case 'attempt':
    case 'dial':
      return { value: s.value, said: false, waiting: false }
    case 'left':
    case 'stop':
      return s.waiting ? { ...s, waiting: false } : s
    case 'connected':
      return s.value === null && !s.said && !s.waiting ? { ...s, waiting: true } : s
    case 'expired':
      return s.waiting && s.value === null && !s.said ? { value: false, said: false, waiting: false } : s.waiting ? { ...s, waiting: false } : s
    default:
      return s
  }
}

/** Where an answer was given. Only 'card' is the full card's own button. */
export type ApprovalSurface = 'card' | 'key' | 'row' | 'notification'

export const CARD_ONLY_REFUSAL = 'This request can be approved only on its card in Beacon, with the Approve button. Nothing was approved.'

/**
 * Why main will not carry out this answer, or null to go ahead. Deny is never refused. An approve
 * is refused unless it came from the card's own button, when the request is critical by the same
 * rule the window and the notification use (`answeredInApp`): what the daemon said on the request
 * (`critical`: undefined for a request main never saw, or that did not say) against what its
 * Prometheus advertises (`advertised`: undefined while that is not known). Anything that does not
 * plainly say it came from the card is treated as not from the card.
 */
export function approveRefusal(decision: ApprovalDecision | null | undefined, from: unknown, critical: boolean | undefined, advertised: boolean | undefined): string | null {
  if (!decision || decision.kind !== 'approve') return null
  if (from === 'card') return null
  return answeredInApp(critical, advertised) ? CARD_ONLY_REFUSAL : null
}

/** How long after a request's card appears or moves in the stack an APPROVE of it is
 *  ignored. The stack is anchored at the top: answering the first card slides the next one's
 *  Approve under the pointer, and the second half of a double-click would approve a request nobody
 *  has read. A click or key already on its way lands on nothing. */
export const APPROVAL_SETTLE_MS = 500

/** Whether an approve given `sinceChange` ms after its card appeared or moved is ignored. Deny never is. */
export function approveTooSoon(decision: ApprovalDecision, sinceChange: number): boolean {
  return decision.kind === 'approve' && !(sinceChange >= APPROVAL_SETTLE_MS)
}

/** A refusal as a person reads it: Electron's "Error invoking remote method …" wrapper removed. */
export function refusalWords(err: unknown): string {
  return String(err instanceof Error ? err.message : err).replace(/^Error invoking remote method '[^']*': (?:Error: )?/, '')
}

/** The most requests main remembers the flag of. Past it the oldest are forgotten, and a forgotten
 *  request is judged like one that did not say. */
export const CRITICAL_BOOK_MAX = 500

/** Note what a request said, keeping the book bounded. `undefined` is noted too: "seen, did not say". */
export function noteCritical(book: Map<string, boolean | undefined>, requestId: string, critical: boolean | undefined): void {
  // A later note that does not say never replaces one that did: a frame's `true` followed by a
  // poll row with the flag missing stays `true`. An explicit `false` does replace it (the daemon
  // is the one that decides), and so does an explicit `true`.
  const kept = critical === undefined && book.has(requestId) ? book.get(requestId) : critical
  book.delete(requestId) // re-noted: it moves to the newest end
  book.set(requestId, kept)
  while (book.size > CRITICAL_BOOK_MAX) {
    const oldest = book.keys().next().value
    if (oldest === undefined) break
    book.delete(oldest)
  }
}

/**
 * Whether the general "write to the daemon" call must refuse this path because it is about
 * approval requests. Answering one (approve or deny) is the connection's resolveApproval, which
 * applies `approveRefusal`; the general call that windows have must not be a second way to send it.
 *
 * AN ALLOWLIST, NOT A PATTERN FOR THE BAD CASE. The path is joined to the address as text and the
 * URL parser normalises it afterwards: `/api/approvals/grants/%2e%2e/X/approve`, a tab inside
 * `appr\tove`, an encoded `?` followed by dot segments all arrive at `/api/approvals/X/approve`
 * while not looking like it. So anything that mentions approvals at all, however it is spelled, is
 * refused, except the two shapes the window really uses: the list of lasting grants, and one grant
 * by a plain id. A path refused by mistake has a named call that does the job; one let through by
 * mistake approves a command.
 */
export function isApprovalAnswerPath(path: unknown): boolean {
  if (typeof path !== 'string') return false
  if (/^\/api\/approvals\/grants(\/[A-Za-z0-9_~:-][A-Za-z0-9_.~:-]{0,199})?$/.test(path)) return false
  // Everything the parser would strip or fold is stripped or folded before looking: percent
  // encoding (several layers deep), control characters and spaces, letter case.
  let p = path
  for (let i = 0; i < 4; i++) {
    let next: string
    try {
      next = decodeURIComponent(p)
    } catch {
      next = p.replace(/%[0-9a-fA-F]{2}/g, (m) => String.fromCharCode(parseInt(m.slice(1), 16))) // decode what can be
    }
    if (next === p) break
    p = next
  }
  // eslint-disable-next-line no-control-regex
  return p.replace(/[\u0000-\u0020\u007f\u00a0\u200b-\u200f\u2028\u2029\ufeff]/g, '').toLowerCase().includes('approvals')
}
