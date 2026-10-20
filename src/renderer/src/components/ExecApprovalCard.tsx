import { Fragment, useEffect, type CSSProperties } from 'react'
import type { ApprovalRequest, ApprovalDecision } from '@shared/ipc'
import { disclosureLabel } from '@shared/approval-disclosure'
import { approvalKey, isTypingTarget } from '@shared/approval-keys'
import { approvalScopes, workerApprovalView } from '@shared/workers'
import { Icon } from './Icon'
import { trace } from '../ui-trace-client'

/**
 * Exec-approval card. Surfaces one daemon pending action with its FIVE choices, not two.
 *
 * SPRINT-CONSENT: the daemon now ships `extents` — what each scope verb WOULD grant, over what,
 * for how long, computed ONCE by `prospective_extents()`. This card renders those strings
 * VERBATIM and never re-derives or re-words them. Two surfaces computing the same extent is the
 * defect the sprint existed to remove: the prompt used to state duration and never extent, while
 * the approval quietly widened a single file to its whole parent directory.
 *
 * The default NARROWS: "Approve once" is the primary action and creates no grant. Everything that
 * outlives the call sits below it, under an explicit "Remember this decision" heading, described
 * in the daemon's own words — including which of them widen to a directory. Beacon deliberately
 * does NOT classify the verbs itself (no local `endsWith(' here')` check): the daemon's prose
 * already says "on exactly …" vs "on anything under …", and duplicating `scope_widens` here would
 * re-introduce the second definition this sprint deleted.
 *
 * `extents` is an OBJECT keyed by verb, so `{}` is the empty case — meaning no describable target,
 * so no remembered grant is on offer. Then only Approve once / Deny render. Never a fabricated one.
 *
 * ── `{}` IS A RULING, NOT A GAP (2026-09-19) ─────────────────────────────────────────────────
 *
 * The empty case used to render NOTHING, and nothing reads as something missing — an operator
 * meeting a card with no "Remember this decision" cannot tell a permanent rule from a daemon too
 * old to offer one. It is permanent for two whole classes now: a third-party MCP tool carries no
 * path and no command, and a PAYLOAD-BEARING desktop action (typing, menu invocation) is not
 * rememberable AT ALL by ruling — remembering "type this" would mint "type ANY text into this
 * app, forever" from a prompt that showed one string, which is the narrow-prompt/wide-grant
 * inversion SPRINT-CONSENT exists to refuse. So the slot now carries a SENTENCE.
 *
 * That sentence states WHAT IS ON OFFER, never WHY — "no lasting option" is Beacon reading the
 * field it was sent; the reason belongs to the daemon and rides in `description` when it has one
 * ("no lasting grant is offered: the value of text cannot be part of a remembered grant…").
 * Beacon naming the cause would be it classifying the request, the same thing the verb comment
 * above forbids.
 *
 * ── ARGUMENTS: FOR `type_text` THE ARGUMENTS ARE THE DECISION ────────────────────────────────
 *
 * The card named the tool and the reason and nothing else. That survives a file write, whose
 * reason carries the path; it does not survive a desktop action, where the reason names neither
 * the text nor the target. Approving a keystroke without seeing it is not consent, so the
 * arguments render — VERBATIM, already scrubbed and truncated daemon-side, and ABOVE the two
 * buttons. Above is load-bearing and the daemon pins the same order in its own prompt: answer
 * options offered before the thing being decided invite the reflex answer, and `A` is one key.
 *
 * Approvals are GLOBAL (no session id), so MainView renders these in one fixed top-center overlay,
 * not per session. Inline-styled (no Tailwind, no icon deps), matching MessageRenderer's approach.
 */

// LAPIS, not sang (match spec, step 12). A permission request is a QUESTION, not an error, and
// painting it in the error colour teaches the reader to dread the thing they are supposed to read.
// Mixed into --node, not transparent: the card floats over every view (Config included), and a 6% tint over nothing let the page
// show through it. --node is opaque in every theme, and lint:contrast measures --lapis-text on it.
const card: CSSProperties = {
  background: 'color-mix(in srgb, var(--lapis) 6%, var(--node))',
  border: '1px solid color-mix(in srgb, var(--lapis) 35%, transparent)',
  borderRadius: 10,
  overflow: 'hidden'
}
const header: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '9px 12px',
  borderBottom: '1px solid color-mix(in srgb, var(--lapis) 20%, transparent)'
}
/** The command itself, in an inset. The user is approving THIS STRING — never a paraphrase. */
const commandInset: CSSProperties = {
  margin: 0,
  padding: '9px 11px',
  background: 'var(--paper)',
  border: '1px solid var(--line3)',
  borderRadius: 7,
  color: 'var(--ink-soft)',
  fontFamily: 'var(--font-mono)',
  fontSize: 11.5,
  lineHeight: 1.6,
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
  maxHeight: 160,
  overflowY: 'auto'
}
/**
 * THE ARGUMENTS BEING APPROVED. Same inset treatment as the command above, because it is the same
 * kind of thing: a literal the operator is consenting to, not prose about it.
 *
 * Bounded by CSS, never by a second truncation. The daemon already cut long values and SAID how
 * much it cut ("… (+391 more chars)"); a cut applied again here would be a silent one, which is
 * the defect rather than the fix. So a large block scrolls.
 */
const argsInset: CSSProperties = {
  padding: '8px 11px',
  background: 'var(--paper)',
  border: '1px solid var(--line3)',
  borderRadius: 7,
  maxHeight: 132,
  overflowY: 'auto'
}
/** The daemon's own word for this block in its Telegram prompt — one vocabulary, two surfaces. */
const argsLabel: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 10,
  color: 'var(--ink3)',
  marginBottom: 5
}
const argsGrid: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'auto minmax(0, 1fr)',
  columnGap: 10,
  rowGap: 3,
  margin: 0
}
const argKey: CSSProperties = {
  margin: 0,
  fontFamily: 'var(--font-mono)',
  fontSize: 11.5,
  lineHeight: 1.5,
  color: 'var(--ink3)',
  whiteSpace: 'nowrap'
}
const argVal: CSSProperties = {
  margin: 0,
  fontFamily: 'var(--font-mono)',
  fontSize: 11.5,
  lineHeight: 1.5,
  color: 'var(--ink-soft)',
  // The value is the decision. It wraps rather than being clipped or ellipsised — an argument
  // the card hides is an argument the operator approved without reading.
  whiteSpace: 'pre-wrap',
  overflowWrap: 'anywhere'
}
/**
 * The `{}` slot. Occupies the place the disclosure would have taken, so the absence of a
 * "Remember this decision" control reads as a stated rule instead of a missing feature.
 */
const noGrantNote: CSSProperties = {
  fontSize: 11,
  lineHeight: 1.5,
  color: 'var(--c-text-dim)',
  padding: '4px 0'
}
// The key glyph, quieter than the label by FACE and SIZE — not by opacity. The match spec draws
// it at 70%; --on-sang over --sang at 70% composites to ~3.5:1, under the ink floor, and an
// opacity-dimmed glyph is invisible to lint:contrast. Same call as the Send button's ⏎.
const actionKey: CSSProperties = { fontFamily: 'var(--font-mono)', fontSize: 10 }
// The remembered-grant option's styling moved to .approval-scope-btn in
// styles.css: inline styles cannot express :hover / :focus-visible / :active,
// and those states ARE the affordance that was missing.
const verbChip: CSSProperties = {
  fontFamily: 'var(--font-mono, monospace)',
  fontSize: 11,
  fontWeight: 600,
  color: 'var(--c-warn)'
}

function age(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000))
  return s < 60 ? `${s}s ago` : `${Math.floor(s / 60)}m ago`
}

/**
 * Countdown to an instant the DAEMON supplied. This renders a provided timestamp relative to now;
 * it never derives the window from createdAt plus a timeout Beacon holds locally. Returns null
 * when the daemon sent nothing — the card then shows no countdown at all rather than guessing one.
 *
 * Re-renders ride MainView's existing 3s poll, matching age()'s granularity — no extra timer.
 */
function expiresIn(expiresAt?: number): string | null {
  if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) return null
  const s = Math.round((expiresAt - Date.now()) / 1000)
  if (s <= 0) return 'expired'
  return s < 60 ? `expires in ${s}s` : `expires in ${Math.floor(s / 60)}m`
}

export function ExecApprovalCard({
  approval,
  error,
  cannotApprove = null,
  disclosureOpen = false,
  onToggleDisclosure,
  first,
  activeSessionId,
  onResolve
}: {
  approval: ApprovalRequest
  /** Daemon rejection text (e.g. a 400 from a scope the daemon does not accept). Shown, not swallowed. */
  error?: string | null
  /** Set when Approve was refused because this Beacon may not approve it (a worker's request, 401 not_a_person): the line to show
   *  in place of Approve. Deny stays. See @shared/approval-refusal. */
  cannotApprove?: string | null
  /**
   * Is THIS request's grant list open? Owned by MainView, keyed by request id.
   *
   * Deliberately NOT local state and deliberately NOT persisted: a new request
   * has a different id, so it is closed by construction. See
   * shared/approval-disclosure.ts for why that rule is load-bearing.
   */
  disclosureOpen?: boolean
  onToggleDisclosure?: () => void
  /** This is the FIRST pending card, so `A`/`D` have an unambiguous referent. See approval-keys. */
  first?: boolean
  /** The conversation on screen, so a worker's request can say whether it is this one. */
  activeSessionId?: string | null
  onResolve: (d: ApprovalDecision) => void
}) {
  // Payload order — the daemon emits these from approve_verbs(), so preserving insertion order
  // preserves ITS ordering decision instead of imposing one here. None at all for a worker's or
  // any once-only request: the daemon refuses every lasting scope on those (409 once_only).
  const scopes = approvalScopes(approval)
  // A worker's request (Prometheus 720) names the worker and its conversation in the header.
  const worker = workerApprovalView(approval, activeSessionId)
  // Wire order, untouched — the daemon sorted these, and re-ordering to put the "important" one
  // first would be Beacon deciding which argument matters. See @shared/approval-arguments.
  const args = Object.entries(approval.arguments ?? {})
  const countdown = expiresIn(approval.expiresAt)

  // `A` approves once, `D` denies — under the narrow conditions in @shared/approval-keys. The
  // listener is on the window because the card has no focus of its own: the user is reading it,
  // not tabbing through it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const action = approvalKey({
        key: e.key,
        modified: e.metaKey || e.ctrlKey || e.altKey,
        typing: isTypingTarget(e.target as HTMLElement | null),
        first: first !== false
      })
      if (!action) return
      if (action === 'approve' && cannotApprove) return // nothing to approve with here; `A` falls through to the page
      e.preventDefault()
      if (action === 'approve') {
        trace({ point: 'card:click', requestId: approval.requestId, scope: 'once' })
        onResolve({ kind: 'approve', scope: 'once' })
      } else onResolve({ kind: 'deny' })
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [approval.requestId, first, onResolve, cannotApprove])

  return (
    <div style={card}>
      <div style={header}>
        {/* A warning triangle in lapis, drawn rather than an emoji: the emoji renders full-colour
            and ignores the card's own palette, which is the whole point of the lapis decision. */}
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--lapis)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
          <path d="M12 9v4" />
          <path d="M12 17h.01" />
        </svg>
        <span style={{ fontSize: 11.5, color: 'var(--lapis-text)' }}>
          {worker ? worker.title : 'Permission needed'}
          {worker?.where ? <span style={{ color: 'var(--ink3)' }}> · {worker.where}</span> : null}
        </span>
        {/* The TOOL, not a re-worded "scope". `extents` describes what each verb WOULD grant if
            you chose it — it is the answer to a question the user has not been asked yet, and
            printing one of its entries here as "the scope being requested" would misreport it. */}
        <span style={{ marginLeft: 'auto', fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--ink3)' }}>
          {approval.toolName} · {age(approval.createdAt)}
          {countdown ? ` · ${countdown}` : ''}
        </span>
      </div>
      <div style={{ padding: '11px 12px', display: 'flex', flexDirection: 'column', gap: 10 }}>
        {/* No `cwd` line: the request carries a description and a tool name, and no working
            directory, so there is nothing true to put on the second line. */}
        <pre style={commandInset}>{approval.description}</pre>

        {/* ABOVE the buttons, deliberately — see the header note. A definition list rather than
            styled divs: these ARE name/value pairs, and a screen reader should say so. */}
        {args.length > 0 ? (
          <div style={argsInset}>
            <div style={argsLabel}>With</div>
            <dl style={argsGrid}>
              {args.map(([key, value]) => (
                <Fragment key={key}>
                  <dt style={argKey}>{key}</dt>
                  <dd style={argVal}>{value}</dd>
                </Fragment>
              ))}
            </dl>
          </div>
        ) : null}

        {error ? (
          <div
            style={{
              padding: '7px 10px',
              borderRadius: 6,
              border: '1px solid var(--sang)',
              color: 'var(--c-err-text)',
              fontSize: 12,
              fontFamily: 'var(--font-mono, monospace)',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word'
            }}
          >
            {error}
          </div>
        ) : null}

        {cannotApprove ? (
          <div style={{ fontSize: 12.5, lineHeight: 1.5, color: 'var(--c-text)' }} data-testid="approval-cannot-approve">
            {cannotApprove}
          </div>
        ) : null}

        <div style={{ display: 'flex', gap: 8 }}>
          {cannotApprove ? null : (
            <button
              className="approval-btn approval-btn-approve"
              onClick={() => {
                trace({ point: 'card:click', requestId: approval.requestId, scope: 'once' })
                onResolve({ kind: 'approve', scope: 'once' })
              }}
            >
              {/* "once" stays in the LABEL. This button creates no remembered grant, and calling it
                  plain "Approve" beside a disclosure that does would blur exactly the line the
                  disclosure exists to draw. */}
              Approve once <span style={actionKey}>A</span>
            </button>
          )}
          <button className="approval-btn approval-btn-deny" onClick={() => onResolve({ kind: 'deny' })}>
            Deny <span style={actionKey}>D</span>
          </button>
        </div>

        {/* Empty extents → NO disclosure at all. The daemon is saying this request
            carries no describable target, so no remembered grant is on offer;
            an empty expander would imply one exists.

            The ELSE branch is not decoration. Rendering nothing left the operator
            unable to tell a permanent rule ("a payload-bearing action is never
            rememberable") from a transient lack ("this daemon is too old to offer
            one"), and the two call for opposite responses. The sentence reports the
            FIELD — no lasting option was offered — and leaves the WHY to the daemon,
            which states it in `description` above when it has one to state. */}
        {scopes.length > 0 ? (
          <div>
            {/* Same control as the sidebar's session-group header — already
                keyboard-reachable, already aria-expanded, already proven. The
                ONLY thing now adjacent to the two safe buttons, and hitting it
                by accident does nothing but open a list. */}
            <button
              className="approval-disclosure-head"
              onClick={() => onToggleDisclosure?.()}
              aria-expanded={disclosureOpen}
              title={
                disclosureOpen
                  ? 'Hide the options that create a lasting grant'
                  : 'Show the options that create a lasting grant'
              }
            >
              <Icon name={disclosureOpen ? 'chevron-down' : 'chevron-right'} size={11} />
              <span>{disclosureLabel(scopes.length)}</span>
            </button>
            {disclosureOpen ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 6 }}>
                {scopes.map(([verb, describes]) => (
                  <button
                    key={verb}
                    className="approval-scope-btn"
                    title={describes}
                    onClick={() => {
                      // BREADCRUMB 1 — the button fired, and this is the verb the CARD
                      // holds. Measured 2026-08-17: all four breadcrumbs appear and the
                      // scope survives intact, so the path is faithful; the failures
                      // were clicks that never landed on a control.
                      trace({ point: 'card:click', requestId: approval.requestId, scope: verb })
                      onResolve({ kind: 'approve', scope: verb })
                    }}
                  >
                    <span style={verbChip}>{verb}</span>
                    <span style={{ display: 'block', marginTop: 2, color: 'var(--c-text-dim)' }}>{describes}</span>
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        ) : cannotApprove ? null : (
          <div style={noGrantNote}>
            This action is approved once, each time — no lasting grant is on offer.
          </div>
        )}
      </div>
    </div>
  )
}
