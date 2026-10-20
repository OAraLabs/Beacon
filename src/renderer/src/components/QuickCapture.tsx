import { useEffect, useRef, useState, type CSSProperties } from 'react'
import type { SessionSummary } from '@shared/ipc'
import { Icon } from './Icon'

// Quick Capture (Makeover Slice 10, Track C #4) — the spotlight-style mini composer the
// ⌘⇧Space/Ctrl+Shift+Space global hotkey summons. Sends through the SAME chat:send path (cache +
// outbox + durable re-key), streams the reply inline, Esc hides, ⏎ sends, "Open in Beacon"
// focuses the main window on the session. Rendered when the window loads with #capture.

const DEFAULT_TARGET = 'desktop:quick'
const LAST_TARGET_KEY = 'capture:session'

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

export function QuickCapture() {
  const [draft, setDraft] = useState('')
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [target, setTarget] = useState(DEFAULT_TARGET)
  const [reply, setReply] = useState('')
  const [streaming, setStreaming] = useState(false)
  const [sending, setSending] = useState(false)
  const inputRef = useRef<HTMLTextAreaElement>(null)
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
      .get(LAST_TARGET_KEY)
      .then((v) => {
        if (v) setTarget(v)
      })
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

  const send = async (): Promise<void> => {
    const text = draft.trim()
    if (!text || sending) return
    const b = window.beacon
    if (!b) return
    setSending(true)
    setReply('')
    setStreaming(true)
    setDraft('')
    void b.settings.set(LAST_TARGET_KEY, target).catch(() => undefined)
    try {
      await b.chat.send({ sessionId: target, message: text, clientMsgId: crypto.randomUUID() })
    } catch (err) {
      setStreaming(false)
      setReply(`send failed: ${String(err)}`)
    } finally {
      setSending(false)
    }
  }

  const onKey = (e: React.KeyboardEvent): void => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void send()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      // Destroys this window (a renderer window.close() never reaches main's cancelable 'close';
      // measured on Electron 33 — scripts/electron-close-semantics-probe.js). Right for a transient
      // box: the next toggle recreates it with a fresh, empty field.
      window.close()
    }
  }

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
          placeholder="Ask Prometheus…  (Enter to send · Esc to hide)"
          spellCheck={false}
        />
      </div>

      {reply || streaming ? (
        <div style={replyBox}>
          {reply}
          {streaming ? <span className="caret" /> : null}
        </div>
      ) : null}

      <div style={footRow}>
        <select style={selectStyle} value={target} onChange={(e) => setTarget(e.target.value)} aria-label="Target session" title="Target session">
          {!sessions.some((s) => s.id === target) ? <option value={target}>{target}</option> : null}
          {sessions.map((s) => (
            <option key={s.id} value={s.id}>
              {s.id}
            </option>
          ))}
        </select>
        <span style={{ flex: 1 }} />
        <button style={linkBtn} onClick={() => window.beacon?.capture.openMain(target)}>
          Open in Beacon <Icon name="chevron-right" size={11} />
        </button>
      </div>
    </div>
  )
}
