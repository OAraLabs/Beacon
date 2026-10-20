/**
 * Resolve-path breadcrumbs — DIAGNOSTIC INSTRUMENTATION FOR ONE OPEN QUESTION.
 *
 * Findings 2 and 5 are both "the click and the daemon disagree":
 *   - a click on `until-restart` was recorded by the daemon as `scope=once`
 *   - a click on `always here` produced NO daemon record at all; the request
 *     sat pending its full 30 minutes and expired on schedule
 *
 * Everything downstream of the IPC boundary is already excluded by evidence:
 * `approval:resolve` has NEVER thrown in a whole session of use, and Electron
 * auto-logs handler rejections — so a failed fetch, a non-2xx, and a success
 * with no daemon record are all ruled out. **The call never reached the
 * handler.** The break is renderer-side, in the top three hops.
 *
 * That cannot be narrowed further by inspection, and renderer `console.log`
 * goes to DevTools — invisible without screen access and discarded entirely in
 * a packaged launch. So the breadcrumbs cross into main and persist, the same
 * shape as socket_events, for the same reason.
 *
 * THE LEADING HYPOTHESIS IS THAT NONE OF THESE ROWS WILL EXIST. Finding 1
 * established the grant blocks do not read as controls; a click that lands on
 * the card but not on the <button> produces exactly this evidence — no error,
 * no IPC, no daemon record, and an operator certain they clicked. If so,
 * findings 2 and 5 collapse into Finding 1 rather than being new bugs. That is
 * worth MEASURING rather than assuming: "probably the same bug" and "measured
 * to be the same bug" are different claims.
 *
 * DEV-GATED. This is instrumentation for one question, not a product surface.
 * An unbounded breadcrumb table on every click is the kind of thing that
 * becomes load-bearing by accident.
 */

/** The four points on the path from the button to the wire, in order. */
export type UiTracePoint =
  /** 1. ExecApprovalCard's onClick fired — the verb the CARD passed. */
  | 'card:click'
  /** 2. MainView.resolveApproval entered — what survived the prop hop. */
  | 'mainview:resolve-enter'
  /** 3. About to cross the process boundary via the preload bridge. */
  | 'mainview:pre-invoke'
  /** 4. The main-process handler was entered — what actually arrived. */
  | 'main:handler-enter'

export interface UiTraceEvent {
  point: UiTracePoint
  /**
   * Wall clock (epoch ms). The ONLY field comparable ACROSS processes — the
   * renderer and main have separate monotonic origins.
   */
  at: number
  /**
   * Monotonic, from performance.now(), in the process named by `proc`.
   *
   * ⚠ NOT comparable across processes: renderer and main each zero their own
   * clock at their own start. Compare `mono` only between rows sharing a
   * `proc`; use `at` to align across the boundary.
   *
   * Recorded because ORDERING ALONE CANNOT SHOW A TIMING BREAK. If the call
   * crosses but arrives after something else already resolved the request, the
   * rows appear in the right order and the defect is invisible. Cheap to record
   * now, unrecoverable afterwards.
   */
  mono: number
  proc: 'renderer' | 'main'
  /** The approval this click concerns. */
  requestId?: string
  /** The scope verb as it stood AT THIS POINT — the value whose drift is in question. */
  scope?: string
  /** Anything else worth carrying (decision kind, error text). */
  detail?: string
}

/** Bounded, like socket_events. Four rows per click; this holds ~75 clicks. */
export const UI_TRACE_MAX_ROWS = 300

/** One-line rendering for reading the table back. Pure. */
export function describeUiTrace(e: UiTraceEvent): string {
  const when = new Date(e.at).toISOString().replace('T', ' ').slice(11, 23)
  const scope = e.scope === undefined ? '' : ` scope=${JSON.stringify(e.scope)}`
  const rid = e.requestId ? ` req=${e.requestId}` : ''
  const detail = e.detail ? ` — ${e.detail}` : ''
  return `${when} [${e.proc}] ${e.point}${rid}${scope} mono=${e.mono.toFixed(1)}ms${detail}`
}

/**
 * Did the click reach the process boundary?
 *
 * The whole question in one predicate: if `card:click` exists and
 * `main:handler-enter` does not, the break is renderer-side. If NEITHER exists,
 * the button never fired at all — Finding 1.
 */
export function traceVerdict(rows: UiTraceEvent[]): string {
  const has = (p: UiTracePoint): boolean => rows.some((r) => r.point === p)
  if (!has('card:click')) return 'the button never fired — the click did not hit the control (Finding 1)'
  if (!has('mainview:resolve-enter')) return 'the card fired but the handler prop was never invoked'
  if (!has('mainview:pre-invoke')) return 'resolveApproval entered but returned before invoking IPC'
  if (!has('main:handler-enter')) return 'the renderer invoked IPC but nothing arrived in main'
  return 'the call crossed the boundary intact — the break is downstream'
}
