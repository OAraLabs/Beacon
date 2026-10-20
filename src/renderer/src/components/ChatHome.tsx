import { useEffect, useRef, useState } from 'react'
import { appendComposerInsert, type ComposerInsert } from '@shared/browser-pane'
import type { PanelPane } from '@shared/side-panel'
import { attachDisabledInMode, chatOptionDisabled, type ChatMode, type ModelCatalog, type ModelOption } from '@shared/composer-controls'
import { appendDictation, dictateUnavailableReason } from '@shared/dictation'
import { AgentChatToggle } from './AgentChatToggle'
import { ModelSwitcher } from './ModelSwitcher'
import { Icon } from './Icon'
import { stageFiles, type PendingFile } from '../attachments-io'
import { useDeviceRole } from './OwnerOnlyNote'

// Chat home / landing: the new-conversation entry shown when no conversation is open.
//
// THE SAME COMPOSER AS THE THREAD, because it is the same job. It used to be a bare textarea and a
// Start button, so starting a conversation meant sending the first turn with no say over the mode,
// the model, or an attachment — you sent, then changed it, which is a turn wasted. The controls
// here are the thread's, in the thread's order, using the thread's classes.
//
// NOTHING HERE IS SESSION-SCOPED YET, which is the whole design problem: there is no session until
// you submit. So the choices are COLLECTED and handed up with the text; MainView mints the session
// and ChatShell applies them to the first turn (see its initialModelKey / initialFiles). A control
// that could not be honoured that way is not rendered — the context meter is absent, because there
// is no window to report until a session exists.

export interface HomeStart {
  text: string
  mode: ChatMode
  /** null = leave the new session on the daemon's default. */
  modelKey: string | null
  files: PendingFile[]
}

export function ChatHome({
  onSubmit,
  insert = null,
  onInsertConsumed,
  dockPane = null,
  onToggleDock,
  handsFreePhase,
  onHandsFreeToggle,
  dictateState = 'idle',
  onDictateToggle,
  dictated,
  onDictationConsumed,
  voiceNotice = ''
}: {
  onSubmit: (start: HomeStart) => void
  dockPane?: PanelPane | null
  onToggleDock?: (p: PanelPane) => void
  /** Browser pane → this composer (Phase 2); same contract as ChatShell's. */
  insert?: ComposerInsert | null
  onInsertConsumed?: () => void
  /** Hands-free is global (it targets the voice session), so it works with no session open.
   *  Absent → no Voice segment (OAra Voice is not configured; see @shared/voice-gate). */
  handsFreePhase?: 'off' | 'listening' | 'capturing' | 'processing' | 'speaking'
  onHandsFreeToggle?: () => void
  dictateState?: 'idle' | 'recording' | 'processing'
  /** Absent → no dictation button, for the same reason. */
  onDictateToggle?: () => void
  dictated?: { text: string; n: number } | null
  onDictationConsumed?: () => void
  /** The voice line MainView owns (a refused check, a denied mic, hands-free state). Shown here as
   *  in a conversation: a Voice click on Home that fails has to say so on Home. */
  voiceNotice?: string
}) {
  const [draft, setDraft] = useState('')
  const [mode, setMode] = useState<ChatMode>('agent')
  const [files, setFiles] = useState<PendingFile[]>([])
  const [attachNote, setAttachNote] = useState('')
  const ref = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const lastInsertRef = useRef(0)

  // The model catalog, so the chip can offer real rows rather than a label. `currentKey` stays
  // null until something is picked: null means "whatever the daemon defaults to", which is the
  // honest state for a session that does not exist yet.
  const [models, setModels] = useState<ModelOption[]>([])
  const [modelKey, setModelKey] = useState<string | null>(null)
  const [defaultKey, setDefaultKey] = useState('local')
  const [modelError, setModelError] = useState(false)
  // An approved device can't read the catalog (Prometheus refuses it): no chip, rather than a read-only "Local · offline".
  const deviceRole = useDeviceRole()
  const limited = deviceRole === 'limited'
  const roleHeard = deviceRole !== undefined // until main has said, the read waits
  useEffect(() => {
    const b = window.beacon
    if (!b || limited || !roleHeard) return
    let alive = true
    void b.daemon
      .get('/api/models')
      .then((d) => {
        if (!alive) return
        const cat = d as ModelCatalog | null
        if (cat && Array.isArray(cat.models)) {
          setModels(cat.models)
          setDefaultKey(cat.default_key ?? 'local')
        } else setModelError(true)
      })
      .catch(() => alive && setModelError(true))
    return () => {
      alive = false
    }
  }, [limited, roleHeard])

  useEffect(() => {
    if (!insert || insert.n === lastInsertRef.current) return
    lastInsertRef.current = insert.n
    setDraft((d) => appendComposerInsert(d, insert.text))
    onInsertConsumed?.()
    setTimeout(() => ref.current?.focus(), 0)
  }, [insert, onInsertConsumed])

  // A delivered dictation appends to the draft and is then consumed — same contract, and the same
  // nonce guard, as the thread: two identical transcripts are two insertions, and a re-render in
  // between must not re-append the same one.
  const lastDictationRef = useRef(0)
  useEffect(() => {
    if (!dictated || dictated.n === lastDictationRef.current) return
    lastDictationRef.current = dictated.n
    setDraft((d) => appendDictation(d, dictated.text))
    onDictationConsumed?.()
    setTimeout(() => ref.current?.focus(), 0)
  }, [dictated, onDictationConsumed])

  async function addFiles(list: FileList | File[]): Promise<void> {
    const { ok, note } = await stageFiles(list)
    setAttachNote(note)
    if (ok.length > 0) setFiles((prev) => [...prev, ...ok])
  }

  function submit(): void {
    const text = draft.trim()
    if (!text && files.length === 0) return
    setDraft('')
    setFiles([])
    setAttachNote('')
    onSubmit({ text, mode, modelKey, files })
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>): void {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      submit()
    }
  }

  const voiceOn = handsFreePhase !== undefined && handsFreePhase !== 'off'
  return (
    <div className="chat-home">
      <div className="chat-home-inner">
        <div className="chat-home-mark" aria-hidden>
          <span className="brand-dot" />
        </div>
        <h1 className="chat-home-title">Prometheus</h1>
        <p className="chat-home-sub">Pick a session, or start a new one.</p>

        {/* The thread composer's own shell and rows — same classes, so the two cannot drift apart
            visually the way they did when this was a bare textarea. */}
        <footer className="composer chat-home-composer-v2">
          {voiceNotice ? (
            <div className="voice-notice" role="status">
              {voiceNotice}
            </div>
          ) : null}
          {attachNote ? (
            <div className="voice-notice" role="status">
              {attachNote}
            </div>
          ) : null}
          {files.length > 0 ? (
            <div className="composer-previews">
              {files.map((f, i) => (
                <div className="composer-thumb" key={`${f.name}:${i}`} title={f.name}>
                  {f.isImage ? <img src={f.dataUrl} alt="" /> : <span aria-hidden>📄</span>}
                  <span className="thumb-name">{f.name}</span>
                  <button
                    className="thumb-remove"
                    aria-label={`Remove ${f.name}`}
                    onClick={() => setFiles((prev) => prev.filter((_, j) => j !== i))}
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          ) : null}

          <div className="composer-controls">
            <AgentChatToggle
              mode={mode}
              onChange={setMode}
              chatDisabled={chatOptionDisabled(files.length)}
              chatDisabledReason="Attachments send in Agent mode — remove them to use Chat"
              voicePhase={onHandsFreeToggle ? handsFreePhase : undefined}
              onVoiceToggle={onHandsFreeToggle}
            />
            {limited ? null : (
              <ModelSwitcher
                variant="composer"
                models={models}
                currentKey={modelKey}
                onSelect={setModelKey}
                error={modelError}
                defaultKey={defaultKey}
                fallbackLabel="Local"
              />
            )}
            {/* NO CONTEXT METER: there is no session, so there is no window to report. A meter
                reading 0 / 0 here would be a number that means nothing. */}
          </div>

          <div className="composer-input-row composer-shell">
            <textarea
              ref={ref}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={onKeyDown}
              onPaste={(e) => {
                const f = Array.from(e.clipboardData.files)
                if (f.length > 0) {
                  e.preventDefault()
                  void addFiles(f)
                }
              }}
              placeholder="Message Prometheus…"
              rows={1}
              autoFocus
              aria-label="Start a new conversation"
            />
            <div className="composer-actions">
              <div className="composer-tools">
                {onDictateToggle ? (
                  <button
                    className={`attach-btn${dictateState !== 'idle' ? ' voice-active' : ''}${dictateState === 'processing' ? ' is-busy' : ''}`}
                    onClick={() => onDictateToggle()}
                    disabled={dictateState === 'processing' || !!dictateUnavailableReason('idle', false)}
                    title={
                      dictateState === 'recording'
                        ? 'Click to stop and insert the transcript'
                        : dictateState === 'processing'
                          ? 'Transcribing…'
                          : 'Dictate into the message box — transcribes only, sends nothing'
                    }
                    aria-label="Dictate into the message box"
                  >
                    <Icon name={dictateState === 'recording' ? 'stop' : dictateState === 'processing' ? 'loader' : 'mic'} size={16} strokeWidth={1.6} />
                  </button>
                ) : null}
                <button
                  className="attach-btn"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={attachDisabledInMode(mode)}
                  title={attachDisabledInMode(mode) ? 'Attachments send in Agent mode — switch to Agent to attach' : 'Attach files'}
                  aria-label="Attach files"
                >
                  <Icon name="paperclip" size={16} strokeWidth={1.6} />
                </button>
                {/* NO SCREENSHOT BUTTON: capture routes through the session's own picker and
                    lands in that session's composer. With no session there is nowhere for the
                    capture to go, so the control is absent rather than inert. */}
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
                <span className="composer-hint">⇧⏎ newline</span>
                <button className="send-btn" onClick={submit} disabled={!draft.trim() && files.length === 0}>
                  {/* `Start`, not `Send` — this one mints the conversation. */}
                  Start <span className="send-key">⏎</span>
                </button>
              </div>
            </div>
          </div>
          <input ref={fileInputRef} type="file" multiple onChange={(e) => { if (e.target.files) void addFiles(e.target.files); e.target.value = '' }} style={{ display: 'none' }} />
        </footer>
        {voiceOn ? <p className="chat-home-sub">Voice mode is on — speak, or type below.</p> : null}
      </div>
    </div>
  )
}
