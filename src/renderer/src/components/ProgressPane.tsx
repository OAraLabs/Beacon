// The dock's fourth pane: a run's PLAN, what it PRODUCED, and a slot for computer use — beside the
// conversation, which is the whole point. Board and Mission already show plan state; neither sits
// next to the thread, so neither lets you watch a run and its checklist at once.
//
// THREE THINGS THIS PANE REFUSES TO DO:
//
//  1. Render blank where there is no conversation. The dock also opens on chat Home and beside a
//     coding run, where `sessionId` is null. An empty pane under a correct header reads as broken,
//     so each of those says which it is and why.
//  2. Call the artifacts outbox "outputs". It is a flat directory with no producer field, and the
//     only existing per-conversation association is a substring match on message text. Outputs here
//     are the agent's own file-writing tool calls in THIS transcript — see @shared/outputs.
//  3. Show a desktop task as anything but what the daemon's action log says (computer_* frames,
//     Prometheus PR 663, folded in @shared/computer). The section shows the latest task's own words:
//     its app, the goal, how many steps and approvals, the last step (whose description is the
//     APP's text), the outcome, and a Stop that says plainly what a stop cannot undo.
//
// Scrolls itself: `.side-panel` is `overflow: hidden` and `.side-panel-body` declares no overflow,
// so a stacked pane is clipped rather than scrolled unless it brings its own container.

import { useCallback, useEffect, useState, type CSSProperties, type ReactNode } from 'react'
import { DOCS_CONTENT_PATH, docsListPath, docsReadPath, type DocListDTO, type DocReadDTO } from '@shared/documents'
import { httpStatusFromError } from '@shared/daemon-api'
import {
  PLAN_BANNERS,
  PLAN_DIR,
  listHitCap,
  planFileFor,
  planStateFrom,
  taskIdFromText,
  type PlanState
} from '@shared/plan'
import { setTaskDone } from '@shared/loop'
import { OUTPUTS_EMPTY, baseName, producedFiles, type OutputMessage, type ProducedFile } from '@shared/outputs'
import {
  computerLogRows,
  computerOutcomeLabel,
  computerStepLabel,
  consentLabel,
  hasPendingApproval,
  latestTask,
  missingSeqs,
  type ComputerTaskLive
} from '@shared/computer'
import type { ApprovalDecision } from '@shared/ipc'
import {
  computerTaskStartBody,
  EMPTY_START_FORM,
  isNeedsApp,
  pickerRows,
  startFormError,
  type DoorRefusal,
  type StartForm
} from '@shared/computer-door'
import { useGateway } from '../gateway-store'
import { Icon } from './Icon'
import { MONO, PlanBody } from './PlanSection'

const wrap: CSSProperties = { flex: 1, minHeight: 0, overflowY: 'auto', padding: '10px 12px 24px' }
/** The empty pending-approval set. A module constant so an absent prop does not allocate a new
 *  Set on every render (which would defeat the row memo's referential stability downstream). */
const NO_IDS: ReadonlySet<string> = new Set<string>()
const head: CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 6, margin: '14px 0 6px',
  fontSize: 10, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--c-text-dim)'
}
const prose: CSSProperties = { fontSize: 12, color: 'var(--c-text-dim)', lineHeight: 1.5 }
const warn: CSSProperties = { ...prose, color: 'var(--c-warn)' }
const toneText = (t: 'ok' | 'warn' | 'err'): string =>
  t === 'ok' ? 'var(--c-ok-text)' : t === 'err' ? 'var(--c-err-text)' : 'var(--c-warn-text)'
const stopBtn = (disabled: boolean): CSSProperties => ({
  fontSize: 11,
  padding: '3px 10px',
  borderRadius: 6,
  border: `1px solid ${disabled ? 'var(--c-line)' : 'var(--c-err)'}`,
  background: 'transparent',
  color: disabled ? 'var(--c-text-faint)' : 'var(--c-err-text)',
  cursor: disabled ? 'not-allowed' : 'pointer',
  fontFamily: 'inherit',
  flexShrink: 0
})

// ── the desktop task's step log ────────────────────────────────────────────
const logList: CSSProperties = {
  listStyle: 'none', margin: '2px 0 0', padding: 0,
  display: 'flex', flexDirection: 'column', gap: 2,
  maxHeight: 220, overflowY: 'auto'
}
const logRow: CSSProperties = { display: 'flex', gap: 6, alignItems: 'baseline' }
const logSeq: CSSProperties = {
  fontFamily: MONO, fontSize: 10, color: 'var(--c-text-faint)',
  minWidth: 16, textAlign: 'right', flexShrink: 0
}
const logBody: CSSProperties = { fontSize: 11, color: 'var(--c-text-dim)', lineHeight: 1.5, minWidth: 0 }
/** The app's own words, in the mono face the pane uses for text it did not write. */
const logAppText: CSSProperties = { fontFamily: MONO, fontSize: 11, color: 'var(--c-text)' }
const logConsent: CSSProperties = { fontSize: 10, color: 'var(--c-text-faint)' }
const logWarn: CSSProperties = { fontSize: 10, color: 'var(--c-warn-text)' }
const logApproval: CSSProperties = { display: 'inline-flex', gap: 4, marginLeft: 6 }
const answerBtn = (tone: 'ok' | 'err'): CSSProperties => ({
  fontSize: 10,
  padding: '1px 7px',
  borderRadius: 5,
  border: `1px solid var(${tone === 'ok' ? '--c-ok' : '--c-err'})`,
  background: 'transparent',
  color: tone === 'ok' ? 'var(--c-ok-text)' : 'var(--c-err-text)',
  cursor: 'pointer',
  fontFamily: 'inherit'
})
const approveBtn = answerBtn('ok')
const denyBtn = answerBtn('err')
/** A step's thumbnail: capped so a big window never pushes the log around, aspect kept when the
 *  daemon sent dimensions (an unknown aspect just shrinks to fit the cap). */
const thumbImg = (width: number | null, height: number | null): CSSProperties => ({
  display: 'block',
  marginTop: 3,
  maxWidth: 160,
  maxHeight: 120,
  width: 'auto',
  height: 'auto',
  ...(width && height ? { aspectRatio: `${width} / ${height}` } : {}),
  borderRadius: 4,
  border: '1px solid var(--c-line)',
  objectFit: 'contain'
})

/** The status word's tone: a step that ran is ordinary text, one that could not act is a warning,
 *  and one that failed is an error. A status Beacon has never seen renders in ordinary text —
 *  colouring an unknown as alarming would be a claim about it. */
const logStatus = (r: { status: string }): CSSProperties => ({
  fontSize: 11,
  color: r.status === 'failed' ? 'var(--c-err-text)'
    : r.status === 'refused' || r.status === 'blocked' || r.status === 'awaiting_approval' || r.status === 'in_flight_at_stop'
      ? 'var(--c-warn-text)'
      : 'var(--c-text)'
})

function Section({ title, icon, children }: { title: string; icon: ReactNode; children: ReactNode }) {
  return (
    <section>
      <div style={head}>
        {icon}
        {title}
      </div>
      {children}
    </section>
  )
}

/** Read one story's plan: list the directory, resolve, read the file. The Board does this too; this
 *  is the shared version, so a third surface does not mean a third hand-written copy of the read. */
export function usePlan(storyId: string | null): {
  state: PlanState | null
  err: string | null
  dirMissing: boolean
  listCapped: boolean
  listErr: string | null
  toggle: (path: string, content: string, lineIndex: number, done: boolean, truncated: boolean) => void
} {
  const [state, setState] = useState<PlanState | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [dirMissing, setDirMissing] = useState(false)
  const [listCapped, setListCapped] = useState(false)
  const [listErr, setListErr] = useState<string | null>(null)

  useEffect(() => {
    const b = window.beacon
    if (!b || !storyId) {
      setState(null)
      return
    }
    let alive = true
    setState(null)
    setErr(null)
    void b.daemon
      .get(docsListPath(PLAN_DIR))
      .then((d) => {
        if (!alive) return
        setListErr(null)
        setDirMissing(false)
        const entries = (d as DocListDTO | null)?.entries ?? []
        setListCapped(listHitCap(entries.length))
        const names = entries.filter((e) => e.type === 'file').map((e) => e.name)
        const res = planFileFor(names, storyId)
        if (res.kind !== 'one') {
          setState(planStateFrom(res, null))
          return
        }
        void b.daemon
          .get(docsReadPath(`${PLAN_DIR}/${res.path}`))
          .then((doc) => {
            if (!alive) return
            const r = doc as DocReadDTO | null
            setState(planStateFrom(res, r?.content ?? '', r?.truncated === true))
          })
          // A read failure is NOT "no plan" — the caller renders the error, never an empty list.
          .catch((e) => { if (alive) setErr(String((e as Error)?.message ?? e)) })
      })
      .catch((e) => {
        if (!alive) return
        if (httpStatusFromError(e) === 404) {
          setDirMissing(true)
          setListErr(null)
          setState(planStateFrom({ kind: 'none', nearMisses: [] }, null))
        } else setListErr(String((e as Error)?.message ?? e))
      })
    return () => {
      alive = false
    }
  }, [storyId])

  /** Tick one line and save it back byte-faithfully — the Board's write, from the shared model. */
  const toggle = useCallback(
    (path: string, content: string, lineIndex: number, done: boolean, truncated: boolean): void => {
      const b = window.beacon
      if (!b) return
      // The content in hand is a 256 KiB PREFIX when the read was capped, and PUT replaces the
      // whole file: writing it back would delete everything past the cap and report success.
      // PlanBody already disables the control; this is the second line of the same refusal.
      if (truncated) return
      const next = setTaskDone(content, lineIndex, done)
      setState((cur) => (cur && cur.kind === 'checklist' ? planStateFrom({ kind: 'one', path }, next) : cur))
      void b.daemon
        .write(DOCS_CONTENT_PATH, { path: `${PLAN_DIR}/${path}`, content: next }, 'PUT')
        .catch((e) => setErr(String((e as Error)?.message ?? e)))
    },
    []
  )

  return { state, err, dirMissing, listCapped, listErr, toggle }
}

export function ProgressPane({ sessionId, view, pendingApprovalIds, onResolveApproval }: {
  sessionId: string | null
  view: string
  /** The approval ids still in the daemon's queue, and how to answer one — see SidePanelProps.
   *  Absent means the desktop log renders its steps with no inline approve/deny control. */
  pendingApprovalIds?: ReadonlySet<string>
  onResolveApproval?: (requestId: string, decision: ApprovalDecision) => void
}) {
  const [messages, setMessages] = useState<OutputMessage[] | null>(null)
  const [msgErr, setMsgErr] = useState<string | null>(null)

  useEffect(() => {
    const b = window.beacon
    if (!b || !sessionId) {
      setMessages(null)
      return
    }
    let alive = true
    setMessages(null)
    setMsgErr(null)
    void b.daemon
      .get(`/api/sessions/${encodeURIComponent(sessionId)}/messages?since=0`)
      .then((d) => {
        if (!alive) return
        const rows = (d as { messages?: OutputMessage[] } | null)?.messages ?? []
        setMessages(rows)
      })
      .catch((e) => { if (alive) setMsgErr(String((e as Error)?.message ?? e)) })
    return () => {
      alive = false
    }
  }, [sessionId])

  // The story this conversation is about, read from its own transcript — the only place a story's
  // key ever reaches a chat. A conversation nobody dispatched has none, which is not an error.
  const storyId = messages ? taskIdFromText(messages.map((m) => m.content ?? '').join('\n')) : null
  const plan = usePlan(storyId)
  const produced: ProducedFile[] = messages ? producedFiles(messages) : []

  // ── No conversation: say WHICH of the three it is, never render blank ─────────────────────
  if (!sessionId) {
    const onRun = view === 'coding' || view === 'loop-manager'
    return (
      <div style={wrap}>
        <Section title="progress" icon={<Icon name="check" size={11} />}>
          <div style={prose}>
            {onRun
              ? 'The dock is open beside a run, not a conversation. This pane follows a chat — its plan, and the files it writes. Open a conversation to fill it.'
              : 'No conversation is open. Pick one from the list, or start a new one, and its plan and outputs appear here.'}
          </div>
        </Section>
      </div>
    )
  }

  return (
    <div style={wrap}>
      {/* ── 1. PROGRESS ─────────────────────────────────────────────────────────────────── */}
      <Section title={storyId ? `progress · ${storyId}` : 'progress'} icon={<Icon name="check" size={11} />}>
        {msgErr ? (
          <div style={{ ...prose, color: 'var(--c-err)' }}>
            Could not read this conversation: {msgErr}. It may well have a plan — the read failed.
          </div>
        ) : messages === null ? (
          <div style={prose}>Reading the conversation…</div>
        ) : !storyId ? (
          <div style={prose}>
            No task is linked to this conversation, so there is no plan to follow. A conversation
            dispatched from the Board carries its task id, and the agent names its plan file after
            it. This one was started by hand.
          </div>
        ) : (
          <>
            {plan.listErr ? <div style={warn}>{PLAN_BANNERS.listFailed(plan.listErr)}</div> : null}
            {plan.listCapped ? <div style={warn}>{PLAN_BANNERS.listingCapped(2000)}</div> : null}
            {plan.dirMissing ? <div style={prose}>{PLAN_BANNERS.noneSavedYet(PLAN_DIR)}</div> : null}
            {/* Chrome-free: the dock already supplies the header, the width and the close. Ticking
                writes through to the same file the Board writes — an inert checkbox beside a live
                plan reads as a bug, not as a decision. */}
            <PlanBody storyId={storyId} state={plan.state} err={plan.err} onToggle={plan.toggle} />
          </>
        )}
      </Section>

      {/* ── 2. OUTPUTS — the transcript's own tool calls, nothing else ───────────────────── */}
      <Section title={produced.length ? `outputs · ${produced.length}` : 'outputs'} icon={<Icon name="files" size={11} />}>
        {messages === null && !msgErr ? (
          <div style={prose}>Reading the conversation…</div>
        ) : produced.length === 0 ? (
          <div style={prose}>{OUTPUTS_EMPTY.noneInThisConversation}</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
            {produced.map((f) => (
              <div key={f.path} style={{ display: 'flex', alignItems: 'baseline', gap: 6 }} title={f.path}>
                <span style={{ fontFamily: MONO, fontSize: 11, color: 'var(--c-text)', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {baseName(f.path)}
                </span>
                <span style={{ fontFamily: MONO, fontSize: 10, color: 'var(--c-text-dim)', flexShrink: 0 }}>
                  {f.tool === 'edit_file' ? 'edited' : 'written'}
                </span>
              </div>
            ))}
          </div>
        )}
      </Section>

      {/* ── 3. COMPUTER USE — the daemon's desktop action log for this conversation ─────── */}
      <Section title="computer use" icon={<Icon name="terminal" size={11} />}>
        <ComputerUse sessionId={sessionId} pendingApprovalIds={pendingApprovalIds} onResolveApproval={onResolveApproval} />
      </Section>
    </div>
  )
}

type StopState =
  | { taskId: string; phase: 'sending' }
  | { taskId: string; phase: 'sent'; stopped?: boolean }
  | { taskId: string; phase: 'failed'; error: string }

/** Executed actions so far: the daemon's own count once the task ended, else the step frames
 *  that dispatched (an action in flight at a stop counts — it may have landed). */
function stepCount(t: ComputerTaskLive): number {
  return t.ended?.steps ?? t.steps.filter((s) => s.status === 'executed' || s.status === 'in_flight_at_stop').length
}
/** Approvals asked so far: the daemon's count once ended, else one per step that waited on one. */
function approvalCount(t: ComputerTaskLive): number {
  return t.ended?.approvals ?? t.steps.filter((s) => s.status === 'awaiting_approval').length
}
const plural = (n: number, w: string): string => `${n} ${w}${n === 1 ? '' : 's'}`

/**
 * The latest desktop task in this conversation, from the gateway store's `computer` state (the
 * live computer_* frames, with this session's log backfilled on open and after a reconnect). The
 * full step-by-step log is a later pane; this is the "what is it doing, and can I stop it" line.
 */
function ComputerUse({ sessionId, pendingApprovalIds, onResolveApproval }: {
  sessionId: string
  pendingApprovalIds?: ReadonlySet<string>
  onResolveApproval?: (requestId: string, decision: ApprovalDecision) => void
}) {
  const { computer, backfillComputer } = useGateway()
  const [backfillErr, setBackfillErr] = useState<string | null>(null)
  const [stop, setStop] = useState<StopState | null>(null)

  useEffect(() => {
    let alive = true
    const load = (): void => {
      void backfillComputer(sessionId).then((e) => {
        if (alive) setBackfillErr(e)
      })
    }
    load()
    // A reconnect is a gap in the live stream: read the log again, the reducer de-dupes by seq.
    let last: string | null = null
    const off = window.beacon?.connection.onStatus((st) => {
      if (st.state === 'connected' && last !== null && last !== 'connected') load()
      last = st.state
    })
    return () => {
      alive = false
      off?.()
    }
  }, [sessionId, backfillComputer])

  const sess = computer.sessions[sessionId]
  const task = latestTask(sess)
  const binding = sess?.binding?.on ? sess.binding : null

  async function stopTask(taskId: string): Promise<void> {
    const b = window.beacon
    if (!b) return
    setStop({ taskId, phase: 'sending' })
    try {
      const res = await b.computer.stopTask(taskId)
      setStop(res.sent ? { taskId, phase: 'sent', stopped: res.stopped } : { taskId, phase: 'failed', error: res.error ?? 'not sent' })
    } catch (e) {
      setStop({ taskId, phase: 'failed', error: String((e as Error)?.message ?? e) })
    }
  }

  const footer = (
    <>
      {backfillErr ? (
        <div style={warn}>Could not read this conversation's earlier desktop log: {backfillErr}. Live steps still appear.</div>
      ) : null}
      {computer.unplaced > 0 ? (
        <div style={warn}>
          {plural(computer.unplaced, 'desktop-log frame')} arrived without the ids needed to place {computer.unplaced === 1 ? 'it' : 'them'}.
        </div>
      ) : null}
      {computer.orphanStreamError ? <div style={warn}>The daemon's desktop log failed: {computer.orphanStreamError}</div> : null}
    </>
  )

  if (!task) {
    return (
      <>
        <div style={prose}>
          {binding
            ? `${binding.app} is picked for ${binding.scope === 'task' ? 'the next task' : 'this conversation'}. No desktop task has run here yet.`
            : 'No desktop task in this conversation yet. A task started here, from Telegram or over the API shows here as it runs.'}
        </div>
        {binding?.describes ? <div style={prose}>{binding.describes}</div> : null}
        <ComputerDoor sessionId={sessionId} binding={binding} />
        {footer}
      </>
    )
  }

  const running = !task.ended
  const last = task.steps.length ? task.steps[task.steps.length - 1] : null
  const outcome = task.ended ? computerOutcomeLabel(task.ended.outcome) : null
  const gaps = missingSeqs(task)
  // The whole log, oldest first, with each step's still-actionable approval identified. The rows
  // are pure (@shared/computer): this component renders them and decides nothing about order,
  // de-dupe or which text wins — all of that is smoke-tested without a window.
  const rows = computerLogRows(task, pendingApprovalIds ?? NO_IDS)
  const anyPending = hasPendingApproval(rows)
  const myStop = stop && stop.taskId === task.taskId ? stop : null
  // The daemon's answer: the WS ack in the store, or the REST reply when the socket was down.
  const answered = task.stopAck ?? (myStop?.phase === 'sent' ? myStop.stopped ?? null : null)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
        <span style={{ fontFamily: MONO, fontSize: 11, color: 'var(--c-text)', flexShrink: 0 }}>{task.started?.app || binding?.app || 'desktop'}</span>
        <span style={{ fontSize: 12, color: 'var(--c-text)', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={task.started?.goal}>
          {task.started?.goal || 'goal not received'}
        </span>
        <span style={{ fontSize: 11, flexShrink: 0, color: outcome ? toneText(outcome.tone) : 'var(--c-text-dim)' }} title={task.ended?.reason || undefined}>
          {outcome ? outcome.text : 'Running'}
        </span>
      </div>
      <div style={prose}>
        {plural(stepCount(task), 'step')} · {plural(approvalCount(task), 'approval')}
        {task.ended?.reason ? ` · ${task.ended.reason}` : ''}
      </div>
      {/* THE LOG — every step this task took, oldest first, not just the last one. A step that is
          waiting on an approval still in the daemon's queue gets its approve/deny control inline,
          so the person watching the log acts from here rather than hunting for the Approvals view. */}
      {rows.length > 0 ? (
        <ol style={logList} aria-label="Desktop task steps">
          {rows.map((r) => (
            <li key={r.seq} style={logRow}>
              <span style={logSeq} title={`Step ${r.seq}`}>{r.seq}</span>
              <span style={logBody}>
                <span style={logStatus(r)}>{r.label}</span>
                {r.appText ? (
                  <>
                    {': '}
                    {/* The app's own text (the element it chose), not Beacon's words: shown verbatim, as
                        text, in the mono face the pane uses for things it did not write. Never markup. */}
                    <span style={logAppText} title="Text from the app itself">{r.appText}</span>
                  </>
                ) : r.reason ? (
                  `: ${r.reason}`
                ) : null}
                {r.consent ? (
                  <span style={logConsent}> · {consentLabel(r.consent)}</span>
                ) : null}
                {r.effect === 'UNVERIFIABLE' ? (
                  <span style={logConsent} title="The window showed no change Beacon could confirm"> · unverified</span>
                ) : null}
                {r.afterStop ? (
                  <span style={logWarn}> · in flight at the stop</span>
                ) : null}
                {r.pendingApprovalId && onResolveApproval ? (
                  <span style={logApproval}>
                    <button style={approveBtn} onClick={() => onResolveApproval(r.pendingApprovalId as string, { kind: 'approve', scope: 'once' })}>Approve</button>
                    <button style={denyBtn} onClick={() => onResolveApproval(r.pendingApprovalId as string, { kind: 'deny' })}>Deny</button>
                  </span>
                ) : null}
                {/* THE THUMBNAIL (Prometheus PR 701). Joined by seq, not carried on the row: the image
                    frame arrives BEFORE its step, so it lives in task.thumbs keyed by seq and is
                    looked up here. src is only ever a data URL the model built from an allowlisted
                    mime — a refused one (src null, mimeType present) says so rather than rendering
                    a broken <img> or, worse, an unvalidated data URL. */}
                {(() => {
                  const thumb = task.thumbs[r.seq]
                  if (!thumb) return null
                  return thumb.src ? (
                    <img
                      src={thumb.src}
                      alt={`The ${thumb.app ?? 'app'} window after step ${r.seq}`}
                      title={thumb.app ? `The ${thumb.app} window after this step` : `The window after step ${r.seq}`}
                      style={thumbImg(thumb.width, thumb.height)}
                    />
                  ) : (
                    <span style={logWarn} title={`mime ${thumb.mimeType ?? 'unknown'} is not one Beacon renders`}>
                      {' '}· a picture Beacon will not show
                    </span>
                  )
                })()}
              </span>
            </li>
          ))}
        </ol>
      ) : last ? (
        /* A task the daemon reported but whose steps have not arrived (or an old daemon): fall back
           to the one-line summary rather than rendering an empty list that reads as "nothing
           happened". Honest about the gap, which `gaps` below also names. */
        <div style={prose}>
          Last step, {computerStepLabel(last.status)}
          {last.action?.description ? (
            <>
              {': '}
              <span style={logAppText} title="Text from the app itself">{last.action.description}</span>
            </>
          ) : last.reason ? (
            `: ${last.reason}`
          ) : null}
        </div>
      ) : null}
      {anyPending && !onResolveApproval ? (
        <div style={warn}>A step is waiting on your approval, but this surface cannot answer it — open the Approvals view.</div>
      ) : null}
      {task.ended?.inFlightAtStop ? (
        <div style={warn}>One action was already in flight when it stopped and may have landed.</div>
      ) : null}
      {gaps.length > 0 ? (
        <div style={warn}>{plural(gaps.length, 'step entry')} of this task did not reach Beacon (seq {gaps.join(', ')}).</div>
      ) : null}
      {task.streamError ? <div style={warn}>The daemon's log for this task failed: {task.streamError}. The task itself carries on.</div> : null}
      {running ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
          <button
            style={stopBtn(myStop?.phase === 'sending')}
            disabled={myStop?.phase === 'sending'}
            onClick={() => void stopTask(task.taskId)}
            title="Stop this desktop task"
            aria-label="Stop this desktop task"
          >
            {myStop?.phase === 'sending' ? 'Stopping…' : 'Stop'}
          </button>
          <span style={prose}>No new action starts after a stop; one action already in flight may still land.</span>
        </div>
      ) : null}
      {myStop?.phase === 'failed' ? <div style={{ ...prose, color: 'var(--c-err-text)' }}>Stop not sent: {myStop.error}</div> : null}
      {running && answered === true ? <div style={prose}>Stop accepted. Waiting for the task to end.</div> : null}
      {running && answered === false ? <div style={prose}>The daemon had nothing running under this task.</div> : null}
      {running && myStop?.phase === 'sent' && answered === null ? <div style={prose}>Stop sent.</div> : null}
      {footer}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// THE DOOR (v1.1 PR 7) — start a desktop task, and pick the app that IS the
// consent. This renders in the no-task state; once a task runs, the log above
// takes over. Every decision is in @shared/computer-door (smoke-tested without
// a window); this component only calls the bridge and renders what comes back.
//
// The daemon's own words are shown, not Beacon's: a refusal's `message` is the
// daemon's `detail` when it sent one (`fromDaemon`), and the picker's rows are
// the daemon's resolved app names. A refusal is rendered inline, never thrown —
// the door answers with a body, and flattening it to an Error string would lose
// the `needs_app` picker.
// ─────────────────────────────────────────────────────────────────────────────

type DoorPhase =
  | { kind: 'idle' }
  | { kind: 'busy'; what: string }
  | { kind: 'refused'; refusal: DoorRefusal }
  | { kind: 'started'; taskId: string }

function ComputerDoor({ sessionId, binding }: {
  sessionId: string
  /** The live binding from the store's `computer` state, or null when off. */
  binding: import('@shared/computer').ComputerBinding | null
}) {
  const [phase, setPhase] = useState<DoorPhase>({ kind: 'idle' })
  const [form, setForm] = useState<StartForm>(EMPTY_START_FORM)
  // The picker's rows: the daemon's app list, or — when a start came back
  // `needs_app` — the options THAT refusal carried. Either way the daemon's.
  const [apps, setApps] = useState<string[]>([])
  const [pickerOpen, setPickerOpen] = useState(false)
  const [appsErr, setAppsErr] = useState<string | null>(null)

  const b = window.beacon
  const formErr = startFormError(form)

  async function loadApps(): Promise<void> {
    if (!b) return
    setAppsErr(null)
    const res = await b.computer.listApps()
    if (res.ok) setApps(pickerRows(res.value?.apps ?? []))
    else {
      // A refusal to even list apps is shown, not swallowed: most often it is
      // not_a_person (this device is not marked for computer use) or
      // computer_use_off (the daemon has the feature off), and both are things
      // the person must see rather than guess at from an empty picker.
      setPhase({ kind: 'refused', refusal: res.refusal })
    }
  }

  async function pick(app: string): Promise<void> {
    if (!b || !app) return
    setPhase({ kind: 'busy', what: 'picking the app' })
    const res = await b.computer.setBinding(sessionId, app)
    if (res.ok) {
      setPickerOpen(false)
      setForm((f) => ({ ...f, app }))
      setPhase({ kind: 'idle' })
      // The live binding frame arrives on the socket; this re-reads so the pane
      // does not wait on it to show the pick took.
      void b.computer.getBinding(sessionId)
    } else {
      setPhase({ kind: 'refused', refusal: res.refusal })
    }
  }

  async function clear(): Promise<void> {
    if (!b) return
    setPhase({ kind: 'busy', what: 'clearing the pick' })
    const res = await b.computer.clearBinding(sessionId)
    if (res.ok) {
      setForm((f) => ({ ...f, app: '' }))
      setPhase({ kind: 'idle' })
    } else {
      setPhase({ kind: 'refused', refusal: res.refusal })
    }
  }

  async function start(): Promise<void> {
    if (!b || formErr) return
    setPhase({ kind: 'busy', what: 'starting the task' })
    const res = await b.computer.startTask(computerTaskStartBody(form, sessionId))
    if (res.ok) {
      const id = res.value?.task_id
      setPhase(id ? { kind: 'started', taskId: id } : { kind: 'idle' })
      setForm(EMPTY_START_FORM)
    } else if (isNeedsApp(res.refusal)) {
      // The door's consent step, not an error: it told us which apps to offer
      // and how the pick will read. Open the picker with THOSE rows.
      setApps(pickerRows(res.refusal.options))
      setPickerOpen(true)
      setPhase({ kind: 'refused', refusal: res.refusal })
    } else {
      setPhase({ kind: 'refused', refusal: res.refusal })
    }
  }

  const refused = phase.kind === 'refused' ? phase.refusal : null
  const busy = phase.kind === 'busy' ? phase.what : null

  return (
    <div style={doorWrap}>
      {/* The current pick, and the control to change or clear it. */}
      <div style={doorRow}>
        <span style={prose}>
          {binding?.on
            ? <>App: <span style={doorApp}>{binding.app}</span></>
            : 'No app picked yet — the pick is the consent.'}
        </span>
        {binding?.on ? (
          <button style={doorBtn(busy !== null)} disabled={busy !== null} onClick={() => void clear()}>Change / clear</button>
        ) : (
          <button
            style={doorBtn(busy !== null)}
            disabled={busy !== null}
            onClick={() => { setPickerOpen((o) => !o); if (apps.length === 0) void loadApps() }}
          >
            {pickerOpen ? 'Hide apps' : 'Pick an app'}
          </button>
        )}
      </div>

      {/* The picker: the daemon's app names. Selecting one IS the consent (W2),
          so this is not a cosmetic dropdown — it is the door's grant step. */}
      {pickerOpen && !binding?.on ? (
        <div style={doorPicker}>
          {appsErr ? <div style={warn}>{appsErr}</div> : null}
          {apps.length === 0 ? (
            <div style={prose}>No running apps with a window yet, or none Beacon may see.</div>
          ) : apps.map((a) => (
            <button key={a} style={doorAppBtn(busy !== null)} disabled={busy !== null} onClick={() => void pick(a)}>{a}</button>
          ))}
        </div>
      ) : null}

      {/* The start form. Only offered once an app is picked: starting without
          one comes back needs_app, which reopens the picker — so we could allow
          it, but not offering it first is the honest ordering (the daemon's
          consent sentence names the app the person is about to grant). */}
      <div style={doorCol}>
        <input
          style={doorInput}
          type="text"
          placeholder="What should it do? (the goal, in your words)"
          value={form.goal}
          aria-label="Desktop task goal"
          onChange={(e) => setForm((f) => ({ ...f, goal: e.target.value }))}
        />
        {/* TEXT IS SEPARATE FROM THE GOAL, and stays separate on the wire. The
            daemon types only this field, never something parsed out of the
            goal — so a keystroke is only ever one the person typed here, and
            only ever one the approval prompt showed. */}
        <input
          style={doorInput}
          type="text"
          placeholder="Text to type, if any (never read from the goal)"
          value={form.text}
          aria-label="Text to type"
          onChange={(e) => setForm((f) => ({ ...f, text: e.target.value }))}
        />
        <div style={doorRow}>
          <button style={startBtn(formErr !== null || busy !== null)} disabled={formErr !== null || busy !== null} onClick={() => void start()}>
            {busy ?? 'Start desktop task'}
          </button>
          {formErr ? <span style={doorHint}>{formErr}</span> : null}
        </div>
      </div>

      {/* The daemon's refusal, verbatim when it sent a sentence. Rendered, not
          thrown — and a non-retryable one gets no Retry, because a control that
          cannot work is worse than no control. */}
      {refused ? (
        <div style={{ ...doorRefusal, color: toneText(isNeedsApp(refused) ? 'warn' : 'err') }}>
          <span>{refused.message}</span>
          {refused.describes ? <span style={doorHint}>{refused.describes}</span> : null}
          {refused.retryable ? (
            <button style={doorBtn()} onClick={() => setPhase({ kind: 'idle' })}>Dismiss</button>
          ) : null}
        </div>
      ) : null}
      {phase.kind === 'started' ? (
        <div style={prose}>Started {phase.taskId}. Its steps appear above as they run.</div>
      ) : null}
    </div>
  )
}

const doorWrap: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 6, marginTop: 6 }
const doorCol: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 4 }
const doorRow: CSSProperties = { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }
const doorApp: CSSProperties = { fontFamily: MONO, fontSize: 11, color: 'var(--c-text)' }
const doorHint: CSSProperties = { fontSize: 10, color: 'var(--c-text-faint)' }
const doorInput: CSSProperties = {
  fontSize: 12, padding: '3px 6px', borderRadius: 5,
  border: '1px solid var(--c-line)', background: 'transparent',
  color: 'var(--c-text)', fontFamily: 'inherit', width: '100%', boxSizing: 'border-box'
}
const doorBtn = (disabled = false): CSSProperties => ({
  fontSize: 10, padding: '2px 8px', borderRadius: 5, border: '1px solid var(--c-line)',
  background: 'transparent',
  color: disabled ? 'var(--c-text-faint)' : 'var(--c-text-dim)',
  cursor: disabled ? 'not-allowed' : 'pointer',
  fontFamily: 'inherit'
})
const doorAppBtn = (disabled = false): CSSProperties => ({
  ...doorBtn(disabled), display: 'block', width: '100%', textAlign: 'left', marginBottom: 2
})
const doorPicker: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 2, marginTop: 2 }
const doorRefusal: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 3, fontSize: 11 }
const startBtn = (disabled: boolean): CSSProperties => ({
  fontSize: 11, padding: '3px 10px', borderRadius: 6,
  border: `1px solid ${disabled ? 'var(--c-line)' : 'var(--c-ok)'}`,
  background: 'transparent', color: disabled ? 'var(--c-text-faint)' : 'var(--c-ok-text)',
  cursor: disabled ? 'not-allowed' : 'pointer', fontFamily: 'inherit'
})
