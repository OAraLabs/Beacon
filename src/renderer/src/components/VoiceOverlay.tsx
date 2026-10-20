import { useEffect, useRef, useState } from 'react'
import type { HandsFreeState } from '@shared/hands-free'
import { elapsedClock, overlayStatus } from '@shared/voice-overlay'

// The hands-free overlay (match spec, "Voice overlay").
//
// Hands-free ALREADY worked before this — mic, VAD, barge-in, the whole state machine — but the
// only thing it put on screen was a one-line notice above the composer. So the mode was, in the
// user's words, unreachable: you pressed Voice, something happened, and the window looked the
// same. This is the missing half. It renders the state that was already there.
//
// A MODAL, not a dock pane, and the reason is in the spec: hands-free takes over rather than
// sitting beside your work. You are not at the keyboard — the window should say so.

const BARS = 19

/** Per-bar geometry, fixed at module scope. Randomising on every render would re-roll the whole
 *  row 60 times a second and read as noise rather than as a level. */
const BAR = Array.from({ length: BARS }, (_, i) => {
  // A deterministic spread — not Math.random(), so the row looks the same every time it opens.
  const t = (i / (BARS - 1)) * Math.PI
  return {
    height: 14 + Math.round(Math.sin(t) * 40), // 14 → 54 → 14, tallest in the middle
    duration: 0.7 + ((i * 7) % 6) / 10, // 0.7 – 1.2s
    delay: ((i * 11) % 7) / 10 // 0 – 0.6s, so the row never pulses in unison
  }
})

export function VoiceOverlay({
  state,
  startedAt,
  level,
  transcript,
  agentName,
  holding,
  onHoldChange,
  onSend,
  canSend,
  onClose
}: {
  state: HandsFreeState
  /** Epoch ms the mic opened — the timer counts from here, not from mount. */
  startedAt: number
  /** Live input level, 0–1, measured off the same chunks the VAD receives. */
  level: number
  /** The last utterance the bridge transcribed. Empty until the first turn comes back. */
  transcript: string
  agentName: string
  holding: boolean
  onHoldChange: (held: boolean) => void
  onSend: () => void
  canSend: boolean
  onClose: () => void
}) {
  const [now, setNow] = useState(() => Date.now())
  const panelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 500)
    return () => clearInterval(t)
  }, [])

  // Esc closes. Captured on the WINDOW, not the panel: the user is across the room and has not
  // clicked anything, so nothing inside here has focus to receive a keydown.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  useEffect(() => {
    panelRef.current?.focus()
  }, [])

  return (
    <div
      className="voice-scrim"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="voice-panel" role="dialog" aria-modal="true" aria-label="Hands-free voice" ref={panelRef} tabIndex={-1}>
        <div className="voice-status">
          <span className="voice-status-dot" aria-hidden />
          <span className="voice-status-text">
            {overlayStatus(state.phase, holding)} · {elapsedClock(now - startedAt)}
          </span>
        </div>

        {/* The bars are driven by the REAL input level when there is one; the canned animation is
            what runs when the level is zero (between utterances), not the whole story. */}
        <div className="voice-wave" aria-hidden data-live={level > 0.02 ? '1' : '0'}>
          {BAR.map((b, i) => (
            <span
              key={i}
              className="voice-bar"
              style={{
                height: b.height,
                animationDuration: `${b.duration}s`,
                animationDelay: `${b.delay}s`,
                transform: level > 0.02 ? `scaleY(${Math.max(0.25, Math.min(1, level * 3 * (0.6 + b.height / 90)))})` : undefined
              }}
            />
          ))}
        </div>

        <p className="voice-transcript">
          {transcript ? `“${transcript}”` : <span className="voice-transcript-wait">Listening — say something.</span>}
        </p>

        <div className="voice-actions">
          {/* HOLD suppresses the auto-send: while it is down, a pause in your sentence does not
              end the turn. Released, the utterance goes. This is the control for the case the
              VAD gets wrong — thinking mid-sentence. */}
          <button
            type="button"
            className={`voice-btn${holding ? ' is-held' : ''}`}
            onMouseDown={() => onHoldChange(true)}
            onMouseUp={() => onHoldChange(false)}
            onMouseLeave={() => holding && onHoldChange(false)}
            onKeyDown={(e) => e.key === ' ' && onHoldChange(true)}
            onKeyUp={(e) => e.key === ' ' && onHoldChange(false)}
          >
            Hold to talk
          </button>
          <button type="button" className="voice-btn voice-btn-send" onClick={onSend} disabled={!canSend}>
            Send to {agentName}
          </button>
        </div>

        {/* One fact, not three claims. `auto-send on pause` is what the VAD actually does and is
            the setting that changes what this overlay does. The spec also lists `whisper · local`
            and `voice: nova`; the bridge reports neither — POST /bridge/voice returns a
            transcript, a reply and stage timings, and there is no config route — so printing them
            would be decoration that lies about where your audio goes. */}
        <div className="voice-foot">
          <span>{holding ? 'hold released to send' : 'auto-send on pause'}</span>
          {state.turns > 0 ? <span>{state.turns} turns</span> : null}
          {state.bargeIns > 0 ? <span>{state.bargeIns} barge-ins</span> : null}
        </div>
      </div>
    </div>
  )
}
