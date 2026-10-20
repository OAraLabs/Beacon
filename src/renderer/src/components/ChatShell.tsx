import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import type { ArtifactEntry, ChatStreamFrame, ConnectionStatus, HistoryMessage } from '@shared/ipc'
import { partsFromContentJson, type ContentPart } from '@shared/parts'
import {
  base64FromText,
  CHAT_UPLOAD_SAFE_BYTES,
  oversizeAttachmentNotice,
  PASTE_AS_FILE_CHARS,
  pasteFilename,
  utf8ByteLength
} from '@shared/attachments'
import { usePreview } from '../preview-store'
import { stageFiles, type PendingFile } from '../attachments-io'
import { MessageBody } from './MessageRenderer'
import { Icon } from './Icon'
import { ToolTimeline } from './ToolTimeline'
import { coalesceToolResults, groupForRender } from '@shared/timeline'
import { finalizeRow, orderForRender } from '@shared/message-order'
import { ModelSwitcher } from './ModelSwitcher'
import { hostDisplayName } from '@shared/daemon-api'
import { speakable, speechText } from '@shared/speech-text'
import { initialWatermark, nextAnnouncement, spokenAnnouncement } from '@shared/live-announce'
import { ProfilePicker } from './ProfilePicker'
import {
  canEditIntoBranch,
  editUnavailableReason,
  forkBanner,
  forkBody,
  forkPointBefore,
  parseForkOrigin,
  parseForkResult,
  type ForkOrigin
} from '@shared/session-fork'
import { appendDictation, dictateUnavailableReason } from '@shared/dictation'
import {
  DRAFT_WRITE_DEBOUNCE_MS,
  draftKey,
  draftStoreValue,
  recallDraft,
  rememberDraft,
  restorableDraft
} from '@shared/drafts'
import { fileName, parseMachineNotice } from '@shared/machine-notice'
import { isMachineryProvenance, isOperatorTurn, lastOperatorTurn, provenanceLabel } from '@shared/provenance'
import { parseWorkerReport } from '@shared/workers'
import { WorkerReportCard } from './WorkerReportCard'
import { stripVoiceParts } from '@shared/voice-preamble'
import { turnLabel, turnMarks } from '@shared/turn-rule'
import { appendComposerInsert, type ComposerInsert } from '@shared/browser-pane'
import {
  UNKNOWN_PROFILE,
  parseSessionProfile,
  profileSelectBody,
  type SessionProfile
} from '@shared/session-profile'
import { AgentChatToggle } from './AgentChatToggle'
import { ContextMeter } from './ContextMeter'
import { DockGroup } from './DockGroup'
import { HostChip } from './HostChip'
import type { PanelPane } from '@shared/side-panel'
import { ActivityLine, type Activity } from './ActivityLine'
import { CompactionLine } from './CompactionLine'
import { COMPACTION_IDLE, endsCompaction, nextCompaction, type CompactionState } from '@shared/compaction-status'
import { attachDisabledInMode, chatOptionDisabled, forceSearchDisabled, modeSendField, modelSelectAction, switchFailureMessage, type ChatMode, type ModelCatalog, type ModelOption } from '@shared/composer-controls'
import { destructiveSlash, parseLocalSlash, resolveModel, resolveSkin, slashBoundary, slashBoundaryReply, slashCompletion, slashKey, slashMatches, slashQuery, type SlashCommand } from '@shared/slash-commands'
import { coerceTheme, THEME_LABEL, THEMES } from '@shared/theme'
import { jumpHasNew, jumpLabel, shouldStick, showJumpPill } from '@shared/jump-latest'
import { setTheme } from '../theme/apply-theme'
import { applyAtChoice, atKey, atMatches, atQuery, chipFromToken, chipsNote, fileQueryParts, referencesFromChips, slashWithReferences, MAX_REFERENCES, type AtCandidate, type ReferenceChip } from '@shared/at-references'
import type { FileEntry, FileListDTO } from '@shared/daemon-api'
import { screenAccessHint, screenshotFilename } from '@shared/capture'
import { clearStall, reportStall } from '../attention-store'
import { stallCause, stallMessage } from '@shared/stall-message'
import { deliversToSession, isAssistantActivity, nextTurnInFlight, watchdogAction } from '@shared/reply-watchdog'
import { emptyWatchdogLog, onArm, onFire, onStandDown, type StandDownReason } from '@shared/watchdog-log'
import { ArtifactChips } from './ArtifactChips'
import { useDeviceRole } from './OwnerOnlyNote'

/** Windowed tail (Slice 3): render only the most recent rows by default — long sessions stop
 * mounting thousands of markdown trees. "Show earlier" reveals the rest on demand. */
const RENDER_WINDOW = 120


/** Flat text of a message for the copy affordance (text parts only; tool cards are skipped). */
function flatText(content: string | ContentPart[]): string {
  if (typeof content === 'string') return content
  return content
    .filter((p) => p.type === 'text')
    .map((p) => p.text ?? '')
    .join('\n\n')
    .trim()
}

interface UiMessage {
  /** Stable React key: str(rowId) | clientMsgId (optimistic) | streaming handle | tool-<callId>. */
  key: string
  rowId: number | null
  ordinal: number | null
  role: string
  /** Flat text (user/streaming) OR structured parts (history via content_json, live tool frames). */
  content: string | ContentPart[]
  pending?: boolean
  /** Live tool rows only (Slice 4): receipt times of tool_call_start/end → timeline durations. */
  startTs?: number
  endTs?: number
  /** Epoch ms the daemon recorded for the row — the turn separator's clock. Absent on optimistic
   *  rows, which is why turnLabel degrades to the number alone rather than inventing a time. */
  createdAt?: number
  /**
   * WHO originated the turn (Prometheus P9.3), verbatim from the daemon: 'user' or a machinery
   * source (compactor, task_supervisor, …). Drives the provenance badge via @shared/provenance —
   * `role` is 'assistant' for both a reply to Will and an automated re-engagement, so it cannot
   * answer "did the operator write this?".
   */
  provenance?: string | null
  /** Whether the content is trusted; false renders a distinct visual state. undefined → trusted. */
  isTrusted?: boolean
  /** The turn was INTERRUPTED (P9.1): the daemon's chat_done carried interrupted:true, from a Stop
   *  pressed here or in any other client. Renders a distinct terminal state — an interrupted turn
   *  must not look identical to a finished one. */
  interrupted?: boolean
}



function fromHistory(h: HistoryMessage): UiMessage {
  // content_json (structured blocks) → ContentPart[]; null/legacy → flat-content fallback.
  return {
    key: h.id,
    rowId: h.rowId,
    ordinal: h.ordinal,
    role: h.role,
    content: partsFromContentJson(h.contentJson, h.content),
    pending: h.pending,
    createdAt: h.createdAt,
    provenance: h.provenance ?? null,
    isTrusted: h.isTrusted
  }
}

function applyFrame(prev: UiMessage[], f: ChatStreamFrame): UiMessage[] {
  switch (f.kind) {
    case 'message': {
      // The user echo carries the durable rowid + client_msg_id — re-key the optimistic row
      // deterministically (NO content matching) and don't double-render.
      const rowId = typeof f.messageId === 'number' ? f.messageId : null
      const key = rowId !== null ? String(rowId) : String(f.messageId)
      // Who wrote it, live (a worker's report is role user but not the operator's words).
      const origin = {
        ...(f.provenance !== undefined ? { provenance: f.provenance } : {}),
        ...(f.isTrusted !== undefined ? { isTrusted: f.isTrusted } : {})
      }
      if (f.clientMsgId) {
        const idx = prev.findIndex((m) => m.key === f.clientMsgId)
        if (idx >= 0) {
          const next = prev.slice()
          next[idx] = { key, rowId, ordinal: f.ordinal ?? null, role: f.role, content: f.content, pending: false, ...origin }
          return next
        }
      }
      const idx = prev.findIndex((m) => m.key === key)
      const msg: UiMessage = { key, rowId, ordinal: f.ordinal ?? null, role: f.role, content: f.content, ...origin }
      if (idx >= 0) {
        const next = prev.slice()
        next[idx] = msg
        return next
      }
      return [...prev, msg]
    }
    case 'delta': {
      const idx = prev.findIndex((m) => m.key === f.messageId)
      if (idx >= 0) {
        const next = prev.slice()
        const prevText = typeof next[idx].content === 'string' ? (next[idx].content as string) : ''
        next[idx] = { ...next[idx], content: prevText + f.content, pending: true }
        return next
      }
      return [...prev, { key: f.messageId, rowId: null, ordinal: null, role: 'assistant', content: f.content, pending: true }]
    }
    case 'done': {
      const idx = prev.findIndex((m) => m.key === f.messageId)
      if (idx < 0) return prev
      const next = prev.slice()
      // Re-key via the shared rule (P9.8) — the same one the smoke pins, so what ships is what is
      // tested. A present rowId re-keys the streamed bubble to str(rowId) (the key reconcile also
      // assigns, so they converge on one row); an absent one only clears pending and leaves the
      // synthetic key for reconcile to fill. NOTE: this does NOT make the cache reconcile in
      // service.ts skippable — the done frame carries the rowid but never the turn's TEXT, so the
      // reconcile is still the only path the assistant reply enters the cache. Only the renderer's
      // null-rowId window is closed here.
      // The interrupted flag (P9.1) rides along independently: a stopped turn still re-keys to its
      // durable rowid AND renders its distinct terminal state.
      const fin = finalizeRow({ key: next[idx].key, rowId: next[idx].rowId }, f.rowId)
      next[idx] = {
        ...next[idx],
        key: fin.key,
        rowId: fin.rowId,
        pending: false,
        ...(f.interrupted ? { interrupted: true } : {})
      }
      return next
    }
    case 'tool_start':
      // Live tool activity → a toolCall part (same model as history) + receipt time (Slice 4:
      // drives the timeline's durations and parallel-batch detection).
      return [
        ...prev,
        {
          key: `tool-${f.callId}`,
          rowId: null,
          ordinal: null,
          role: 'tool',
          content: [{ type: 'toolCall', id: f.callId, name: f.toolName, args: f.inputs }],
          startTs: Date.now()
        }
      ]
    case 'tool_end': {
      const idx = prev.findIndex((m) => m.key === `tool-${f.callId}`)
      if (idx < 0) return prev
      const next = prev.slice()
      const parts: ContentPart[] = Array.isArray(next[idx].content) ? [...(next[idx].content as ContentPart[])] : []
      parts.push({ type: 'toolResult', toolUseId: f.callId, output: f.result, error: f.success === false || !!f.error })
      next[idx] = { ...next[idx], content: parts, endTs: Date.now() }
      return next
    }
    case 'error': {
      // Render the daemon's failure IN THE THREAD. Previously error frames went
      // only to the Activity panel, so a turn that died (e.g. an out-of-credits
      // provider) looked like silence here and got misreported as a timeout.
      // `hint` is the actionable half — always show it when present.
      const detail = [f.message, f.hint].filter(Boolean).join(' — ')
      return [
        ...prev,
        {
          key: `err-${crypto.randomUUID()}`,
          rowId: null,
          ordinal: null,
          role: 'system',
          content: detail || 'the turn failed'
        }
      ]
    }
    default:
      return prev
  }
}

export function ChatShell({
  sessionId,
  initialMessage,
  initialFiles,
  initialModelKey,
  onInitialSent,
  mode = 'agent',
  onModeChange,
  daemonLastSeen,
  voiceState = 'idle',
  voiceNotice = '',
  handsFreePhase = 'off',
  onHandsFreeToggle,
  dictateState = 'idle',
  onDictateToggle,
  dictated = null,
  onDictationConsumed,
  insert = null,
  onInsertConsumed,
  jumpTo,
  sessionTitle,
  onForked,
  dockPane = null,
  onToggleDock,
  pinned,
  onTogglePin,
  onRenameSession,
  onDeleteSession,
  onPopOut,
  onPopIn,
  onClosePane
}: {
  sessionId: string
  /** Split panes: close this pane (the conversation is not affected). Absent when it is the only one. */
  onClosePane?: () => void
  /** Main window: move this conversation into its own window (@shared/session-windows). */
  onPopOut?: () => void
  /** Session window: move this conversation back into the main window. */
  onPopIn?: () => void
  /** R3: the pane the dock is SHOWING beside this thread (null = closed). Owned by MainView. */
  dockPane?: PanelPane | null
  /** Toggle a dock pane — the thread header's dock group and the composer's Browser/Terminal. */
  onToggleDock?: (p: PanelPane) => void
  /** Session actions for the overflow menu. Only what this build can actually do is passed —
   *  the menu's own note says which of the spec's rows are absent and why. */
  pinned?: boolean
  onTogglePin?: () => void
  onRenameSession?: (title: string) => void
  onDeleteSession?: () => void
  /** First message to send into a freshly-minted session (submit-from-Home). Sent once, on mount. */
  initialMessage?: string
  /** Files staged on the HOME screen before the session existed — they ride the first turn.
   *  Without this, choosing an attachment on home would silently drop it at session creation. */
  initialFiles?: PendingFile[]
  /** A model picked on HOME. Applied to this session BEFORE the first turn is dispatched, so the
   *  first reply comes from the model that was chosen rather than the default. */
  initialModelKey?: string | null
  /** Fired right after the initial message is dispatched, so the parent can clear its pending state. */
  onInitialSent?: () => void
  /** Per-session Agent|Chat mode — held by the parent so it survives this component's remount. */
  mode?: ChatMode
  onModeChange?: (m: ChatMode) => void
  /**
   * Voice turn state, owned by MainView (a turn targets voice:beacon regardless of the
   * session shown here, and the switch remounts this component — so the state must outlive it).
   */
  voiceState?: 'idle' | 'recording' | 'processing'
  /** DICTATION (B6) — transcribe into THIS draft. Owned by MainView so a
   * session switch (which remounts this component) cannot drop one mid-flight.
   * Absent → no dictation button: OAra Voice is not configured (@shared/voice-gate). */
  dictateState?: 'idle' | 'recording' | 'processing'
  onDictateToggle?: () => void
  /** A transcript to append. `n` increments per delivery so dictating the same
   * words twice appends twice — value equality would swallow the second. */
  dictated?: { text: string; n: number } | null
  onDictationConsumed?: () => void
  /** Browser pane → composer (Phase 2). A page block the USER chose to bring here; they send it,
   * or edit it, or delete it. One-directional: nothing flows back to the pane. */
  insert?: ComposerInsert | null
  onInsertConsumed?: () => void
  /** One visible notice per bridge outcome — '' = nothing. Never silently discarded. */
  voiceNotice?: string
  /** Hands-free mode (item 8): VAD-driven turns with barge-in — owned by MainView like voiceState. */
  handsFreePhase?: 'off' | 'listening' | 'capturing' | 'processing' | 'speaking'
  onHandsFreeToggle?: () => void
  /**
   * Epoch ms of the last frame from ANY session, owned by MainView. This component
   * cannot observe it — the session filter below is deliberately blind to other
   * sessions — so the fact is supplied rather than inferred. Absent (older call
   * site) → the quiet timer stays silent about the daemon entirely.
   */
  daemonLastSeen?: () => number
  /**
   * A search hit to land on: the durable rowid as a string, plus a nonce so that jumping to the
   * SAME message twice still re-fires (the second click of a row must move the view, not no-op).
   * Owned by MainView because the session switch remounts this component — the target has to
   * outlive the mount it was chosen in.
   */
  jumpTo?: { messageId: string; nonce: number } | null
  /** Human title for the export header — MainView owns the rename map, this component does not. */
  sessionTitle?: string
  /**
   * A branch was created (B4): open it and send the edited text into it. MainView owns session
   * selection, and it already has the machinery — this is the same open+stage pair
   * `beginFromHome` uses, with an id the DAEMON minted instead of one the client did.
   */
  onForked?: (sessionId: string, text: string) => void
}) {
  const [status, setStatus] = useState<ConnectionStatus>({ state: 'idle', gateway: null })
  /**
   * Read replies aloud.
   *
   * Spoken by the PLATFORM (Web Speech, the system voices), not by the daemon. The voice bridge
   * is speech-in/speech-out — you hand it audio and it hands audio back — so there is no route
   * that takes a written reply and returns sound, which is why this button sat disabled. The
   * synthesiser in the renderer has been there the whole time and needs no daemon at all.
   */
  const [readAloud, setReadAloud] = useState(false)
  const spokenKeyRef = useRef<string | null>(null)
  const speechOk = typeof window !== 'undefined' && 'speechSynthesis' in window
  // Screen-reader announcements of finished replies (@shared/live-announce). ALWAYS present — unlike
  // read-aloud, which is an opt-in synthesiser, this just keeps a hidden aria-live region current so
  // a screen reader the user runs themselves hears each settled reply once. `announcedRef` is the
  // watermark (what was last published); `announce` is the text now in the live region. The seq in
  // the key forces a DOM mutation even when two consecutive replies have identical text — a live
  // region that doesn't change doesn't re-announce.
  const announcedRef = useRef<string | null>(null)
  /** Has the backlog been marked as already-heard yet? Separate from the watermark because arming is
   *  a different act from announcing — see the effect below. Reset per mount (a session switch
   *  remounts ChatShell), so landing on a session never recites it. */
  const announceArmedRef = useRef(false)
  const [announce, setAnnounce] = useState<{ text: string; seq: number }>({ text: '', seq: 0 })
  /** history.fetch has settled (loaded OR failed) for this mount. Arming waits on THIS, not on the
   *  first render with rows: a stream frame can render a row before history lands. */
  const [historyLoaded, setHistoryLoaded] = useState(false)
  const [messages, setMessages] = useState<UiMessage[]>([])
  /**
   * The composer's text, seeded from the in-memory draft so a session switch brings it back.
   *
   * A LAZY INITIALISER, not an effect that fills the field in afterwards: ChatShell is remounted
   * per session (`key={active}` in MainView — deliberately, it is what keeps a Stop button from
   * interrupting the wrong session), so anything in here dies with the mount and the draft was the
   * one thing nobody had lifted out of it. `mode`, `voiceState`, `dictateState` and `jumpTo` all
   * live above for exactly that reason; @shared/drafts is the same lift for this one, and seeding at
   * construction means the first paint already shows the text rather than flashing an empty box and
   * then filling it.
   *
   * recallDraft reads the module-level map, which is synchronous — no round trip, no race. The
   * durable store is only consulted when memory has nothing (a relaunch), in the effect below.
   */
  const [draft, setDraft] = useState(() => recallDraft(sessionId) ?? '')
  /**
   * Whether this mount has typed something, as opposed to merely being seeded with it.
   *
   * The durable restore below is async, so a person who switches to a session and starts typing
   * before it lands would have their typing overwritten by the older text — the restore would look
   * like it worked and quietly eat what they wrote. Once anything has been typed here, the restore
   * stands down. The memory path needs no such guard because it is synchronous.
   */
  const draftTouchedRef = useRef(false)
  /**
   * The draft value this mount last saw written through — seeded, so the mount's own first effect
   * run is a no-op rather than a write.
   *
   * WHY A VALUE AND NOT A "FIRST RUN" BOOLEAN. A boolean flag flips on the mount's first effect run,
   * and `main.tsx` wraps the tree in StrictMode, which runs every effect, cleans it up, and runs it
   * again. The second run sees the flag already spent, concludes the seed was typed, and writes it —
   * clearing the durable draft the restore had not yet read. Production builds do not double-invoke
   * effects, so that would have shipped green and lost every draft under `npm run dev`: the one place
   * someone would go to check that the feature works.
   *
   * A value comparison is idempotent under both, and it is the honest question anyway — "is this
   * different from what the store already has" is what decides whether a write is owed. Note it is
   * NOT a comparison against the seed: sending sets the draft to `''`, which on a fresh session
   * EQUALS the seed, and skipping that write would leave the sent text on disk to resurrect at the
   * next launch.
   */
  const draftKnownRef = useRef(draft)

  // A delivered dictation appends to the draft and is then consumed. Keyed on
  // `dictated.n`: two identical transcripts are two insertions, and re-renders
  // in between must not re-append the same one.
  const lastDictationRef = useRef(0)

  /**
   * Persist the draft: memory synchronously, the durable store debounced.
   *
   * One effect rather than a wrapper around every `setDraft` call. There are eight of them — send,
   * the slash-boundary bail, edit-last, a dictation append, a browser-pane insert, a failed-send
   * put-back, slash and @ completion — and routing them all through one helper would still leave
   * the ninth, written by whoever adds the next feature, silently not persisted. Watching the value
   * means every path is covered including the functional updates, and a new one cannot opt out.
   *
   * Runs that change nothing write nothing, which is what makes it safe to run twice (StrictMode)
   * and safe to run on mount at all: seeding is not typing, and echoing the seed back would clear a
   * durable draft the restore below had not yet read.
   */
  useEffect(() => {
    if (draft === draftKnownRef.current) return
    draftKnownRef.current = draft
    rememberDraft(sessionId, draft)
    draftTouchedRef.current = true
    const b = window.beacon
    if (!b) return
    const id = setTimeout(() => {
      // `null` = a forgotten session: main already deleted this row and writing it back would undo
      // the forget (see @shared/drafts). A rejection is swallowed: this is a cache write, and there
      // is no sentence worth putting in the thread about it. The memory copy is already correct, so
      // a failed write costs durability across a relaunch and nothing else — which is not worth an
      // error the user cannot act on.
      const value = draftStoreValue(sessionId, draft)
      if (value === null) return
      void b.settings.set(draftKey(sessionId), value).catch(() => undefined)
    }, DRAFT_WRITE_DEBOUNCE_MS)
    return () => clearTimeout(id)
  }, [draft, sessionId])

  /**
   * Flush the durable copy when this mount goes away, without waiting out the debounce.
   *
   * Mount-scoped, keyed on `sessionId` only, and reading the latest draft through a ref — putting
   * the flush in the effect above instead would run it on every keystroke (each change cleans up
   * the previous run), which is the exact write the debounce exists to prevent.
   *
   * BEST EFFORT, and it is worth being precise about that: on a session switch the in-memory copy
   * is what actually brings the draft back, so this write is what keeps the durable store current
   * for a session you do not revisit. On app close it races teardown — an invoke sent during window
   * destruction may never complete. The debounce is the guarantee; this narrows the window it can
   * lose rather than closing it.
   *
   * ONLY IF SOMETHING WAS TYPED HERE. Writing back a value this mount merely SEEDED is not a flush,
   * it is an echo — and under StrictMode's dev double-mount the first cleanup fires before the
   * restore's async read resolves, so an unguarded echo would write `''` over the durable draft it
   * was about to read. Production builds do not double-invoke effects, so this would have shipped
   * looking fine and lost every draft in `npm run dev`, which is exactly where someone would go to
   * check that the feature works.
   */
  useEffect(() => {
    return () => {
      if (!draftTouchedRef.current) return
      const b = window.beacon
      if (!b) return
      const value = draftStoreValue(sessionId, draftKnownRef.current)
      if (value === null) return // forgotten — the flush would resurrect the row main deleted
      void b.settings.set(draftKey(sessionId), value).catch(() => undefined)
    }
  }, [sessionId])

  /**
   * Restore the durable draft after a RELAUNCH — the only case the in-memory map cannot cover.
   *
   * Stands down when memory already has a value for this session (the common in-app switch: no read
   * at all, so no round trip and no race) and when anything has been typed into this mount before
   * the read landed. That second guard is the load-bearing one: without it a person who switches to
   * a session and starts typing immediately gets their new text replaced by the older draft a
   * quarter-second later, and the feature reads as though it deleted what they wrote.
   */
  useEffect(() => {
    if (recallDraft(sessionId) !== undefined) return
    const b = window.beacon
    if (!b) return
    let alive = true
    void b.settings
      .get(draftKey(sessionId))
      .then((raw) => {
        const text = restorableDraft(raw)
        if (!alive || text.length === 0 || draftTouchedRef.current) return
        rememberDraft(sessionId, text)
        // Adopt the value as already-known BEFORE the state update, so the persist effect above
        // sees no change and writes nothing. Restoring is not typing: without this the mount would
        // write back the very row it just read and mark itself touched, which then suppresses a
        // later legitimate restore's guard.
        draftKnownRef.current = text
        setDraft(text)
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [sessionId])

  useEffect(() => {
    if (!dictated || dictated.n === lastDictationRef.current) return
    lastDictationRef.current = dictated.n
    setDraft((d) => appendDictation(d, dictated.text))
    onDictationConsumed?.()
  }, [dictated, onDictationConsumed])
  const lastInsertRef = useRef(0)
  useEffect(() => {
    if (!insert || insert.n === lastInsertRef.current) return
    lastInsertRef.current = insert.n
    setDraft((d) => appendComposerInsert(d, insert.text))
    onInsertConsumed?.()
    setTimeout(() => draftRef.current?.focus(), 0)
  }, [insert, onInsertConsumed])
  // Slash-command autocomplete (X3): popup state is derived from the draft (pure query predicate)
  // plus two interaction bits — the highlighted row and a dismissed flag (Escape closes the
  // popup without eating the typed text; it re-arms as soon as the draft changes).
  const [slashHighlight, setSlashHighlight] = useState(0)
  const [slashDismissed, setSlashDismissed] = useState(false)
  // @-references (Prometheus PR 382, the Beacon half): chips the daemon resolves against the
  // session workspace. The popup opens on an `@token` under the caret; file candidates come from
  // GET /api/files for the token's directory (Beacon is remote — it can only NAME files the daemon
  // lists); `@diff`, `@diff:<ref>` and URLs are literal. Choosing a file/diff/url removes the token
  // and adds a chip; choosing a folder descends.
  const [atChips, setAtChips] = useState<ReferenceChip[]>([])
  const [atHighlight, setAtHighlight] = useState(0)
  const [atDismissed, setAtDismissed] = useState(false)
  const [atCaret, setAtCaret] = useState(0)
  const [atEntries, setAtEntries] = useState<{ dir: string; entries: FileEntry[] }>({ dir: '', entries: [] })
  const [agentInfo, setAgentInfo] = useState<{ model?: string; provider?: string } | null>(null)
  // Model switcher (Composer-controls): the session's effective model + the catalog from the live
  // model REST. ONE state for BOTH the top-bar and composer switchers; server-backed, re-fetched
  // per mount (so it reflects this session). Falls back to the /api/status model on a fetch failure.
  const [modelCatalog, setModelCatalog] = useState<ModelOption[]>([])
  const [modelDefaultKey, setModelDefaultKey] = useState<string>('local')
  const [currentModelKey, setCurrentModelKey] = useState<string | null>(null)
  const [modelError, setModelError] = useState(false)
  /** Per-session agent profile (item 6). `source` distinguishes pinned from inherited. */
  const [profileState, setProfileState] = useState<SessionProfile>(UNKNOWN_PROFILE)
  /** The daemon's profiles WITH their descriptions — the autonomy menu shows the operator's own
   *  words for what each grants rather than a ladder invented in the renderer. */
  const [profileNames, setProfileNames] = useState<{ name: string; description?: string }[]>([])
  // An approved device (not the owner) can't read the model catalog, the session's model or its profile (Prometheus refuses them), so
  // it is shown neither chip: a read-only "Local · offline" and a "profile" chip said things that were not true (the 0.4.5 sweep).
  const deviceRole = useDeviceRole()
  const limited = deviceRole === 'limited'
  // Main has not said yet whether this is the owner (the page's first moments): those reads wait.
  const roleHeard = deviceRole !== undefined
  const [sending, setSending] = useState(false)
  // Force-search one-shot arm (per NEXT message, never sticky — consumed by the send attempt).
  const [pendingFiles, setPendingFiles] = useState<PendingFile[]>([])
  /** rowId of the message a search jump landed on — drives the transient highlight. */
  const [highlightRow, setHighlightRow] = useState<number | null>(null)
  /** The rowId still being chased. Cleared once landed, or once declared unreachable. */
  const [pendingJump, setPendingJump] = useState<number | null>(null)
  /** One backfill per jump: a second would loop, since a genuinely absent row stays absent. */
  const backfilledRef = useRef(false)
  /** Said out loud when a jump cannot land: a scroll that silently does nothing and a broken
   * search look identical from the chair — the same silence-is-ambiguous class as the verifier
   * fix in Prometheus 277. */
  const [jumpMiss, setJumpMiss] = useState(false)
  /** Editing a past message into a branch (B4). Holds the row key being edited and its draft. */
  const [editKey, setEditKey] = useState<string | null>(null)
  const [editDraft, setEditDraft] = useState('')
  const [forking, setForking] = useState(false)
  const [forkNotice, setForkNotice] = useState('')
  // A failed model switch, in words: the daemon probes a backend BEFORE switching (Prometheus
  // PR 390) and a down box is a 503 whose body names why. '' = nothing to say.
  const [modelNotice, setModelNotice] = useState('')
  const [forkOrigin, setForkOrigin] = useState<ForkOrigin | null>(null)
  /** Export popover + its one-line outcome. Never silent: a write to disk the user cannot see
   * needs to say where it went. */
  const [exportOpen, setExportOpen] = useState(false)
  /** Rename draft, or null when not renaming. A separate row rather than an inline edit on the
   *  title: the title is 21px display type and editing in place fights the header's layout. */
  const [renaming, setRenaming] = useState<string | null>(null)
  /** Delete asks first. It is the only irreversible row in the menu. */
  const [confirmDelete, setConfirmDelete] = useState(false)
  /** A destructive slash command (`/reset`, `/clear`) asks first too — it wipes the session's
   *  context, which is not recoverable from this client. Holds the command name pending confirm. */
  const [confirmSlash, setConfirmSlash] = useState<string | null>(null)
  const [exportNote, setExportNote] = useState('')
  /** Live turn readout, fed by `agent_progress`. Null when no turn is running. */
  const [activity, setActivity] = useState<Activity | null>(null)
  /** The inline "Tidying up the conversation…" line (issue 283), fed by this session's compaction frames. */
  const [compaction, setCompaction] = useState<CompactionState>(COMPACTION_IDLE)
  const [dragging, setDragging] = useState(false)
  const [showAll, setShowAll] = useState(false)
  const [detached, setDetached] = useState(false)
  /** How many rows were rendered when the user left the bottom; null while attached. */
  const detachBaseline = useRef<number | null>(null)
  /** Read inside onScroll, which is not a render — a ref, not the state it mirrors. */
  const renderedCount = useRef(0)
  const [copiedKey, setCopiedKey] = useState<string | null>(null)
  const listEndRef = useRef<HTMLDivElement>(null)
  /**
   * Scroll the MESSAGE LIST, never `scrollIntoView`.
   *
   * `scrollIntoView` walks up and scrolls every scrollable ancestor it needs to — and
   * `overflow: hidden` does NOT stop a PROGRAMMATIC scroll, it only hides the scrollbar and
   * blocks the user. So sticking to the bottom of a long thread quietly scrolled `.view-area`
   * by 692px, lifting the entire shell off the top of the window: rail, header and composer all
   * shifted up with a band of empty background below. Setting scrollTop on the one container
   * that is meant to scroll cannot move anything else.
   */
  const stickToBottom = (): void => {
    const el = scrollerRef.current
    if (el) el.scrollTop = el.scrollHeight
  }
  const scrollerRef = useRef<HTMLElement>(null)
  const stickRef = useRef(true) // auto-scroll only while the user is parked at the bottom
  const replyWatchdog = useRef<ReturnType<typeof setTimeout> | null>(null) // armed per clean send; assistant activity stands it down
  /** Is a real agent turn streaming? Only turns emit delta/progress/tool_* — a command
   *  reply is chat_message frames only — so this is what lets a command_done decline to
   *  stand down a watchdog that is currently guarding a live turn. */
  const turnInFlight = useRef(false)
  /** Re-rendering MIRROR of turnInFlight (P9.1). A ref does not repaint, and the Stop button must
   *  appear the moment a turn goes live and vanish on its terminal frame. Updated in lockstep with
   *  the ref in the frame handler; reset on session switch — turnInFlight is per-mount but the
   *  frames it saw belonged to the PREVIOUS session, so a button armed there must not show here. */
  const [turnLive, setTurnLive] = useState(false)
  /** Coalescing state for the durable decision record. Re-arms are COUNTED here,
   *  never written — a pulsing turn re-arms every 3s and writing those would turn
   *  a diagnostic table into a disk-fill. */
  const wdLog = useRef(emptyWatchdogLog())
  /** Emit a watchdog record. Fire-and-forget; never allowed to disturb the watchdog. */
  const logWatchdog = (step: { state: ReturnType<typeof emptyWatchdogLog>; event: unknown }): void => {
    wdLog.current = step.state
    if (step.event) {
      try {
        window.beacon?.watchdog(step.event as Parameters<NonNullable<typeof window.beacon>['watchdog']>[0])
      } catch {
        /* diagnostics must never break the thing they observe */
      }
    }
  }
  /**
   * Epoch ms when the socket last LEFT 'connected' — i.e. Beacon's own liveness
   * watchdog terminated it and the backoff reconnect began (see ws.ts:171).
   *
   * The reply watchdog cannot tell "the turn died" from "we stopped listening",
   * but Beacon knows which of the two happened to its own socket, so the message
   * should not guess. Field evidence: 42 disconnect/reconnect cycles in one day
   * with gaps of 1.3–4s, zero emit failures daemon-side — every one of those
   * would have read as "the turn may have died" for what was a ~2s reconnect.
   */
  const socketDroppedAt = useRef<number | null>(null)
  // Outbox manifest (artifact download chips). Refreshed on mount + shortly after tool_end frames
  // (a tool may have just published a deliverable). Older daemon → empty list → chips never render.
  const [artifacts, setArtifacts] = useState<ArtifactEntry[]>([])
  const artifactsTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const refreshArtifacts = (delayMs: number): void => {
    if (artifactsTimer.current !== null) clearTimeout(artifactsTimer.current)
    artifactsTimer.current = setTimeout(() => {
      artifactsTimer.current = null
      void window.beacon?.artifacts
        .list()
        .then(setArtifacts)
        .catch(() => setArtifacts([]))
    }, delayMs)
  }
  const fileInputRef = useRef<HTMLInputElement>(null)
  const draftRef = useRef<HTMLTextAreaElement>(null)
  const initialSentRef = useRef(false) // submit-from-Home: guard the one-shot initial send per mount

  // Model/provider chip (Slice 6): GET /api/status on mount + whenever the link comes (back) up —
  // always-visible answer to "which brain am I talking to". Display-only; switching is daemon work.
  useEffect(() => {
    const b = window.beacon
    if (!b) return
    let alive = true
    const load = (): void => {
      void b.daemon
        .get('/api/status')
        .then((d) => {
          if (!alive || !d || typeof d !== 'object') return
          const s = d as { model?: string; provider?: string }
          setAgentInfo({ model: s.model, provider: s.provider })
        })
        .catch(() => undefined)
    }
    load()
    const off = b.connection.onStatus((s) => {
      if (s.state === 'connected') load()
    })
    return () => {
      alive = false
      off()
    }
  }, [])


  // Model switcher (Composer-controls): fetch the catalog + this session's effective model on mount
  // and on reconnect. On failure, modelError → read-only fallback (never a broken dropdown).
  useEffect(() => {
    const b = window.beacon
    if (!b || limited || !roleHeard) return
    let alive = true
    const load = async (): Promise<void> => {
      try {
        const cat = (await b.daemon.get('/api/models')) as ModelCatalog | null
        const cur = (await b.daemon.get(`/api/sessions/${encodeURIComponent(sessionId)}/model`)) as ModelOption | null
        if (!alive) return
        if (cat && Array.isArray(cat.models)) {
          setModelCatalog(cat.models)
          setModelDefaultKey(cat.default_key ?? 'local')
          setModelError(false)
        } else {
          setModelError(true)
        }
        if (cur && typeof cur.key === 'string') setCurrentModelKey(cur.key)
      } catch {
        if (alive) setModelError(true)
      }
    }
    void load()
    const offModel = b.connection.onStatus((s) => {
      if (s.state === 'connected') void load()
    })
    return () => {
      alive = false
      offModel()
    }
  }, [sessionId, limited, roleHeard])

  /** Switch the session's model: a preset key SETS the override (POST {key}); the default/local key
   *  CLEARS it (DELETE). Both endpoints return the new effective option, which we reflect. */
  // The session's profile and the catalog of names. Two calls because they answer different
  // questions: what THIS chat runs under, and what it could run under.
  useEffect(() => {
    const b = window.beacon
    if (!b || limited || !roleHeard) return
    let alive = true
    void b.daemon
      .get(`/api/sessions/${encodeURIComponent(sessionId)}/profile`)
      .then((d) => alive && setProfileState(parseSessionProfile(d)))
      .catch(() => undefined) // older daemon → the control renders read-only
    void b.daemon
      .get('/api/profiles')
      .then((d) => {
        if (!alive) return
        const rows = Array.isArray(d) ? d : []
        setProfileNames(
          rows
            .map((p) => p as { name?: string; description?: string })
            .filter((p): p is { name: string; description?: string } => !!p.name)
            .map((p) => ({ name: p.name, description: p.description }))
        )
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [sessionId, limited, roleHeard])

  // Where this conversation came from, if anywhere. A branch that does not say it is a branch
  // is just a conversation that mysteriously starts mid-thought.
  useEffect(() => {
    const b = window.beacon
    if (!b) return
    let alive = true
    void b.daemon
      .get(`/api/sessions/${encodeURIComponent(sessionId)}/fork`)
      .then((d) => alive && setForkOrigin(parseForkOrigin(d)))
      .catch(() => undefined) // older daemon → no banner, everything else works
    return () => {
      alive = false
    }
  }, [sessionId])

  /**
   * Edit a past message into a branch: fork the conversation at the point BEFORE it, then send
   * the edited text into the session that comes back. The daemon never learns an edit happened —
   * it only ever sees "copy up to here" and then a new message.
   */
  async function saveEdit(key: string): Promise<void> {
    const text = editDraft.trim()
    const at = forkPointBefore(rendered, key)
    if (!text || at === null) return
    setForking(true)
    setForkNotice('')
    try {
      const res = await window.beacon?.daemon.write(
        `/api/sessions/${encodeURIComponent(sessionId)}/fork`,
        forkBody(at),
        'POST'
      )
      const fork = parseForkResult(res)
      if (!fork) {
        setForkNotice('Could not branch: the daemon returned no session.')
        return
      }
      setEditKey(null)
      setEditDraft('')
      // MainView opens it and sends the edited text — the same staging the landing page uses.
      onForked?.(fork.sessionId, text)
    } catch (e) {
      setForkNotice(`Could not branch: ${(e as Error)?.message ?? e}`)
    } finally {
      setForking(false)
    }
  }

  const onSelectProfile = async (choice: string): Promise<void> => {
    const b = window.beacon
    if (!b) return
    try {
      await b.daemon.write(
        `/api/sessions/${encodeURIComponent(sessionId)}/profile`,
        profileSelectBody(choice),
        'PUT'
      )
      // Re-read rather than assume: the daemon decides `source` and `effective`, and a client
      // that painted its own guess would disagree with the next turn.
      const fresh = await b.daemon.get(`/api/sessions/${encodeURIComponent(sessionId)}/profile`)
      setProfileState(parseSessionProfile(fresh))
    } catch {
      // leave the control showing the last known truth; the next mount reconciles
    }
  }

  const onSelectModel = async (key: string): Promise<void> => {
    const b = window.beacon
    if (!b) return
    const action = modelSelectAction(key, modelDefaultKey)
    try {
      const resp = (await b.daemon.write(
        `/api/sessions/${encodeURIComponent(sessionId)}/model`,
        action.body,
        action.method
      )) as ModelOption | null
      setCurrentModelKey(resp && typeof resp.key === 'string' ? resp.key : key)
      setModelError(false)
      setModelNotice('')
    } catch (e) {
      // The switcher keeps showing the last known truth (nothing switched — the daemon refused
      // before touching the session), and the reason is said once, in words.
      setModelNotice(switchFailureMessage(e, key))
    }
  }

  useEffect(() => {
    const b = window.beacon
    if (!b) return
    // Reset turn state on session switch (P9.1): turnInFlight/the Stop mirror describe the session
    // that was on screen, not this one. Without this, switching INTO a quiet session while another
    // one streams would show a Stop button that interrupts the WRONG session.
    turnInFlight.current = false
    setTurnLive(false)
    b.connection.status().then(setStatus).catch(() => undefined)
    // Read-through: paint cached history immediately; main reconciles by the rowid cursor.
    // coalesceToolResults: history stores an assistant tool_use and its user tool_result as SEPARATE
    // rows, but per-message pairing only matches within one row — fold the result back onto its call
    // (the live stream already arrives coalesced) so reloaded tool cards aren't stuck "running".
    b.history
      .fetch(sessionId)
      .then((rows) => {
        setMessages(coalesceToolResults(rows.map(fromHistory)))
        setHistoryLoaded(true)
        // Submit-from-Home: send the landing's first message INTO this freshly-minted session — once,
        // and only AFTER history paints + the stream subscription below is live, so assistant deltas
        // aren't missed and the empty-history paint can't clobber the optimistic row.
        if (initialMessage && !initialSentRef.current) {
          initialSentRef.current = true
          // Everything the home screen chose is applied to THIS turn: the model before the
          // dispatch (or the first reply comes from the default, not the one that was picked),
          // then the staged attachments, which ride the first message exactly as they would a
          // later one.
          void (async () => {
            if (initialModelKey) await onSelectModel(initialModelKey).catch(() => undefined)
            if (initialFiles && initialFiles.length > 0) {
              await uploadFiles(initialFiles, initialMessage, crypto.randomUUID()).catch((err) =>
                setMessages((prev) => [
                  ...prev,
                  { key: `err-${crypto.randomUUID()}`, rowId: null, ordinal: null, role: 'system', content: `upload failed: ${String(err)}` }
                ])
              )
            } else {
              await dispatchText(initialMessage)
            }
            onInitialSent?.()
          })()
        }
      })
      // A failed fetch has no backlog on screen to recite, and must not leave announcements disarmed.
      .catch(() => setHistoryLoaded(true))
    const offStatus = b.connection.onStatus((s) => {
      // Record the moment the socket stops being 'connected'. armReplyWatchdog
      // reads this to say which of the two things actually happened.
      if (s.state !== 'connected') socketDroppedAt.current = Date.now()
      setStatus(s)
    })
    const offStream = b.chat.onStream((f) => {
      // Render only THIS session's deltas (filter by payload.session_id); others bump unread in App.
      // ARTIFACTS ARE GLOBAL, so this runs BEFORE the session filter. `listArtifacts()`
      // hits GET /api/artifacts with no session parameter — the outbox manifest is
      // app-wide — so a tool that saved a deliverable in ANOTHER session used to be
      // filtered out below and the chips went stale until something finished a tool
      // in THIS one. Same coupling as the watchdog was, found only because someone
      // went looking: a stale chip list never complains.
      //
      // Unlike liveness this stays in ChatShell rather than moving to MainView: the
      // chips ARE a chat-view surface, only one ChatShell is mounted at a time, and
      // with no chat view there is nothing to refresh.
      if (f.kind === 'tool_end') refreshArtifacts(1_500)

      // Everything below is about THIS conversation. Render only this session's
      // frames; others bump unread in MainView, which sees them unfiltered.
      if (!deliversToSession(f, sessionId)) return

      // Live activity readout. `progress` pulses ~every 3s for the whole turn and
      // carries what it's actually doing; tick advances per pulse so the UI's
      // motion is EVENT-driven (movement = liveness, never a decorative loop).
      if (f.kind === 'progress') {
        setActivity((prev) => ({
          phase: f.phase,
          toolName: f.toolName,
          round: f.round,
          chars: f.chars,
          toolCalls: f.toolCalls,
          elapsedS: f.elapsedS,
          at: Date.now(),
          tick: (prev?.tick ?? 0) + 1
        }))
      }
      if (f.kind === 'done' || f.kind === 'error') setActivity(null)
      // Compaction (issue 283). Every frame goes through: the rules also clear a running line when the
      // model call starts or the turn ends, and they refuse a compaction frame that does not name
      // this session, which deliversToSession above would have let through.
      setCompaction((prev) => nextCompaction(prev, f, sessionId))
      // A pulse that said "compacting" is stale once the pass has ended; show nothing until the next one.
      if (endsCompaction(f, sessionId)) setActivity((prev) => (prev?.phase === 'compacting' ? null : prev))

      // The watchdog rule lives in shared/reply-watchdog — pure, and pinned by
      // reply-watchdog-smoke, so what ships is what is tested. Assistant activity
      // RE-ARMS rather than merely clearing (silence measured from the last sign of
      // life, not from the send); only a terminal frame stands it down.
      //
      // command_done is NOT assistant activity, so it never reaches clearStall here
      // and never reaches setActivity above — a /steer terminator arriving mid-turn
      // cannot disturb a running turn's readout. It stands the timer down only when
      // the timer is the one its own exchange armed.
      // Decide against the state BEFORE this frame, then advance it.
      const action = watchdogAction(f, turnInFlight.current)
      turnInFlight.current = nextTurnInFlight(f, turnInFlight.current)
      setTurnLive(turnInFlight.current) // the Stop button's truth (P9.1) — mirrors the ref
      if (isAssistantActivity(f)) clearStall(sessionId) // the agent spoke — drop it from the attention queue
      if (action === 'stand-down') {
        if (replyWatchdog.current !== null) {
          clearTimeout(replyWatchdog.current)
          replyWatchdog.current = null
        }
        const reason: StandDownReason = f.kind === 'command_done' ? 'command_done' : 'done'
        logWatchdog(onStandDown(wdLog.current, Date.now(), sessionId, reason))
      } else if (action === 'rearm') {
        armReplyWatchdog()
      }
      setMessages((prev) => applyFrame(prev, f))
    })
    refreshArtifacts(0)
    return () => {
      offStatus()
      offStream()
      if (replyWatchdog.current !== null) {
        // UNMOUNT IS A FINDING, not housekeeping: the watchdog is per-ChatShell, so
        // switching away from a stalled session cancels it and the stall is never
        // reported for that session. Recording it does not fix it; it makes it visible.
        logWatchdog(onStandDown(wdLog.current, Date.now(), sessionId, 'unmount'))
        clearTimeout(replyWatchdog.current)
        replyWatchdog.current = null
      }
      if (artifactsTimer.current !== null) {
        clearTimeout(artifactsTimer.current)
        artifactsTimer.current = null
      }
    }
  }, [sessionId])

  // Stick-to-bottom (Slice 3): instant (non-smooth) scroll on new content, but ONLY while the
  // user is at the bottom — scrolling up to read pins the viewport and shows the jump chip instead.
  // ── Land on a search hit (global search, ⌘⇧F) ─────────────────────────────────────────────
  // Split in two on purpose. Arming records WHAT to land on; the effect below does the landing and
  // re-runs on every commit that could move the row. A single-shot scroll was measured landing the
  // row and then losing it: `showAll` mounts every earlier message ABOVE the target, so the layout
  // the scroll was computed against stops existing one commit later.
  useEffect(() => {
    if (!jumpTo) return
    const target = Number(jumpTo.messageId)
    if (!Number.isFinite(target)) return
    setJumpMiss(false)
    setHighlightRow(null)
    setShowAll(true) // a hit is usually old; the windowed tail would otherwise not contain it
    setPendingJump(target)
    backfilledRef.current = false
  }, [jumpTo])

  useEffect(() => {
    if (pendingJump === null) return
    let cancelled = false

    const el = scrollerRef.current?.querySelector(`[data-row-id="${pendingJump}"]`)
    if (el) {
      stickRef.current = false // parking on an old message must not be yanked back to the bottom
      el.scrollIntoView({ block: 'center', inline: 'nearest' })
      // Markdown bodies above the target can still settle after this commit (code blocks, lists),
      // so re-centre on the next frame. Idempotent and invisible when nothing moved.
      const raf = requestAnimationFrame(() => {
        if (!cancelled) scrollerRef.current?.querySelector(`[data-row-id="${pendingJump}"]`)?.scrollIntoView({ block: 'center', inline: 'nearest' })
      })
      setHighlightRow(pendingJump)
      setPendingJump(null)
      return () => {
        cancelled = true
        cancelAnimationFrame(raf)
      }
    }

    // Not mounted. Once — and only once — pay for a full re-pull: the forward cursor cannot fill a
    // hole beneath itself, and a hit older than Beacon's first frame in this session lives there.
    if (backfilledRef.current) {
      setJumpMiss(true)
      setPendingJump(null)
      return
    }
    backfilledRef.current = true
    void window.beacon?.history
      .backfill(sessionId)
      .then((rows) => {
        if (cancelled) return
        setMessages(coalesceToolResults(rows.map(fromHistory))) // re-runs this effect via `messages`
      })
      .catch(() => {
        if (cancelled) return
        setJumpMiss(true)
        setPendingJump(null)
      })
    return () => {
      cancelled = true
    }
  }, [pendingJump, messages, showAll, sessionId])

  // The highlight is a landing cue, not a selection — it fades on its own so the message does not
  // stay marked for the rest of the session.
  useEffect(() => {
    if (highlightRow === null) return
    const t = setTimeout(() => setHighlightRow(null), 2600)
    return () => clearTimeout(t)
  }, [highlightRow])

  // The activity slot at the foot of the thread counts too: the compaction line (issue 283) mounts with
  // no new message, and a reader parked at the bottom had it half under the fold for a whole pass in
  // the live check. Chromium's scroll anchoring rescues that only when it happens to anchor below.
  const slotShown = `${compaction.show}:${activity !== null}`
  useEffect(() => {
    if (stickRef.current) stickToBottom()
  }, [messages, slotShown])

  function onScroll(): void {
    const el = scrollerRef.current
    if (!el) return
    const g = { scrollTop: el.scrollTop, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight }
    // TWO thresholds. Sticking is tight (keep following a streaming reply); the PILL is a
    // screenful (a way back), so it does not flicker on every nudge of the wheel.
    stickRef.current = shouldStick(g)
    const show = showJumpPill(g)
    setDetached((was) => {
      // Mark where the transcript stood the moment you left the bottom — the pill's count is
      // what arrived AFTER that, not the size of the conversation.
      if (show && !was) detachBaseline.current = renderedCount.current
      if (!show) detachBaseline.current = null
      return show
    })
  }

  function jumpToLatest(): void {
    stickRef.current = true
    setDetached(false)
    detachBaseline.current = null
    stickToBottom()
  }

  function runExport(format: 'markdown' | 'json'): void {
    setExportOpen(false)
    setExportNote('exporting…')
    void window.beacon?.session
      .export(sessionId, format, { title: sessionTitle })
      .then((r) => {
        if (!r || !r.ok) {
          setExportNote(`Export failed: ${r?.error ?? 'unknown error'}`)
          return
        }
        // A count of zero is a real outcome, not a success worth celebrating — say which it was.
        const where = r.savedPath ? r.savedPath.split('/').slice(-1)[0] : 'Downloads'
        const base = r.messages === 0 ? `Nothing to export — wrote an empty ${where}` : `Saved ${r.messages} messages to ${where}`
        setExportNote(r.warning ? `${base} — ${r.warning}` : base)
      })
      .catch((e) => setExportNote(`Export failed: ${e?.message ?? e}`))
  }

  function copyMessage(key: string, content: string | ContentPart[]): void {
    const t = flatText(content)
    if (!t) return
    void navigator.clipboard?.writeText(t).then(() => {
      setCopiedKey(key)
      setTimeout(() => setCopiedKey((k) => (k === key ? null : k)), 1200)
    })
  }

  /** Reply watchdog: a clean send should produce SOME assistant activity (delta/tool/done) within
   * 30 s. When the daemon accepts a message but never generates — e.g. the session's model isn't
   * being served — the thread otherwise reads as dead silence (live-walk finding 2026-07-12).
   * One timer; a resend re-arms it; assistant frames stand it down (onStream above). */
  function armReplyWatchdog(): void {
    if (replyWatchdog.current !== null) clearTimeout(replyWatchdog.current)
    // Writes a row only on a COLD arm; a re-arm just increments a counter.
    logWatchdog(onArm(wdLog.current, Date.now(), sessionId))
    clearStall(sessionId) // a fresh attempt is in flight — not stalled unless this one also dies
    replyWatchdog.current = setTimeout(() => {
      replyWatchdog.current = null
      setActivity(null) // nothing is alive to report
      setCompaction(COMPACTION_IDLE) // nor is a pass that has gone quiet with it
      reportStall(sessionId) // Mission's "needs you" card + tray HUD pick this up
      // WHAT THIS TIMER ACTUALLY WITNESSED: 30s of silence IN THIS SESSION. That
      // is all it can ever witness, because the session filter above it drops
      // every other session's frames. It used to announce "the turn itself may
      // have died" from exactly that evidence — a claim about the daemon drawn
      // from one conversation.
      //
      // It was wrong on 2026-08-16, three times in a row, and provably: the
      // daemon emitted 36 progress pulses at an exact 3s cadence through an
      // approval wait, every one of them for a session the view was not showing.
      // Dropped at the filter, the timer never re-armed, and Beacon told the
      // operator to go check a daemon that was healthy.
      //
      // Three facts now choose the wording, in order of how much they license:
      //   1. the socket dropped and came back   → Beacon stopped receiving
      //   2. the gateway spoke to OTHER sessions → only THIS session is quiet
      //   3. the gateway said nothing at all     → the alarming claim, earned
      //
      // (2) is the fact this component cannot observe. MainView supplies it.
      const dropped = socketDroppedAt.current
      const lastAny = daemonLastSeen?.() ?? 0
      const evidence = {
        droppedInWindow: dropped !== null && Date.now() - dropped <= 30_000,
        gatewaySpokeElsewhere: lastAny > 0 && Date.now() - lastAny <= 30_000
      }
      const content = stallMessage(evidence)
      // Record the decision AND the raw inputs it came from. A later reader can
      // then recompute the verdict instead of trusting it — which is exactly what
      // the 2026-08-17 investigation could not do, because `daemonLastSeen` is a
      // ref that is written nowhere.
      logWatchdog(
        onFire(wdLog.current, Date.now(), sessionId, {
          cause: stallCause(evidence),
          socketDroppedAt: dropped,
          daemonLastSeenAt: lastAny > 0 ? lastAny : null,
          turnInFlight: turnInFlight.current
        })
      )
      setMessages((prev) => [
        ...prev,
        { key: `stall-${crypto.randomUUID()}`, rowId: null, ordinal: null, role: 'system', content }
      ])
    }, 30_000)
  }

  /** Text-send core (used by send() and retry): optimistic row keyed by a fresh clientMsgId —
   * the WS echo re-keys it to the durable rowid. Appends its own failure row.
   * `forceSearch` rides only from send() (the armed toggle) — a retry never re-forces, because
   * the one-shot arm was consumed by the original attempt. */
  async function dispatchText(text: string, forceSearch = false, chips: ReferenceChip[] = []): Promise<void> {
    const b = window.beacon
    if (!b) return
    const clientMsgId = crypto.randomUUID()
    const references = referencesFromChips(chips)
    const note = chipsNote(chips)
    try {
      setMessages((prev) => [...prev, { key: clientMsgId, rowId: null, ordinal: null, role: 'user', content: note ? `${text}\n\n${note}` : text, pending: true }])
      const res = await b.chat.send({
        sessionId,
        message: text,
        clientMsgId,
        ...modeSendField(mode),
        ...(forceSearch && mode === 'agent' ? { forceSearch: true } : {}),
        ...(references.length > 0 ? { references } : {})
      })
      if (res.status === 'refused' || res.status === 'not-connected') {
        // The daemon refused a reference (400/403/404/502/503 — its own words follow) or we are
        // offline: NO turn was queued. Drop the optimistic row, put the chips and text back so the
        // user can fix the reference and resend — a silently dropped chip is the failure PR 382 prevents.
        setMessages((prev) => prev.filter((m) => m.key !== clientMsgId))
        setAtChips(chips)
        setDraft(text)
        setMessages((prev) => [
          ...prev,
          { key: `err-${clientMsgId}`, rowId: null, ordinal: null, role: 'system', content: `not sent: ${res.error ?? res.status}` }
        ])
        return
      }
      if (res.error) {
        // The send failed WHILE CONNECTED (main outboxed it for the next reconnect) — say so.
        // Silence here reads as "the daemon is ignoring me" (live-walk finding 2026-07-12).
        setMessages((prev) => [
          ...prev,
          { key: `err-${clientMsgId}`, rowId: null, ordinal: null, role: 'system', content: `send failed: ${res.error} — queued; retries on reconnect` }
        ])
      } else if (res.status !== 'queued') {
        armReplyWatchdog()
      }
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        { key: `err-${clientMsgId}`, rowId: null, ordinal: null, role: 'system', content: `send failed: ${String(err)}` }
      ])
    }
  }

  /**
   * Upload staged files as chat_upload frames, with the text as the caption.
   *
   * One implementation, two callers: an ordinary send, and the FIRST turn of a session started
   * from the home screen with attachments already staged. They were one block inside send();
   * the home path would otherwise have had to reimplement the optimistic row and the caption
   * rule, which is the kind of duplication that drifts.
   */
  async function uploadFiles(files: PendingFile[], text: string, clientMsgId: string): Promise<void> {
    const b = window.beacon
    if (!b) return
    // Optimistic LOCAL row with image/file parts (+ caption text). The daemon converts uploads to
    // text server-side, so these thumbnails are session-local (see @shared/parts). No re-key — the
    // daemon echo arrives as its own [Image: …] / extracted-text turn.
    const parts: ContentPart[] = files.map((f) =>
      f.isImage
        ? { type: 'image', dataUrl: f.dataUrl }
        : { type: 'file', fileName: f.name, fileSize: f.size, mimeType: f.mimeType }
    )
    if (text) parts.push({ type: 'text', text })
    setMessages((prev) => [...prev, { key: clientMsgId, rowId: null, ordinal: null, role: 'user', content: parts }])
    // One chat_upload per file; the text rides as caption on the LAST (matches the web client).
    for (let i = 0; i < files.length; i++) {
      const f = files[i]
      const ok = await b.chat.upload({
        sessionId,
        filename: f.name,
        contentBase64: f.base64,
        mimeType: f.mimeType,
        caption: i === files.length - 1 ? text : ''
      })
      if (!ok) throw new Error('not connected')
    }
  }

  /** The Stop button (P9.1): POST /api/chat/interrupt for THIS session. The daemon broadcasts
   *  chat_done{interrupted:true} to every client, so a stop pressed here also ends the turn in any
   *  other window — and one pressed THERE clears this button via the same frame. The reply's
   *  terminal state is that frame's job, not this call's: a transport failure or an explicit error
   *  is reported in-thread, never silently. */
  const [stopping, setStopping] = useState(false)
  async function stopTurn(): Promise<void> {
    const b = window.beacon
    if (!b || stopping) return
    setStopping(true)
    try {
      const res = await b.chat.interrupt(sessionId)
      if (res.error) {
        setMessages((prev) => [
          ...prev,
          { key: `err-${crypto.randomUUID()}`, rowId: null, ordinal: null, role: 'system', content: `stop failed: ${res.error}` }
        ])
      }
      // stopped:false WITHOUT an error means the turn had already ended on its own — its done frame
      // is on its way or has landed; there is nothing to say.
    } finally {
      setStopping(false)
    }
  }

  async function send(confirmed = false): Promise<void> {
    // Telegram-bound command typed on web (P9.2): gate it HERE rather than sending it. `web:false`
    // was a CSS class with no mechanism behind it — nothing checked the flag before send. Reply
    // locally with the same boundary the daemon would, and never round-trip it.
    const boundary = slashBoundary(draft)
    if (boundary) {
      setDraft('')
      setMessages((prev) => [
        ...prev,
        { key: `err-${crypto.randomUUID()}`, rowId: null, ordinal: null, role: 'system', content: slashBoundaryReply(boundary) }
      ])
      return
    }
    // A DESTRUCTIVE web command (`/reset`, `/clear`) wipes the session's context and cannot be
    // undone from here, so it asks first — unless this call IS the confirm. The draft is left
    // intact so the confirm can re-enter send(true) and dispatch the very same text.
    const destCmd = destructiveSlash(draft)
    if (destCmd && !confirmed) {
      setConfirmSlash(destCmd)
      return
    }
    setConfirmSlash(null)
    // `/search <query>` is BEACON's, not the router's: it strips the command and sends the query
    // with the web-search arm set for that one turn. This is where the Search button's capability
    // went when the button was removed — without it, removing the button would have removed the
    // feature. `local` overrides the toggle for this send only; nothing is left armed after.
    const local = parseLocalSlash(draft.trim())
    const text = local ? local.text : draft.trim()
    const files = pendingFiles
    const chips = atChips
    if ((!text && files.length === 0) || sending) return
    const b = window.beacon
    if (!b) return
    // The client-side commands that ACT rather than send. Each reports what it did (or what it
    // could not understand): a slash command that silently does nothing is indistinguishable
    // from a broken one.
    if (local && local.command !== 'search') {
      setDraft('')
      if (local.command === 'skin') {
        const plate = resolveSkin(local.text, THEMES, THEME_LABEL)
        if (!plate) {
          setExportNote(`No plate called “${local.text}”. Try: ${THEMES.map((t) => THEME_LABEL[t]).join(', ')}`)
        } else {
          void setTheme(coerceTheme(plate))
          setExportNote(`Plate: ${THEME_LABEL[coerceTheme(plate)]}`)
        }
        return
      }
      if (local.command === 'export') {
        const fmt = local.text.trim().toLowerCase()
        if (fmt !== 'markdown' && fmt !== 'json') {
          setExportNote('Export needs a format — /export markdown or /export json')
          return
        }
        runExport(fmt)
        return
      }
      if (local.command === 'model') {
        const picked = resolveModel(local.text, modelCatalog)
        if (picked.kind === 'ambiguous') {
          // NAME the matches. "Be more specific" on its own makes the user guess at what they
          // were ambiguous between; the list turns a dead end into a one-word correction.
          setExportNote(`“${local.text}” matches ${picked.matches.join(' and ')} — say which.`)
          return
        }
        if (picked.kind === 'none') {
          setExportNote(`No model matches “${local.text}”.`)
          return
        }
        void onSelectModel(picked.key)
        setExportNote(`Model: ${modelCatalog.find((m) => m.key === picked.key)?.label ?? picked.key}`)
        return
      }
    }
    // A Chat turn calls no tools at all, so a forced search there would be silently dropped and
    // the user would get an ordinary answer they believed was searched. Say so instead.
    if (local?.command === 'search' && forceSearchDisabled(mode)) {
      setMessages((prev) => [
        ...prev,
        { key: `err-${crypto.randomUUID()}`, rowId: null, ordinal: null, role: 'system', content: 'Chat turns use no tools — switch to Agent to force a search' }
      ])
      return
    }
    if (!local && slashWithReferences(text, chips)) {
      // The daemon answers 400 for this; say it here, before the round trip, and keep everything.
      setMessages((prev) => [
        ...prev,
        { key: `err-${crypto.randomUUID()}`, rowId: null, ordinal: null, role: 'system', content: 'a slash command cannot carry @-references — remove the chips or the command' }
      ])
      return
    }
    if (files.length > 0 && chips.length > 0) {
      setMessages((prev) => [
        ...prev,
        { key: `err-${crypto.randomUUID()}`, rowId: null, ordinal: null, role: 'system', content: 'attachments and @-references cannot ride one message yet — send them separately' }
      ])
      return
    }
    setDraft('')
    setPendingFiles([])
    setAtChips([])
    setSending(true)
    const clientMsgId = crypto.randomUUID()
    try {
      if (files.length > 0) {
        await uploadFiles(files, text, clientMsgId)
      } else {
        // Forcing a search is now per-MESSAGE (`/search <query>`) rather than a sticky arm, so
        // there is nothing to disarm afterwards: the next turn is only forced if it says so too.
        await dispatchText(text, local?.command === 'search', chips)
      }
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        { key: `err-${clientMsgId}`, rowId: null, ordinal: null, role: 'system', content: `send failed: ${String(err)}` }
      ])
    } finally {
      setSending(false)
    }
  }

  /** The most recent text the OPERATOR typed (sorted order) — drives retry-last / edit-last
   *  (Slice 6). A machine turn with the user role (a task's report) is skipped: re-sending it would
   *  send its text as the operator's own words. Same rule as lastUserKey, so the button and the
   *  text it sends are the same row. */
  function lastUserText(): string {
    const row = lastOperatorTurn(orderForRender(messages), (m) => !!flatText(m.content))
    return row ? flatText(row.content) : ''
  }

  async function retryLast(): Promise<void> {
    const t = lastUserText()
    if (!t || sending) return
    setSending(true)
    await dispatchText(t)
    setSending(false)
  }

  // Retry with a DIFFERENT model (PARITY-PLAN A6): sets the session's model override through the
  // exact path the composer switcher uses, then re-dispatches. If the override write fails the
  // retry still runs and the composer's model badge shows the truth — the badge, not this menu,
  // is the authority on what will serve the turn.
  const [retryMenuOpen, setRetryMenuOpen] = useState(false)
  async function retryWithModel(key: string): Promise<void> {
    if (sending) return
    if (key !== currentModelKey) await onSelectModel(key)
    await retryLast()
  }

  function editLast(): void {
    const t = lastUserText()
    if (!t) return
    setDraft(t)
    draftRef.current?.focus()
  }

  // ── Screenshot capture (PARITY-PLAN A3) ─────────────────────────────────────
  // The 📷 picker lists screens+windows from main (desktopCapturer); a grabbed PNG lands in the
  // SAME pendingFiles path a picked/pasted image takes, so send/upload code has one shape.
  const [shotOpen, setShotOpen] = useState(false)
  const [attachNote, setAttachNote] = useState('')
  const preview = usePreview()
  const [shotSources, setShotSources] = useState<import('@shared/capture').CaptureSourcesResult | null>(null)
  const [shotNote, setShotNote] = useState('')

  function toggleShotPicker(): void {
    if (shotOpen) {
      setShotOpen(false)
      return
    }
    setShotOpen(true)
    setShotSources(null)
    setShotNote('')
    void window.beacon?.screenshot
      .sources()
      .then((r) => setShotSources(r))
      .catch(() => setShotNote('could not list screens — try again'))
  }

  function grabShot(sourceId: string): void {
    setShotNote('capturing…')
    void window.beacon?.screenshot
      .grab(sourceId)
      .then((r) => {
        if (!r) return
        if (!r.ok) {
          setShotNote(r.error)
          return
        }
        const name = screenshotFilename(Date.now(), r.mimeType)
        setPendingFiles((prev) => [
          ...prev,
          {
            dataUrl: `data:${r.mimeType};base64,${r.base64}`,
            base64: r.base64,
            mimeType: r.mimeType,
            name,
            isImage: true,
            size: Math.floor((r.base64.length * 3) / 4)
          }
        ])
        setShotOpen(false)
      })
      .catch(() => setShotNote('capture failed — try again'))
  }

  async function addFiles(files: FileList | File[]): Promise<void> {
    const arr = Array.from(files)
    if (arr.length === 0) return
    // Staging + the oversize refusal live in ../attachments-io, shared with the home composer.
    const { ok, note } = await stageFiles(arr)
    setAttachNote(note)
    if (ok.length > 0) setPendingFiles((prev) => [...prev, ...ok])
  }

  function onFilePick(e: React.ChangeEvent<HTMLInputElement>): void {
    if (e.target.files) void addFiles(e.target.files)
    e.target.value = '' // reset so re-picking the same file re-fires onChange
  }

  function onPaste(e: React.ClipboardEvent<HTMLTextAreaElement>): void {
    const files = Array.from(e.clipboardData.files)
    if (files.length > 0) {
      e.preventDefault()
      void addFiles(files)
      return
    }
    // Paste-as-file (PARITY-PLAN A5): a paste longer than the threshold becomes a .txt chip
    // instead of drowning the draft. Only where attachments can actually SEND (Agent mode) —
    // in Chat mode the paste stays ordinary text rather than minting a chip that cannot go.
    const text = e.clipboardData.getData('text/plain')
    if (text.length > PASTE_AS_FILE_CHARS && !attachDisabledInMode(mode)) {
      e.preventDefault()
      const bytes = utf8ByteLength(text)
      const name = pasteFilename(Date.now())
      if (bytes > CHAT_UPLOAD_SAFE_BYTES) {
        setAttachNote(oversizeAttachmentNotice(name, bytes))
        return
      }
      const b64 = base64FromText(text)
      setPendingFiles((prev) => [
        ...prev,
        { dataUrl: `data:text/plain;base64,${b64}`, base64: b64, mimeType: 'text/plain', name, isImage: false, size: bytes }
      ])
    }
  }

  /** Preview a staged pdf in the pane via a blob URL (Chromium's own viewer; no daemon involved —
   * the file has not been sent yet). One live URL at a time; the previous one is revoked. */
  const pendingBlobUrl = useRef<string | null>(null)
  function previewPendingPdf(f: PendingFile): void {
    if (pendingBlobUrl.current) URL.revokeObjectURL(pendingBlobUrl.current)
    const bytes = Uint8Array.from(atob(f.base64), (c) => c.charCodeAt(0))
    const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }))
    pendingBlobUrl.current = url
    preview.open({ kind: 'render', title: f.name, url, renderKind: 'pdf' })
  }

  function onDrop(e: React.DragEvent<HTMLElement>): void {
    e.preventDefault()
    setDragging(false)
    if (e.dataTransfer.files.length > 0) void addFiles(e.dataTransfer.files)
  }

  function onDragOver(e: React.DragEvent<HTMLElement>): void {
    e.preventDefault()
    if (!dragging) setDragging(true)
  }

  function onDragLeave(e: React.DragEvent<HTMLElement>): void {
    e.preventDefault()
    setDragging(false)
  }

  function removePending(idx: number): void {
    setPendingFiles((prev) => prev.filter((_, i) => i !== idx))
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>): void {
    // @-reference popup keys (PR 382): same reducer and keys as the slash popup. Enter on a token
    // that has no candidate row but IS a url/diff makes the chip directly.
    if (atTok && (atVisible || chipFromToken(atTok.query))) {
      const key = e.key
      if (key === 'ArrowUp' || key === 'ArrowDown' || key === 'Enter' || key === 'Tab' || key === 'Escape') {
        e.preventDefault()
        if (!atVisible) {
          if (key === 'Enter' || key === 'Tab') {
            const chip = chipFromToken(atTok.query)
            if (chip) chooseAt({ ...chip, desc: '' })
          } else if (key === 'Escape') setAtDismissed(true)
          return
        }
        const action = atKey(
          key === 'ArrowUp' ? 'up' : key === 'ArrowDown' ? 'down' : key === 'Enter' ? 'enter' : key === 'Tab' ? 'tab' : 'escape',
          atHighlight,
          atList.length
        )
        if (action.kind === 'move') setAtHighlight(action.highlight)
        else if (action.kind === 'insert') chooseAt(atList[action.highlight])
        else if (action.kind === 'dismiss') setAtDismissed(true)
        return
      }
    }
    // Slash-command popup keys first (X3): while the popup is visible, Up/Down move the
    // highlight, Enter/Tab insert the completion (NOT send), Escape dismisses without eating
    // the typed text. Everything else falls through to the normal composer behaviour.
    if (slashVisible) {
      const key = e.key
      if (key === 'ArrowUp' || key === 'ArrowDown' || key === 'Enter' || key === 'Tab' || key === 'Escape') {
        e.preventDefault()
        const action = slashKey(
          key === 'ArrowUp' ? 'up' : key === 'ArrowDown' ? 'down' : key === 'Enter' ? 'enter' : key === 'Tab' ? 'tab' : 'escape',
          slashHighlight,
          slashList.length
        )
        if (action.kind === 'move') setSlashHighlight(action.highlight)
        else if (action.kind === 'insert') insertSlash(slashList[action.highlight])
        else if (action.kind === 'dismiss') setSlashDismissed(true)
        return
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void send()
    }
  }

  function insertSlash(cmd: SlashCommand): void {
    // Completion = "/name " (trailing space, ready for arguments) — slashQuery closes the
    // popup on its own (space ends the leading token), so no extra state dance here.
    setDraft(slashCompletion(cmd))
    draftRef.current?.focus()
  }

  // Slash-command popup (X3): open while the draft is a single leading-slash token (pure
  // predicate, shared), fuzzy-ranked, web-available commands partitioned first. Dismissed by
  // Escape; re-arms on any further edit (onChange clears the flag).
  const slashQ = slashQuery(draft)
  // At most SIX rows (match spec, step 17). The list opens OVER the composer, so a taller one
  // covers the message being answered — and past six the ranking is doing the work anyway.
  const slashList = slashQ !== null && !slashDismissed ? slashMatches(slashQ).slice(0, 6) : []
  const atTok = atChips.length < MAX_REFERENCES && !atDismissed && slashQ === null ? atQuery(draft, atCaret) : null
  const atList: AtCandidate[] = atTok ? atMatches(atTok.query, atEntries.dir === fileQueryParts(atTok.query).dir ? atEntries.entries : []) : []
  const atVisible = atTok !== null && atList.length > 0
  // The directory the token names is listed once per directory change (not per keystroke).
  const atDir = atTok ? fileQueryParts(atTok.query).dir : null
  useEffect(() => {
    if (atDir === null) return
    let alive = true
    const b = window.beacon
    if (!b) return
    void (b.daemon.get(`/api/files?path=${encodeURIComponent(atDir)}`) as Promise<FileListDTO>)
      .then((d) => {
        if (alive) setAtEntries({ dir: atDir, entries: Array.isArray(d?.entries) ? d.entries : [] })
      })
      .catch(() => {
        if (alive) setAtEntries({ dir: atDir, entries: [] }) // no listing → only diff/url candidates; the daemon still validates
      })
    return () => {
      alive = false
    }
  }, [atDir])

  function chooseAt(cand: AtCandidate): void {
    if (!atTok) return
    const r = applyAtChoice(draft, atTok, cand)
    setDraft(r.draft)
    if (r.chip) setAtChips((prev) => [...prev, r.chip as ReferenceChip])
    setAtHighlight(0)
    requestAnimationFrame(() => {
      const el = draftRef.current
      if (!el) return
      el.focus()
      el.setSelectionRange(r.caret, r.caret)
      setAtCaret(r.caret)
    })
  }
  const slashVisible = slashList.length > 0

  // Hide truly-empty rows (legacy tool turns with no content_json) while keeping streaming rows and
  // anything with parts. Display-only — the cache/cursor still tracks every durable row.
  //
  // MEMOIZED — the composer's draft state lives in this component, so every keystroke
  // re-renders ChatShell. Recomputing order/group per keystroke over up to RENDER_WINDOW
  // rows, then re-rendering every MessageBody (each a full react-markdown pipeline), was
  // the typing lag. memo()d MessageBody + cached lists below mean a keystroke re-renders
  // the shell and the composer, not 120 markdown parses.
  const rendered = useMemo(
    () =>
      orderForRender(messages).filter(
        (m) => !!m.pending || (typeof m.content === 'string' ? m.content.trim().length > 0 : m.content.length > 0)
      ),
    [messages]
  )
  // Windowed tail: long sessions mount only the last RENDER_WINDOW rows until asked.
  const hiddenCount = showAll ? 0 : Math.max(0, rendered.length - RENDER_WINDOW)
  const visible = useMemo(
    () => (hiddenCount > 0 ? rendered.slice(hiddenCount) : rendered),
    [rendered, hiddenCount]
  )
  const groups = useMemo(() => groupForRender(visible), [visible])
  // Turn numbering runs over `rendered` — the whole conversation — so it does not restart at 1
  // when the windowed tail is showing, and does not renumber when "Show earlier" expands it.
  // onScroll runs outside render, so the pill's baseline needs the count in a ref.
  renderedCount.current = rendered.length

  const marks = useMemo(
    () =>
      turnMarks(
        rendered.map((m) => ({
          key: m.key,
          // A worker's report arrives with the user role but nobody typed it: it opens no turn.
          role: parseWorkerReport(m.provenance, flatText(m.content)) ? 'worker' : m.role,
          text: flatText(m.content),
          createdAt: m.createdAt,
          // Everything in `rendered` already passed a has-content filter, so a row here is blank
          // only if it is an empty STRING. An image-only message has no text and is not blank.
          blank: typeof m.content === 'string' ? !m.content.trim() : m.content.length === 0
        }))
      ),
    [rendered]
  )

  // Speak the newest FINISHED assistant reply while read-aloud is on.
  //
  // Finished, not streaming: speaking a partial reply means starting over every few tokens, and
  // the synthesiser has no way to resume mid-sentence. And only replies that arrive AFTER the
  // toggle goes on — turning it on must not recite the whole backlog, so the last existing reply
  // is marked spoken at that moment without being read.
  useEffect(() => {
    if (!speechOk) return
    const synth = window.speechSynthesis
    if (!readAloud) {
      synth.cancel()
      spokenKeyRef.current = null
      return
    }
    const last = [...rendered].reverse().find((m) => m.role === 'assistant' && !m.pending)
    if (!last) return
    if (spokenKeyRef.current === null) {
      spokenKeyRef.current = last.key // arm on what is already there; say nothing
      return
    }
    if (spokenKeyRef.current === last.key) return
    spokenKeyRef.current = last.key
    const text = flatText(last.content)
    if (!speakable(text)) return
    synth.cancel()
    synth.speak(new SpeechSynthesisUtterance(speechText(text)))
  }, [readAloud, rendered, speechOk])

  // Publish the newest FINISHED reply into the hidden aria-live region (audit #11).
  //
  // The same rule as read-aloud above, for a screen reader the user runs themselves: finished, once,
  // no backlog recital. The decision is @shared/live-announce's — this effect only feeds it rows and
  // publishes what it returns. `speakable`/`speechText` are passed/applied here too so BOTH
  // consumers agree on what is worth saying, and both strip the markdown that a screen reader would
  // otherwise read as literal asterisks.
  //
  // `announceArmedRef` is deliberately SEPARATE from the watermark. Arming (mark the backlog as
  // already-heard, publish nothing) and announcing (publish a row that settled since) are different
  // acts, and overloading announcedRef's null to mean both would make a backlogged session recite
  // its last message on every open.
  //
  // Arming waits for HISTORY to settle, not for the first render: the mount renders empty and history
  // lands one replacement later, so arming immediately would set a null watermark and then announce
  // the whole backlog as "news". Nor is "the first render that has rows" enough: a stream frame for
  // this session can render a pending row BEFORE history resolves, and arming on that render marks
  // nothing (a pending row is never the watermark), so the backlog is recited when it lands (PR 185
  // review; probe:live-announce constructs that order). History loads in a single setMessages
  // replacement, batched with setHistoryLoaded, so the armed render really holds the whole backlog.
  // An empty session arms to null, so its first reply is announced — correct, that one IS news.
  useEffect(() => {
    const rows = rendered.map((m) => ({ key: m.key, role: m.role, pending: m.pending, interrupted: m.interrupted, text: flatText(m.content) }))
    if (!announceArmedRef.current) {
      if (!historyLoaded) return // the backlog has not landed; arming now would let it through
      announceArmedRef.current = true
      announcedRef.current = initialWatermark(rows)
      return // arm only: the backlog is already-heard, nothing is published
    }
    const next = nextAnnouncement(rows, announcedRef.current, speakable)
    if (!next) return
    announcedRef.current = next.key
    setAnnounce((a) => ({ text: spokenAnnouncement(next, speechText), seq: a.seq + 1 }))
  }, [rendered, historyLoaded])

  // Stop talking when the conversation is left or the window goes away — a synthesiser keeps
  // reading a reply whose session you have already closed, which is how you end up hunting for
  // the tab that is speaking.
  useEffect(() => {
    if (!speechOk) return
    return () => window.speechSynthesis.cancel()
  }, [sessionId, speechOk])

  // Retry/edit live on the LAST message the operator typed (Slice 6) — never on a machine turn that
  // arrived with the user role (@shared/provenance isOperatorTurn).
  const lastUserKey = useMemo(() => lastOperatorTurn(visible, (m) => !!flatText(m.content))?.key, [visible])

  return (
    <div className="app">
      {/* The thread header (design handoff 2026-09-03, screen 1). Left: what this is — a sang dot,
          the session title in the display face, a mono subtitle. Right, in order: autonomy chip,
          host chip (state + gateway; the address lives in its tooltip), the dock group (R3),
          skin, overflow. The original gave full·auto, Local, Connected, the IP, Export and NOX
          equal weight, so none read as more important than the others: connection detail
          collapses into one chip, the model chip lives in the composer (it always did — this was
          its duplicate), and Export moves to the overflow. */}
      <header className="topbar thread-head">
        <div className="thread-title">
          <span className="brand-dot" />
          <div className="thread-title-text">
            <h1 className="thread-name" title={sessionTitle ?? sessionId}>{sessionTitle || 'Beacon'}</h1>
            {/* `Prometheus · NOX host · 24 msgs`. The ADDRESS is not here — it is 19 characters
                that never change, sitting in the most prominent line in the window; it lives in
                the host chip's tooltip, which is where you want it the once you need it. A
                gateway with no name (a bare IP) drops the clause rather than printing the
                number the clause exists to keep out. */}
            <div className="thread-sub">
              Prometheus
              {hostDisplayName(status.gateway) ? ` · ${hostDisplayName(status.gateway)} host` : ''} ·{' '}
              {rendered.length} msg{rendered.length === 1 ? '' : 's'}
            </div>
          </div>
        </div>
        <div className="thread-tools">
          {/* Screen 1's right cluster, in order: AUTONOMY CHIP · host chip · read-aloud · dock
              group · overflow. The autonomy chip is this ProfilePicker — it renders `full · auto`,
              which is exactly what the design labels it; moving it to the overflow briefly took
              the chip out of the header the design requires. The SKIN picker did move, to
              Config → Skin, because the handoff says the plate belongs where you change it. */}
          {limited ? null : (
            <ProfilePicker
              state={profileState}
              names={profileNames}
              onSelect={(c) => void onSelectProfile(c)}
              disabled={profileState.effective === null}
            />
          )}
          {/* One chip for state, host and distance — shared with Mission's banner. */}
          <HostChip />
          <button
            className={`thread-speak${readAloud ? ' is-on' : ''}`}
            onClick={() => setReadAloud((on) => !on)}
            disabled={!speechOk}
            aria-pressed={readAloud}
            title={
              speechOk
                ? readAloud
                  ? 'Reading replies aloud — click to stop'
                  : 'Read replies aloud as they finish'
                : 'Read replies aloud — this build has no speech synthesiser'
            }
            aria-label="Read replies aloud"
          >
            <Icon name="speaker" size={13} />
          </button>
          {onToggleDock ? <DockGroup pane={dockPane} onToggle={onToggleDock} /> : null}
          {onPopOut || onPopIn ? (
            <button
              className={`thread-popout${onPopIn ? ' is-popped' : ''}`}
              onClick={() => (onPopIn ? onPopIn() : onPopOut?.())}
              title={onPopIn ? 'Return this conversation to the main window' : 'Open this conversation in its own window'}
              aria-label={onPopIn ? 'Return to main window' : 'Open in its own window'}
            >
              <Icon name="popout" size={13} />
            </button>
          ) : null}
          {onClosePane ? (
            <button className="thread-close-pane" onClick={onClosePane} title="Close this pane (the conversation stays in the list)" aria-label="Close this pane">
              <Icon name="x" size={13} />
            </button>
          ) : null}
          <div style={{ position: 'relative' }}>
            <button
              className="thread-more"
              onClick={() => {
                setExportNote('')
                setExportOpen((o) => !o)
              }}
              title="More — rename, pin, export, delete"
              aria-label="More"
              aria-expanded={exportOpen}
            >
              ⋯
            </button>
            {exportOpen ? (
              /* The overflow menu (match spec, step 16.4). The spec also lists `Fork session`
                 and `Duplicate`; neither exists here — forking is per-MESSAGE (the ✎ on a user
                 row branches from that point, which is a different operation), and there is no
                 duplicate route at all. Rows for them would be affordances for nothing. */
              <div className="thread-menu" role="menu">
                {onRenameSession ? (
                  <button
                    className="export-choice"
                    role="menuitem"
                    onClick={() => {
                      setExportOpen(false)
                      setRenaming(sessionTitle ?? '')
                    }}
                  >
                    Rename
                  </button>
                ) : null}
                {onTogglePin ? (
                  <button
                    className="export-choice"
                    role="menuitem"
                    onClick={() => {
                      setExportOpen(false)
                      onTogglePin()
                    }}
                  >
                    {pinned ? 'Unpin' : 'Pin'}
                  </button>
                ) : null}
                {onPopOut || onPopIn ? (
                  <button
                    className="export-choice"
                    role="menuitem"
                    onClick={() => {
                      setExportOpen(false)
                      if (onPopIn) onPopIn()
                      else onPopOut?.()
                    }}
                  >
                    {onPopIn ? 'Return to main window' : 'Open in its own window'}
                  </button>
                ) : null}
                <button className="export-choice" role="menuitem" onClick={() => runExport('markdown')}>
                  Export transcript — Markdown
                </button>
                <button className="export-choice" role="menuitem" onClick={() => runExport('json')}>
                  Export transcript — JSON
                </button>
                {onDeleteSession ? (
                  <>
                    <div className="thread-menu-rule" role="separator" />
                    {/* SANG, and last, and behind a confirm: it is the one row here that cannot
                        be undone. */}
                    <button
                      className="export-choice is-destructive"
                      role="menuitem"
                      onClick={() => {
                        setExportOpen(false)
                        setConfirmDelete(true)
                      }}
                    >
                      Delete
                    </button>
                  </>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>
      </header>
      {exportNote ? (
        <div className="export-note" role="status">
          {exportNote}
        </div>
      ) : null}
      {renaming !== null ? (
        <form
          className="thread-inline"
          onSubmit={(e) => {
            e.preventDefault()
            const t = renaming.trim()
            setRenaming(null)
            if (t) onRenameSession?.(t)
          }}
        >
          <input
            autoFocus
            value={renaming}
            onChange={(e) => setRenaming(e.target.value)}
            onKeyDown={(e) => e.key === 'Escape' && setRenaming(null)}
            aria-label="Session title"
            placeholder="Session title"
          />
          <button type="submit" disabled={!renaming.trim()}>
            Rename
          </button>
          <button type="button" onClick={() => setRenaming(null)}>
            Cancel
          </button>
        </form>
      ) : null}
      {confirmDelete ? (
        <div className="thread-inline" role="alertdialog" aria-label="Delete this conversation">
          {/* Says WHAT will be lost before asking. "Are you sure?" without a subject is how a
              person confirms the wrong thing. */}
          <span className="thread-inline-say">
            Delete “{sessionTitle || sessionId}” and its {rendered.length} message
            {rendered.length === 1 ? '' : 's'}? This cannot be undone.
          </span>
          <button
            type="button"
            className="is-destructive"
            onClick={() => {
              setConfirmDelete(false)
              onDeleteSession?.()
            }}
          >
            Delete
          </button>
          <button type="button" onClick={() => setConfirmDelete(false)}>
            Cancel
          </button>
        </div>
      ) : null}
      {confirmSlash ? (
        <div className="thread-inline" role="alertdialog" aria-label={`Confirm /${confirmSlash}`}>
          {/* Same rule as delete: say WHAT is lost before asking. `/reset` clears the daemon-side
              context for this session — the client cannot undo it, and before P9.2 it wore a
              "Telegram" badge that implied it would do nothing here at all. */}
          <span className="thread-inline-say">
            /{confirmSlash} clears this conversation’s context on the daemon. The messages stay on
            screen here, but the agent forgets them. Continue?
          </span>
          <button
            type="button"
            className="is-destructive"
            onClick={() => {
              setConfirmSlash(null)
              void send(true) // re-enter with the SAME draft (send() left it intact)
            }}
          >
            Clear context
          </button>
          <button type="button" onClick={() => setConfirmSlash(null)}>
            Cancel
          </button>
        </div>
      ) : null}

      {/* NOT role="log" and NOT aria-live, deliberately. role="log" carries an implicit
          aria-live="polite", so adding it for structure would turn this list into a live region whose
          rows the streaming reducer mutates per token — a flood. Announcements go through the single
          hidden region below the list instead; see @shared/live-announce for the reasoning. */}
      <main className="messages" ref={scrollerRef} onScroll={onScroll}>
        {rendered.length === 0 ? (
          /* A new session's turn area is EMPTY (match spec, step 18.3): no hero, no tagline, no
             session id. The composer below is the invitation; anything else is decoration the
             user scrolls past forever.
             NO SUGGESTION CHIPS: the spec draws three "drawn from recent commands", and nothing
             here records recent commands — the slash catalog is static and /api/tools/recent is
             a tool-call tail. Three fixed chips presented as recents would be a fiction. */
          <div className="empty" />
        ) : (
          <>
            {hiddenCount > 0 ? (
              <button className="show-earlier" onClick={() => setShowAll(true)}>
                Show {hiddenCount} earlier message{hiddenCount === 1 ? '' : 's'}
              </button>
            ) : null}
            {groups.map((item, gi) => {
              const machineNotice = item.kind === 'timeline' ? null : parseMachineNotice(flatText(item.m.content))
              // A worker's report (Prometheus 713): the daemon's turn, not the operator's — a card,
              // left-aligned, with none of the user row's controls (retry/edit would re-send the
              // worker's output as the operator's own words).
              const workerReport =
                item.kind === 'timeline' ? null : parseWorkerReport(item.m.provenance, flatText(item.m.content))
              // Screen 1 separates TURNS with a centred mono rule. A turn starts at a user message
              // that a person actually typed — a machine notice arrives with the user role but is
              // a tool result, so it never opens one. The first turn needs no rule above it.
              const mark = item.kind === 'timeline' ? undefined : marks.get(item.m.key)
              const startsTurn = !!mark && gi > 0
              // A voice turn's message arrives with a system prompt glued to its front. The bubble
              // shows what the person SAID; the chip on the rule says how they said it.
              const shown: string | ContentPart[] =
                item.kind === 'timeline'
                  ? ''
                  : item.m.role === 'user'
                    ? stripVoiceParts(item.m.content)
                    : item.m.content
              return (
                <Fragment key={`g${item.key}`}>
                {startsTurn && mark ? (
                  <div className="turn-rule">
                    <span className="turn-rule-label">{turnLabel(mark)}</span>
                    {mark.voice ? <span className="turn-voice">voice</span> : null}
                  </div>
                ) : null}
                {item.kind === 'timeline' ? (
                <div key={item.key} className="msg msg-timeline">
                  <ToolTimeline calls={item.calls} />
                </div>
              ) : (
                <div
                  key={item.key}
                  className={`msg msg-${workerReport ? 'worker' : item.m.role}${
                    highlightRow !== null && item.m.rowId === highlightRow ? ' msg-jump-target' : ''
                  }`}
                  data-row-id={item.m.rowId ?? undefined}
                >
                  {/* The avatar chip carries the role for the assistant; the user's role is
                      carried by right-alignment and the bubble. Neither needs a caps label —
                      that is what made the thread read as a transcript (screen 1). */}
                  {item.m.role === 'assistant' ? (
                    <span className="msg-avatar" aria-hidden>
                      P
                    </span>
                  ) : null}
                  <div className="msg-col">
                  <div className="msg-role">
                    <span className="sr-only">{item.m.role}</span>
                    {/* Provenance + trust badges (Prometheus P9.3). `role` is 'assistant' for both a
                        reply to Will and an automated turn, so without this a cron re-engagement, a
                        task supervisor's output or a file-mutation summary renders identically to
                        something the operator typed — and untrusted third-party content is
                        indistinguishable from his own words. Only NON-user provenance is badged; a
                        plain user/assistant exchange stays clean. */}
                    {isMachineryProvenance(item.m.provenance) ? (
                      <span className="msg-prov" title={`Automated turn — originated from the ${provenanceLabel(item.m.provenance)}, not typed by you`}>
                        {provenanceLabel(item.m.provenance)}
                      </span>
                    ) : null}
                    {item.m.isTrusted === false ? (
                      <span className="msg-untrusted" title="Untrusted content — this turn carried material from an external source">
                        untrusted
                      </span>
                    ) : null}
                    {flatText(shown) ? (
                      <button
                        className="msg-copy"
                        onClick={() => copyMessage(item.m.key, shown)}
                        title="Copy message"
                        aria-label="Copy message text"
                      >
                        <Icon name={copiedKey === item.m.key ? 'check' : 'copy'} size={12} />
                      </button>
                    ) : null}
                    {/* Edit into a branch (B4). USER rows only, and only where something durable
                        precedes them — a fork of nothing is not a fork, and the daemon 404s on
                        it, so the control says why instead of failing on click. */}
                    {isOperatorTurn(item.m) ? (
                      <button
                        className="msg-copy"
                        onClick={() => {
                          setEditKey(item.m.key)
                          setEditDraft(flatText(shown))
                          setForkNotice('')
                        }}
                        disabled={!canEditIntoBranch(rendered, item.m.key) || sending || forking}
                        title={editUnavailableReason(rendered, item.m.key) ?? 'Edit this message into a new branch'}
                        aria-label="Edit this message into a new branch"
                      >
                        <Icon name="code" size={12} />
                      </button>
                    ) : null}
                    {item.m.key === lastUserKey ? (
                      <>
                        <button
                          className="msg-copy"
                          onClick={() => void retryLast()}
                          disabled={sending}
                          title="Retry — send this message again"
                          aria-label="Retry last message"
                        >
                          <Icon name="refresh" size={12} />
                        </button>
                        <span style={{ position: 'relative', display: 'inline-flex' }}>
                          <button
                            className="msg-copy"
                            onClick={() => setRetryMenuOpen((o) => !o)}
                            disabled={sending || modelCatalog.length === 0}
                            title="Retry with a different model"
                            aria-label="Retry with a different model"
                            aria-expanded={retryMenuOpen}
                          >
                            ⇄
                          </button>
                          {retryMenuOpen ? (
                            <div
                              role="menu"
                              aria-label="Retry with model"
                              style={{
                                position: 'absolute',
                                top: '100%',
                                right: 0,
                                zIndex: 30,
                                minWidth: 190,
                                background: 'var(--c-raise)',
                                border: '1px solid var(--c-line)',
                                borderRadius: 8,
                                padding: 4,
                                display: 'flex',
                                flexDirection: 'column',
                                gap: 2
                              }}
                            >
                              {modelCatalog.map((m) => (
                                <button
                                  key={m.key}
                                  role="menuitem"
                                  disabled={m.available === false}
                                  onClick={() => {
                                    setRetryMenuOpen(false)
                                    void retryWithModel(m.key)
                                  }}
                                  style={{
                                    textAlign: 'left',
                                    fontSize: 12,
                                    padding: '4px 8px',
                                    borderRadius: 6,
                                    border: 'none',
                                    background: m.key === currentModelKey ? 'var(--c-arc-soft)' : 'transparent',
                                    color: m.available === false ? 'var(--c-text-faint)' : 'var(--c-text)',
                                    cursor: m.available === false ? 'not-allowed' : 'pointer',
                                    font: 'inherit'
                                  }}
                                >
                                  {m.label}
                                  {m.key === currentModelKey ? ' · current' : ''}
                                </button>
                              ))}
                            </div>
                          ) : null}
                        </span>
                        <button
                          className="msg-copy"
                          onClick={editLast}
                          title="Edit — copy back into the composer"
                          aria-label="Edit last message"
                        >
                          ✎
                        </button>
                      </>
                    ) : null}
                  </div>
                  {editKey === item.m.key ? (
                    <div className="msg-body" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                      <textarea
                        value={editDraft}
                        onChange={(e) => setEditDraft(e.target.value)}
                        aria-label="Edited message"
                        rows={Math.min(10, Math.max(2, editDraft.split('\n').length))}
                        style={{
                          width: '100%', font: 'inherit', fontSize: 13, padding: 8,
                          background: 'var(--c-inset)', color: 'var(--c-text)',
                          border: '1px solid var(--c-line-bright)', borderRadius: 6, resize: 'vertical'
                        }}
                      />
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <button
                          onClick={() => void saveEdit(item.m.key)}
                          disabled={forking || !editDraft.trim()}
                          style={{
                            fontSize: 11, padding: '3px 10px', borderRadius: 6,
                            border: '1px solid var(--c-arc)', background: 'var(--c-inset)',
                            color: 'var(--c-text)', cursor: 'pointer'
                          }}
                        >
                          {forking ? 'branching…' : 'Send as a new branch'}
                        </button>
                        <button
                          onClick={() => {
                            setEditKey(null)
                            setEditDraft('')
                          }}
                          disabled={forking}
                          style={{
                            fontSize: 11, padding: '3px 10px', borderRadius: 6,
                            border: '1px solid var(--c-line)', background: 'transparent',
                            color: 'var(--c-text-dim)', cursor: 'pointer'
                          }}
                        >
                          Cancel
                        </button>
                        {/* Say what will happen BEFORE it happens: this does not change the
                            message you are looking at — the original conversation is untouched. */}
                        <span style={{ fontSize: 10, color: 'var(--c-text-faint)' }}>
                          keeps this conversation as it is; the edit continues in a copy
                        </span>
                      </div>
                    </div>
                  ) : workerReport ? (
                    <WorkerReportCard report={workerReport} />
                  ) : machineNotice ? (
                    /* R13: a daemon-injected turn summary, not something a person typed. It
                       renders as the tool result it is — one row per file — instead of a user
                       bubble full of raw machine syntax. The whole block stays in the title. */
                    <div className="machine-notice" title={machineNotice.raw}>
                      <span className="machine-notice-cap">files touched</span>
                      {machineNotice.files.length === 0 ? (
                        <span className="machine-notice-row">{machineNotice.raw.split('\n')[0]}</span>
                      ) : (
                        machineNotice.files.map((f, i) => (
                          <span className="machine-notice-row" key={`${f.path}:${i}`} title={f.path}>
                            <span className={`machine-notice-dot${f.ok ? '' : ' is-bad'}`} aria-hidden />
                            <span className="machine-notice-op">{f.op}</span>
                            <span className="machine-notice-path">{fileName(f.path)}</span>
                            {f.delta ? <span className="machine-notice-delta">{f.delta}</span> : null}
                          </span>
                        ))
                      )}
                    </div>
                  ) : (
                  <div className="msg-body">
                    {/* The caret means "text is streaming in", so it belongs ONLY on a
                        streaming assistant message. It used to render for any pending row —
                        including the user's own message, which is never generated — so it
                        read as a cursor stuck on text you already sent, and any dropped echo
                        left it blinking forever. */}
                    <MessageBody
                      content={shown}
                      streaming={!!item.m.pending && item.m.role === 'assistant'}
                    />
                  </div>
                  )}
                  {item.m.role === 'assistant' && !item.m.pending ? (
                    <ArtifactChips text={flatText(item.m.content)} artifacts={artifacts} />
                  ) : null}
                  {/* P9.1: an interrupted turn renders its own terminal state — the daemon kept
                      what the turn had already produced and says so on the done frame. Without
                      this the operator could not tell a stopped reply from a complete one, and a
                      reply that looks complete but was cut mid-thought is worse than one that
                      says it was cut. */}
                  {item.m.interrupted ? (
                    <span className="msg-interrupted" title="You stopped this turn — the agent kept what it had already produced">
                      stopped
                    </span>
                  ) : null}
                  </div>
                </div>
                )}
                </Fragment>
              )
            })}
          </>
        )}
        {/* Sits at the foot of the thread, where the reply will land. */}
        {/* While the daemon compacts this session its line takes the activity slot (issue 283); the
            spinner still turns with the pulse. */}
        <CompactionLine state={compaction} tick={activity?.tick ?? 0} />
        {activity && compaction.show !== 'running' ? <ActivityLine activity={activity} /> : null}
        <div ref={listEndRef} />
      </main>

      {/* Screen-reader channel for finished replies (audit #11) — the one live region on the thread.
          It sits OUTSIDE <main> on purpose: main is the scrolling list the user navigates, and a live
          region inside it would announce the rows the reducer mutates PER TOKEN (the delta case
          appends to the same node), i.e. a few hundred announcements per reply. The visible rows stay
          out of the announcement path entirely; this hidden element publishes only settled text, once
          per turn, decided by @shared/live-announce.

          aria-live="polite" (never "assertive": a reply is not an interruption) + aria-atomic="true"
          (announce the whole region, not just the changed fragment). The REGION stays mounted: screen
          readers announce changes inside a live region that already exists, and one inserted together
          with its text is often not announced at all. The seq keys the CHILD instead: React reuses a
          node whose text is unchanged, and a region whose content does not mutate does not re-announce,
          so two identical consecutive replies would silence the second. Replacing the child span is
          the mutation. sr-only keeps it off-screen; aria-hidden is NOT used, that would defeat the
          whole point. */}
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        <span key={announce.seq}>{announce.text}</span>
      </div>

      {detached ? (
        <button
          className={`jump-latest${jumpHasNew(rendered.length, detachBaseline.current) ? ' has-new' : ''}`}
          onClick={jumpToLatest}
          aria-label="Jump to latest message"
        >
          <Icon name="chevron-down" size={11} />
          {jumpLabel(rendered.length, detachBaseline.current)}
        </button>
      ) : null}

      <footer
        className={`composer${dragging ? ' dragging' : ''}`}
        onDrop={onDrop}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
      >
        {voiceNotice ? (
          <div className="voice-notice" role="status">
            {voiceNotice}
          </div>
        ) : null}
        {forkOrigin ? (
          <div className="voice-notice" role="status">
            {forkBanner(forkOrigin, undefined)} — this conversation is a copy up to that point.
          </div>
        ) : null}
        {forkNotice ? (
          <div className="voice-notice" role="status">
            {forkNotice}
          </div>
        ) : null}
        {modelNotice ? (
          <div className="voice-notice" role="status">
            {modelNotice}
          </div>
        ) : null}
        {jumpMiss ? (
          <div className="voice-notice" role="status">
            That message is no longer in this session&rsquo;s history — the search index still has it, the
            conversation store does not.
          </div>
        ) : null}
        {pendingFiles.length > 0 ? (
          <div className="composer-previews">
            {pendingFiles.map((f, i) => {
              const isPdf = f.mimeType === 'application/pdf'
              return (
                <div
                  className="composer-thumb"
                  key={`${f.name}-${i}`}
                  onClick={isPdf ? () => previewPendingPdf(f) : undefined}
                  title={isPdf ? `Preview ${f.name}` : undefined}
                  style={isPdf ? { cursor: 'pointer' } : undefined}
                >
                  {f.isImage ? <img src={f.dataUrl} alt={f.name} /> : <span aria-hidden>{isPdf ? '📄' : '📎'}</span>}
                  <span className="thumb-name">{f.name}</span>
                  <button
                    className="thumb-remove"
                    onClick={(e) => {
                      e.stopPropagation() // the pdf chip is clickable; remove must stay remove
                      removePending(i)
                    }}
                    title="Remove"
                    aria-label={`Remove ${f.name}`}
                  >
                    ✕
                  </button>
                </div>
              )
            })}
          </div>
        ) : null}
        {attachNote ? (
          <div
            role="status"
            style={{ display: 'flex', alignItems: 'baseline', gap: 8, fontSize: 11, color: 'var(--c-err)', padding: '2px 4px' }}
          >
            <span style={{ flex: 1 }}>{attachNote}</span>
            <button
              onClick={() => setAttachNote('')}
              aria-label="Dismiss attachment notice"
              style={{ background: 'transparent', border: 'none', color: 'var(--c-text-dim)', cursor: 'pointer', font: 'inherit' }}
            >
              ✕
            </button>
          </div>
        ) : null}
        {/* Screen 1, row 1, in the handoff's order: the mode control FIRST (it is the thing you
            are choosing), then which model serves it, then the one-shot search arm, then the
            window pressure right-aligned. Voice is the control's third segment, not a fourth
            glyph — see AgentChatToggle for why. */}
        <div className="composer-controls">
          <AgentChatToggle
            mode={mode}
            onChange={(m) => onModeChange?.(m)}
            chatDisabled={chatOptionDisabled(pendingFiles.length)}
            chatDisabledReason="Attachments send in Agent mode — remove them to use Chat"
            voicePhase={onHandsFreeToggle ? handsFreePhase : undefined}
            onVoiceToggle={onHandsFreeToggle}
            voiceDisabled={voiceState !== 'idle'}
          />
          {limited ? null : (
            <ModelSwitcher
              variant="composer"
              models={modelCatalog}
              currentKey={currentModelKey}
              onSelect={(k) => void onSelectModel(k)}
              error={modelError}
              defaultKey={modelDefaultKey}
              fallbackLabel={agentInfo?.model}
            />
          )}
          {/* NO TOOL CHIP, and NO `Search` BUTTON.
              The chip: the spec says "if the count has not resolved, do not render the chip yet",
              and it has not resolved — probed against the live daemon on 2026-09-03, /api/tools,
              /api/tools/{registry,list,enabled,available} and /api/capabilities are all 404, and
              /api/tools/recent is a call TAIL, not a registry. So there is no count. The em dash
              that used to sit here read as a failed load, which is worse than nothing.
              The button: its capability MOVED to `/search <query>` (see parseLocalSlash) rather
              than being deleted — it arms the same one-shot `tool_choice: web_search`. */}
          {/* Right-aligned window pressure, per screen 1. The sessions panel carries the same
              reading (screen 3); this is the one at the moment of sending, which is when "will
              the next message fit" is actually the question. */}
          <span className="composer-ctx">
            <ContextMeter sessionId={sessionId} onOpen={() => window.dispatchEvent(new Event('beacon:open-status'))} variant="composer" />
          </span>
        </div>
        {atChips.length > 0 ? (
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', padding: '0 16px 6px' }} aria-label="References">
            {atChips.map((c, i) => (
              <div className="composer-thumb" key={`${c.type}:${c.target}:${i}`} title={`@${c.type} ${c.target}`}>
                <span aria-hidden>{c.type === 'file' ? '@' : c.type === 'diff' ? '±' : '🔗'}</span>
                <span className="thumb-name">{c.label}</span>
                <button className="thumb-remove" aria-label={`Remove ${c.label}`} onClick={() => setAtChips((prev) => prev.filter((_, j) => j !== i))}>
                  ×
                </button>
              </div>
            ))}
          </div>
        ) : null}
        {atVisible ? (
          <div className="slash-popup" role="listbox" aria-label="References">
            {atList.map((c, i) => (
              <button
                key={`${c.type}:${c.target}`}
                role="option"
                aria-selected={i === atHighlight}
                className={`slash-item${i === atHighlight ? ' slash-item-active' : ''}`}
                onMouseEnter={() => setAtHighlight(i)}
                onMouseDown={(e) => {
                  e.preventDefault() // mousedown not click — the textarea blur would otherwise race the choice
                  chooseAt(c)
                }}
              >
                <span className="slash-name">@{c.label}</span>
                <span className="slash-desc">{c.desc}</span>
              </button>
            ))}
          </div>
        ) : null}
        {slashVisible ? (
          <div className="slash-popup" role="listbox" aria-label="Slash commands">
            {slashList.map((c, i) => (
              <button
                key={c.name}
                role="option"
                aria-selected={i === slashHighlight}
                className={`slash-item${i === slashHighlight ? ' slash-item-active' : ''}${c.web ? '' : ' slash-item-tel'}${c.destructive ? ' slash-item-destructive' : ''}`}
                onMouseEnter={() => setSlashHighlight(i)}
                onMouseDown={(e) => {
                  // mousedown not click — the textarea blur would otherwise race the insert.
                  e.preventDefault()
                  insertSlash(c)
                }}
              >
                <span className="slash-name">/{c.name}</span>
                <span className="slash-desc">{c.desc}</span>
                {/* A destructive command is marked in the popup too, not only at the confirm: the
                    operator should see `/reset` clears context BEFORE choosing it. Mutually
                    exclusive with the Telegram tag by construction — a destructive command runs on
                    web (P9.2), a web:false one is refused there, so a command is never both. */}
                {c.destructive ? <span className="slash-destructive-tag">clears context</span> : null}
                {!c.web ? <span className="slash-tel-tag">Telegram</span> : null}
              </button>
            ))}
          </div>
        ) : null}
        {shotOpen ? (
          <div
            role="dialog"
            aria-label="Capture a screenshot"
            style={{ border: '1px solid var(--c-line)', borderRadius: 8, background: 'var(--c-raise)', padding: 10, marginBottom: 6 }}
          >
            {(() => {
              if (!shotSources && !shotNote) return <div style={{ fontSize: 12, color: 'var(--c-text-dim)' }}>Listing screens…</div>
              const hint = shotSources ? screenAccessHint(shotSources.access) : ''
              if (hint)
                return (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    <div style={{ fontSize: 12, color: 'var(--c-text)' }}>{hint}</div>
                    <div>
                      <button
                        className="attach-btn"
                        style={{ fontSize: 12, width: 'auto', padding: '4px 10px' }}
                        onClick={() => window.beacon?.screenshot.openSettings()}
                      >
                        Open System Settings
                      </button>
                    </div>
                  </div>
                )
              return (
                <>
                  {shotSources && shotSources.sources.length > 0 ? (
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 8, maxHeight: 260, overflowY: 'auto' }}>
                      {shotSources.sources.map((s) => (
                        <button
                          key={s.id}
                          onClick={() => grabShot(s.id)}
                          title={`Capture ${s.name}`}
                          style={{
                            display: 'flex',
                            flexDirection: 'column',
                            gap: 4,
                            padding: 6,
                            border: '1px solid var(--c-line)',
                            borderRadius: 6,
                            background: 'var(--c-inset)',
                            cursor: 'pointer',
                            font: 'inherit',
                            textAlign: 'left'
                          }}
                        >
                          {s.thumbDataUrl ? (
                            <img src={s.thumbDataUrl} alt="" style={{ width: '100%', borderRadius: 4, display: 'block' }} />
                          ) : null}
                          <span style={{ fontSize: 11, color: 'var(--c-text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {s.kind === 'screen' ? '🖥 ' : '▢ '}
                            {s.name}
                          </span>
                        </button>
                      ))}
                    </div>
                  ) : shotSources ? (
                    <div style={{ fontSize: 12, color: 'var(--c-text-dim)' }}>Nothing to capture — no screens or windows listed.</div>
                  ) : null}
                  {shotNote ? (
                    <div style={{ fontSize: 11, color: 'var(--c-text-dim)', marginTop: 6 }} role="status">
                      {shotNote}
                    </div>
                  ) : null}
                </>
              )
            })()}
          </div>
        ) : null}
        {/* ONE container, not six: the textarea and the controls share a single bordered field, so
            the composer reads as a single object rather than a row of competing boxes. */}
        <div className="composer-input-row composer-shell">
          <textarea
            ref={draftRef}
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value)
              setSlashHighlight(0)
              setSlashDismissed(false)
              setAtHighlight(0)
              setAtDismissed(false)
              setAtCaret(e.target.selectionStart ?? e.target.value.length)
            }}
            onSelect={(e) => setAtCaret((e.target as HTMLTextAreaElement).selectionStart ?? 0)}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            placeholder="Message Prometheus…"
            rows={1}
          />
          <div className="composer-actions">
            <div className="composer-tools">
          {/* ONE audio control in this row, not two (R4 — sort by JOB).
              A bare mic and a labelled `Dictate` sat side by side reading as two intensities of
              one feature. They were two different jobs: the mic SENT a voice turn, Dictate TYPES
              into the draft. This row is input methods, so the input method is what stays; the
              send lives in Voice mode, whose overlay has `Hold to talk` — speak one utterance,
              release, it goes. Same capability, on the surface that owns it. */}
          {onDictateToggle ? (
            <button
              className={`attach-btn${dictateState !== 'idle' ? ' voice-active' : ''}${dictateState === 'processing' ? ' is-busy' : ''}`}
              onClick={() => onDictateToggle()}
              disabled={dictateState === 'processing' || !!dictateUnavailableReason(voiceState, sending)}
              title={
                dictateState === 'recording'
                  ? 'Click to stop and insert the transcript'
                  : dictateState === 'processing'
                    ? 'Transcribing…'
                    : (dictateUnavailableReason(voiceState, sending) ??
                      'Dictate into the message box — transcribes only, sends nothing')
              }
              aria-label={
                dictateState === 'recording' ? 'Stop dictating and insert the transcript' : 'Dictate into the message box'
              }
            >
              <Icon
                name={dictateState === 'recording' ? 'stop' : dictateState === 'processing' ? 'loader' : 'mic'}
                size={16}
                strokeWidth={1.6}
              />
            </button>
          ) : null}
          <button
            className="attach-btn"
            onClick={() => fileInputRef.current?.click()}
            disabled={sending || attachDisabledInMode(mode)}
            title={attachDisabledInMode(mode) ? 'Attachments send in Agent mode — switch to Agent to attach' : 'Attach files'}
            aria-label="Attach files"
          >
            <Icon name="paperclip" size={16} strokeWidth={1.6} />
          </button>
          <button
            className="attach-btn"
            onClick={toggleShotPicker}
            disabled={sending || attachDisabledInMode(mode)}
            title={attachDisabledInMode(mode) ? 'Attachments send in Agent mode — switch to Agent to attach' : 'Capture a screenshot'}
            aria-label="Capture a screenshot"
            aria-expanded={shotOpen}
          >
            <Icon name="camera" size={16} strokeWidth={1.6} />
          </button>
          {/* R3: the dock's browser and terminal are reachable from here too, because the reason
              a user opens them is usually to hand something to the agent. Labeled (R4): two
              different jobs, two different words, not two glyphs. */}
          {onToggleDock ? (
            <>
              <span className="composer-divider" aria-hidden />
              <button
                className={`attach-btn attach-btn-labeled${dockPane === 'browser' ? ' is-active' : ''}`}
                onClick={() => onToggleDock('browser')}
                aria-pressed={dockPane === 'browser'}
                title={`${dockPane === 'browser' ? 'Close' : 'Open'} the browser pane (⌘2)`}
              >
                <Icon name="globe" size={15} strokeWidth={1.6} />
                <span>Browser</span>
              </button>
              <button
                className={`attach-btn attach-btn-labeled${dockPane === 'terminal' ? ' is-active' : ''}`}
                onClick={() => onToggleDock('terminal')}
                aria-pressed={dockPane === 'terminal'}
                title={`${dockPane === 'terminal' ? 'Close' : 'Open'} the terminal pane (⌘3)`}
              >
                <Icon name="terminal" size={15} strokeWidth={1.6} />
                <span>Terminal</span>
              </button>
            </>
          ) : null}
            </div>
            <div className="composer-send">
              {/* The newline chord, OUT of the placeholder. Instructions inside a placeholder
                  compete with the prompt for the same line and then vanish the moment the user
                  starts typing — which is the moment they would want them. */}
              <span className="composer-hint">⇧⏎ newline</span>
              {/* P9.1: while a turn streams, Send becomes Stop. The daemon has exposed interrupt on
                  both transports for weeks and Telegram/iOS both had the button; without it the
                  only off switch for a runaway turn was killing the app. `turnLive` is frame-driven
                  (delta/progress/tool_* arm it, done/error clear it), so a turn started — or
                  stopped — in ANOTHER window moves this button too, via the broadcast. */}
              {turnLive ? (
                <button
                  className="send-btn stop-btn"
                  onClick={() => void stopTurn()}
                  disabled={stopping}
                  title="Stop the running turn — the agent keeps what it already produced"
                  aria-label="Stop the running turn"
                >
                  {stopping ? 'Stopping…' : 'Stop'}
                </button>
              ) : (
                <button
                  className="send-btn"
                  onClick={() => void send()}
                  disabled={sending || (draft.trim().length === 0 && pendingFiles.length === 0)}
                >
                  Send <span className="send-key">⏎</span>
                </button>
              )}
            </div>
          </div>
        </div>
        <input ref={fileInputRef} type="file" multiple onChange={onFilePick} style={{ display: 'none' }} />
      </footer>
    </div>
  )
}
