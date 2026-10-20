/**
 * Voice turns (feat/voice-turns) — the pure core of Beacon's mic path.
 *
 * Beacon is the SECOND contract client of oara-voice's POST /bridge/voice
 * (after Android v3.0.0). The contract wants RAW pcm16 mono at 16kHz — no
 * container — so there is no MediaRecorder anywhere in this path: capture
 * yields float32 at the AudioContext rate and THIS module does the Int16/16k
 * conversion. The math is the one place a wrong guess costs a rewrite, so
 * it lives here, pure and smoke-tested.
 *
 * Reference for the pcm16 capture contract: Android's AudioRecorder.kt
 * (ENCODING_PCM_16BIT mono). web-ptt is NOT the reference — it posts
 * webm/opus to the daemon's /route/stream, a different contract entirely.
 *
 * AUDIO TRANSIT (stated, not implied): raw mic audio is base64'd and POSTed
 * to the oara middleware on tailnet — your own box, bearer-gated. Same trust
 * model the stack already runs under; noted so a later reader doesn't have
 * to reconstruct the reasoning.
 */

/** ONE persistent voice conversation (spec Q2, frozen). Per-window ephemeral
 * sessions would make voice turns unable to reference each other. Expected
 * consequence: it shows up in the session list like any session. */
export const VOICE_SESSION_ID = 'voice:beacon'

/** The bridge's sample-rate contract. */
export const VOICE_SAMPLE_RATE = 16000

/**
 * Float32 (context rate, possibly multi-channel already downmixed) → Int16
 * pcm at 16kHz. Linear-interpolation resample when rates differ; clamps the
 * Int16 range (floats can exceed ±1.0 — clipping silently corrupts STT).
 */
export function float32ToPcm16At16k(samples: Float32Array, contextRate: number): Int16Array {
  if (contextRate <= 0) throw new Error(`invalid context rate: ${contextRate}`)
  if (samples.length === 0) return new Int16Array(0)
  const ratio = contextRate / VOICE_SAMPLE_RATE
  const outLen = Math.max(1, Math.floor(samples.length / ratio))
  const out = new Int16Array(outLen)
  for (let i = 0; i < outLen; i++) {
    const src = i * ratio
    const i0 = Math.floor(src)
    const i1 = Math.min(i0 + 1, samples.length - 1)
    const frac = src - i0
    const v = samples[i0] * (1 - frac) + samples[i1] * frac
    const clamped = Math.max(-1, Math.min(1, v))
    out[i] = clamped < 0 ? Math.round(clamped * 32768) : Math.round(clamped * 32767)
  }
  return out
}

/** Int16 PCM → base64 (little-endian bytes, the wire format). */
export function pcm16ToBase64(pcm: Int16Array): string {
  const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength)
  let bin = ''
  // Chunked to stay under call-stack limits on long turns (60s ≈ 1.9MB).
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(bin)
}

/** base64 WAV reply → object URL for playback (renderer). */
export function wavBase64ToBlobUrl(b64: string): string {
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' }))
}

/** The bridge's response, as the daemon-adjacent middleware serves it. */
export interface BridgeVoiceResponse {
  status: string // 'complete' | 'no_speech' | 'timeout' | 'error'
  transcript?: string
  speak?: string
  full?: string
  audio_base64?: string | null
  audio_error?: string | null
  stage_ms?: { stt?: number; agent?: number; tts?: number }
}

/** Outcome the UI renders — every bridge status maps to ONE visible state.
 * A silent path is the defect class: a discarded turn and a broken mic must
 * not look identical from the chair (spec review delta; #277's family). */
export type VoiceOutcome =
  | { kind: 'spoken'; transcript: string; reply: string; audioUrl: string | null }
  | { kind: 'no_speech'; notice: string }
  | { kind: 'timeout'; notice: string }
  | { kind: 'error'; notice: string }

export function parseVoiceOutcome(r: BridgeVoiceResponse): VoiceOutcome {
  if (r.status === 'no_speech') {
    return { kind: 'no_speech', notice: "Didn't catch that — try again" }
  }
  if (r.status === 'timeout') {
    return { kind: 'timeout', notice: 'The agent took too long to answer — try again' }
  }
  if (r.status !== 'complete') {
    return { kind: 'error', notice: `Voice turn failed (${r.status})` }
  }
  return {
    kind: 'spoken',
    transcript: r.transcript ?? '',
    reply: r.full || r.speak || '',
    audioUrl: r.audio_base64 ? wavBase64ToBlobUrl(r.audio_base64) : null
  }
}
