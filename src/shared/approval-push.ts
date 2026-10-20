/**
 * Approval push (feat/approval-push-ws) — the pure core of the WS approval path.
 *
 * WHY THIS EXISTS. Approvals reached Beacon only by a 3s REST poll; the agent
 * could sit blocked up to a full poll interval with no signal. The daemon now
 * pushes `approval_pending` / `approval_resolved` frames (PR #280). Beacon's
 * job: upsert/remove rows as frames arrive, and fire a native notification
 * WITH ACTION BUTTONS for the pending one (spec beacon-approvals-push-spec.md).
 *
 * THE POLL IS NOT REDUNDANT — do not remove it later. A WS-only client that
 * missed a frame would show a ghost approval forever: the request resolved
 * elsewhere (Telegram, another client, timeout) but nothing ever tells this
 * client. Poll reconciles state the client missed while not listening. Push
 * makes poll latency-free; poll makes push safe. Keep both.
 *
 * Everything here is pure and smoke-tested (approval-push-smoke). The Electron
 * Notification itself lives in main — it cannot be constructed headless.
 */

import type { ApprovalRequest } from './ipc'
import { coerceArguments, type ApprovalArguments } from './approval-arguments'

/**
 * The daemon's snake_case pending shape — the SAME dict `serialize_pending()` serves over BOTH
 * transports (the `approval_pending` WS frame and GET /api/approvals).
 *
 * ONE MAPPER, BY WIRING — NOT BY ASSERTION. This comment used to claim drift was "impossible by
 * construction" while `rest.ts` mapped these same fields inline, a second time, with different
 * rules. The claim was false for as long as it stood: the two mappers disagreed about a missing
 * `tool_name`, a missing `description`, and a missing `request_id`. What makes it true now is that
 * `RestClient.listApprovals()` CALLS `rawToApproval` — nothing else. If a future poll path maps
 * this dict itself again, this sentence goes back to being a lie, so check the call site before
 * trusting it.
 *
 * Every field is `unknown` on purpose. A typed wire interface (`request_id: string`) is a claim
 * about a remote process that this one cannot enforce — that is exactly what let the REST path
 * emit `requestId: undefined` while its own interface swore the field was a string.
 */
export interface RawApprovalPush {
  request_id?: unknown
  tool_name?: unknown
  description?: unknown
  /** epoch SECONDS (`PendingAction.created_at = time.time()`); ×1000 → ms. */
  created_at?: unknown
  /**
   * epoch SECONDS, float — same unit and origin as created_at, so the same ×1000.
   *
   * Read off a real pending request rather than assumed (daemon fb73b28):
   *   "created_at": 1786913676.553194
   *   "expires_at": 1786915476.553194
   * delta exactly 1800.0. The daemon computes it as created_at + the window in force on THAT
   * queue instance, so Beacon must not reconstruct it from a timeout of its own — see expiresAt
   * in ipc.ts.
   */
  expires_at?: unknown
  /** dict[str, str] from prospective_extents() — verb → prose. OBJECT, not array; `{}` is valid. */
  extents?: unknown
  /**
   * dict[str, str] | None from `redact_arguments()` — the arguments being approved, scrubbed and
   * truncated daemon-side. `null` (its only empty form) means nothing worth showing.
   *
   * This doc used to live on rest.ts's own RawApproval interface. There is one wire description
   * now, because there is one mapper.
   */
  arguments?: unknown
  /** A worker's request (Prometheus #720): the worker's task id, its conversation, once-only. */
  worker_task_id?: unknown
  session_id?: unknown
  once_only?: unknown
}

/**
 * snake→camel for BOTH transports: the WS frame path (main/index.ts) and the REST poll path
 * (connection/rest.ts) call this same function. A malformed field degrades to the honest empty
 * case, never a fabricated value (extents `{}`, expiresAt undefined → no countdown).
 *
 * RETURNING null IS A DROP, AND CALLERS MUST TREAT IT AS ONE. A request with no usable
 * `request_id` is not a row with a missing label — it is a row that can never be ANSWERED:
 * every resolve POSTs to /api/approvals/<id>/approve, so an absent id yields a 404 forever while
 * the 3s poll re-renders the card each time. It also inflates the OS dock badge with a number the
 * operator cannot clear, and collides in React's reconciler (the card is keyed by requestId).
 * Dropping it is the lesser harm — but a silent drop is its own hazard, so the poll path LOGS
 * what it dropped rather than merely filtering it away.
 */
export function rawToApproval(raw: RawApprovalPush): ApprovalRequest | null {
  if (typeof raw.request_id !== 'string' || raw.request_id.length === 0) return null
  return {
    requestId: raw.request_id,
    toolName: typeof raw.tool_name === 'string' ? raw.tool_name : 'tool',
    description: typeof raw.description === 'string' ? raw.description : '',
    createdAt: typeof raw.created_at === 'number' && Number.isFinite(raw.created_at)
      ? raw.created_at * 1000
      : 0,
    extents: raw.extents && typeof raw.extents === 'object' && !Array.isArray(raw.extents)
      ? (raw.extents as Record<string, string>)
      : {},
    expiresAt: typeof raw.expires_at === 'number' && Number.isFinite(raw.expires_at)
      ? raw.expires_at * 1000
      : undefined,
    // THE PUSH PATH IS THE ONE THAT MATTERS HERE. A frame arrives ahead of the poll, so this is
    // the version of the card the operator sees FIRST and may answer before any poll replaces it.
    // An `arguments` carried on the REST mapper alone would render a card whose decisive value
    // appears seconds late — and `A` is a one-key approve.
    arguments: coerceArguments(raw.arguments),
    // Undefined unless present and well-formed: an ordinary request stays byte-identical.
    workerTaskId: typeof raw.worker_task_id === 'string' && raw.worker_task_id ? raw.worker_task_id : undefined,
    sessionId: typeof raw.session_id === 'string' && raw.session_id ? raw.session_id : undefined,
    onceOnly: raw.once_only === true ? true : undefined
  }
}

/** The resolved frame's payload: request_id + resolution (approved|denied|expired). */
export interface ApprovalResolvedPayload {
  request_id?: unknown
  resolution?: unknown
}

/**
 * Decision-grade notification body. The button is a side-effectful control with
 * NO confirmation step, so the body must show the TARGET of what runs — a
 * `bash` approval truncated to its tool name is an informed-look mis-tap
 * waiting to happen. Full description up to BUDGET chars, cut on a word
 * boundary + "…" only past the budget.
 */
export const BODY_BUDGET = 200

/**
 * A CUT NEVER HAPPENS SILENTLY. This used to end at a bare "…", which states that
 * something was removed but not how much — so a body stopping mid-clause looked the
 * same whether it hid three words or three paragraphs. The daemon settled this rule
 * for argument values ("… (+391 more chars)") and it holds harder here, where the
 * notification may carry a button. Same vocabulary, because it is the same rule.
 *
 * The marker is sized against `full.length`, an upper bound on the hidden count, so
 * the result is ALWAYS within budget without iterating to a fixpoint: `hidden` can
 * never have more digits than the length it is subtracted from.
 */
export function decisionGradeBody(toolName: string, description: string, budget = BODY_BUDGET): string {
  const full = `${toolName}: ${description}`.trim()
  if (full.length <= budget) return full
  const room = Math.max(0, budget - `… (+${full.length} more chars)`.length)
  // Cut on a word boundary so the ellipsis never splits a token mid-word.
  let cut = full.slice(0, room)
  const lastSpace = cut.lastIndexOf(' ')
  if (lastSpace > room * 0.6) cut = cut.slice(0, lastSpace)
  cut = cut.trimEnd()
  return `${cut}… (+${full.length - cut.length} more chars)`
}

/**
 * ── THE NOTIFICATION CANNOT CARRY AN ARGUMENT, SO IT MUST NOT CARRY A BUTTON ──
 *
 * On darwin the notification renders an "Approve" button whose handler resolves the
 * request IMMEDIATELY — no confirmation step, no second surface. `decisionGradeBody`
 * above states the condition that makes such a control defensible: the body must show
 * the TARGET of what runs. For a payload-bearing request it provably cannot. The body
 * is 200 characters, a `computer_type_text` description fills them on its own, and the
 * text that would be typed is not in the description at all.
 *
 * Measured on the captured Prometheus bf4e1fe request, the old body read:
 *
 *   computer_type_text: computer_type_text acts on the desktop: Prometheus may type
 *   text in firefox, in the background (without raising the window) — no lasting
 *   grant is offered: the value of text cannot…
 *
 * It truncated at exactly the clause that mattered and never reached "transfer 500 to
 * account 9". One tap approved a keystroke nobody had read.
 *
 * WHY NOT FIT THE ARGUMENTS IN. Because something would have to be dropped, and
 * choosing WHICH argument survives a 200-character budget is Beacon deciding which
 * argument matters — the one thing @shared/approval-arguments forbids it to do, since
 * only the daemon knows which parameter carries the payload (`ComputerExtent.
 * payload_params`, which is not on the wire). A body showing `text: "transfer 500 to
 * acc…"` next to a live Approve button is WORSE than one showing nothing: it reads as
 * complete, and it invites the tap it should have prevented.
 *
 * So the buttons come off instead, and the notification does what it already does on
 * every non-darwin platform — click, focus the window, decide on the card where the
 * arguments render in full above the buttons. That is not a new fallback; it is the
 * existing one, which this file already describes as the premise degrading rather
 * than breaking.
 *
 * THE PREDICATE IS "CARRIES ARGUMENTS", NOT "IS A DESKTOP ACTION". Beacon holds no
 * tool list and classifies nothing: it reads the field the daemon sent. If the daemon
 * thought an argument worth showing (it drops opaque plumbing before serializing),
 * then it is worth showing, and a body that cannot show it has no business offering a
 * one-tap answer.
 *
 * ONE CALL DECIDES BOTH. Body and buttons come back together so the two can never
 * disagree — a body that omits the arguments while the buttons stay live is precisely
 * the defect, and it is unreachable if nothing computes them separately.
 */
export interface NotificationPlan {
  /** The notification body, already within BODY_BUDGET. */
  body: string
  /** Whether the darwin action buttons may be offered. */
  offersActions: boolean
}

/** Stated, not implied: the operator is told the arguments exist and were left out. */
function omissionNote(count: number): string {
  return ` — ${count} argument${count === 1 ? '' : 's'} not shown; approve in Beacon`
}

export function notificationPlan(
  toolName: string,
  description: string,
  args?: ApprovalArguments
): NotificationPlan {
  const count = args ? Object.keys(args).length : 0
  if (count === 0) return { body: decisionGradeBody(toolName, description), offersActions: true }
  // The note is RESERVED out of the budget, never appended past it — a body that
  // overran would be cut by the OS, and the first thing lost would be the sentence
  // explaining why there is nothing to tap.
  const note = omissionNote(count)
  return {
    body: `${decisionGradeBody(toolName, description, Math.max(0, BODY_BUDGET - note.length))}${note}`,
    offersActions: false
  }
}

/**
 * Reducer: apply one push frame to the pending list. Pending UPSERTS by
 * requestId (a poll and its frame WILL race — upsert is idempotent); resolved
 * REMOVES whatever the resolution. Pure — returns the next list.
 */
export function applyApprovalFrame(
  list: ApprovalRequest[],
  frame: { type: string; payload: Record<string, unknown> }
): ApprovalRequest[] {
  if (frame.type !== 'approval_pending' && frame.type !== 'approval_resolved') return list
  if (frame.type === 'approval_pending') {
    const a = rawToApproval(frame.payload as RawApprovalPush)
    if (!a) return list
    return [a, ...list.filter((x) => x.requestId !== a.requestId)]
  }
  const rid = (frame.payload as ApprovalResolvedPayload).request_id
  if (typeof rid !== 'string') return list
  return list.filter((x) => x.requestId !== rid)
}
