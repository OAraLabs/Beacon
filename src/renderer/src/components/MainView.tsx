import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ApprovalDecision, ApprovalRequest, SessionSummary } from '@shared/ipc'
import {
  VOICE_SESSION_ID,
  float32ToPcm16At16k,
  parseVoiceOutcome,
  pcm16ToBase64,
  type VoiceOutcome
} from '@shared/voice'
import { startVoiceCapture, type VoiceCapture } from '../voice-capture'
import { startHandsFreeCapture, type HandsFreeCapture } from '../hands-free-capture'
import { VoiceOverlay } from './VoiceOverlay'
import { ToastStack } from './ToastStack'
import { dismissToast, pushToast, replyToastMessage, type Toast } from '@shared/toasts'
import { chunkLevel } from '@shared/voice-overlay'
import { handsFreeLabel, handsFreeReduce, initialHandsFree, speechEndToPcm16Base64, type HandsFreeEvent, type HandsFreeState } from '@shared/hands-free'
import { initialPlayback, outcomeFromDone, partialSpeechNotice, playbackIdle, playbackReduce, playbackStart, type PlaybackState, type VoiceStreamEvent } from '@shared/voice-stream'
import { wavBase64ToBlobUrl } from '@shared/voice'
import { VOICE_CHECKING_NOTICE, ipcErrorMessage } from '@shared/voice-gate'
import { needsPinMigration, pinBody, pinFailureNotice } from '@shared/session-pins'
import {
  dictationLanded,
  parseDictationOutcome,
  DICTATION_MOVED_NOTICE,
  type DictationOutcome
} from '@shared/dictation'
import type { GatewayEvent } from '@shared/gateway-events'
import { applyApprovalFrame } from '@shared/approval-push'
import { BEACON_GATEWAY } from '@shared/session-sources'
import { SearchOverlay } from './SearchOverlay'
import type { SearchSummaryHit } from '@shared/search'
import { plainSnippet } from '@shared/search'
import { ArtifactsPanel } from './ArtifactsPanel'
import { WikiPanel } from './WikiPanel'
import { Sidebar } from './Sidebar'
import { ChatShell } from './ChatShell'
import { ExecApprovalCard } from './ExecApprovalCard'
import { cannotApproveLine } from '@shared/approval-refusal'
import { NavRail } from './NavRail'
import { StubPanel } from './StubPanel'
import { ToolCallFeed } from './ToolCallFeed'
import { ActivityFeed } from './ActivityFeed'
import { StatusPanel } from './StatusPanel'
import { SessionsPanel } from './SessionsPanel'
import { ConfigPanel } from './ConfigPanel'
import { FilesPanel } from './FilesPanel'
import { CheckpointsPanel } from './CheckpointsPanel'
import { DocumentsPanel } from './DocumentsPanel'
import { CodingPanel } from './CodingPanel'
import { LoopManagerPanel } from './LoopManagerPanel'
import { IntegrationsPanel } from './IntegrationsPanel'
import { BoardPanel } from './BoardPanel'
import { SkillsPanel } from './SkillsPanel'
import { GatewayStoreProvider } from '../gateway-store'
import { PreviewProvider, usePreview } from '../preview-store'
import { PreviewPane } from './PreviewPane'
import { ComposeRelay } from '../browser/ComposeRelay'
import { BrowserHostRelay } from '../browser/BrowserHostRelay'
import { PaneLinkRelay } from '../browser/PaneLinkRelay'
import type { ComposerInsert } from '@shared/browser-pane'
import type { FileEntry, FileListDTO } from '@shared/daemon-api'
import { SidePanel } from './SidePanel'
import {
  DEFAULT_PANEL_STATE,
  PANEL_OPEN_KEY,
  PANEL_PANE_KEY,
  PANEL_PANES,
  canDock,
  paneInfo,
  panelWidthKey,
  panesSharingWidth,
  paneForChord,
  widthGroupRepresentatives,
  parsePanelState,
  parsePanelWidth,
  showSessions,
  fitSessionListWidth,
  PANEL_DIVIDER_WIDTH,
  RAIL_WIDTH,
  SESSION_LIST_WIDTH,
  SESSION_LIST_WIDTH_SETTING_KEY,
  togglePane as togglePaneState,
  type PanelPane,
  type PanelState
} from '@shared/side-panel'
import { Icon } from './Icon'
import { PaneDropZones, type PaneDropZone } from './PaneDropZones'
import { PaneDivider } from './PaneDivider'
import { SubNav } from './SubNav'
import { CodingSurface } from './CodingSurface'
import { CommandPalette, type PaletteCommand } from './CommandPalette'
import { ShortcutSheet } from './ShortcutSheet'
import { MissionHome } from './MissionHome'
import { ChatHome, type HomeStart } from './ChatHome'
import type { PendingFile } from '../attachments-io'
import { DEFAULT_VIEW, NAV_VIEWS, usesPillRow, viewLabel, type ViewId } from '@shared/views'
import { ErrorBoundary } from './ErrorBoundary'
import { HOME, LAST_SESSION_KEY, beginFromHome, resolveLaunchTarget, type ChatTarget } from '@shared/chat-home'
import {
  closePane,
  evenWidths,
  focusPane,
  paneWeights,
  withWidths,
  focusedTarget,
  maxPanesFor,
  openBeside,
  panesMinWidth,
  parseLayout,
  removeSession,
  serializeLayout,
  showIn,
  single,
  visibleSessions,
  SESSION_DRAG_TYPE,
  SPLIT_LAYOUT_KEY,
  type PaneLayout
} from '@shared/split-panes'
import { resolveSessionMode, type ChatMode } from '@shared/composer-controls'
import { isDisclosureOpen, toggleDisclosure, type DisclosureState } from '@shared/approval-disclosure'
import { dropDraftMemory, forgetDraft } from '@shared/drafts'
import { trace } from '../ui-trace-client'
import { isOwnerOnlyView } from '@shared/device-role'
import { OwnerOnlyNote, useDeviceRole } from './OwnerOnlyNote'

/** True when a keydown originated in an editable element — global shortcuts must not fire there. */
function inEditable(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null
  return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)
}

/** The connected app: session sidebar + chat — or the Home/landing when no conversation is open.
 *  Mounted only once setup is complete. */
export function MainView() {
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  // Owner of this Prometheus, or an approved device that may only chat (@shared/device-role).
  const role = useDeviceRole()
  // SPLIT PANES (@shared/split-panes): a row of panes, one focused. `active` is the FOCUSED pane's
  // session (null = Home), so everything that already meant "the open conversation" (Send to chat,
  // voice, dictation, the dock, a search jump, Home's first message) follows focus unchanged.
  // The RAW setter. Called only by setActive (every choice: it marks chosenSinceMount), adjustLayout
  // (a session leaving because main opened its own window: not a choice) and launch-restore.
  // scripts/launch-restore-smoke.mjs holds that line.
  const [layout, setActiveState] = useState<PaneLayout>(() => single(HOME))
  const active: ChatTarget = focusedTarget(layout)
  const layoutRef = useRef(layout)
  layoutRef.current = layout
  /** How many panes fit now (computed with the widths, below); read by callbacks. */
  const maxPanesRef = useRef(1)
  /**
   * Has anything chosen what the chat surface shows since mount? Launch-restore FILLS an empty
   * choice; it never overrides one. The list paints before the restore's read of the last session
   * returns, so a row clicked (or New chat pressed) in that gap used to be replaced by the restored
   * session a moment later. Set by the ONE setter everything but the restore goes through — a click,
   * Home, a fork, a Home submit, a notification/deep-link switch, a forget's fallback — so a new
   * caller is covered without having to know this exists. Only the restore uses setActiveState.
   */
  const chosenSinceMount = useRef(false)
  /** "Show this" (a session already in a pane gets focus; anything else replaces the focused pane),
   *  or any other change to the panes (split, close, focus, drop). Every choice comes through here. */
  const setActive = useCallback((target: ChatTarget | ((l: PaneLayout) => PaneLayout)) => {
    chosenSinceMount.current = true
    setActiveState((l) => (typeof target === 'function' ? target(l) : showIn(l, target)))
  }, [])
  /** Not a choice: a session left the screen because main opened it in its own window (including a
   *  window restored at launch). Must not mark the choice, or it would cancel launch-restore. */
  const adjustLayout = useCallback((fn: (l: PaneLayout) => PaneLayout) => setActiveState(fn), [])
  // Per-session Agent|Chat mode memory (Composer-controls, Level 2): in-memory only, so a fresh
  // app launch resets every session to Agent (no cross-launch persistence, by decision).
  const [modeBySession, setModeBySession] = useState<Record<string, ChatMode>>({})
  /** The home screen's first turn, waiting for ChatShell to mount: the text, plus anything the
   *  home composer chose that only a real session can carry (a model, staged attachments). */
  const [pendingInitial, setPendingInitial] = useState<
    { id: string; text: string; files?: PendingFile[]; modelKey?: string | null } | null
  >(null)
  const [unread, setUnread] = useState<Record<string, boolean>>({})
  const [titles, setTitles] = useState<Record<string, string>>({})
  const [pinned, setPinned] = useState<Record<string, boolean>>({})
  const [approvals, setApprovals] = useState<ApprovalRequest[]>([])
  /** Corner notices for things that happened OFF the surface you are looking at. See
   *  @shared/toasts for the rule about what does and does not earn one. */
  const [toasts, setToasts] = useState<Toast[]>([])
  const raiseToast = useCallback((t: Omit<Toast, 'id' | 'at'>) => {
    setToasts((prev) => pushToast(prev, { ...t, id: crypto.randomUUID(), at: Date.now() }))
  }, [])
  /** Sessions already announced, so one arrival raises one toast rather than one per poll. */
  const announced = useRef<Set<string>>(new Set())
  /** The poll runs outside render (like activeRef), so the toast's title comes from a ref. */
  const titlesRef = useRef<Record<string, string>>({})
  /** requestId → the daemon's rejection text for the last resolve attempt (''/absent = none). */
  const [approvalErrors, setApprovalErrors] = useState<Record<string, string>>({})
  /** requestId → the line a worker's request shows once this Beacon has been told it may not approve it (401 not_a_person). */
  const [cannotApprove, setCannotApprove] = useState<Record<string, string>>({})
  /** The approvals as last rendered, for resolveApproval (a stable callback) to read the request it is answering. */
  const approvalsRef = useRef<ApprovalRequest[]>([])
  approvalsRef.current = approvals
  /** The approval ids STILL in the daemon's queue, as a set. The progress pane's desktop log joins
   *  a step's `approvalRequestId` against this to decide whether to render an approve/deny control
   *  inline — a step whose request has been answered keeps its row but has nothing left to act on.
   *  Derived here, where the push and poll paths both land, rather than re-derived in the pane:
   *  one source of "is this still actionable", so the two cannot disagree. */
  const pendingApprovalIds = useMemo(
    () => new Set(approvals.map((a) => a.requestId)),
    [approvals]
  )

  // ── Voice turns (feat/voice-turns) ─────────────────────────────────────────
  // The mic lives in the composer, but the turn targets VOICE_SESSION_ID —
  // a session that may not be the one being looked at. Starting a turn
  // switches there so the transcript+reply land somewhere visible. State is
  // owned HERE (not ChatShell) because a session switch remounts ChatShell
  // (key={active}) and would otherwise drop a turn mid-flight.
  /** Kept for the dictation guard and the Voice segment's interlock; nothing sets it to
   *  'recording' now that push-to-talk's button is gone. */
  const voiceState = 'idle' as const
  /** Every bridge outcome maps to ONE visible notice — a silent path is the
   * defect class (spec; the silence-is-ambiguous family). '' = nothing to show. */
  const [voiceNotice, setVoiceNotice] = useState('')
  const voiceAudioRef = useRef<HTMLAudioElement | null>(null)
  // Streaming playback (oara-voice #12): segments arrive over IPC while the model is still writing;
  // a pure reducer decides what plays next, and ONE <audio> element plays the queue in order.
  const playbackRef = useRef<PlaybackState>(initialPlayback)
  /** Hands-free listens for the queue draining after `done` (→ back to listening). */
  const onPlaybackIdleRef = useRef<(() => void) | null>(null)
  /** Set by a barge-in: segments still arriving for the interrupted turn are dropped. */
  const discardSegmentsRef = useRef(false)
  const dispatchPlayback = useCallback((action: Parameters<typeof playbackReduce>[1]) => {
    const before = playbackRef.current
    const after = playbackReduce(before, action)
    playbackRef.current = after
    if (action.kind !== 'reset' && playbackIdle(after) && !playbackIdle(before)) onPlaybackIdleRef.current?.()
    const url = playbackStart(before, after)
    if (url) {
      if (voiceAudioRef.current) voiceAudioRef.current.pause()
      const el = new Audio(url)
      el.onended = () => dispatchPlayback({ kind: 'ended' })
      el.onerror = () => dispatchPlayback({ kind: 'ended' }) // an unplayable segment must not stall the queue
      voiceAudioRef.current = el
      void el.play().catch(() => dispatchPlayback({ kind: 'ended' }))
    }
  }, [])

  /** One spoken turn over the stream route, phrases playing as they arrive (shared by PTT and
   *  hands-free). Resolves when the bridge's `done` (or the fallback's joined WAV) has been handled;
   *  returns whether any audio was queued — hands-free uses that to decide 'speaking' vs 'listening'. */
  const speakTurn = useCallback(
    async (b64: string): Promise<{ spoke: boolean }> => {
      const b = window.beacon
      if (!b) return { spoke: false }
      // Streaming: play each phrase as the bridge synthesizes it. The subscription lives for
      // this turn only; `done` (or the fallback's joined WAV) ends it.
      dispatchPlayback({ kind: 'reset' })
      discardSegmentsRef.current = false
      let fellBack = false
      let spoke = false
      let doneEv: Extract<VoiceStreamEvent, { type: 'done' }> | null = null
      const unsub = b.voice.onStreamEvent((ev) => {
        if (ev.type === 'segment') {
          if (discardSegmentsRef.current) return // barge-in: the interrupted reply's tail is dropped
          spoke = true
          dispatchPlayback({ kind: 'segment', seq: ev.seq, url: wavBase64ToBlobUrl(ev.audio_base64) })
        } else if (ev.type === 'done') {
          doneEv = ev
          dispatchPlayback({ kind: 'done' })
        } else if (ev.type === 'fallback') fellBack = true
      })
      let res: Awaited<ReturnType<typeof b.voice.turnStream>>
      try {
        res = await b.voice.turnStream(b64)
      } finally {
        unsub()
      }
      if (fellBack || !doneEv) {
        // Older middleware (no stream route): the joined WAV came back in the response, as before.
        const outcome: VoiceOutcome = parseVoiceOutcome(res)
        setVoiceNotice(outcome.kind === 'spoken' ? '' : outcome.notice)
        // The overlay's transcript is the bridge's own, never a local guess: STT runs there,
        // after the utterance ends, so there is nothing to show until the turn comes back.
        setVoiceTranscript(outcome.kind === 'spoken' ? outcome.transcript : '')
        if (outcome.kind === 'spoken' && outcome.audioUrl && !discardSegmentsRef.current) {
          dispatchPlayback({ kind: 'segment', seq: 0, url: outcome.audioUrl })
          dispatchPlayback({ kind: 'done' })
          spoke = true
        }
      } else {
        const d = doneEv as Extract<VoiceStreamEvent, { type: 'done' }>
        const outcome: VoiceOutcome = outcomeFromDone(d)
        setVoiceTranscript(outcome.kind === 'spoken' ? outcome.transcript : '')
        // A partly spoken reply is SAID (the bridge's own words), never just an early stop.
        setVoiceNotice(outcome.kind === 'spoken' ? partialSpeechNotice(d) : outcome.notice)
      }
      return { spoke }
    },
    [dispatchPlayback]
  )

  // ── Hands-free mode (item 8): VAD-driven turns, barge-in, idle auto-off ─────────────────
  // The pure reducer (@shared/hands-free) owns the rules and returns EFFECTS; this shell performs
  // them: open/close the VAD via main, send the utterance as a streaming turn, stop playback.
  const handsFreeRef = useRef<HandsFreeState>(initialHandsFree())
  const [handsFreePhase, setHandsFreePhase] = useState<HandsFreeState['phase']>('off')
  const handsFreeCaptureRef = useRef<HandsFreeCapture | null>(null)
  const handsFreeUnsubRef = useRef<(() => void) | null>(null)
  /** Overlay state. The MACHINE was already here; none of this changes how a turn runs — it is
   *  what the overlay draws, which is the half that was missing. */
  const [handsFreeStartedAt, setHandsFreeStartedAt] = useState(0)
  const [micLevel, setMicLevel] = useState(0)
  const [voiceTranscript, setVoiceTranscript] = useState('')
  /** `Hold to talk`: while held, a pause does NOT end the turn — the utterance is stashed and
   *  goes on release. This is the control for the case the VAD gets wrong: thinking mid-sentence. */
  const [holding, setHolding] = useState(false)
  const holdingRef = useRef(false)
  const heldUtteranceRef = useRef<string | null>(null)
  const [heldReady, setHeldReady] = useState(false)
  const pendingUtteranceRef = useRef<string | null>(null)

  const stopHandsFreeIo = useCallback(() => {
    setMicLevel(0) // the mic is gone; leaving the last level would freeze the bars mid-word
    handsFreeCaptureRef.current?.stop()
    handsFreeCaptureRef.current = null
    handsFreeUnsubRef.current?.()
    handsFreeUnsubRef.current = null
    void window.beacon?.vad.stop().catch(() => undefined)
  }, [])

  const dispatchHandsFree = useCallback(
    (ev: HandsFreeEvent) => {
      const { state, effects } = handsFreeReduce(handsFreeRef.current, ev)
      handsFreeRef.current = state
      setHandsFreePhase(state.phase)
      const label = handsFreeLabel(state)
      if (label || state.phase !== 'off') setVoiceNotice(label)
      for (const fx of effects) {
        if (fx.kind === 'stop_playback') {
          discardSegmentsRef.current = true
          voiceAudioRef.current?.pause()
          dispatchPlayback({ kind: 'reset' })
          void window.beacon?.vad.reset().catch(() => undefined)
        } else if (fx.kind === 'skip_playback') {
          discardSegmentsRef.current = true
          voiceAudioRef.current?.pause()
          dispatchPlayback({ kind: 'reset' })
        } else if (fx.kind === 'close_vad' || fx.kind === 'auto_off') {
          if (fx.kind === 'close_vad') stopHandsFreeIo()
        } else if (fx.kind === 'send_turn') {
          const b64 = pendingUtteranceRef.current
          pendingUtteranceRef.current = null
          if (!b64) {
            dispatchHandsFree({ kind: 'turn_done', now: Date.now(), spoke: false })
            continue
          }
          if (active !== VOICE_SESSION_ID) void select(VOICE_SESSION_ID)
          void speakTurn(b64)
            .then(({ spoke }) => dispatchHandsFree({ kind: 'turn_done', now: Date.now(), spoke }))
            .catch((err) => dispatchHandsFree({ kind: 'error', now: Date.now(), message: ipcErrorMessage(err, 'voice turn failed') }))
        }
        // 'open_vad' is performed by onHandsFreeToggle (it needs the mic first).
      }
    },
    [active, dispatchPlayback, speakTurn, stopHandsFreeIo] // eslint-disable-line react-hooks/exhaustive-deps
  )

  useEffect(() => {
    onPlaybackIdleRef.current = () => {
      if (handsFreeRef.current.phase === 'speaking') dispatchHandsFree({ kind: 'playback_done', now: Date.now() })
    }
  }, [dispatchHandsFree])

  // The idle clock: only the reducer decides; this just ticks while the mode is on.
  useEffect(() => {
    if (handsFreePhase === 'off') return
    const t = setInterval(() => dispatchHandsFree({ kind: 'tick', now: Date.now() }), 5000)
    return () => clearInterval(t)
  }, [handsFreePhase, dispatchHandsFree])

  /** Send what `Hold to talk` has been holding. The same path a VAD-detected pause takes — the
   *  hold only changes WHEN the turn starts, never how it runs. */
  const flushHeldUtterance = useCallback(() => {
    const held = heldUtteranceRef.current
    heldUtteranceRef.current = null
    setHeldReady(false)
    if (!held) return
    pendingUtteranceRef.current = held
    dispatchHandsFree({ kind: 'speech_end', now: Date.now(), durationMs: 0 })
  }, [dispatchHandsFree])

  /** A pre-microphone check is in flight (Voice or dictation). One at a time: a second click while
   *  OAra Voice has not answered yet must not start a second check, or a second mic. */
  const voiceCheckingRef = useRef(false)

  const onHandsFreeToggle = useCallback(async () => {
    const b = window.beacon
    if (!b) return
    if (handsFreeRef.current.phase !== 'off') {
      dispatchHandsFree({ kind: 'stop' })
      return
    }
    if (voiceCheckingRef.current) return
    voiceCheckingRef.current = true
    /** The listener closed after it opened but before the mic did. The reducer ignores a close while
     *  the mode is off, so it is kept here and refuses the start below. */
    let closedEarly: string | null = null
    try {
      // THE INTEGRATION FIRST, THE MICROPHONE LAST (@shared/voice-gate). The bridge has to answer
      // and the VAD socket has to be OPEN before the mic is asked for, so a broken setup is named
      // without the OS microphone prompt ever appearing. Each refusal names itself.
      setVoiceNotice(VOICE_CHECKING_NOTICE)
      await b.voice.preflight()
      handsFreeUnsubRef.current = b.vad.onEvent((ev) => {
        if (ev.type === 'closed') {
          if (handsFreeRef.current.phase === 'off') closedEarly = ev.reason
          else dispatchHandsFree({ kind: 'vad_closed', now: Date.now(), reason: ev.reason })
        } else if (ev.type === 'event') {
          if (ev.event.type === 'speech_start') dispatchHandsFree({ kind: 'speech_start', now: Date.now() })
          else if (ev.event.type === 'speech_end') {
            const utterance = speechEndToPcm16Base64(ev.event.audioBase64)
            if (holdingRef.current) {
              // Held: keep it, say nothing to the reducer. The turn starts when the button lifts.
              heldUtteranceRef.current = utterance
              setHeldReady(true)
              return
            }
            pendingUtteranceRef.current = utterance
            dispatchHandsFree({ kind: 'speech_end', now: Date.now(), durationMs: ev.event.durationMs })
          }
        }
      })
      await b.vad.start() // resolves only once the socket is open
      setVoiceNotice('')
      // Only now the mic (a denied mic is named). The overlay's bars are drawn from the SAME chunks
      // the VAD is fed, so what you see moving is the audio that is actually being listened to —
      // not a decorative animation beside it.
      handsFreeCaptureRef.current = await startHandsFreeCapture((chunk) => {
        b.vad.audio(chunk)
        setMicLevel(chunkLevel(chunk))
      })
      if (closedEarly) throw new Error(`OAra Voice closed the connection while the microphone was opening — ${closedEarly}`)
      setHandsFreeStartedAt(Date.now())
      setVoiceTranscript('')
      dispatchHandsFree({ kind: 'start', now: Date.now() })
    } catch (err) {
      stopHandsFreeIo()
      dispatchHandsFree({ kind: 'error', now: Date.now(), message: ipcErrorMessage(err, 'Microphone unavailable — check permissions') })
    } finally {
      voiceCheckingRef.current = false
    }
  }, [dispatchHandsFree, stopHandsFreeIo])

  // A voice notice belongs to where it was raised. Changing session (or going Home) clears it, so an
  // old error never shows up in a new conversation. Not while hands-free is on: its line is the
  // mode's live state, re-set on every transition, and a voice turn itself switches session. The
  // reducer's copy is cleared too, or the next transition would put the old error back.
  useEffect(() => {
    if (handsFreeRef.current.phase !== 'off') return
    handsFreeRef.current = { ...handsFreeRef.current, notice: '' }
    setVoiceNotice('')
  }, [active])

  // PUSH-TO-TALK IS GONE, with its button (R4: the icon row is input methods, and it held two
  // audio glyphs). The capability is not lost — Voice mode's overlay has `Hold to talk`, which
  // records one utterance and sends it down the SAME /bridge/voice route via speakTurn. The one
  // difference is that it needs the VAD socket open, so if the VAD service is down there is no
  // longer a bridge-only fallback. Say so rather than discover it later.

  // ── Dictation (B6) ─────────────────────────────────────────────────────────
  // NOT a voice turn: this transcribes into the draft of the conversation you
  // are ALREADY looking at, switches nothing, and sends nothing. State lives
  // here for the same reason the turn's does — a session switch remounts
  // ChatShell (key={active}) and would drop a dictation mid-flight.
  const [dictateState, setDictateState] = useState<'idle' | 'recording' | 'processing'>('idle')
  const dictateCaptureRef = useRef<VoiceCapture | null>(null)
  /** The session the dictation was STARTED in. A transcript belongs to that
   * draft, not to whatever is on screen when it comes back. */
  const dictateForRef = useRef<ChatTarget>(null)
  /** Handed to ChatShell to append. The counter makes each delivery distinct,
   * so dictating the same words twice inserts twice — a boolean would not. */
  const [dictated, setDictated] = useState<{ text: string; n: number } | null>(null)
  const dictateSeqRef = useRef(0)

  const onDictateToggle = useCallback(async () => {
    const b = window.beacon
    if (!b) return
    if (dictateState === 'recording') {
      const cap = dictateCaptureRef.current
      dictateCaptureRef.current = null
      if (!cap) return
      setDictateState('processing')
      try {
        const { samples, contextRate } = await cap.stop()
        const b64 = pcm16ToBase64(float32ToPcm16At16k(samples, contextRate))
        const res = await b.voice.dictate(b64)
        const outcome: DictationOutcome = parseDictationOutcome(res)
        if (outcome.kind !== 'text') {
          setVoiceNotice(outcome.notice)
        } else if (!dictationLanded(dictateForRef.current, active)) {
          // Refusing to insert is the correct behaviour, but it MUST be said —
          // a silently dropped transcript is indistinguishable from a mic that
          // never worked.
          setVoiceNotice(DICTATION_MOVED_NOTICE)
        } else {
          dictateSeqRef.current += 1
          setDictated({ text: outcome.text, n: dictateSeqRef.current })
          setVoiceNotice('')
        }
      } catch (err) {
        setVoiceNotice(ipcErrorMessage(err, 'dictation failed'))
      } finally {
        setDictateState('idle')
      }
      return
    }
    if (dictateState === 'idle') {
      if (voiceCheckingRef.current) return
      voiceCheckingRef.current = true
      try {
        // The integration first, the microphone last — the same rule as Voice (@shared/voice-gate).
        setVoiceNotice(VOICE_CHECKING_NOTICE)
        try {
          await b.voice.preflight()
        } catch (err) {
          setVoiceNotice(ipcErrorMessage(err, 'dictation unavailable'))
          return
        }
        setVoiceNotice('')
        try {
          dictateForRef.current = active
          dictateCaptureRef.current = await startVoiceCapture()
          setDictateState('recording')
        } catch {
          setVoiceNotice('Microphone unavailable — check permissions')
          setDictateState('idle')
        }
      } finally {
        voiceCheckingRef.current = false
      }
      return
    }
  }, [dictateState, active]) // eslint-disable-line react-hooks/exhaustive-deps
  /**
   * WHICH request has its grant options revealed — never a boolean, and NEVER
   * persisted. A new request has a different id, so it is closed by
   * construction; opening is the operator's consent act, and it does not carry
   * over. See shared/approval-disclosure.ts for why this must not become a
   * remembered preference (the persisted-collapse mechanism next door makes
   * that an easy and wrong change).
   */
  const [disclosedFor, setDisclosedFor] = useState<DisclosureState>(null)
  /**
   * Epoch ms of the last inbound frame from ANY session — the app-level "is the
   * gateway talking at all" fact. Read by ChatShell's quiet-timer to decide which
   * claim it is entitled to make. A ref, not state: it changes on every frame and
   * nothing renders from it directly.
   */
  const daemonLastSeen = useRef(0)
  const [view, setView] = useState<ViewId>(DEFAULT_VIEW)
  // A view that reads only the owner's routes: the note on an approved device, nothing while main has not said which yet.
  const ownerGate: 'note' | 'wait' | null = isOwnerOnlyView(view) ? (role === 'limited' ? 'note' : role === undefined ? 'wait' : null) : null
  const viewRef = useRef(view)
  useEffect(() => {
    viewRef.current = view
  }, [view])
  /**
   * Is the oara integration configured? The voice controls exist only when it is (@shared/voice-gate):
   * OAra Voice is not public, so a fresh install has no Voice segment and no dictation button.
   * Starts false, so a fresh install never shows a control that then vanishes. Re-read on window
   * focus and on every view change, so an entry added to integrations.json or toggled in
   * Integrations takes effect without a restart. A failed read counts as not configured.
   */
  const [voiceConfigured, setVoiceConfigured] = useState(false)
  useEffect(() => {
    const b = window.beacon
    if (!b) return
    let live = true
    const read = (): void => {
      void b.voice.configured().then(
        (yes) => live && setVoiceConfigured(yes === true),
        () => live && setVoiceConfigured(false)
      )
    }
    read()
    window.addEventListener('focus', read)
    return () => {
      live = false
      window.removeEventListener('focus', read)
    }
  }, [view])
  const [paletteOpen, setPaletteOpen] = useState(false)
  /** ⌘⇧F overlay. The string is the seed query handed over from the palette's pinned row. */
  const [searchQuery, setSearchQuery] = useState<string | null>(null)
  // Mirrors for the global key handler (it subscribes once): is an overlay up to take Esc first?
  const paletteOpenRef = useRef(false)
  const searchOpenRef = useRef(false)
  const sheetOpenRef = useRef(false)
  paletteOpenRef.current = paletteOpen
  searchOpenRef.current = searchQuery !== null
  /**
   * The message a search hit asked for. Held HERE, not in ChatShell, because selecting the hit's
   * session remounts ChatShell — a target owned by the component being replaced would be lost in
   * the swap. The nonce makes a repeat jump to the same row fire again instead of no-op'ing.
   */
  const [jump, setJump] = useState<{ sessionId: string; messageId: string; nonce: number } | null>(null)
  const [sheetOpen, setSheetOpen] = useState(false)
  sheetOpenRef.current = sheetOpen
  // The side panel (@shared/side-panel): the chat view's right-hand companion, hosting the
  // browser (a HUMAN viewer — @shared/browser-pane) or the terminal (a HUMAN surface —
  // @shared/terminal), one at a time. Collapsed by default; open/pane/width persist like the
  // rail groups. Opening it always lands on the chat view, because that is where it lives.
  const [panel, setPanel] = useState<PanelState>(DEFAULT_PANEL_STATE)
  const panelRef = useRef(panel)
  // Desired width per pane (R3: 300 for the inspector, 392 for browser/terminal until dragged).
  // Browser and terminal share one persisted width; the inspector keeps its own.
  const [panelWidths, setPanelWidths] = useState<Partial<Record<PanelPane, number>>>({})
  // Whether the session list can stay up beside an open dock is a question about ROOM, so the
  // width has to be a rendered value, not a one-off read — a window resize changes the answer.
  const [viewportWidth, setViewportWidth] = useState(() => (typeof window === 'undefined' ? 0 : window.innerWidth))
  useEffect(() => {
    const onResize = (): void => setViewportWidth(window.innerWidth)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  useEffect(() => {
    const b = window.beacon
    if (!b) return
    let alive = true
    // One read per width GROUP, derived from the registry: a new pane is hydrated without anyone
    // remembering to add a key here, which is the other half of the branch below.
    const reps = widthGroupRepresentatives()
    void Promise.all([
      b.settings.get(PANEL_OPEN_KEY),
      b.settings.get(PANEL_PANE_KEY),
      ...reps.map((r) => b.settings.get(panelWidthKey(r)))
    ])
      .then(([open, pane, ...widths]) => {
        if (!alive) return
        const s = parsePanelState(open, pane)
        panelRef.current = s
        setPanel(s)
        const next: Partial<Record<PanelPane, number>> = {}
        reps.forEach((rep, i) => {
          const w = parsePanelWidth(widths[i])
          if (w === null) return
          for (const id of panesSharingWidth(rep)) next[id] = w
        })
        setPanelWidths(next)
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [])
  const applyPanel = useCallback((next: PanelState) => {
    panelRef.current = next
    setPanel(next)
    const b = window.beacon
    if (b) {
      void b.settings.set(PANEL_OPEN_KEY, next.open ? '1' : '0').catch(() => undefined)
      void b.settings.set(PANEL_PANE_KEY, next.pane).catch(() => undefined)
    }
    // Opening the dock lands you on a surface it can sit beside. If you are already on one
    // (the thread, or a coding run) you stay put — being yanked to chat to get a shell is the
    // very adjacency defect R3 exists to kill.
    if (next.open && !canDock(viewRef.current)) setView('chat')
  }, [])
  /** The dock is SHOWING only on a surface it can sit beside (the thread, or a coding run):
   *  `open` persists across views and launch lands on Mission, so the dock group's pressed state
   *  and the palette's verbs derive from this, not from `open` alone. */
  const panelShowing = canDock(view) && panel.open
  // The session list's width is the user's (a divider on its right edge). DESIRED width persists;
  // what renders is that width fitted to the window and to the dock when one is showing, so the
  // conversation never drops under its minimum because the list was dragged wide.
  const [listWidth, setListWidth] = useState<number>(SESSION_LIST_WIDTH)
  useEffect(() => {
    let alive = true
    void window.beacon?.settings
      .get(SESSION_LIST_WIDTH_SETTING_KEY)
      .then((raw) => {
        const w = parsePanelWidth(raw)
        if (alive && w !== null) setListWidth(w)
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [])
  const onListWidth = useCallback((w: number) => {
    setListWidth(w)
    void window.beacon?.settings.set(SESSION_LIST_WIDTH_SETTING_KEY, String(Math.round(w))).catch(() => undefined)
  }, [])
  const dockFootprint = panelShowing ? (panelWidths[panel.pane] ?? paneInfo(panel.pane).defaultWidth) + PANEL_DIVIDER_WIDTH : 0
  // Split panes: the conversation area keeps EVERY pane's minimum, so the list and the dock fit around
  // all of them, not around one.
  const conversationMin = panesMinWidth(layout.panes.length)
  const listShown = fitSessionListWidth(listWidth, viewportWidth, dockFootprint, conversationMin)
  /** R3, derived not stored: the session list yields to the wide panes (browser, terminal) — but
   *  only when keeping it would actually squeeze the conversation. See showSessions. */
  const sessionsShowing = showSessions(view, panel, {
    viewport: viewportWidth,
    dock: panelWidths[panel.pane] ?? paneInfo(panel.pane).defaultWidth,
    list: listShown,
    conversationMin
  })
  /** How many panes fit beside the list and the dock right now. A split past this is refused, and the
   *  caller offers the session its own window instead. */
  const paneRoom = viewportWidth - RAIL_WIDTH - (sessionsShowing ? listShown : 0) - dockFootprint
  const maxPanes = maxPanesFor(paneRoom)
  maxPanesRef.current = maxPanes
  const canOpenBeside = layout.panes.length < maxPanes && active !== null
  /** The dock group / composer / palette / ⌘1 ⌘2 ⌘3. On the chat view: the showing pane closes
   *  the dock, anything else opens on it. From ANY OTHER view the toggle only ever opens — it
   *  brings the chat view up with that pane; a persisted-open dock the user cannot see must never
   *  "close" on the press that was meant to reveal it. */
  const togglePane = useCallback(
    (pane: PanelPane) => applyPanel(canDock(viewRef.current) ? togglePaneState(panelRef.current, pane) : { open: true, pane }),
    [applyPanel]
  )
  /** Show a pane (pop-in, reattach): never closes. */
  const showPane = useCallback((pane: PanelPane) => applyPanel({ open: true, pane }), [applyPanel])
  const closePanel = useCallback(() => applyPanel({ ...panelRef.current, open: false }), [applyPanel])
  const onPanelWidth = useCallback((w: number) => {
    const pane = panelRef.current.pane
    // Which panes move is DECLARED on the registry, not guessed from the id here. The previous
    // `pane === 'inspector' ? … : …` swept every non-inspector pane into the browser+terminal
    // entry, so a fourth pane's divider would have resized those two and never itself — dead to
    // the eye, damaging underneath, and invisible to both the compiler and the suite.
    const moving = panesSharingWidth(pane)
    setPanelWidths((prev) => {
      const next = { ...prev }
      for (const id of moving) next[id] = w
      return next
    })
    void window.beacon?.settings.set(panelWidthKey(pane), String(w)).catch(() => undefined)
  }, [])
  const showBrowser = useCallback(() => showPane('browser'), [showPane])
  /** A clicked local link wants the browser pane. Only on a surface the dock sits beside (the thread,
   *  a coding run): from Wiki or Settings, showing the pane would yank the person to the chat view
   *  just to open a link, so the click is declined and the link opens in the system browser. */
  const showBrowserForLink = useCallback((): boolean => {
    if (!canDock(viewRef.current)) return false
    showPane('browser')
    return true
  }, [showPane])
  // Send to chat (Phase 2): the pane hands MainView a block; MainView shows the chat view and
  // delivers it to whichever composer is up (a session's, or Home's). The user sends it from
  // there — or not. Owned here because a session switch remounts the composer.
  const [composerInsert, setComposerInsert] = useState<ComposerInsert | null>(null)
  const insertSeq = useRef(0)
  const sendToChat = useCallback((text: string) => {
    setView('chat')
    setComposerInsert({ text, n: ++insertSeq.current })
  }, [])
  const onInsertConsumed = useCallback(() => setComposerInsert(null), [])
  const [configTab, setConfigTab] = useState<string | null>(null) // palette deep-link (Slice 8)
  const activeRef = useRef(active)
  useEffect(() => {
    activeRef.current = active
  }, [active])

  // ── Session windows (@shared/session-windows) ───────────────────────────────
  // Sessions popped out into their own OS windows. ONE PLACE AT A TIME: a popped-out session is not
  // shown here (a placeholder stands in), its row's click brings its window forward, and it never
  // goes unread here while it is open somewhere you can read it.
  const [popped, setPopped] = useState<ReadonlySet<string>>(() => new Set())
  const poppedRef = useRef<ReadonlySet<string>>(popped)
  // A pop-out of the OPEN conversation, waiting for the chat view to unmount first (its unmount
  // writes the draft, which the new window then reads).
  const [popping, setPopping] = useState<string | null>(null)
  useEffect(() => {
    const b = window.beacon
    if (!b?.sessionWindows) return
    const apply = (ids: string[]): void => {
      const next = new Set(ids)
      const prev = poppedRef.current
      // A session coming BACK: you were reading it in its window, so it is not unread here, and
      // its last-viewed mark moves to where it is now (else the next refresh flags it).
      for (const id of prev) {
        if (next.has(id)) continue
        setUnread((u) => ({ ...u, [id]: false }))
        const sw = sessionsRef.current.find((x) => x.id === id)?.watermark ?? 0
        if (sw > 0) void b.settings.set(`viewed:${id}`, String(sw)).catch(() => undefined)
      }
      // A session LEAVING: this window's memory copy of its draft is stale from now on, and a split
      // pane showing it closes (one place at a time; a lone pane keeps the placeholder instead).
      for (const id of next) {
        if (prev.has(id)) continue
        dropDraftMemory(id)
        adjustLayout((l) => removeSession(l, id))
      }
      poppedRef.current = next
      setPopped(next)
      setPopping((p) => (p !== null && next.has(p) ? null : p))
    }
    void b.sessionWindows.list().then(apply).catch(() => undefined)
    return b.sessionWindows.onChanged(apply)
  }, [])
  // The draft's memory copy is dropped in ONE place, `apply` above, when a session joins the popped-out
  // set, however it got there (this window, a relaunch restore). Not here as well: a second and third
  // drop made each one untestable, since removing any of them changed nothing.
  const popOut = useCallback((id: string) => {
    if (!id) return
    const l = layoutRef.current
    if (l.panes.length > 1 && l.panes.includes(id)) {
      // In a split: close its pane NOW (that unmount writes the draft), then the effect below opens it.
      setActive((cur) => removeSession(cur, id))
      setPopping(id)
    } else if (id === activeRef.current) setPopping(id) // the lone pane: placeholder, then open
    else void window.beacon?.sessionWindows.open(id)
  }, [])
  useEffect(() => {
    if (!popping) return
    // This runs after the commit that unmounted the chat, so its draft write is already sent; the
    // open below reaches main after it.
    void window.beacon?.sessionWindows.open(popping).then((ok) => {
      if (!ok) setPopping(null) // refused: show the conversation here again rather than a dead placeholder
    })
  }, [popping])
  const returnHere = useCallback((id: string) => {
    void window.beacon?.sessionWindows.requestClose(id)
  }, [])
  const activePopped = active !== null && (popped.has(active) || popping === active)

  // ── Split panes: what is on screen ───────────────────────────────────────────
  const onScreen = visibleSessions(layout).filter((id) => !popped.has(id))
  const onScreenKey = onScreen.join('\n')
  const onScreenRef = useRef<ReadonlySet<string>>(new Set())
  useEffect(() => {
    const now = new Set(onScreenKey ? onScreenKey.split('\n') : [])
    const b = window.beacon
    // A session leaving the screen (its pane closed or replaced): you were reading it, so it is not
    // unread and its last-viewed mark moves to where it is (the focused pane's select already did this).
    for (const id of onScreenRef.current) {
      if (now.has(id)) continue
      const sw = sessionsRef.current.find((x) => x.id === id)?.watermark ?? 0
      if (sw > 0) void b?.settings.set(`viewed:${id}`, String(sw)).catch(() => undefined)
    }
    onScreenRef.current = now
    // Notifications: every pane on screen is one you can see, not only the focused one.
    b?.session.setVisible([...now])
    setUnread((u) => {
      let changed = false
      const next = { ...u }
      for (const id of now) {
        if (!next[id]) continue
        next[id] = false
        changed = true
      }
      return changed ? next : u
    })
  }, [onScreenKey])

  // Remember the layout for the next launch. Not before launch-restore has run, or the empty first
  // render would overwrite what it is about to read.
  const layoutRestored = useRef(false)
  const layoutKey = serializeLayout(layout)
  useEffect(() => {
    if (!layoutRestored.current) return
    void window.beacon?.settings.set(SPLIT_LAYOUT_KEY, layoutKey).catch(() => undefined)
  }, [layoutKey])

  /** Open a session in a new pane beside pane `at` (default: the focused one). No room → its own window. */
  const openSessionBeside = useCallback(
    (id: string, side: 'left' | 'right' = 'right', at?: number) => {
      if (!id) return
      if (poppedRef.current.has(id)) {
        void window.beacon?.sessionWindows.open(id) // one place at a time: it is in its own window
        return
      }
      const r = openBeside(layoutRef.current, id, side, at ?? layoutRef.current.focus, maxPanesRef.current)
      if (r.outcome === 'full') {
        popOut(id)
        return
      }
      setActive(() => r.layout)
      setView('chat')
    },
    [popOut]
  )
  const closePaneAt = useCallback((index: number) => setActive((l) => closePane(l, index)), [setActive])
  // Divider drags are a choice like any other layout change, so they go through setActive too.
  const panesRef = useRef<HTMLDivElement | null>(null)
  const commitPaneWidths = useCallback((widths: number[]) => setActive((l) => withWidths(l, widths)), [setActive])
  const evenPaneWidths = useCallback(() => setActive((l) => evenWidths(l)), [setActive])
  const weights = paneWeights(layout)
  const focusPaneAt = useCallback(
    (index: number) => {
      if (layoutRef.current.focus !== index) setActive((l) => focusPane(l, index))
    },
    [setActive]
  )
  const onScreenSet = useMemo(() => new Set(onScreenKey ? onScreenKey.split('\n') : []), [onScreenKey])

  // A sidebar session row being dragged: the panes show their drop zones. Read off the drag's own
  // payload type, so no other drag (a file, a link) lights them up.
  const [sessionDrag, setSessionDrag] = useState(false)
  useEffect(() => {
    const start = (e: DragEvent): void => {
      if (e.dataTransfer?.types.includes(SESSION_DRAG_TYPE)) setSessionDrag(true)
    }
    const end = (): void => setSessionDrag(false)
    document.addEventListener('dragstart', start)
    document.addEventListener('dragend', end)
    document.addEventListener('drop', end)
    return () => {
      document.removeEventListener('dragstart', start)
      document.removeEventListener('dragend', end)
      document.removeEventListener('drop', end)
    }
  }, [])
  /** A session dropped on pane `index`: beside it (left/right) or in it (center). */
  const onPaneDrop = useCallback(
    (index: number, zone: PaneDropZone, id: string) => {
      setSessionDrag(false)
      if (zone !== 'center') {
        openSessionBeside(id, zone, index)
        return
      }
      if (poppedRef.current.has(id)) {
        void window.beacon?.sessionWindows.open(id)
        return
      }
      setActive((l) => showIn(focusPane(l, index), id))
    },
    [openSessionBeside]
  )
  // Notifications skip the session you are looking at. A placeholder is not looking at it.
  useEffect(() => {
    if (activePopped) window.beacon?.session.setActive('')
    else if (active) window.beacon?.session.setActive(active)
  }, [active, activePopped])
  // Mirror the session list into a ref so the async forget() reads the current list after its
  // confirm dialog (the callback closes over refs only — no stale `sessions`/`active`).
  const sessionsRef = useRef(sessions)
  useEffect(() => {
    sessionsRef.current = sessions
  }, [sessions])

  const refreshSessions = useCallback(async (): Promise<SessionSummary[]> => {
    const b = window.beacon
    if (!b) return []
    const list = await b.sessions.list().catch(() => [] as SessionSummary[])
    setSessions(list)
    const entries = await Promise.all(
      list.map(async (s) => {
        const lv = Number((await b.settings.get(`viewed:${s.id}`).catch(() => null)) ?? 0)
        const title = await b.settings.get(`title:${s.id}`).catch(() => null)
        // MIGRATION (B5, Prometheus 341): the daemon owns titles now (durable session_titles
        // table, a set title outranks auto-titling). A leftover LOCAL override is pushed up once
        // and cleared on success; until then it still paints, so nothing flickers. Idempotent —
        // a failed PUT (offline) simply retries on the next refresh.
        if (title) {
          const ok = await b.daemon
            .write(`/api/sessions/${encodeURIComponent(s.id)}/title`, { title }, 'PUT')
            .then(() => true)
            .catch(() => false)
          if (ok) await b.settings.set(`title:${s.id}`, '').catch(() => undefined)
        }
        // Pins are the daemon's now. A local `pinned:<id>` row is a leftover from when they were
        // not: push it up once, then clear it. Without this, switching the read to the daemon
        // silently unpins everything the user pinned before today.
        const local = await b.settings.get(`pinned:${s.id}`).catch(() => null)
        if (needsPinMigration(s.pinned, local)) {
          const ok = await b.daemon
            .write(`/api/sessions/${encodeURIComponent(s.id)}/pin`, pinBody(true), 'PUT')
            .then(() => true)
            .catch(() => false)
          if (ok) await b.settings.set(`pinned:${s.id}`, '').catch(() => undefined)
        }
        // UNREAD MEANS "MOVED SINCE YOU LAST READ IT" — not "you have never opened this".
        // `lv` is 0 for any session with no local watermark, so `watermark > 0 > lv` marked every
        // historical conversation unread forever: 134 of 182 rows carried a dot, which marks
        // nothing. A session you have never opened has nothing to have moved PAST, so it is not
        // unread; it is simply unvisited. Sessions that move while the app is running still mark
        // themselves from the gateway stream (see the onGateway handler), so a genuinely new
        // arrival is not lost by requiring a watermark here.
        const seenBefore = lv > 0
        return [s.id, seenBefore && (s.watermark ?? 0) > lv, title ?? '', s.pinned === true || local === '1'] as const
      })
    )
    setUnread((prev) => {
      const next = { ...prev }
      for (const [id, u] of entries) next[id] = id === activeRef.current || poppedRef.current.has(id) || onScreenRef.current.has(id) ? false : next[id] || u
      // A reply that landed in a conversation you are NOT looking at is the canonical
      // not-visible-on-this-surface event — "a background run finished while you were
      // elsewhere". One toast per session per arrival: `announced` is what stops the poll from
      // raising the same notice every few seconds, and it clears when you open the session.
      // The DISPLAY title from the list (main already resolved daemon title → first user message),
      // with a local rename on top. `titlesRef` alone was the bug: the migration pushed local
      // titles up to the daemon and emptied that map, so every toast fell through to the raw id.
      const served = new Map(list.map((s) => [s.id, s.title]))
      for (const [id, u] of entries) {
        if (!u || id === activeRef.current || prev[id] || announced.current.has(id)) continue
        announced.current.add(id)
        raiseToast({ kind: 'ok', message: replyToastMessage(served.get(id), titlesRef.current[id], id), actionLabel: 'Dismiss' })
      }
      return next
    })
    // Local display-name overrides (Slice 6) — `title:<id>` settings; daemon ids stay canonical.
    const nextTitles = Object.fromEntries(entries.filter(([, , t]) => t).map(([id, , t]) => [id, t]))
    titlesRef.current = nextTitles
    setTitles(nextTitles)
    setPinned(Object.fromEntries(entries.filter(([, , , p]) => p).map(([id]) => [id, true])))
    return list
  }, [])

  /** Pin = a LOCAL flag in the settings table ('1'; empty clears), same shape as rename. */
  const togglePin = useCallback(async (id: string, pin: boolean) => {
    const b = window.beacon
    if (!b) return
    // Optimistic: the row moves under the cursor, then the daemon confirms or the click is undone.
    setPinned((prev) => ({ ...prev, [id]: pin }))
    try {
      await b.daemon.write(`/api/sessions/${encodeURIComponent(id)}/pin`, pinBody(pin), 'PUT')
      setPinned((prev) => {
        const next = { ...prev }
        if (pin) next[id] = true
        else delete next[id]
        return next
      })
    } catch (err) {
      // LOUD, and reverted. A pin that exists only on this screen is worse than one that failed:
      // the user believes the phone will agree, and it will not.
      setPinned((prev) => {
        const next = { ...prev }
        if (pin) delete next[id]
        else next[id] = true
        return next
      })
      setVoiceNotice(pinFailureNotice(pin, err instanceof Error ? err.message : undefined))
    }
  }, [])

  /** Rename = a LOCAL override in the settings table (the daemon has no rename API). Empty clears. */
  /** Rename writes THROUGH to the daemon (PUT /api/sessions/{id}/title — Prometheus 341/298):
   * durable, shared by every client, and it outranks auto-titling permanently; empty clears back
   * to auto. Optimistic local paint until the next refresh; a daemon failure falls back to the
   * old local-only override so the rename is never silently lost. */
  const rename = useCallback(
    async (id: string, title: string) => {
      const b = window.beacon
      if (!b) return
      const ok = await b.daemon
        .write(`/api/sessions/${encodeURIComponent(id)}/title`, { title }, 'PUT')
        .then(() => true)
        .catch(() => false)
      if (!ok) await b.settings.set(`title:${id}`, title).catch(() => undefined)
      setTitles((prev) => {
        const next = { ...prev }
        if (title) next[id] = title
        else delete next[id]
        return next
      })
      if (ok) void refreshSessions()
    },
    [refreshSessions]
  )

  /** Persist the last real session for launch-restore (renderer-only settings KV; no new IPC). */
  const persistLast = useCallback((id: string) => {
    void window.beacon?.settings.set(LAST_SESSION_KEY, id).catch(() => undefined)
  }, [])

  /** Tell main which session is focused (notification gating); '' = none (Home). */
  const syncActive = useCallback((target: ChatTarget) => {
    window.beacon?.session.setActive(target ?? '')
  }, [])

  /**
   * Mint a fresh session id (the daemon mints via POST /api/sessions). Returns it, or null.
   *
   * DECLARES ITS GATEWAY. This used to send no body, which took the daemon's
   * `desktop` default — the same default a probe script gets for the same reason,
   * making a human's chat indistinguishable from anything that merely used the
   * API. Saying `beacon` is what makes the Desktop chip mean "undeclared caller".
   */
  const createSession = useCallback(async (): Promise<string | null> => {
    const b = window.beacon
    if (!b) return null
    try {
      const res = (await b.daemon.write('/api/sessions', { gateway: BEACON_GATEWAY }, 'POST')) as {
        session_id?: string
      } | null
      const id = res?.session_id
      if (!id) return null
      await refreshSessions()
      return id
    } catch {
      return null // surfaced via the connection indicator on 401
    }
  }, [refreshSessions])

  /** Go to the Home/landing (no conversation open) — reached from the Sidebar "+", palette, Mission. */
  const goHome = useCallback(() => {
    setActive(HOME)
    syncActive(HOME)
    setView('chat')
  }, [syncActive])

  /** Submit-from-Home: mint a session, focus it, and stage the first message for ChatShell to send. */
  /**
   * A branch was created in ChatShell (B4): open it and send the edited text into it. This is
   * `beginFromHome`'s open+stage pair with a session id the DAEMON minted — no createSession,
   * because the fork already exists with its history copied.
   */
  const openForked = useCallback(
    (id: string, text: string) => {
      setActive(id)
      syncActive(id)
      persistLast(id)
      setView('chat')
      setPendingInitial({ id, text })
      void refreshSessions()
    },
    // Same identity-stability reasoning as `select` — see its note.
    [] // eslint-disable-line react-hooks/exhaustive-deps
  )

  /**
   * Start a conversation from the home screen, carrying what was chosen there.
   *
   * The home composer has no session to apply anything to, so it COLLECTS: mode, model, staged
   * files. This mints the session, records the mode against the new id (ChatShell reads it from
   * modeBySession on its first render, so the first turn goes out in the chosen mode), and hands
   * the model and files to ChatShell, which applies them to that first turn.
   */
  const startFromHome = useCallback(
    (start: HomeStart) => {
      void beginFromHome(start.text, {
        createSession,
        open: (id) => {
          setModeBySession((prev) => ({ ...prev, [id]: start.mode }))
          setActive(id)
          syncActive(id)
          persistLast(id)
          setView('chat')
        },
        stageInitial: (id, t) => setPendingInitial({ id, text: t, files: start.files, modelKey: start.modelKey })
      })
    },
    [createSession, syncActive, persistLast]
  )

  /** A message hit: show its session, then hand ChatShell the rowid to land on. */
  const jumpToHit = useCallback(
    (sessionId: string, messageId: string) => {
      setView('chat')
      void select(sessionId)
      setJump({ sessionId, messageId, nonce: Date.now() })
    },
    // select is identity-stable by construction (see its own note); listing it keeps the intent
    // visible without reintroducing the refetch loop that note describes.
    [] // eslint-disable-line react-hooks/exhaustive-deps
  )

  const select = useCallback(
    async (id: string) => {
      // One place at a time: a popped-out session is shown in its own window, not here.
      if (poppedRef.current.has(id)) {
        void window.beacon?.sessionWindows.open(id)
        return
      }
      setActive(id)
      setUnread((prev) => ({ ...prev, [id]: false }))
      announced.current.delete(id)
      const b = window.beacon
      if (!b) return
      b.session.setActive(id)
      void b.settings.set(LAST_SESSION_KEY, id).catch(() => undefined) // remember for launch-restore
      // Read the ref, NOT `sessions`, so this callback stays identity-stable. A `[sessions]` dep
      // here closed an ~8/sec refetch loop: the launch-restore effect lists `select` in its deps,
      // so refreshSessions() → setSessions(new array) → new `sessions` → new `select` → that effect
      // re-runs → refreshSessions() … which also starved the chat stream (replies spun forever).
      // sessionsRef.current === sessions at call time, so behavior is unchanged. Keep deps `[]`.
      const s = sessionsRef.current.find((x) => x.id === id)
      await b.settings.set(`viewed:${id}`, String(s?.watermark ?? 0)).catch(() => undefined)
    },
    []
  )

  const forget = useCallback(
    async (id: string) => {
      const b = window.beacon
      if (!b) return
      const ok = window.confirm(
        `Forget "${id}"?\n\nThis removes the session from Beacon's sidebar for good. Durable history kept on the daemon is not deleted.`
      )
      if (!ok) return
      await b.session.forget(id).catch(() => undefined)
      // Drop the draft AND tombstone it. Order is load-bearing in both directions: after the
      // `session.forget` await, because main's deleteSessionSettings is what removes the durable
      // `draft:<id>` row; before setActive, because that is what unmounts ChatShell and runs the
      // unmount flush that would otherwise write the row straight back. See @shared/drafts.
      forgetDraft(id)
      // In a split, its pane just closes. Otherwise, if the forgotten session was open, clear the chat
      // view by switching to another session (or the default): ChatShell is keyed by session, so this
      // remounts it empty.
      if (layoutRef.current.panes.length > 1 && layoutRef.current.panes.includes(id)) {
        setActive((l) => removeSession(l, id))
      } else if (activeRef.current === id) {
        const fallback = sessionsRef.current.find((x) => x.id !== id)?.id ?? HOME
        setActive(fallback)
        b.session.setActive(fallback ?? '')
        void b.settings.set(LAST_SESSION_KEY, fallback ?? '').catch(() => undefined)
      }
      setUnread((prev) => {
        const next = { ...prev }
        delete next[id]
        return next
      })
      await refreshSessions()
    },
    [refreshSessions]
  )

  useEffect(() => {
    const b = window.beacon
    if (!b) return
    // Launch-restore: reopen the last real session if it still exists, else show Home (first-run /
    // no-session / stale id). Renderer-only via the settings KV — no new IPC, no daemon change.
    // UNLESS something was chosen while it was awaiting (see chosenSinceMount): the list is on
    // screen and clickable for the whole of both awaits.
    void (async () => {
      const list = await refreshSessions()
      const last = await b.settings.get(LAST_SESSION_KEY).catch(() => null)
      const savedLayout = await b.settings.get(SPLIT_LAYOUT_KEY).catch(() => null)
      // From here the layout is saved as it changes (whether or not this restore applies it).
      layoutRestored.current = true
      if (chosenSinceMount.current) return
      // A saved split comes back as it was (minus sessions forgotten since); a single pane goes through
      // the existing last-session restore, unchanged.
      const known = new Set(list.map((s) => s.id))
      const split = parseLayout(savedLayout, (id) => known.has(id))
      if (split && split.panes.length > 1) {
        setActiveState(split)
        syncActive(focusedTarget(split))
      } else {
        const target = resolveLaunchTarget(last, list.map((s) => s.id))
        setActiveState(single(target))
        syncActive(target)
      }
    })()

    let pending: ReturnType<typeof setTimeout> | null = null
    const scheduleRefresh = (): void => {
      if (pending) return
      pending = setTimeout(() => {
        pending = null
        void refreshSessions()
      }, 1500)
    }

    const offStream = b.chat.onStream((f) => {
      // DAEMON LIVENESS, and it belongs HERE rather than in ChatShell. A frame
      // arriving for ANY session proves the gateway is alive — that is a fact
      // about the connection, not about the conversation on screen. ChatShell
      // reads this when its own quiet-timer fires, so a silent SESSION is never
      // reported as a silent DAEMON.
      //
      // This subscription already saw every frame regardless of session (it is
      // what drives unread for background sessions). The liveness fact was
      // available at this layer the whole time; the watchdog was just reading a
      // filtered copy one component down.
      daemonLastSeen.current = Date.now()
      const sid = 'sessionId' in f ? f.sessionId : undefined
      if (sid && sid !== activeRef.current && !poppedRef.current.has(sid) && !onScreenRef.current.has(sid) && (f.kind === 'done' || f.kind === 'message' || f.kind === 'delta')) {
        setUnread((prev) => ({ ...prev, [sid]: true }))
      }
      scheduleRefresh()
    })
    // SESSION_SWITCH means "take me to this conversation" — from a notification click or a
    // beacon://open deep link — and both can land while another view is up. select() alone
    // changes the session but leaves the VIEW where it was, so a cold start (Mission home)
    // looked like the link did nothing. Flip the view too.
    const offSwitch = b.session.onSwitch((id) => {
      setView('chat')
      void select(id)
    })
    // Terminal pop-in: the detached window closed via "Pop in" — show the pane here, where the
    // same shell re-attaches. (A window merely CLOSED does not steal the panel.)
    const offPlacement = b.terminal.onPlacement((p) => {
      if (p.cause === 'pop-in') showPane('terminal')
    })
    // Renderer-side jump bus (same pattern as beacon:open-settings): Mission's "needs you" card
    // dispatches this to land on a stalled session without prop-drilling select() through App.
    const onOpenSession = (e: Event): void => {
      const id = (e as CustomEvent<string>).detail
      if (typeof id === 'string' && id) void select(id)
    }
    window.addEventListener('beacon:open-session', onOpenSession)
    return () => {
      offStream()
      offSwitch()
      offPlacement()
      window.removeEventListener('beacon:open-session', onOpenSession)
      if (pending) clearTimeout(pending)
    }
  }, [refreshSessions, select, syncActive, showPane])

  // Global approval overlay. Approvals carry no session id (they're app-level,
  // not per-session), so this lives here rather than in ChatShell. Two discovery
  // paths, ONE notification authority (main):
  //   1. PUSH — the daemon's `approval_pending`/`approval_resolved` WS frames
  //      apply to the list instantly (applyApprovalFrame). This is discovery.
  //   2. POLL — the 3s REST list, kept as the RECONCILER: it replaces the list
  //      wholesale, so a request resolved elsewhere (Telegram, another client,
  //      timeout) clears within one tick.
  //
  // THE POLL IS NOT REDUNDANT — do not remove it. A WS-only client that missed
  // a frame would show a ghost approval forever; poll is what reconciles state
  // the client missed while not listening. Push makes poll latency-free; poll
  // makes push safe. Keep both (spec beacon-approvals-push-spec.md).
  //
  // Notification moved to MAIN (notifyApproval): the frame path and the poll
  // path both feed main's single dedupe set via approvals:new / the frame
  // handler, so one request gets exactly one notification no matter which saw
  // it first. The in-window Notification that used to fire here is retired.
  const seenApprovals = useRef<Set<string>>(new Set())
  useEffect(() => {
    const b = window.beacon
    if (!b) return
    // PUSH path: frames update the list immediately (upsert by requestId).
    const offGateway = b.events.onGateway((ev: GatewayEvent) => {
      if (ev.type !== 'approval_pending' && ev.type !== 'approval_resolved') return
      setApprovals((prev) => applyApprovalFrame(prev, { type: ev.type, payload: ev.payload }))
    })
    return () => {
      offGateway()
    }
  }, [])
  useEffect(() => {
    const b = window.beacon
    if (!b) return
    let alive = true
    const poll = (): void => {
      void b.approvals
        .list()
        .then((l) => {
          if (!alive) return
          setApprovals(l) // wholesale replace — the reconciler clears ghosts
          b.approvals.notifyCount(l.length)
          const fresh = l.filter((a) => !seenApprovals.current.has(a.requestId))
          for (const a of fresh) seenApprovals.current.add(a.requestId)
          if (fresh.length > 0) b.approvals.notifyNew(fresh) // main decides notification (dedupes with the frame path)
        })
        .catch(() => undefined)
    }
    poll()
    const id = setInterval(poll, 3000)
    return () => {
      alive = false
      clearInterval(id)
    }
  }, [])

  const resolveApproval = useCallback(async (requestId: string, decision: ApprovalDecision) => {
    // BREADCRUMB 2 — what survived the prop hop from the card.
    trace({
      point: 'mainview:resolve-enter',
      requestId,
      scope: decision.kind === 'approve' ? decision.scope : undefined,
      detail: `decision.kind=${decision.kind}`
    })
    const b = window.beacon
    if (!b) return
    setApprovalErrors((m) => (m[requestId] ? { ...m, [requestId]: '' } : m)) // clear a stale rejection
    const approval = approvalsRef.current.find((a) => a.requestId === requestId)
    // Optimistic remove, except an approve of a worker's request: that one can be refused for who is asking (401 not_a_person),
    // and a card that left and came back with the next poll is the flicker that refusal used to cause. It waits for the answer.
    const waits = decision.kind === 'approve' && !!approval?.workerTaskId
    const remove = (): void => setApprovals((p) => p.filter((a) => a.requestId !== requestId))
    if (!waits) remove()
    try {
      // BREADCRUMB 3 — about to cross the process boundary. A row here with no
      // main:handler-enter means the invoke did not arrive.
      trace({
        point: 'mainview:pre-invoke',
        requestId,
        scope: decision.kind === 'approve' ? decision.scope : undefined
      })
      await b.approvals.resolve(requestId, decision)
      if (waits) remove()
    } catch (err) {
      // Not this Beacon's to approve: say so once, in place of Approve; the card stays, with Deny.
      const line = approval ? cannotApproveLine(approval, err) : null
      if (line) {
        setCannotApprove((m) => ({ ...m, [requestId]: line }))
        return
      }
      // SPRINT-CONSENT: a rejected resolve is SHOWN, never swallowed. Beacon holds no verb list —
      // the daemon's normalise_scope is the sole authority — so a 400 here is the only signal that
      // the two vocabularies have drifted. Silently discarding it (the previous `.catch(() =>
      // undefined)`) is what would let a scope Beacon offers but the daemon rejects look like a
      // successful approval. The request is still pending server-side, so the 3s poll restores the
      // card on its own; this only has to carry the reason back to it.
      setApprovalErrors((m) => ({ ...m, [requestId]: String(err instanceof Error ? err.message : err) }))
    }
  }, [])

  // ── Slice 5: global keys — ⌘K palette, ? cheat sheet (never inside inputs) ──
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'f') {
        // ⌘⇧F (frozen spec): global conversation search. ⌘F stays free for a future
        // find-in-conversation, which is why this is not the plainer chord.
        e.preventDefault()
        setPaletteOpen(false)
        setSheetOpen(false)
        setSearchQuery((q) => (q === null ? '' : null))
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setSheetOpen(false)
        setPaletteOpen((o) => !o)
      } else if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && paneForChord(e.key)) {
        // ⌘n toggles the nth pane in dock order. Derived from PANEL_PANES rather than a literal
        // /^[1-3]$/, which had to be remembered and would have left ⌘4 silently dead.
        // Each toggles; from any view but chat it opens (and brings the chat view up).
        e.preventDefault()
        togglePane(paneForChord(e.key) as PanelPane)
      } else if (e.key === 'Escape' && !inEditable(e) && !paletteOpenRef.current && !sheetOpenRef.current && !searchOpenRef.current) {
        // R3: Esc closes the dock — when no overlay is up to take the key first, and never from
        // inside an input (the composer, the terminal's textarea, and the palette own their Esc).
        if (canDock(viewRef.current) && panelRef.current.open) closePanel()
      } else if (e.key === '?' && !e.metaKey && !e.ctrlKey && !e.altKey && !inEditable(e)) {
        e.preventDefault()
        setPaletteOpen(false)
        setSheetOpen((o) => !o)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [togglePane, closePanel])

  const paletteCommands: PaletteCommand[] = [
    ...NAV_VIEWS.map<PaletteCommand>((v) => ({
      id: `view:${v.id}`,
      label: `Go to ${v.label}`,
      group: 'view',
      run: () => setView(v.id)
    })),
    // Slice 8: deep-links into the native surfaces (Config tabs) — Memory/Skills/Telemetry/… are
    // one keystroke away without growing the nav rail.
    ...['memory', 'skills', 'telemetry', 'sentinel', 'wiki', 'cron', 'profiles'].map<PaletteCommand>((tabId) => ({
      id: `surface:${tabId}`,
      label: `Open ${tabId[0].toUpperCase()}${tabId.slice(1)}`,
      hint: 'config',
      group: 'view',
      run: () => {
        setConfigTab(tabId)
        setView('config')
      }
    })),
    ...sessions.map<PaletteCommand>((s) => ({
      id: `session:${s.id}`,
      label: `Open ${titles[s.id] ?? s.title ?? s.id}`,
      hint: s.gateway,
      group: 'session',
      run: () => {
        void select(s.id)
        setView('chat')
      }
    })),
    {
      id: 'action:new-chat',
      label: 'New chat',
      group: 'action',
      run: goHome
    },
    {
      id: 'action:reconnect',
      label: 'Reconnect to gateway',
      group: 'action',
      run: () => void window.beacon?.connection.reconnect()
    },
    {
      id: 'action:settings',
      label: 'Open Connection Settings',
      hint: '⌘,',
      group: 'action',
      run: () => window.dispatchEvent(new Event('beacon:open-settings'))
    },
    // R3: the dock's three panes, one verb each — the palette is where tools that earn no rail
    // slot stay reachable from any view.
    ...PANEL_PANES.map<PaletteCommand>((p) => ({
      id: `action:${p.id}`,
      label: panelShowing && panel.pane === p.id ? `Close the ${p.label.toLowerCase()} pane` : `Open the ${p.label.toLowerCase()} pane`,
      hint: p.shortcut,
      group: 'action',
      run: () => togglePane(p.id)
    })),
    {
      id: 'action:shortcuts',
      label: 'Show keyboard shortcuts',
      hint: '?',
      group: 'action',
      run: () => setSheetOpen(true)
    }
  ]

  // The voice controls exist only when OAra Voice is configured, or while one is running, so a
  // recording or a hands-free session can always be stopped from the control that started it.
  // An absent handler is what hides a control (AgentChatToggle, ChatHome and ChatShell all read it).
  const voiceOffered = voiceConfigured || handsFreePhase !== 'off'
  const dictationOffered = voiceConfigured || dictateState !== 'idle'

  return (
    <GatewayStoreProvider>
      <PreviewProvider>
      {approvals.length > 0 ? (
        <div
          style={{
            position: 'fixed',
            top: 12,
            left: '50%',
            transform: 'translateX(-50%)',
            zIndex: 50,
            width: 'min(560px, 90vw)',
            display: 'flex',
            flexDirection: 'column',
            gap: 8
          }}
        >
          {approvals.map((a, i) => (
            <ExecApprovalCard
              key={a.requestId}
              approval={a}
              first={i === 0}
              activeSessionId={view === 'chat' ? active : null}
              error={approvalErrors[a.requestId] || null}
              cannotApprove={cannotApprove[a.requestId] ?? null}
              disclosureOpen={isDisclosureOpen(disclosedFor, a.requestId)}
              onToggleDisclosure={() => setDisclosedFor((s) => toggleDisclosure(s, a.requestId))}
              onResolve={(d) => void resolveApproval(a.requestId, d)}
            />
          ))}
        </div>
      ) : null}
      <div className="shell">
        <NavRail view={view} onSelect={setView} />
        <InspectorSync view={view} panel={panel} showPane={showPane} closePreviewWhenHidden />
        <div className="view-area">
          {view === 'chat' ? (
            <div className="layout">
              {/* R3: the session list collapses (rail-only) while the browser or terminal shows,
                  so the thread keeps its reading width; the inspector leaves it alone. */}
              {sessionsShowing ? (
                <Sidebar
                  sessions={sessions}
                  active={active ?? ''}
                  unread={unread}
                  titles={titles}
                  pinned={pinned}
                  onTogglePin={(id, pin) => void togglePin(id, pin)}
                  onSelect={(id) => void select(id)}
                  onForget={(id) => void forget(id)}
                  onRename={(id, t) => void rename(id, t)}
                  onNew={goHome}
                  onManage={() => setView('sessions')}
                  onOpenStatus={() => setView('status')}
                  width={listShown}
                  onWidth={onListWidth}
                  popped={popped}
                  onPopOut={popOut}
                  onReturnHere={returnHere}
                  onScreen={onScreenSet}
                  onOpenBeside={(id) => openSessionBeside(id, 'right')}
                  canOpenBeside={canOpenBeside}
                  fitWidth={(w) => fitSessionListWidth(w, window.innerWidth, dockFootprint, conversationMin)}
                />
              ) : null}
              {/* THE PANES (@shared/split-panes): one conversation per pane, left to right, one focused.
                  Every pane renders the SAME tree, keyed by its session, so moving focus between panes
                  never remounts a conversation (its scroll, its draft and its history stay put): focus
                  only decides which props a pane gets. The focused pane gets everything that means
                  "the open conversation": Send to chat, voice, dictation, the dock, a search jump.

                  Each pane has its own boundary, keyed by session. ChatShell renders the daemon's
                  frames, the surface most likely to meet a shape it does not expect; one bad message
                  costs that pane, never the window (the Sidebar, outside, is the way out). The single
                  `.panes` element is also what the dock measures its room from (SidePanel). */}
              <div ref={panesRef} className={`panes${sessionDrag ? ' is-dragging-session' : ''}`} data-pane-count={layout.panes.length}>
              {layout.panes.map((target, i) => {
                const focused = i === layout.focus
                const multi = layout.panes.length > 1
                return [
                  i > 0 ? (
                    <PaneDivider key={`divider:${layout.panes[i - 1] ?? 'home'}|${target ?? 'home'}`} index={i - 1} container={panesRef} onCommit={commitPaneWidths} onReset={evenPaneWidths} />
                  ) : null,
                  <section
                    key={target ?? 'home'}
                    style={multi ? { flexGrow: weights[i] } : undefined}
                    className={`pane${focused ? ' is-focused' : ''}${multi ? ' is-split' : ''}`}
                    data-pane-index={i}
                    data-session={target ?? ''}
                    onMouseDownCapture={() => focusPaneAt(i)}
                    onFocusCapture={() => focusPaneAt(i)}
                  >
              <ErrorBoundary
                key={target ?? 'home'}
                label={target === null ? 'the new-chat screen' : 'this conversation'}
                hint={
                  target === null
                    ? 'Pick a conversation from the list, or reload.'
                    : 'Your other conversations are unaffected — pick one from the list.'
                }
              >
              {target === null ? (
                <ChatHome
                  onSubmit={startFromHome}
                  insert={composerInsert}
                  onInsertConsumed={onInsertConsumed}
                  dockPane={panelShowing ? panel.pane : null}
                  onToggleDock={togglePane}
                  handsFreePhase={handsFreePhase}
                  onHandsFreeToggle={voiceOffered ? () => void onHandsFreeToggle() : undefined}
                  dictateState={dictateState}
                  onDictateToggle={dictationOffered ? onDictateToggle : undefined}
                  dictated={dictated}
                  onDictationConsumed={() => setDictated(null)}
                  voiceNotice={voiceNotice}
                />
              ) : focused && activePopped ? (
                <div className="popped-placeholder" role="status">
                  <div className="popped-placeholder-body">
                    <Icon name="popout" size={18} />
                    <p className="popped-placeholder-title">This conversation is open in its own window.</p>
                    <p className="popped-placeholder-note">One place at a time: it moves back here when that window closes.</p>
                    <div className="popped-placeholder-actions">
                      <button className="popped-placeholder-btn is-primary" onClick={() => void window.beacon?.sessionWindows.open(target)} disabled={popping === target}>
                        Bring its window to the front
                      </button>
                      <button className="popped-placeholder-btn" onClick={() => returnHere(target)} disabled={popping === target}>
                        Return it here
                      </button>
                    </div>
                  </div>
                </div>
              ) : (
                <ChatShell
                  key={target}
                  sessionId={target}
                  onPopOut={() => popOut(target)}
                  onClosePane={multi ? () => closePaneAt(i) : undefined}
                  initialMessage={pendingInitial?.id === target ? pendingInitial.text : undefined}
                  initialFiles={pendingInitial?.id === target ? pendingInitial.files : undefined}
                  initialModelKey={pendingInitial?.id === target ? pendingInitial.modelKey : undefined}
                  onInitialSent={() => setPendingInitial(null)}
                  mode={resolveSessionMode(modeBySession, target)}
                  onModeChange={(m) => setModeBySession((prev) => ({ ...prev, [target]: m }))}
                  daemonLastSeen={() => daemonLastSeen.current}
                  voiceState={focused ? voiceState : undefined}
                  voiceNotice={focused ? voiceNotice : undefined}
                  dictateState={focused ? dictateState : undefined}
                  onDictateToggle={focused && dictationOffered ? onDictateToggle : undefined}
                  dictated={focused ? dictated : null}
                  onDictationConsumed={() => setDictated(null)}
                  insert={focused ? composerInsert : null}
                  onInsertConsumed={onInsertConsumed}
                  handsFreePhase={focused ? handsFreePhase : undefined}
                  onHandsFreeToggle={focused && voiceOffered ? () => void onHandsFreeToggle() : undefined}
                  jumpTo={jump && jump.sessionId === target ? { messageId: jump.messageId, nonce: jump.nonce } : null}
                  sessionTitle={titles[target] ?? sessions.find((s) => s.id === target)?.title}
                  onForked={openForked}
                  dockPane={focused && panelShowing ? panel.pane : null}
                  onToggleDock={focused ? togglePane : undefined}
                  pinned={!!pinned[target]}
                  onTogglePin={() => void togglePin(target, !pinned[target])}
                  onRenameSession={(t) => void rename(target, t)}
                  onDeleteSession={() => void forget(target)}
                />
              )}
              </ErrorBoundary>
                    {sessionDrag ? (
                      <PaneDropZones
                        index={i}
                        canSplit={layout.panes.length < maxPanes && target !== null}
                        onDropSession={onPaneDrop}
                      />
                    ) : null}
                  </section>
                ]
              })}
              </div>
              {/* The DOCK is a panel too, and it renders daemon-shaped data (the run inspector, the
                  Progress pane). Keyed by pane so switching panes clears a fallback; pinned to the
                  pane's width so a broken pane does not squeeze the conversation. The dock buttons
                  in the thread header, outside this boundary, still close it. */}
              {panel.open ? (
                <ErrorBoundary
                  key={panel.pane}
                  label={`the ${paneInfo(panel.pane).label} pane`}
                  hint="Close it from the dock buttons in the conversation header, or open another pane."
                  width={panelWidths[panel.pane] ?? paneInfo(panel.pane).defaultWidth}
                >
                <SidePanel
                  pane={panel.pane}
                  width={panelWidths[panel.pane] ?? paneInfo(panel.pane).defaultWidth}
                  onWidth={onPanelWidth}
                  onClose={closePanel}
                  onSendToChat={sendToChat}
                  onOpenSession={(id) => void select(id)}
                  sessionId={active}
                  view={view}
                  pendingApprovalIds={pendingApprovalIds}
                  conversationMin={conversationMin}
                />
                </ErrorBoundary>
              ) : null}
            </div>
          ) : (
            // R2: every other surface is its pill row (when it has a second level) over the view.
            <div className="surface">
              {usesPillRow(view) ? <SubNav view={view} onSelect={setView} counts={{ sessions: sessions.length }} /> : null}
              {/* SubNav is deliberately OUTSIDE this boundary: it is the way out of a broken view.
                  A boundary around the whole surface would take the pill row with it, leaving a
                  person staring at a dead panel with no route to any other one. */}
              {/* KEYED BY VIEW, and that is load-bearing rather than decorative. Without the key,
                  React reconciles the SAME boundary element across a view change, so its captured
                  error survives: switching away from a broken panel would keep showing that panel's
                  error surface forever, with a pill row right there that appears to do nothing.
                  Keying remounts the boundary per view, so navigating away clears it — which is the
                  whole reason SubNav sits outside. */}
              <ErrorBoundary
                key={view}
                label={`the ${viewLabel(view)} view`}
                hint="The rest of Beacon still works — switch views from the rail."
              >
              {/* An approved device (not the owner): a view that reads only the owner's routes is the note instead, and never mounts,
                  so nothing is asked that Prometheus would refuse (the 0.4.5 sweep, S1–S9). Coding keeps its own surface. Until main has
                  said which (the page's first moments), such a view waits rather than asks. */}
              {ownerGate && view !== 'coding' && view !== 'loop-manager' ? (
            ownerGate === 'note' ? <OwnerOnlyNote area={view} /> : null
          ) : view === 'mission' ? (
            <MissionHome
              approvals={approvals}
              onResolveApproval={(id, d) => void resolveApproval(id, d)}
              onNewChat={goHome}
              onOpenView={setView}
            />
          ) : view === 'toolfeed' ? (
            <ToolCallFeed />
          ) : view === 'activity' ? (
            <ActivityFeed />
          ) : view === 'status' ? (
            <StatusPanel sessionId={active ?? ''} />
          ) : view === 'sessions' ? (
            <SessionsPanel
              sessions={sessions}
              active={active ?? ''}
              onOpen={(id) => {
                void select(id)
                setView('chat')
              }}
              onPurged={(id) => {
                // The daemon has already destroyed its rows; drop OUR copy too, or the cache would
                // keep serving a conversation that no longer exists anywhere else — the exact
                // "deleted but still readable" state a purge exists to prevent. Reuses the forget
                // path, which also clears the local title/viewed/pinned rows.
                void window.beacon?.session.forget(id).catch(() => undefined)
                if (layoutRef.current.panes.length > 1 && layoutRef.current.panes.includes(id)) {
                  setActive((l) => removeSession(l, id))
                } else if (activeRef.current === id) {
                  const fallback = sessionsRef.current.find((x) => x.id !== id)?.id ?? HOME
                  setActive(fallback)
                  window.beacon?.session.setActive(fallback ?? '')
                }
                void refreshSessions()
              }}
            />
          ) : view === 'board' ? (
            <BoardPanel sessions={sessions} active={active ?? ''} />
          ) : view === 'files' ? (
            <FilesPanel />
          ) : view === 'checkpoints' ? (
            <CheckpointsPanel sessions={sessions} active={active ?? ''} />
          ) : view === 'documents' ? (
            <DocumentsPanel />
          ) : view === 'coding' || view === 'loop-manager' ? (
            // The Coding surface draws its own second level as a left column and carries the
            // dock's Terminal/Browser beside the run (see CodingSurface).
            <div className="coding-with-dock">
              <CodingSurface view={view} onSelect={setView} dockPane={panelShowing ? panel.pane : null} onToggleDock={togglePane}>
                {ownerGate === 'note' ? <OwnerOnlyNote area={view} /> : ownerGate === 'wait' ? null : view === 'coding' ? <CodingPanel /> : <LoopManagerPanel />}
              </CodingSurface>
              {panelShowing ? (
                <SidePanel
                  pane={panel.pane}
                  width={panelWidths[panel.pane] ?? paneInfo(panel.pane).defaultWidth}
                  onWidth={onPanelWidth}
                  onClose={closePanel}
                  onSendToChat={sendToChat}
                  onOpenSession={(id) => void select(id)}
                  sessionId={null}
                  view={view}
                  pendingApprovalIds={pendingApprovalIds}
                  onResolveApproval={(id, d) => void resolveApproval(id, d)}
                />
              ) : null}
            </div>
          ) : view === 'skills' ? (
            <SkillsPanel />
          ) : view === 'artifacts' ? (
            <ArtifactsPanel />
          ) : view === 'wiki' ? (
            <WikiPanel />
          ) : view === 'integrations' ? (
            <IntegrationsPanel />
          ) : view === 'config' ? (
            <ConfigPanel key={configTab ?? 'default'} initialTab={configTab ?? undefined} />
          ) : (
            <StubPanel view={view} />
          )}
              </ErrorBoundary>
            </div>
          )}
        </div>
        {/* Off the chat view the preview is still its own pane beside the surface; on the chat view
            it is the dock's inspector (R3: one dock slot on the right of the thread). */}
        {view !== 'chat' ? (
          <PreviewPane
            onOpenSession={(id) => {
              setView('chat')
              void select(id)
            }}
          />
        ) : null}
        <ComposeRelay onInsert={sendToChat} />
        <BrowserHostRelay onReattached={showBrowser} />
        <PaneLinkRelay onShow={showBrowserForLink} />
      </div>
      {paletteOpen ? (
        <PaletteLayer
          commands={paletteCommands}
          onClose={() => setPaletteOpen(false)}
          onSearch={(q) => {
            setPaletteOpen(false)
            setSearchQuery(q)
          }}
        />
      ) : null}
      {searchQuery !== null ? (
        <SearchLayer initialQuery={searchQuery} onClose={() => setSearchQuery(null)} onJump={jumpToHit} />
      ) : null}
      {sheetOpen ? <ShortcutSheet onClose={() => setSheetOpen(false)} /> : null}
      <ToastStack toasts={toasts} onDismiss={(id) => setToasts((prev) => dismissToast(prev, id))} />
      {/* Hands-free, made visible. The Voice segment always started the mic and the VAD; what it
          never did was SHOW you that, so pressing it looked like nothing happened. */}
      {handsFreePhase !== 'off' ? (
        <VoiceOverlay
          state={handsFreeRef.current}
          startedAt={handsFreeStartedAt}
          level={micLevel}
          transcript={voiceTranscript}
          agentName="Prometheus"
          holding={holding}
          onHoldChange={(held) => {
            holdingRef.current = held
            setHolding(held)
            if (!held) flushHeldUtterance()
          }}
          onSend={flushHeldUtterance}
          canSend={heldReady}
          onClose={() => dispatchHandsFree({ kind: 'stop' })}
        />
      ) : null}
      </PreviewProvider>
    </GatewayStoreProvider>
  )
}

/**
 * The palette plus its FILES group.
 *
 * A layer for the same structural reason SearchLayer is one: opening a file means `usePreview()`,
 * and MainView's body RENDERS PreviewProvider, so a hook called up there binds to the no-op
 * default and the pane silently never opens.
 *
 * The workspace listing is fetched WHEN THE PALETTE OPENS, not on mount: it is one shallow
 * `/api/files` call whose result is only ever looked at here, and paying for it on every launch
 * to populate a list nobody has asked for yet is the kind of cost that never shows up in a
 * screenshot. A daemon that cannot list simply contributes no FILES group — the palette is still
 * a palette without it, so there is nothing to report and nothing to degrade.
 */
function PaletteLayer({
  commands,
  onClose,
  onSearch
}: {
  commands: PaletteCommand[]
  onClose: () => void
  onSearch: (q: string) => void
}) {
  const preview = usePreview()
  const [files, setFiles] = useState<FileEntry[]>([])
  useEffect(() => {
    const b = window.beacon
    if (!b) return
    let alive = true
    void b.daemon
      .get('/api/files?path=')
      .then((d) => {
        if (!alive) return
        const list = (d as FileListDTO | null)?.entries
        setFiles(Array.isArray(list) ? list.filter((e) => e.type === 'file') : [])
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [])
  const withFiles: PaletteCommand[] = [
    ...commands,
    ...files.map<PaletteCommand>((f) => ({
      id: `file:${f.name}`,
      label: f.name,
      // The SIZE, because it is the fact that decides whether you want to open it here or not.
      hint: typeof f.size === 'number' ? fmtBytes(f.size) : undefined,
      group: 'file',
      run: () => preview.open({ kind: 'file', path: f.name })
    }))
  ]
  return <CommandPalette commands={withFiles} onClose={onClose} onSearch={onSearch} />
}

/** `12.4k` / `980` — the palette's hint column is mono and narrow; a full byte count is noise. */
function fmtBytes(n: number): string {
  if (n < 1000) return `${n}`
  if (n < 1000 * 1000) return `${(n / 1000).toFixed(1)}k`
  return `${(n / 1000 / 1000).toFixed(1)}M`
}

/**
 * The search overlay plus its peek target. This exists as its own component for one structural
 * reason: MainView's body RENDERS PreviewProvider, so it sits above that context and usePreview()
 * there would silently bind to the no-op default — the pane would never open and nothing would
 * report why. A layer inside the tree consumes the real context.
 */
function SearchLayer({
  initialQuery,
  onClose,
  onJump
}: {
  initialQuery: string
  onClose: () => void
  onJump: (sessionId: string, messageId: string) => void
}) {
  const preview = usePreview()
  return (
    <SearchOverlay
      initialQuery={initialQuery}
      onClose={onClose}
      onJump={onJump}
      onPeek={(hit: SearchSummaryHit) =>
        preview.open({
          kind: 'summary',
          title: 'Compressed history',
          // summary_text is the whole summary; the snippet (markers stripped) is the fallback for
          // a daemon that sent only the excerpt.
          body: hit.summaryText || plainSnippet(hit.snippet),
          sessionId: hit.sessionId,
          anchorCount: hit.anchorMessageIds.length,
          depth: hit.depth
        })
      }
    />
  )
}

/**
 * R3: the preview store ↔ the dock's inspector pane. Same structural reason as SearchLayer — the
 * store's context is rendered by MainView's body, so a consumer has to sit inside the tree. A
 * target opened while the chat view is up (a tool-call chip, a file chip) brings the dock up on
 * the inspector; when the inspector stops showing (closed, or another pane took the slot) the
 * target is cleared, so reopening the inspector later starts from "nothing selected" rather than
 * a stale call from another conversation.
 */
function InspectorSync({
  view,
  panel,
  showPane,
  closePreviewWhenHidden
}: {
  view: ViewId
  panel: PanelState
  showPane: (p: PanelPane) => void
  closePreviewWhenHidden: boolean
}) {
  const { target, close } = usePreview()
  const viewRef = useRef(view)
  viewRef.current = view
  const lastTarget = useRef(target)
  useEffect(() => {
    if (target && target !== lastTarget.current && viewRef.current === 'chat') showPane('inspector')
    lastTarget.current = target
  }, [target, showPane])
  const inspectorShowing = view === 'chat' && panel.open && panel.pane === 'inspector'
  const wasShowing = useRef(inspectorShowing)
  useEffect(() => {
    if (closePreviewWhenHidden && wasShowing.current && !inspectorShowing && lastTarget.current) close()
    wasShowing.current = inspectorShowing
  }, [inspectorShowing, closePreviewWhenHidden, close])
  return null
}
