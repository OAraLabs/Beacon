import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'
import type { SessionSummary } from '@shared/ipc'
import { asList, daemonErrorSentence } from '@shared/daemon-api'
import {
  bindBody,
  bindConfirmText,
  bindOutcomeText,
  boundWorkspacePath,
  boundaryEffect,
  currentBoundary,
  forkSuggestion,
  boundaryEffectLabel,
  checkpointsUnavailableReason,
  clearConfirmText,
  clearOutcomeText,
  emptyStateText,
  fmtCheckpointLabel,
  fmtCheckpointStats,
  fmtCheckpointTime,
  restoreBody,
  restorePlan,
  restorePlanSentence,
  sortCheckpoints,
  workspaceCandidates,
  type BoundaryEffect,
  type CheckpointDetailDTO,
  type CheckpointListDTO,
  type CheckpointRow,
  type CheckpointsUnavailable,
  type RestoreResultDTO,
  type SessionWorkspaceDTO,
  type WorkspaceWriteDTO
} from '@shared/checkpoints'
import { parseForkOrigin } from '@shared/session-fork'
import { NotAuthorized } from './NotAuthorized'
import { InlineConfirm } from './InlineDialogs'

// Checkpoints view (Prometheus PR 381, the Beacon half). One list per ACTIVE chat session: the file
// checkpoints the daemon took at the start of each turn for a session with a workspace. Select one to
// see what a restore would do NOW (a dry run — the daemon's own answer, not a client guess), then
// restore with a confirm that names the checkpoint. The list is the evidence that undo exists for a
// turn; a turn with no row here had no checkpoint, and the panel says so rather than implying one.

const MONO = 'var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)'
const panel: CSSProperties = { flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }
const head: CSSProperties = { padding: '10px 16px', borderBottom: '1px solid var(--c-line)', background: 'var(--c-raise)', flexShrink: 0, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }
const title: CSSProperties = { fontSize: 15, fontWeight: 600, color: 'var(--c-text)' }
const sub: CSSProperties = { fontSize: 12, color: 'var(--c-text-dim)', fontFamily: MONO, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '50%' }
const rowWrap = (active: boolean): CSSProperties => ({
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
  width: '100%',
  padding: '8px 16px',
  background: active ? 'var(--c-raise)' : 'transparent',
  border: 'none',
  borderLeft: `2px solid ${active ? 'var(--c-arc)' : 'transparent'}`,
  cursor: 'pointer',
  textAlign: 'left',
  font: 'inherit',
  color: 'var(--c-text)'
})
const btn = (disabled: boolean, danger = false): CSSProperties => ({
  fontSize: 12,
  padding: '5px 10px',
  borderRadius: 4,
  border: `1px solid ${danger ? 'var(--c-err)' : 'var(--c-line)'}`,
  background: 'transparent',
  color: disabled ? 'var(--c-text-faint)' : danger ? 'var(--c-err)' : 'var(--c-text)',
  cursor: disabled ? 'default' : 'pointer',
  opacity: disabled ? 0.6 : 1,
  font: 'inherit'
})
const note: CSSProperties = { padding: '12px 16px', fontSize: 13, color: 'var(--c-text-dim)', lineHeight: 1.45 }
const err: CSSProperties = { padding: '12px 16px', fontSize: 13, color: 'var(--c-err)', fontFamily: MONO, whiteSpace: 'pre-wrap' }
const detailBox: CSSProperties = { borderTop: '1px solid var(--c-line)', padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 8, flexShrink: 0, maxHeight: '45vh', overflowY: 'auto' }

function bridge() {
  const b = window.beacon
  if (!b) throw new Error('bridge unavailable')
  return b
}

async function fetchList(sessionId: string): Promise<CheckpointRow[]> {
  const d = (await bridge().daemon.get(`/api/sessions/${encodeURIComponent(sessionId)}/checkpoints`)) as CheckpointListDTO
  return sortCheckpoints(asList<CheckpointRow>(d?.checkpoints))
}

async function fetchWorkspace(sessionId: string): Promise<SessionWorkspaceDTO | null> {
  try {
    return (await bridge().daemon.get(`/api/sessions/${encodeURIComponent(sessionId)}/workspace`)) as SessionWorkspaceDTO
  } catch {
    return null // older daemon (pre item W) — unknown, and the empty state must not claim "no workspace"
  }
}

/**
 * The bind picker's own surface. It sits on --c-raise so its one accent pair (--c-err-text on
 * --c-err-soft over --c-raise/--node) is a pair lint:contrast already measures.
 */
const pickerBox: CSSProperties = {
  borderBottom: '1px solid var(--c-line)',
  background: 'var(--c-raise)',
  padding: '12px 16px',
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
  flexShrink: 0,
  maxHeight: '55vh',
  overflowY: 'auto'
}
const candidateRow = (picked: boolean): CSSProperties => ({
  display: 'flex',
  alignItems: 'baseline',
  gap: 8,
  width: '100%',
  padding: '6px 8px',
  borderRadius: 4,
  border: `1px solid ${picked ? 'var(--c-arc)' : 'transparent'}`,
  background: picked ? 'var(--c-arc-soft)' : 'transparent',
  cursor: 'pointer',
  textAlign: 'left',
  font: 'inherit',
  color: 'var(--c-text)'
})
/**
 * The effect badge. `widens` is the one choice on the list that GRANTS rather than restricts, so it
 * carries three independent signals, not one: the colour, the ▲ glyph, and the word. A reader who
 * is colour-blind, or skimming, or looking at a screenshot still gets it. A colour change must
 * never cost the other two.
 *
 * WHY SANG, AND WHAT THAT SAYS ABOUT THE PALETTE. This wore --c-amber first, and read wrong on
 * screen: --c-amber is an alias of --lapis, the SECONDARY/info blue, so the one row that grants
 * privilege wore the link colour and said "interactive" rather than "this one grants".
 *
 * There is no caution tier to move to. The codex has four signal hues — sang, lapis, online,
 * idle — and none of them is "warning": --c-warn is an alias of --idle, which the palette itself
 * documents as the NEUTRAL queued/stale tone (and has no -soft variant, so it cannot even carry a
 * tint), and --c-violet is a second alias of lapis. A name exists; a hue does not.
 *
 * So: sang, but the TEXT and SOFT variants rather than the full-strength fill. --c-err at full
 * weight is what the Restore button wears, and that one means "cannot be undone"; this one can be.
 * --c-err-text on --c-err-soft is a caution chip, distinguishable from both the neutral rows and
 * the destructive button. The pair is already measured across all nine plates by lint:contrast
 * ("active chip label on its own tint").
 */
const effectBadge = (e: BoundaryEffect): CSSProperties => ({
  fontSize: 11,
  fontFamily: MONO,
  padding: '1px 6px',
  borderRadius: 3,
  flexShrink: 0,
  border: `1px solid ${e === 'widens' ? 'var(--c-err)' : 'var(--c-line)'}`,
  background: e === 'widens' ? 'var(--c-err-soft)' : 'transparent',
  color: e === 'widens' ? 'var(--c-err-text)' : 'var(--c-text-faint)',
  fontWeight: e === 'widens' ? 600 : 400
})
const textInput: CSSProperties = {
  flex: 1,
  minWidth: 0,
  fontSize: 13,
  fontFamily: MONO,
  padding: '6px 10px',
  borderRadius: 6,
  border: '1px solid var(--c-line)',
  background: 'var(--c-void)',
  color: 'var(--c-text)',
  font: 'inherit'
}

async function fetchDetail(sessionId: string, cid: string): Promise<CheckpointDetailDTO> {
  return (await bridge().daemon.get(`/api/sessions/${encodeURIComponent(sessionId)}/checkpoints/${encodeURIComponent(cid)}`)) as CheckpointDetailDTO
}

async function postRestore(sessionId: string, cid: string, dryRun: boolean): Promise<RestoreResultDTO> {
  return (await bridge().daemon.write(
    `/api/sessions/${encodeURIComponent(sessionId)}/checkpoints/${encodeURIComponent(cid)}/restore`,
    restoreBody(cid, dryRun),
    'POST'
  )) as RestoreResultDTO
}

/** PUT the bind. The request key is `path`; the response carries `workspace`, RESOLVED. */
async function putWorkspace(sessionId: string, path: string): Promise<WorkspaceWriteDTO> {
  return (await bridge().daemon.write(
    `/api/sessions/${encodeURIComponent(sessionId)}/workspace`,
    bindBody(path),
    'PUT'
  )) as WorkspaceWriteDTO
}

/** DELETE clears. `{"path": ""}` is equivalent; DELETE is used because it says so at the verb. */
async function deleteWorkspace(sessionId: string): Promise<WorkspaceWriteDTO> {
  return (await bridge().daemon.write(
    `/api/sessions/${encodeURIComponent(sessionId)}/workspace`,
    undefined,
    'DELETE'
  )) as WorkspaceWriteDTO
}

/**
 * The parent's workspace, for a forked session — a SUGGESTION only.
 *
 * fork_session copies `lcm_messages` and writes `session_forks`; it never touches
 * `session_workspaces`, so a fork starts unbound and must stay that way until someone says
 * otherwise. This pre-fills the free-text box and selects NOTHING. Nothing here calls putWorkspace.
 */
async function fetchParentWorkspace(sessionId: string): Promise<{ path: string; from: string } | null> {
  try {
    const origin = parseForkOrigin(await bridge().daemon.get(`/api/sessions/${encodeURIComponent(sessionId)}/fork`))
    if (!origin?.originSession) return null
    const ws = (await bridge().daemon.get(
      `/api/sessions/${encodeURIComponent(origin.originSession)}/workspace`
    )) as SessionWorkspaceDTO
    const path = boundWorkspacePath(ws)
    return path ? { path, from: origin.originSession } : null
  } catch {
    return null // not a fork, an older daemon, or the parent is gone — no suggestion, no error
  }
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/**
 * What to show when a write is refused. The daemon's validator sentences are already user-facing
 * prose, so they are rendered VERBATIM; the raw `HTTP 400: PUT …` line is the fallback for a
 * body that was not JSON or was truncated at `safeText`'s 200 chars. Never invent copy for a
 * refusal the daemon already worded.
 */
function refusalText(e: unknown): string {
  return daemonErrorSentence(e) ?? errText(e)
}

export function CheckpointsPanel({ sessions, active }: { sessions: SessionSummary[]; active: string }) {
  const [rows, setRows] = useState<CheckpointRow[]>([])
  const [unavailable, setUnavailable] = useState<CheckpointsUnavailable | null>(null)
  const [listErr, setListErr] = useState<string | null>(null)
  const [workspace, setWorkspace] = useState<SessionWorkspaceDTO | null | undefined>(undefined)
  const [selected, setSelected] = useState<string | null>(null)
  const [detail, setDetail] = useState<CheckpointDetailDTO | null>(null)
  const [plan, setPlan] = useState<RestoreResultDTO | null>(null)
  const [planErr, setPlanErr] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [outcome, setOutcome] = useState<{ text: string; ok: boolean } | null>(null)
  const [nonce, setNonce] = useState(0)

  // ── the bind control ──────────────────────────────────────────────────────────────────────
  // 'picking' -> 'confirming'; there is no path from the Bind button straight to a PUT. Clearing
  // goes through 'clearing', which confirms too: clearing WIDENS the boundary back to the daemon
  // roots and stops checkpoints, so it is not the safe half of this control.
  const [wsMode, setWsMode] = useState<'idle' | 'picking' | 'confirming' | 'clearing'>('idle')
  /** A candidate path, or null. Starts null and is never seeded: nothing is pre-selected. */
  const [picked, setPicked] = useState<string | null>(null)
  const [useFree, setUseFree] = useState(false)
  const [freeText, setFreeText] = useState('')
  const [suggestion, setSuggestion] = useState<{ path: string; from: string } | null>(null)
  const [wsBusy, setWsBusy] = useState(false)
  const [wsErr, setWsErr] = useState<string | null>(null)
  const [wsOutcome, setWsOutcome] = useState<{ text: string; ok: boolean } | null>(null)

  const session = sessions.find((s) => s.id === active)
  // Read by the in-flight suggestion fetch. A useCallback closure captures the values from when the
  // picker opened; these say what is true when the fetch RESOLVES, which is the question being asked.
  const activeRef = useRef(active)
  const freeTextRef = useRef('')
  useEffect(() => { activeRef.current = active }, [active])

  useEffect(() => {
    let alive = true
    setRows([])
    setUnavailable(null)
    setListErr(null)
    setSelected(null)
    setDetail(null)
    setPlan(null)
    setPlanErr(null)
    setConfirming(false)
    // `workspace` MUST be cleared here. It was the one piece of state this effect did not reset,
    // so between sessions the strip kept showing the previous session's bound path — and offered
    // Clear… against it. The write would have gone to the right session with the wrong sentence on
    // screen, which is the worst version of this bug rather than a cosmetic one.
    setWorkspace(undefined)
    if (!active) return
    void fetchWorkspace(active).then((ws) => {
      if (alive) setWorkspace(ws)
    })
    void fetchList(active)
      .then((list) => {
        if (alive) setRows(list)
      })
      .catch((e) => {
        if (!alive) return
        const why = checkpointsUnavailableReason(e)
        setUnavailable(why)
        if (why === 'error') setListErr(errText(e))
      })
    return () => {
      alive = false
    }
  }, [active, nonce])

  /**
   * Per-SESSION state, reset only when the session actually changes.
   *
   * This is deliberately NOT folded into the [active, nonce] effect above. Committing a bind, a
   * clear, or a RESTORE bumps `nonce` to re-read the strip — so anything that effect resets is
   * wiped one tick after it is written. That is how the bind outcome came to be set and then never
   * seen (PR 168), and then how the restore outcome was destroyed by the very refresh the restore
   * triggers (issue 167). Caught by rendering the panel, not by any model test.
   *
   * `outcome` belongs here rather than above for exactly that reason: it still has to be cleared on
   * a real session switch (a new conversation must not inherit a line about another's restore), but
   * it must survive the `nonce` bump that the restore itself causes.
   */
  useEffect(() => {
    setWsMode('idle')
    setPicked(null)
    setUseFree(false)
    setFreeText('')
    setSuggestion(null)
    setWsErr(null)
    setWsOutcome(null)
    setOutcome(null)
  }, [active])

  const select = useCallback(
    (cid: string) => {
      setSelected(cid)
      setDetail(null)
      setPlan(null)
      setPlanErr(null)
      setOutcome(null)
      setConfirming(false)
      void fetchDetail(active, cid)
        .then(setDetail)
        .catch((e) => setPlanErr(errText(e)))
    },
    [active]
  )

  const preview = useCallback(() => {
    if (!selected) return
    setBusy(true)
    setPlanErr(null)
    setOutcome(null)
    void postRestore(active, selected, true)
      .then(setPlan)
      .catch((e) => setPlanErr(errText(e)))
      .finally(() => setBusy(false))
  }, [active, selected])

  const restore = useCallback(() => {
    if (!selected) return
    setConfirming(false)
    setBusy(true)
    setPlanErr(null)
    void postRestore(active, selected, false)
      .then((r) => {
        const p = restorePlan(r)
        setOutcome({ text: restorePlanSentence(p, false), ok: p.errors === 0 })
        setPlan(null)
        setNonce((n) => n + 1) // the workspace changed under every other checkpoint — re-read the list
      })
      .catch((e) => setOutcome({ text: `Restore refused: ${errText(e)}`, ok: false }))
      .finally(() => setBusy(false))
  }, [active, selected])

  /** Open the picker. The parent-workspace suggestion is fetched HERE, not on mount: two extra
   *  GETs per session switch to serve a control almost nobody opens is the wrong trade. */
  const openPicker = useCallback(() => {
    setWsMode('picking')
    setPicked(null)
    setUseFree(false)
    setFreeText('')
    setWsErr(null)
    setWsOutcome(null)
    setSuggestion(null)
    freeTextRef.current = ''
    const opened = active
    void fetchParentWorkspace(active).then((sug) => {
      // Two guards, both real: `opened !== active` means the user switched sessions while this was
      // in flight (the parent of a session they have left must not be suggested for the one they
      // are on), and a non-empty box means they started typing — their text wins over a hint.
      if (!sug || opened !== activeRef.current) return
      // Pre-FILL, never pre-SELECT — and the decision is @shared/checkpoints' forkSuggestion, not
      // this handler, so the gate can pin it. fork_session does not copy a workspace and this must
      // not become a path by which it effectively does.
      const decision = forkSuggestion(sug.path, freeTextRef.current)
      if (!decision) return
      setSuggestion(sug)
      freeTextRef.current = decision.fill
      setFreeText(decision.fill)
      // decision.select is `false` by type. Nothing here touches picked/useFree.
    })
  }, [active])

  const chosenPath = useFree ? freeText.trim() : (picked ?? '')

  const commitBind = useCallback(() => {
    const path = chosenPath
    if (!path) return
    setWsBusy(true)
    setWsErr(null)
    const target = active
    void putWorkspace(target, path)
      .then((r) => {
        // The write went to `target`; if the user has since moved on, the new session's panel must
        // not inherit an outcome line about a different conversation's boundary.
        if (activeRef.current !== target) return
        // Stated from the RESOLVED path the daemon returned, not from what was typed.
        setWsOutcome({ text: bindOutcomeText(r?.workspace, workspace?.daemon_workspace_roots), ok: true })
        setWsMode('idle')
        setNonce((n) => n + 1) // re-read the workspace strip AND the list
      })
      .catch((e) => setWsErr(refusalText(e)))
      .finally(() => setWsBusy(false))
  }, [active, chosenPath, workspace])

  const commitClear = useCallback(() => {
    setWsBusy(true)
    setWsErr(null)
    const target = active
    void deleteWorkspace(target)
      .then(() => {
        if (activeRef.current !== target) return
        setWsOutcome({ text: clearOutcomeText(workspace?.daemon_workspace_roots), ok: true })
        setWsMode('idle')
        setNonce((n) => n + 1)
      })
      .catch((e) => setWsErr(refusalText(e)))
      .finally(() => setWsBusy(false))
  }, [active, workspace])

  const header = (
    <div style={head}>
      <span style={title}>Checkpoints</span>
      <span style={sub} title={active}>
        {session?.title || active || 'no session selected'}
      </span>
      {rows.length > 0 ? <span style={{ fontSize: 12, color: 'var(--c-text-faint)' }}>{rows.length}</span> : null}
      <span style={{ flex: 1 }} />
      <button style={btn(!active)} disabled={!active} onClick={() => setNonce((n) => n + 1)}>
        Refresh
      </button>
    </div>
  )

  if (unavailable === 'auth')
    return (
      <div style={panel}>
        {header}
        <NotAuthorized what="checkpoints" />
      </div>
    )

  const wsPath = boundWorkspacePath(workspace)
  const dryPlan = plan ? restorePlan(plan) : null
  const roots = workspace?.daemon_workspace_roots
  const candidates = workspaceCandidates(workspace)
  // The baseline every label and sentence is measured against: for a BOUND session that is its
  // bound directory, not the daemon's roots. Re-binding /srv/app/web to /srv/app is a widening,
  // and measuring it against the roots would have shown it as a narrowing.
  const baseline = currentBoundary(wsPath, roots)
  // A daemon that answered the GET can be bound. `null` is an older daemon (the GET failed), and
  // `undefined` is still in flight — neither is a state in which to offer a write.
  // Not on a screen that says the daemon does not know this session: the workspace GET answers for
  // any id, so without this the panel offered to set a write boundary on a session it had just
  // told the user does not exist.
  const canBind = Boolean(active) && workspace !== undefined && workspace !== null && unavailable !== 'no-session'

  return (
    <div style={panel}>
      {header}
      <div style={{ padding: '8px 16px', fontSize: 12, color: 'var(--c-text-dim)', fontFamily: MONO, borderBottom: '1px solid var(--c-line)', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={wsPath ?? undefined}>
          {workspace === undefined ? 'workspace: …' : wsPath ? `workspace: ${wsPath}` : workspace === null ? 'workspace: unknown (daemon predates /workspace)' : 'workspace: none bound — checkpoints are not taken for this session'}
        </span>
        {canBind && wsMode === 'idle' ? (
          <>
            <button style={btn(wsBusy)} disabled={wsBusy} onClick={openPicker}>
              {wsPath ? 'Change…' : 'Bind…'}
            </button>
            {wsPath ? (
              <button style={btn(wsBusy)} disabled={wsBusy} onClick={() => { setWsErr(null); setWsOutcome(null); setWsMode('clearing') }}>
                Clear…
              </button>
            ) : null}
          </>
        ) : null}
      </div>
      {wsOutcome ? (
        <div style={{ padding: '8px 16px', fontSize: 13, color: wsOutcome.ok ? 'var(--c-text)' : 'var(--c-err)', borderBottom: '1px solid var(--c-line)', lineHeight: 1.45 }}>
          {wsOutcome.text}
        </div>
      ) : null}
      {/* The RESTORE outcome lives here at PANEL level, deliberately NOT inside the `selected` detail
          box below. Committing a restore bumps `nonce` to re-read the list, and that same effect
          clears `selected` — so the detail box UNMOUNTS one tick after the restore resolves. An
          outcome rendered inside it is destroyed by the refresh the restore itself triggers, which
          is issue 167: the result of the panel's one irreversible action was never readable, and a
          restore that reported errors looked identical to one that succeeded. The bind outcome
          beside it has the same placement for the same reason (PR 168). Clearing is interaction-
          driven, not refresh-driven: select() and preview() both null it. */}
      {outcome ? (
        <div
          role="status"
          style={{ padding: '8px 16px', fontSize: 13, color: outcome.ok ? 'var(--c-text)' : 'var(--c-err)', borderBottom: '1px solid var(--c-line)', lineHeight: 1.45 }}
        >
          {outcome.text}
        </div>
      ) : null}
      {wsMode === 'picking' ? (
        <div style={pickerBox}>
          <div style={{ fontSize: 13, color: 'var(--c-text)', fontWeight: 600 }}>Bind a workspace to this conversation</div>
          <div style={{ fontSize: 12, color: 'var(--c-text-dim)', lineHeight: 1.45 }}>
            Binding does not add a directory — it REPLACES this conversation’s write boundary with the one
            you pick.{' '}
            {wsPath
              ? `Right now that boundary is ${wsPath}.`
              : roots?.length
                ? `Right now it follows the daemon’s ${roots.length} configured root${roots.length === 1 ? '' : 's'}.`
                : 'The daemon did not report its configured roots.'}
          </div>
          {candidates.length === 0 ? (
            <div style={{ fontSize: 12, color: 'var(--c-text-faint)' }}>
              The daemon offered no candidates — type an absolute path below.
            </div>
          ) : (
            candidates.map((c) => (
              <button
                key={c.path}
                style={candidateRow(!useFree && picked === c.path)}
                onClick={() => { setPicked(c.path); setUseFree(false); setWsErr(null) }}
                title={c.path}
              >
                <span style={{ fontSize: 12, fontFamily: MONO, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.path}</span>
                <span style={{ fontSize: 11, color: 'var(--c-text-faint)', fontFamily: MONO, flexShrink: 0 }}>{c.kind === 'cwd' ? 'daemon cwd' : 'gate root'}</span>
                <span style={effectBadge(boundaryEffect(c.path, baseline))}>
                  {boundaryEffect(c.path, baseline) === 'widens' ? '▲ ' : ''}{boundaryEffectLabel(boundaryEffect(c.path, baseline))}
                </span>
              </button>
            ))
          )}
          {candidates.some((c) => boundaryEffect(c.path, baseline) === 'widens') ? (
            <div style={{ fontSize: 12, color: 'var(--c-err-text)', lineHeight: 1.45 }}>
              ▲ A <strong>widens</strong> candidate is not inside this conversation’s current boundary
              ({wsPath ? wsPath : roots?.length ? `${roots.length} configured root${roots.length === 1 ? '' : 's'}` : 'the daemon’s configuration'}).
              Binding to it GRANTS write access this conversation does not have today — the one choice
              here that adds privilege rather than removing it.
            </div>
          ) : null}
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--c-text-dim)' }}>
            <input
              type="radio"
              checked={useFree}
              onChange={() => { setUseFree(true); setPicked(null); setWsErr(null) }}
            />
            Other directory (absolute path)
          </label>
          <div style={{ display: 'flex', gap: 6 }}>
            <input
              value={freeText}
              placeholder="/absolute/path"
              // Focus alone no longer selects the field: focusing it (to read a long pre-filled
              // suggestion, or by tabbing through) used to discard an already-picked candidate
              // silently. Selecting the field is now an explicit act — the radio, or typing.
              onFocus={() => { if (!picked) setUseFree(true) }}
              // onChange selects the field too, not just onFocus: a value can change without a
              // focus event (paste from the context menu, an OS autofill), and text that silently
              // does not count is worse than a field that refuses it.
              onChange={(e) => { freeTextRef.current = e.target.value; setFreeText(e.target.value); setUseFree(true); setPicked(null); setWsErr(null) }}
              style={textInput}
            />
          </div>
          {suggestion ? (
            <div style={{ fontSize: 12, color: 'var(--c-text-dim)', lineHeight: 1.45 }}>
              {picked || freeText.trim() !== suggestion.path ? (
                <>Pre-filled from the session this one was forked from ({suggestion.from.slice(0, 12)}…). A fork does{' '}
                <strong>not</strong> inherit a workspace.</>
              ) : (
                <>Pre-filled from the session this one was forked from ({suggestion.from.slice(0, 12)}…). A fork does{' '}
                <strong>not</strong> inherit a workspace — this is a suggestion, and nothing is selected until you choose it.</>
              )}
            </div>
          ) : null}
          {useFree && freeText.trim() ? (
            <div style={{ fontSize: 12, color: 'var(--c-text-faint)', fontFamily: MONO }}>
              predicted effect: {boundaryEffectLabel(boundaryEffect(freeText.trim(), baseline))} — the daemon expands
              ~ and resolves symlinks, so this is confirmed only after the bind
            </div>
          ) : null}
          {wsErr ? <div style={{ ...err, padding: 0 }}>{wsErr}</div> : null}
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <button style={btn(!chosenPath || wsBusy)} disabled={!chosenPath || wsBusy} onClick={() => { setWsErr(null); setWsMode('confirming') }}>
              Continue…
            </button>
            <button style={btn(wsBusy)} disabled={wsBusy} onClick={() => setWsMode('idle')}>Cancel</button>
          </div>
        </div>
      ) : null}
      {wsMode === 'confirming' ? (
        <div style={pickerBox}>
          <div style={{ fontSize: 13, color: 'var(--c-text)', fontWeight: 600 }}>Bind this conversation to</div>
          <div style={{ fontSize: 13, fontFamily: MONO, color: 'var(--c-text)', wordBreak: 'break-all' }}>{chosenPath}</div>
          <div style={{ fontSize: 13, color: boundaryEffect(chosenPath, baseline) === 'widens' ? 'var(--c-err-text)' : 'var(--c-text-dim)', lineHeight: 1.5 }}>
            {bindConfirmText(chosenPath, roots, wsPath)}
          </div>
          {wsErr ? <div style={{ ...err, padding: 0 }}>{wsErr}</div> : null}
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <button style={btn(wsBusy, boundaryEffect(chosenPath, baseline) === 'widens')} disabled={wsBusy} onClick={commitBind}>
              {wsBusy ? 'Binding…' : 'Bind'}
            </button>
            <button style={btn(wsBusy)} disabled={wsBusy} onClick={() => setWsMode('picking')}>Back</button>
          </div>
        </div>
      ) : null}
      {wsMode === 'clearing' ? (
        <div style={pickerBox}>
          <div style={{ fontSize: 13, color: 'var(--c-text)', fontWeight: 600 }}>Clear this conversation’s workspace?</div>
          <div style={{ fontSize: 13, color: 'var(--c-err-text)', lineHeight: 1.5 }}>{clearConfirmText(roots, wsPath)}</div>
          {wsErr ? <div style={{ ...err, padding: 0 }}>{wsErr}</div> : null}
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <button style={btn(wsBusy, true)} disabled={wsBusy} onClick={commitClear}>
              {wsBusy ? 'Clearing…' : 'Clear'}
            </button>
            <button style={btn(wsBusy)} disabled={wsBusy} onClick={() => setWsMode('idle')}>Cancel</button>
          </div>
        </div>
      ) : null}
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {!active ? (
          <div style={note}>Select a chat session to see its checkpoints.</div>
        ) : unavailable === 'disabled' ? (
          <div style={note}>File checkpoints are not enabled on this daemon (`checkpoints.enabled: false`, or the store failed to open at boot — see the daemon log).</div>
        ) : unavailable === 'no-session' ? (
          <div style={note}>The daemon does not know this session.</div>
        ) : unavailable === 'error' ? (
          <div style={err}>Failed to list checkpoints.{'\n'}{listErr}</div>
        ) : rows.length === 0 ? (
          <div style={note}>{emptyStateText(Boolean(wsPath), canBind)}</div>
        ) : (
          rows.map((c) => (
            <button key={c.id} style={rowWrap(c.id === selected)} onClick={() => select(c.id)} title={c.id}>
              <span style={{ fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{fmtCheckpointLabel(c)}</span>
              <span style={{ fontSize: 12, color: 'var(--c-text-dim)', fontFamily: MONO }}>
                {fmtCheckpointTime(c)} · {fmtCheckpointStats(c)}
              </span>
            </button>
          ))
        )}
      </div>
      {selected && wsMode === 'idle' ? (
        <div style={detailBox}>
          <div style={{ fontSize: 12, color: 'var(--c-text-faint)', fontFamily: MONO }} title={selected}>
            {selected.slice(0, 12)}…{detail ? ` · ${fmtCheckpointStats(detail)}` : ''}
          </div>
          {detail?.diff ? (
            <div style={{ fontSize: 12, color: 'var(--c-text-dim)', fontFamily: MONO }}>
              now vs checkpoint: {asList<string>(detail.diff.changed).length} changed · {asList<string>(detail.diff.deleted).length} deleted · {asList<string>(detail.diff.added).length} added since · {asList<string>(detail.diff.unchanged).length} unchanged
            </div>
          ) : null}
          {(detail?.skipped ?? 0) > 0 ? (
            <div style={{ fontSize: 12, color: 'var(--c-warn, var(--c-text-dim))' }}>
              {detail?.skipped} file{detail?.skipped === 1 ? ' was' : 's were'} too large to capture — a restore leaves {detail?.skipped === 1 ? 'it' : 'them'} as {detail?.skipped === 1 ? 'it is' : 'they are'}.
            </div>
          ) : null}
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <button style={btn(busy)} disabled={busy} onClick={preview}>
              {busy ? 'Working…' : 'Preview restore'}
            </button>
            <button style={btn(busy || !dryPlan || dryPlan.noop, true)} disabled={busy || !dryPlan || dryPlan.noop} onClick={() => setConfirming(true)}>
              Restore…
            </button>
            {!dryPlan ? <span style={{ fontSize: 12, color: 'var(--c-text-faint)' }}>Preview first — the daemon computes what would change.</span> : null}
          </div>
          {planErr ? <div style={{ ...err, padding: 0 }}>{planErr}</div> : null}
          {dryPlan ? <div style={{ fontSize: 13, color: 'var(--c-text)' }}>{restorePlanSentence(dryPlan, true)}</div> : null}
          {plan && !dryPlan?.noop ? (
            <div style={{ fontSize: 12, fontFamily: MONO, color: 'var(--c-text-dim)', maxHeight: 140, overflowY: 'auto' }}>
              {asList<string>(plan.restored).map((p) => (
                <div key={`r:${p}`}>rewrite {p}</div>
              ))}
              {asList<string>(plan.deleted).map((p) => (
                <div key={`d:${p}`}>remove {p}</div>
              ))}
              {asList<{ path?: string; error?: string }>(plan.errors).map((e, i) => (
                <div key={`e:${i}`} style={{ color: 'var(--c-err)' }}>
                  error {e.path}: {e.error}
                </div>
              ))}
            </div>
          ) : null}
          {confirming && dryPlan ? (
            <InlineConfirm
              title={`Restore this checkpoint? ${restorePlanSentence(dryPlan, true)} Files created since the checkpoint are removed. This cannot be undone from here.`}
              confirmLabel="Restore"
              danger
              onConfirm={restore}
              onCancel={() => setConfirming(false)}
            />
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
