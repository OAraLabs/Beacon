// The voice-mode system prompt that arrives INSIDE the user's own message.
//
// A hands-free turn is sent to the daemon with a spoken-style instruction glued to the front:
//
//   [Voice mode] Respond in at most 2 short spoken sentences. No markdown, no lists, no code
//   blocks, no emoji. If the full answer is long, give the headline and say the detail is
//   available on screen.
//
//   Make one out.
//
// (Captured from the wire — `beacon.db`, 2026-09-03 — not paraphrased from the design note.)
//
// The daemon stores the whole thing as the user's message, so the transcript printed 190
// characters of plumbing above four words the person actually said. That is R13 — never surface
// machine syntax raw — and it is attributed to a human who never typed it.
//
// So: strip it from DISPLAY and mark the turn `voice` instead. Nothing is deleted — the raw row is
// what was sent and what export writes. What you can SEE is what copy and edit-into-a-branch take,
// which is the point: copying a message should not hand you 190 characters you were never shown.
// Pure (no React) so the renderer and a smoke share one parser.

import type { ContentPart } from './parts'

/** The tag, anchored to the start. Matching only the TAG (not the sentence after it) means a
 *  reworded prompt still strips — the wording is the daemon's to change, the bracket is the
 *  contract. Case-insensitive because it is a label, not an identifier. */
const TAG = /^\s*\[voice mode\]/i

/** True when this message text opens with the voice-mode preamble. */
export function hasVoicePreamble(text: string): boolean {
  return TAG.test(text ?? '')
}

/**
 * The text with the preamble removed.
 *
 * The preamble runs to the first BLANK line — that is the separator the daemon writes, and the one
 * thing here that is structural rather than a guess about wording. A message that is nothing but
 * the preamble (no blank line) strips to empty, which is correct: the person said nothing that
 * turn, so there is nothing to print. Text without the tag is returned untouched.
 */
export function stripVoicePreamble(text: string): string {
  const s = text ?? ''
  if (!TAG.test(s)) return s
  const brk = s.search(/\r?\n[ \t]*\r?\n/)
  if (brk < 0) return ''
  return s.slice(brk).replace(/^(\r?\n[ \t]*)+/, '')
}

/**
 * The same strip over structured content. ONLY the leading text block is considered: a `[Voice
 * mode]` string appearing later in a turn is the user quoting it, not plumbing, and rewriting that
 * would be editing what they said. A leading block that strips to nothing is dropped, so a
 * voice turn carrying an image and no words renders as the image alone.
 */
export function stripVoiceParts(content: string | ContentPart[]): string | ContentPart[] {
  if (typeof content === 'string') return stripVoicePreamble(content)
  const i = content.findIndex((p) => p.type === 'text')
  if (i < 0) return content
  const first = content[i]
  if (!hasVoicePreamble(first.text ?? '')) return content
  const stripped = stripVoicePreamble(first.text ?? '')
  const out = content.slice()
  if (stripped) out[i] = { ...first, text: stripped }
  else out.splice(i, 1)
  return out
}

/** True when this message (flat or structured) opens with the preamble — i.e. it was a voice turn. */
export function isVoiceTurn(content: string | ContentPart[]): boolean {
  if (typeof content === 'string') return hasVoicePreamble(content)
  const first = content.find((p) => p.type === 'text')
  return hasVoicePreamble(first?.text ?? '')
}
