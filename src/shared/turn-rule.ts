// The separator between turns: `TURN 11 · 22:41`.
//
// It used to read `TURN`. A bare label costs the same vertical space as a numbered one and carries
// nothing — you cannot say which exchange you are looking at, or when it happened, which is the
// only reason to draw a rule there at all. So the number and the clock ARE the separator.
//
// Numbering runs over the WHOLE conversation, not the rendered window. ChatShell mounts only the
// last RENDER_WINDOW rows by default; numbering the window would restart at 1 partway through a
// long session and quietly disagree with itself the moment "Show earlier" was clicked.
//
// Pure (no React) so the renderer and a smoke share one implementation.

import { isMachineNotice } from './machine-notice'
import { hasVoicePreamble } from './voice-preamble'

export interface TurnRow {
  key: string
  role: string
  /** Flat text of the row — the caller flattens; this module does not know about ContentPart. */
  text: string
  /** Epoch ms, when the row carries one. Absent on optimistic rows the daemon has not echoed. */
  createdAt?: number
  /**
   * The row has NOTHING to show — not merely no text.
   *
   * A user message can be an image with no caption, and its flat text is empty because `flatText`
   * only reads text parts. Judging emptiness by text alone therefore dropped a real turn: a
   * screenshot someone sent IS a turn, and the separator above it went missing along with the
   * numbering of everything after it. The caller knows whether the row has renderable content of
   * any kind, so the caller says.
   */
  blank?: boolean
}

export interface TurnMark {
  /** 1-based, over the whole conversation. */
  n: number
  /** Epoch ms, or null when the row carried none — the label then shows the number alone. */
  at: number | null
  /** The turn was spoken: its user message arrived with the voice-mode preamble. */
  voice: boolean
}

/**
 * Mark every row that OPENS a turn.
 *
 * A turn opens at a user message a person actually typed. A machine notice ([FILE MUTATION
 * VERIFIER]) arrives with the user role and is a tool result, so it opens nothing — otherwise the
 * count inflates by one for every file-touching turn and the numbers stop matching the exchanges.
 * An empty user row (all whitespace) is not a turn either.
 */
export function turnMarks(rows: TurnRow[]): Map<string, TurnMark> {
  const marks = new Map<string, TurnMark>()
  let n = 0
  for (const r of rows) {
    if (r.role !== 'user') continue
    const text = r.text ?? ''
    // `blank` when the caller said so; otherwise fall back to the text, which is right for the
    // string-content rows that carry no parts at all.
    if (r.blank ?? !text.trim()) continue
    if (isMachineNotice(text)) continue
    n += 1
    marks.set(r.key, {
      n,
      at: typeof r.createdAt === 'number' && Number.isFinite(r.createdAt) ? r.createdAt : null,
      voice: hasVoicePreamble(text)
    })
  }
  return marks
}

/** `22:41` — 24-hour wall clock, zero-padded, in the viewer's own zone. */
export function clockLabel(at: number | null): string {
  if (at === null || !Number.isFinite(at)) return ''
  const d = new Date(at)
  if (Number.isNaN(d.getTime())) return ''
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** `TURN 11 · 22:41`, or `TURN 11` when the row carried no timestamp. Never a bare `TURN`. */
export function turnLabel(mark: TurnMark): string {
  const clock = clockLabel(mark.at)
  return clock ? `TURN ${mark.n} · ${clock}` : `TURN ${mark.n}`
}
