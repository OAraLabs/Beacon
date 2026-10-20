/**
 * Dictation (B6) — the pure core of Beacon's composer mic.
 *
 * A voice TURN and a DICTATION are different acts and must not be confused:
 * a turn speaks to Prometheus in VOICE_SESSION_ID and sends; dictation only
 * transcribes into the draft of the conversation you are already looking at,
 * and sends nothing. They share a microphone and nothing else — which is why
 * this module is separate from shared/voice.ts rather than a flag inside it.
 *
 * Wire: POST {baseUrl}/bridge/transcribe (oara-voice#3), STT only — no
 * session_id exists on that request, so dictation cannot start a turn even
 * if this code were wrong.
 */

/** The middleware's STT-only response (oara-voice PR #3). */
export interface BridgeTranscribeResponse {
  status: string // 'ok' | 'no_speech'
  text?: string
  raw_text?: string
  duration_ms?: number
  stage_ms?: { stt?: number }
  /** Measured input level and the floor it was judged against (oara-voice#8).
   * Optional: a middleware older than that reports neither, and the generic
   * notice is used. */
  level_rms?: number
  silence_floor_rms?: number
}

/** One visible state per outcome — a discarded dictation and a broken mic
 * must never look alike from the chair (the silence-is-ambiguous family). */
export type DictationOutcome =
  | { kind: 'text'; text: string }
  | { kind: 'no_speech'; notice: string }
  | { kind: 'error'; notice: string }

/**
 * Why nothing was heard, in the user's terms.
 *
 * "Didn't catch that" is one sentence for three different problems, and two of
 * them the reader can fix in seconds — but only if the notice says which. The
 * middleware reports the level it measured and the floor it applied
 * (oara-voice#8), which is enough to tell them apart:
 *
 *   level 0             nothing arriving — muted, unplugged, permission denied
 *   0 < level < floor   the mic works and is turned down too far
 *   level >= floor      audible, but no words — a quiet room, or not speech
 *
 * Falls back to the generic notice when the fields are absent: an older
 * middleware not REPORTING a level is not the same as a level of zero, and
 * telling someone their mic is muted on that evidence would be a guess.
 */
export function noSpeechNotice(r: BridgeTranscribeResponse): string {
  const level = typeof r?.level_rms === 'number' ? r.level_rms : null
  const floor = typeof r?.silence_floor_rms === 'number' ? r.silence_floor_rms : null
  if (level === null || floor === null) return "Didn't catch that — nothing was added"
  if (level <= 0) return 'No sound reached the mic — check that it is not muted or blocked'
  if (level < floor) {
    return `Your mic is too quiet to hear (level ${round1(level)}, needs ${round1(floor)}) — move closer or raise the input level`
  }
  return "Didn't catch that — nothing was added"
}

function round1(n: number): number {
  return Math.round(n * 10) / 10
}

export function parseDictationOutcome(r: BridgeTranscribeResponse): DictationOutcome {
  const text = (r?.text ?? '').trim()
  // no_speech AND ok-with-empty-text collapse to the same visible state: the
  // gate that produced it (energy floor, oara-voice#6) is not the user's
  // problem — "nothing was heard" is.
  if (r?.status === 'no_speech' || (r?.status === 'ok' && !text)) {
    return { kind: 'no_speech', notice: noSpeechNotice(r) }
  }
  if (r?.status !== 'ok') {
    return { kind: 'error', notice: `Dictation failed (${r?.status ?? 'no status'})` }
  }
  return { kind: 'text', text }
}

/**
 * Append a transcript to a draft the way a person would.
 *
 * The rule is spacing only — the transcript is NEVER edited (no capitalising,
 * no punctuation repair). Whisper's output is the user's words; silently
 * "improving" them would make a wrong transcript harder to spot, not easier.
 */
export function appendDictation(draft: string, text: string): string {
  const add = text.trim()
  if (!add) return draft
  if (!draft.trim()) return add
  // A draft ending in whitespace already has its separator; adding another
  // would leave a double space exactly where the cursor sits.
  return /\s$/.test(draft) ? draft + add : draft + ' ' + add
}

/**
 * Why the mic cannot dictate right now, or null when it can.
 *
 * Dictation is refused while a voice TURN is in flight because they share one
 * microphone: two captures at once yields two half-utterances, and the second
 * getUserMedia can also fail outright depending on the platform.
 */
export function dictateUnavailableReason(
  voiceState: 'idle' | 'recording' | 'processing',
  sending: boolean
): string | null {
  if (voiceState !== 'idle') return 'The mic is busy with a voice turn'
  if (sending) return 'Wait for the message to send'
  return null
}

/**
 * A dictation belongs to the conversation it was STARTED in. If the user
 * switches away mid-flight, the transcript must not be poured into whatever
 * draft is now on screen — that is someone else's message.
 *
 * null is Home, which is a real target with its own draft (it stages the first
 * message of a new conversation), so Home→Home lands and Home→session does not.
 */
export function dictationLanded(
  startedIn: string | null,
  activeNow: string | null
): boolean {
  return startedIn === activeNow
}

export const DICTATION_MOVED_NOTICE =
  'Dictation discarded — you switched conversations while it was transcribing'
