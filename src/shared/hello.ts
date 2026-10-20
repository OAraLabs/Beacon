// "Say hello to your assistant" (F1): the end of both paths, and the first proof that the whole thing works
// (docs/ONBOARDING-v0.4.0.md, §4). The logic is pure so a headless smoke can walk every way it can go: compose,
// send, wait, the three ways it goes wrong (no answer in time, the computer gone, the computer refusing), and the
// first reply. The component only performs the sends and the polling and feeds each outcome in as an event.
//
// No Node/Electron imports (same rule as shared/setup-wizard.ts).

/** How long to wait for a first answer before saying so. A model can take a while on its first load. */
export const DEFAULT_HELLO_TIMEOUT_MS = 120_000

export type HelloPhase = 'compose' | 'sending' | 'waiting' | 'slow' | 'lost' | 'refused' | 'done'

export interface HelloState {
  phase: HelloPhase
  /** What is in the field. */
  text: string
  /** The conversation the message went into, once there is one (a retry reuses it). */
  session: string | null
  /** The first reply, cleaned for display. */
  reply: string
  /** When the current wait began (ms), for the timeout. */
  waitingSince: number
}

export type HelloEvent =
  | { type: 'edit'; text: string }
  | { type: 'send' } // compose → sending
  | { type: 'session'; id: string } // the conversation exists (kept even if the send then fails, so a retry reuses it)
  | { type: 'sent'; session: string; at: number } // sending → waiting
  | { type: 'failed'; kind: 'lost' | 'refused' }
  | { type: 'tick'; now: number; timeoutMs: number }
  | { type: 'reply'; text: string }
  | { type: 'keepWaiting'; at: number } // slow → waiting, the clock restarted
  | { type: 'retry' } // slow, lost or refused → sending

export function initialHello(prefill: string): HelloState {
  return { phase: 'compose', text: prefill, session: null, reply: '', waitingSince: 0 }
}

export function helloReduce(s: HelloState, e: HelloEvent): HelloState {
  switch (e.type) {
    case 'edit':
      return s.phase === 'compose' ? { ...s, text: e.text } : s
    case 'send':
      return s.phase === 'compose' && s.text.trim().length > 0 ? { ...s, phase: 'sending' } : s
    case 'session':
      return s.phase === 'sending' ? { ...s, session: e.id } : s
    case 'sent':
      return s.phase === 'sending' ? { ...s, phase: 'waiting', session: e.session, waitingSince: e.at } : s
    case 'failed':
      return s.phase === 'sending' || s.phase === 'waiting' || s.phase === 'slow' ? { ...s, phase: e.kind } : s
    case 'tick':
      return s.phase === 'waiting' && e.now - s.waitingSince >= e.timeoutMs ? { ...s, phase: 'slow' } : s
    case 'reply':
      // A late answer still finishes it: the model was only slow.
      return s.phase === 'waiting' || s.phase === 'slow' ? { ...s, phase: 'done', reply: e.text } : s
    case 'keepWaiting':
      return s.phase === 'slow' ? { ...s, phase: 'waiting', waitingSince: e.at } : s
    case 'retry':
      return s.phase === 'slow' || s.phase === 'lost' || s.phase === 'refused' ? { ...s, phase: 'sending' } : s
  }
}

/** Control, zero-width and bidirectional-override characters: none belong in text shown as someone's words
 *  (newlines and tabs stay). The same set the discovery model strips from a computer's name. */
// eslint-disable-next-line no-control-regex
const UNSAFE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2069\ufeff]/g

export const MAX_REPLY_CHARS = 1_000

/** The assistant's words, for display: cleaned, trimmed, and cut at MAX_REPLY_CHARS with an ellipsis. */
export function displayReply(text: string): string {
  const t = text.replace(UNSAFE, '').trim()
  return t.length <= MAX_REPLY_CHARS ? t : `${t.slice(0, MAX_REPLY_CHARS).trimEnd()}…`
}

/** The first assistant message with something in it, from GET /api/sessions/{id}/messages, or null. */
export function firstReply(raw: unknown): string | null {
  const messages = (raw as { messages?: unknown } | null)?.messages
  if (!Array.isArray(messages)) return null
  for (const m of messages) {
    const r = m as { role?: unknown; content?: unknown }
    if (r?.role !== 'assistant' || typeof r.content !== 'string') continue
    const text = displayReply(r.content)
    if (text) return text
  }
  return null
}

/** What a failed call to the computer means to the person. A reply with a status (the computer answered, and
 *  said no) is not "we lost touch"; anything else (refused connection, timeout, no route) is. */
export function failureKind(err: unknown): 'lost' | 'refused' {
  const msg = err instanceof Error ? err.message : String(err)
  return /\bHTTP \d{3}\b/.test(msg) ? 'refused' : 'lost'
}

/** The wait before "No answer yet": 2 minutes, or what a dev or probe build is told. A release build ignores it. */
export function helloTimeoutMs(raw: Readonly<Record<string, string | undefined>>, allowed: boolean): number {
  if (!allowed) return DEFAULT_HELLO_TIMEOUT_MS
  const n = Number(raw.BEACON_HELLO_TIMEOUT_MS)
  return Number.isInteger(n) && n >= 500 && n <= 600_000 ? n : DEFAULT_HELLO_TIMEOUT_MS
}
