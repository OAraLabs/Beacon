// Streaming voice turns — the Beacon half of oara-voice #12 (`POST /bridge/voice/stream`).
//
// The bridge now speaks the reply AS IT IS WRITTEN: the response is NDJSON, one object per line —
//   {"type":"transcript", transcript, stt_ms, level_rms}
//   {"type":"segment", seq, text, audio_base64 (a WAV of ONE phrase), synth_ms, t_ms}   × N
//   {"type":"done", ...the /bridge/voice envelope minus audio_base64 (segments, stage_ms{ttfa,…})}
// so a client can PLAY segment 0 while the model is still writing segment 2. Before this, Beacon
// waited for the whole joined WAV (`/bridge/voice`) — the first sound came after the last phrase
// was synthesized.
//
// Pure model (no DOM, no fetch, no Audio): the incremental NDJSON parser (chunks split lines at
// arbitrary byte boundaries), the event types, the ordered playback queue as a reducer, and the
// done→outcome mapping. Main owns the HTTP stream; the renderer owns <audio>. The smoke pins this.

import { parseVoiceOutcome, type BridgeVoiceResponse, type VoiceOutcome } from './voice'

export type VoiceStreamEvent =
  | { type: 'transcript'; task_id?: string | null; transcript: string; stt_ms?: number; level_rms?: number }
  | { type: 'segment'; seq: number; text: string; audio_base64: string; synth_ms?: number; t_ms?: number }
  | { type: 'done'; status: string; transcript?: string; speak?: string; full?: string; segments?: number; audio_error?: string | null; stage_ms?: Record<string, number | null> }
  /** Main → renderer only: the bridge has no /voice/stream (older middleware) — main fell back to
   *  /bridge/voice and the joined WAV arrives in the final response instead of as segments. */
  | { type: 'fallback'; reason: string }

/** Feed raw text chunks; get back every complete JSON line. A line split across two chunks is held
 *  until its newline arrives; a line that is not JSON is reported, not dropped silently. */
export class NdjsonBuffer {
  private buf = ''

  push(chunk: string): { events: VoiceStreamEvent[]; malformed: string[] } {
    this.buf += chunk
    const events: VoiceStreamEvent[] = []
    const malformed: string[] = []
    let nl = this.buf.indexOf('\n')
    while (nl >= 0) {
      const line = this.buf.slice(0, nl).trim()
      this.buf = this.buf.slice(nl + 1)
      if (line) {
        const ev = parseStreamLine(line)
        if (ev) events.push(ev)
        else malformed.push(line.slice(0, 120))
      }
      nl = this.buf.indexOf('\n')
    }
    return { events, malformed }
  }

  /** End of stream: a trailing line without a newline is still a line. */
  flush(): { events: VoiceStreamEvent[]; malformed: string[] } {
    const rest = this.buf.trim()
    this.buf = ''
    if (!rest) return { events: [], malformed: [] }
    const ev = parseStreamLine(rest)
    return ev ? { events: [ev], malformed: [] } : { events: [], malformed: [rest.slice(0, 120)] }
  }
}

export function parseStreamLine(line: string): VoiceStreamEvent | null {
  let obj: unknown
  try {
    obj = JSON.parse(line)
  } catch {
    return null
  }
  if (!obj || typeof obj !== 'object') return null
  const o = obj as Record<string, unknown>
  switch (o.type) {
    case 'transcript':
      return { type: 'transcript', task_id: (o.task_id as string | null | undefined) ?? null, transcript: String(o.transcript ?? ''), stt_ms: numOr(o.stt_ms), level_rms: numOr(o.level_rms) }
    case 'segment':
      if (typeof o.audio_base64 !== 'string' || typeof o.seq !== 'number') return null
      return { type: 'segment', seq: o.seq, text: String(o.text ?? ''), audio_base64: o.audio_base64, synth_ms: numOr(o.synth_ms), t_ms: numOr(o.t_ms) }
    case 'done':
      return {
        type: 'done',
        status: String(o.status ?? 'error'),
        transcript: strOr(o.transcript),
        speak: strOr(o.speak),
        full: strOr(o.full),
        segments: numOr(o.segments),
        audio_error: (o.audio_error as string | null | undefined) ?? null,
        stage_ms: (o.stage_ms as Record<string, number | null> | undefined) ?? undefined
      }
    default:
      return null
  }
}

function numOr(v: unknown): number | undefined {
  return typeof v === 'number' ? v : undefined
}
function strOr(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined
}

// ── playback queue (pure reducer; the renderer drives <audio> from it) ────────────────────────

export interface PlaybackState {
  /** Segments in arrival order — the bridge emits them in the order the model wrote them. */
  queue: { seq: number; url: string }[]
  /** Index into `queue` of the segment playing now, or -1 when idle. */
  playing: number
  /** How many queue entries have finished playing — the first unplayed index after a drain. */
  played: number
  /** Set when `done` arrived; playback may still be draining. */
  finished: boolean
}

export const initialPlayback: PlaybackState = { queue: [], playing: -1, played: 0, finished: false }

export type PlaybackAction =
  | { kind: 'segment'; seq: number; url: string }
  | { kind: 'ended' } // the current <audio> finished
  | { kind: 'done' }
  | { kind: 'reset' }

/** The one rule: play the next queued segment as soon as the current one ends — and start the FIRST
 *  segment the moment it arrives. Out-of-order arrival is not expected (one worker, ordered), but a
 *  lower seq arriving late is inserted by seq so it is never played after a later phrase. */
export function playbackReduce(state: PlaybackState, action: PlaybackAction): PlaybackState {
  switch (action.kind) {
    case 'reset':
      return initialPlayback
    case 'segment': {
      const queue = [...state.queue, { seq: action.seq, url: action.url }].sort((a, b) => a.seq - b.seq)
      // Idle (nothing ever played, or drained) → start at the first UNPLAYED entry, never replay one.
      const playing = state.playing === -1 ? (state.played < queue.length ? state.played : -1) : state.playing
      return { ...state, queue, playing }
    }
    case 'ended': {
      if (state.playing === -1) return state
      const played = state.playing + 1
      return { ...state, played, playing: played < state.queue.length ? played : -1 }
    }
    case 'done':
      return { ...state, finished: true }
  }
}

/** The URL to (re)start playing after an action, or null when nothing should start. Only a change of
 *  `playing` to a real index is a start — an 'ended' with nothing queued starts nothing. */
export function playbackStart(before: PlaybackState, after: PlaybackState): string | null {
  if (after.playing === -1 || after.playing === before.playing) return null
  return after.queue[after.playing]?.url ?? null
}

/** Idle = nothing playing and (done arrived or nothing queued). */
export function playbackIdle(state: PlaybackState): boolean {
  return state.playing === -1 && (state.finished || state.queue.length === 0)
}

// ── outcomes ────────────────────────────────────────────────────────────────────────────────

/** The `done` line IS the /bridge/voice envelope minus the joined audio, so the existing single
 *  mapper applies — audioUrl is null because the audio already went by, segment by segment. */
export function outcomeFromDone(done: Extract<VoiceStreamEvent, { type: 'done' }>): VoiceOutcome {
  const asResponse: BridgeVoiceResponse = {
    status: done.status,
    transcript: done.transcript,
    speak: done.speak,
    full: done.full,
    audio_base64: null,
    audio_error: done.audio_error ?? null,
    stage_ms: (done.stage_ms as BridgeVoiceResponse['stage_ms']) ?? undefined
  }
  return parseVoiceOutcome(asResponse)
}

/** A partly-spoken reply must be SAID: the bridge names it in audio_error ("reply partly spoken:
 *  N segment(s)"); the notice carries it rather than letting the audio just stop early. */
export function partialSpeechNotice(done: Extract<VoiceStreamEvent, { type: 'done' }>): string {
  if (!done.audio_error) return ''
  return `Speech stopped early — ${done.audio_error}`
}

/** 404 on /bridge/voice/stream = a middleware older than oara-voice #12: use /bridge/voice. Anything
 *  else is a real failure and must not be masked by a fallback. */
export function streamUnsupported(status: number): boolean {
  return status === 404 || status === 405
}

export const VOICE_STREAM_PATH = '/bridge/voice/stream'
export const VOICE_PATH = '/bridge/voice'
