import { useEffect, useRef, useState, type CSSProperties } from 'react'
import type { SessionSummary } from '@shared/ipc'
import { screenAccessHint, screenshotFilename, type CaptureSourcesResult } from '@shared/capture'
import { CAPTURE_DEFAULT_TARGET, CAPTURE_NEW_TARGET, CAPTURE_TARGET_KEY, captureCanSend, captureTargets, storedCaptureTarget } from '@shared/quick-capture'
import { BEACON_GATEWAY } from '@shared/session-sources'
import { sendUploads, stagedScreenshot, stageFiles, type PendingFile } from '../attachments-io'
import { Icon } from './Icon'

// Quick Capture (Makeover Slice 10, Track C #4) — the spotlight-style mini composer the
// ⌘⇧Space/Ctrl+Shift+Space global hotkey summons. Sends through the SAME chat:send path (cache +
// outbox + durable re-key), streams the reply inline, Esc hides, ⏎ sends, "Open in Beacon"
// focuses the main window on the session. Rendered when the window loads with #capture.
//
// It carries more than text (@shared/quick-capture): ⌘V of files or an image, files from a picker,
// and a screenshot, all staged as chips and sent on the main composer's upload path. The target
// can be a new conversation. Dropping a file from another app is not offered: clicking that app
// takes focus, and this window hides when it loses focus.


const shell: CSSProperties = {
  height: '100vh',
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
  padding: 14,
  background: 'var(--c-base)',
  border: '1px solid var(--c-line-bright)',
  borderRadius: 'var(--r-4)',
  overflow: 'hidden'
}
const inputRow: CSSProperties = { display: 'flex', alignItems: 'center', gap: 10 }
const textArea: CSSProperties = {
  flex: 1,
  resize: 'none',
  background: 'var(--c-inset)',
  color: 'var(--c-text)',
  border: '1px solid var(--c-line)',
  borderRadius: 'var(--r-3)',
  padding: '9px 12px',
  font: 'inherit',
  outline: 'none'
}
const replyBox: CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflowY: 'auto',
  fontSize: 13,
  lineHeight: 1.5,
  color: 'var(--c-text)',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
  background: 'var(--c-raise)',
  border: '1px solid var(--c-line)',
  borderRadius: 'var(--r-3)',
  padding: '9px 12px'
}
const footRow: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  fontSize: 11,
  color: 'var(--c-text-faint)'
}
const selectStyle: CSSProperties = {
  fontSize: 11,
  padding: '3px 7px',
  borderRadius: 'var(--r-2)',
  border: '1px solid var(--c-line)',
  background: 'var(--c-inset)',
  color: 'var(--c-text-dim)',
  font: 'inherit',
  maxWidth: 220
}
const linkBtn: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 5,
  fontSize: 11,
  padding: '3px 9px',
  borderRadius: 'var(--r-2)',
  border: '1px solid var(--c-line)',
  background: 'transparent',
  color: 'var(--c-arc)',
  cursor: 'pointer',
  font: 'inherit'
}

const toolBtn = (disabled = false): CSSProperties => ({
  display: 'inline-flex',
  alignItems: 'center',
  gap: 5,
  fontSize: 11,
  padding: '3px 8px',
  borderRadius: 'var(--r-2)',
  border: '1px solid var(--c-line)',
  background: 'transparent',
  color: disabled ? 'var(--c-text-faint)' : 'var(--c-text-dim)',
  cursor: disabled ? 'not-allowed' : 'pointer',
  font: 'inherit'
})
const chip: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  maxWidth: 190,
  padding: '3px 7px',
  fontSize: 11,
  color: 'var(--c-text)',
  background: 'var(--c-inset)',
  border: '1px solid var(--c-line)',
  borderRadius: 'var(--r-2)'
}
const noteStyle: CSSProperties = { fontSize: 11, color: 'var(--c-warn-text)', lineHeight: 1.4 }
const pickerBox: CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflowY: 'auto',
  background: 'var(--c-raise)',
  border: '1px solid var(--c-line)',
  borderRadius: 'var(--r-3)',
  padding: 8
}
const sourceBtn = (disabled = false): CSSProperties => ({
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
  padding: 5,
  border: '1px solid var(--c-line)',
  borderRadius: 'var(--r-2)',
  background: 'var(--c-inset)',
  color: disabled ? 'var(--c-text-faint)' : 'var(--c-text-dim)',
  cursor: disabled ? 'not-allowed' : 'pointer',
  font: 'inherit',
  fontSize: 11,
  textAlign: 'left',
  minWidth: 0
})

export function QuickCapture() {
  const [draft, setDraft] = useState('')
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [target, setTarget] = useState(CAPTURE_DEFAULT_TARGET)
  const [started, setStarted] = useState<string | null>(null)
  const [reply, setReply] = useState('')
  const [streaming, setStreaming] = useState(false)
  const [sending, setSending] = useState(false)
  const [files, setFiles] = useState<PendingFile[]>([])
  const [note, setNote] = useState('')
  // The screenshot picker: null = closed; `sources` null = still listing.
  const [picker, setPicker] = useState<{ sources: CaptureSourcesResult | null; busy: boolean } | null>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const targetRef = useRef(target)
  useEffect(() => {
    targetRef.current = target
  }, [target])

  // Session choices + last-used target; refresh whenever the mini window regains focus.
  useEffect(() => {
    const b = window.beacon
    if (!b) return
    const load = (): void => {
      void b.sessions.list().then(setSessions).catch(() => undefined)
      inputRef.current?.focus()
    }
    void b.settings
      .get(CAPTURE_TARGET_KEY)
      .then((v) => setTarget(storedCaptureTarget(v)))
      .catch(() => undefined)
    load()
    window.addEventListener('focus', load)
    return () => window.removeEventListener('focus', load)
  }, [])

  // Ride the broadcast stream; render only the chosen session's reply.
  useEffect(() => {
    const b = window.beacon
    if (!b) return
    const off = b.chat.onStream((f) => {
      if (!('sessionId' in f) || f.sessionId !== targetRef.current) return
      if (f.kind === 'delta') {
        setStreaming(true)
        setReply((r) => r + f.content)
      } else if (f.kind === 'done') {
        setStreaming(false)
      }
    })
    return off
  }, [])

  const addFiles = async (list: FileList | File[]): Promise<void> => {
    const { ok, note: refused } = await stageFiles(list)
    setNote(refused)
    if (ok.length > 0) setFiles((prev) => [...prev, ...ok])
    inputRef.current?.focus()
  }

  const pickFiles = (): void => {
    // The picker takes focus, and this window hides when it loses focus: ask main to hold it up.
    // Main drops the hold when focus comes back (a choice or a cancel) and after two minutes.
    window.beacon?.capture.hold(true)
    fileInputRef.current?.click()
  }

  const openPicker = (): void => {
    const b = window.beacon
    if (!b) return
    setNote('')
    setPicker({ sources: null, busy: false })
    void b.screenshot
      .sources()
      .then((sources) => setPicker((p) => (p ? { ...p, sources } : p)))
      .catch(() => {
        setPicker(null)
        setNote('Could not list what can be captured. Try again.')
      })
  }

  const shoot = (sourceId: string): void => {
    const b = window.beacon
    if (!b || picker?.busy) return
    setPicker((p) => (p ? { ...p, busy: true } : p))
    // Main hides this window for the shot and shows it again; the state here rides through.
    void b.capture
      .shot(sourceId)
      .then((r) => {
        if (!r.ok) {
          setNote(r.error)
          setPicker((p) => (p ? { ...p, busy: false } : p))
          return
        }
        setFiles((prev) => [...prev, stagedScreenshot(r.base64, r.mimeType, screenshotFilename(Date.now(), r.mimeType))])
        setNote('')
        setPicker(null)
        inputRef.current?.focus()
      })
      .catch(() => {
        setNote('The capture failed. Try again.')
        setPicker((p) => (p ? { ...p, busy: false } : p))
      })
  }

  const send = async (): Promise<void> => {
    if (!captureCanSend(draft, files.length, sending)) return
    const b = window.beacon
    if (!b) return
    const text = draft.trim()
    const staged = files
    setSending(true)
    setNote('')
    try {
      let sessionId = target
      if (sessionId === CAPTURE_NEW_TARGET) {
        // Declares its gateway, as the main window's New chat does (@shared/session-sources).
        const res = (await b.daemon.write('/api/sessions', { gateway: BEACON_GATEWAY }, 'POST').catch(() => null)) as { session_id?: string } | null
        if (!res?.session_id) {
          // Nothing was cleared: the text and the files are still here to send again.
          setNote('Could not start a new conversation. Check the connection and try again.')
          return
        }
        sessionId = res.session_id
        targetRef.current = sessionId
        setStarted(sessionId)
        setTarget(sessionId)
      }
      setReply('')
      setStreaming(true)
      setDraft('')
      setFiles([])
      setPicker(null)
      void b.settings.set(CAPTURE_TARGET_KEY, sessionId).catch(() => undefined)
      try {
        if (staged.length > 0) await sendUploads((req) => b.chat.upload(req), sessionId, staged, text)
        else await b.chat.send({ sessionId, message: text, clientMsgId: crypto.randomUUID() })
      } catch (err) {
        // Put back what did not go, so a dropped connection does not cost the capture.
        setStreaming(false)
        setDraft(text)
        setFiles(staged)
        setNote(`Not sent: ${err instanceof Error ? err.message : String(err)}`)
      }
    } finally {
      setSending(false)
    }
  }

  const onKey = (e: React.KeyboardEvent): void => {
    if (e.key === 'Enter' && !e.shiftKey && e.target === inputRef.current) {
      e.preventDefault()
      void send()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      // Esc backs out of the screenshot picker first, then closes the box.
      if (picker) return setPicker(null)
      // Destroys this window (a renderer window.close() never reaches main's cancelable 'close';
      // measured on Electron 33 — scripts/electron-close-semantics-probe.js). Right for a transient
      // box: the next toggle recreates it with a fresh, empty field.
      window.close()
    }
  }

  const hint = picker?.sources ? screenAccessHint(picker.sources.access) : ''
  return (
    <div style={shell} onKeyDown={onKey}>
      <div style={inputRow}>
        <span style={{ color: 'var(--c-arc)', display: 'inline-flex', flexShrink: 0 }} aria-hidden>
          <Icon name="zap" size={16} />
        </span>
        <textarea
          ref={inputRef}
          style={textArea}
          rows={2}
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onPaste={(e) => {
            const pasted = Array.from(e.clipboardData.files)
            if (pasted.length > 0) {
              e.preventDefault()
              void addFiles(pasted)
            }
          }}
          placeholder="Ask Prometheus…  (Enter to send · ⌘V adds a copied file or image · Esc to hide)"
          spellCheck={false}
          aria-label="Message"
        />
      </div>

      {files.length > 0 ? (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }} aria-label="Attached">
          {files.map((f, i) => (
            <span style={chip} key={`${f.name}:${i}`} title={f.name}>
              {f.isImage ? <img src={f.dataUrl} alt="" style={{ maxHeight: 22, maxWidth: 36, borderRadius: 3, display: 'block' }} /> : <Icon name="paperclip" size={11} />}
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.name}</span>
              <button
                aria-label={`Remove ${f.name}`}
                onClick={() => setFiles((prev) => prev.filter((_, j) => j !== i))}
                style={{ background: 'transparent', border: 'none', color: 'var(--c-text-dim)', cursor: 'pointer', padding: 0, font: 'inherit', lineHeight: 1 }}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      ) : null}

      {note ? (
        <div style={noteStyle} role="status">
          {note}
        </div>
      ) : null}

      {picker ? (
        <div style={pickerBox} role="dialog" aria-label="Capture a screenshot">
          {!picker.sources ? (
            <div style={{ fontSize: 12, color: 'var(--c-text-dim)' }}>Listing screens…</div>
          ) : hint ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'flex-start' }}>
              <div style={{ fontSize: 12, color: 'var(--c-text)' }}>{hint}</div>
              <button style={toolBtn()} onClick={() => window.beacon?.screenshot.openSettings()}>
                Open System Settings
              </button>
            </div>
          ) : picker.sources.sources.length === 0 ? (
            <div style={{ fontSize: 12, color: 'var(--c-text-dim)' }}>Nothing to capture was found.</div>
          ) : (
            <>
              <div style={{ fontSize: 11, color: 'var(--c-text-faint)', marginBottom: 6 }}>
                {picker.busy ? 'Capturing…' : 'Pick what to capture. This box steps out of the picture.'}
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(130px, 1fr))', gap: 6 }}>
                {picker.sources.sources.map((s) => (
                  <button key={s.id} style={sourceBtn(picker.busy)} disabled={picker.busy} onClick={() => shoot(s.id)} title={`Capture ${s.name}`}>
                    {s.thumbDataUrl ? <img src={s.thumbDataUrl} alt="" style={{ width: '100%', borderRadius: 3, display: 'block' }} /> : null}
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.name}</span>
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      ) : reply || streaming ? (
        <div style={replyBox}>
          {reply}
          {streaming ? <span className="caret" /> : null}
        </div>
      ) : null}

      <div style={footRow}>
        <select style={selectStyle} value={target} onChange={(e) => setTarget(e.target.value)} aria-label="Send to" title="Send to">
          {captureTargets(sessions, target, undefined, started).map((t) => (
            <option key={t.value} value={t.value}>
              {t.label}
            </option>
          ))}
        </select>
        <button style={toolBtn()} onClick={pickFiles} title="Attach files" aria-label="Attach files">
          <Icon name="paperclip" size={12} />
        </button>
        <button
          style={toolBtn()}
          onClick={() => (picker ? setPicker(null) : openPicker())}
          title="Attach a screenshot"
          aria-label="Attach a screenshot"
          aria-pressed={picker !== null}
        >
          <Icon name="camera" size={12} />
        </button>
        <span style={{ flex: 1 }} />
        {target !== CAPTURE_NEW_TARGET ? (
          <button style={linkBtn} onClick={() => window.beacon?.capture.openMain(target)}>
            Open in Beacon <Icon name="chevron-right" size={11} />
          </button>
        ) : null}
      </div>
      <input
        ref={fileInputRef}
        type="file"
        multiple
        style={{ display: 'none' }}
        onChange={(e) => {
          if (e.target.files) void addFiles(e.target.files)
          e.target.value = ''
        }}
      />
    </div>
  )
}
