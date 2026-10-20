// Hands-free voice mode — the pure model (item 8, the pieces after streaming playback).
//
// The shape, mirrored from the Android client that already ships it (oara-voice
// android/…/PTTViewModel.kt + VadStreamClient.kt): the mic stays open, 512-sample float32 chunks
// at 16 kHz stream to the VAD service (Silero, `ws://<oara-host>:8012/vad/stream?token=…`), which
// answers `speech_start` / `speech_end{audio_base64}`. A finished utterance becomes a voice turn
// (the streaming route from #108); speech while the reply is playing is a BARGE-IN (stop playback,
// capture); nothing heard for a while turns the mode off by itself.
//
// Everything here is pure and headless-smoked: the state machine (a reducer that returns EFFECTS
// for the shell to perform, so the rules are testable without a mic), the VAD wire codec, the
// resample-and-chunk pipeline, and the speech_end → pcm16 conversion the bridge wants.
//
// NOT here (renderer/main): getUserMedia, the WebSocket, <audio>. NOT built at all: wake word —
// an in-renderer model needs a wasm/ONNX runtime under `script-src 'self'` (CSP), which is a
// separate decision; hands-free here is "listening while on", started by a click.

import { float32ToPcm16At16k, pcm16ToBase64 } from './voice'

/**
 * The VAD service's port when the oara entry in integrations.json does not name one
 * (`"options": { "vadPort": … }`).
 * 8012 since 2026-10-12: oara-vad moved off 8011, which is Prometheus's own TLS WebSocket port
 * (8006/8011 in home-network mode). The next move is a config edit, not a code change.
 */
export const DEFAULT_VAD_PORT = 8012
export const VAD_SAMPLE_RATE = 16000
export const VAD_CHUNK_SAMPLES = 512 // 32 ms — the service's Silero window
export const DEFAULT_IDLE_TIMEOUT_MS = 90_000 // Android's default: quiet for 90 s → off
export const MIN_UTTERANCE_MS = 300 // shorter than this is a cough, not a turn

// ── state machine ───────────────────────────────────────────────────────────────────────────

export type HandsFreePhase = 'off' | 'listening' | 'capturing' | 'processing' | 'speaking'

export interface HandsFreeState {
  phase: HandsFreePhase
  /** Epoch ms of the last thing that counts as activity (start, speech end, turn done, playback done). */
  lastActivityMs: number
  /** Speech was heard while a turn was in flight — skip the reply's playback and capture instead. */
  speechDuringProcessing: boolean
  turns: number
  bargeIns: number
  /** '' when nothing to say. Set on auto-off, VAD loss, errors — never silent. */
  notice: string
  idleTimeoutMs: number
}

export function initialHandsFree(idleTimeoutMs: number = DEFAULT_IDLE_TIMEOUT_MS): HandsFreeState {
  return { phase: 'off', lastActivityMs: 0, speechDuringProcessing: false, turns: 0, bargeIns: 0, notice: '', idleTimeoutMs }
}

export type HandsFreeEvent =
  | { kind: 'start'; now: number }
  | { kind: 'stop' }
  | { kind: 'speech_start'; now: number }
  | { kind: 'speech_end'; now: number; durationMs: number }
  | { kind: 'turn_done'; now: number; spoke: boolean }
  | { kind: 'playback_done'; now: number }
  | { kind: 'vad_closed'; now: number; reason: string }
  | { kind: 'error'; now: number; message: string }
  | { kind: 'tick'; now: number }

/** What the shell must DO after a transition. Pure data, so the smoke can assert it. */
export type HandsFreeEffect =
  | { kind: 'open_vad' }
  | { kind: 'close_vad' }
  | { kind: 'send_turn' } // the shell has the speech_end audio in hand
  | { kind: 'stop_playback' } // barge-in
  | { kind: 'skip_playback' } // reply arrived while the user was already talking again
  | { kind: 'auto_off' }

export function handsFreeReduce(s: HandsFreeState, e: HandsFreeEvent): { state: HandsFreeState; effects: HandsFreeEffect[] } {
  const fx: HandsFreeEffect[] = []
  switch (e.kind) {
    case 'start':
      if (s.phase !== 'off') return { state: s, effects: fx }
      fx.push({ kind: 'open_vad' })
      return { state: { ...s, phase: 'listening', lastActivityMs: e.now, speechDuringProcessing: false, notice: '' }, effects: fx }
    case 'stop':
      if (s.phase === 'off') return { state: s, effects: fx }
      if (s.phase === 'speaking') fx.push({ kind: 'stop_playback' })
      fx.push({ kind: 'close_vad' })
      return { state: { ...s, phase: 'off', speechDuringProcessing: false, notice: '' }, effects: fx }
    case 'speech_start':
      if (s.phase === 'listening') return { state: { ...s, phase: 'capturing' }, effects: fx }
      if (s.phase === 'speaking') {
        // BARGE-IN: the user talks over the reply — stop it and listen to them.
        fx.push({ kind: 'stop_playback' })
        return { state: { ...s, phase: 'capturing', bargeIns: s.bargeIns + 1 }, effects: fx }
      }
      if (s.phase === 'processing') return { state: { ...s, speechDuringProcessing: true }, effects: fx }
      return { state: s, effects: fx }
    case 'speech_end':
      if (s.phase !== 'capturing') return { state: s, effects: fx }
      if (e.durationMs < MIN_UTTERANCE_MS) return { state: { ...s, phase: 'listening', lastActivityMs: e.now }, effects: fx }
      fx.push({ kind: 'send_turn' })
      return { state: { ...s, phase: 'processing', lastActivityMs: e.now, turns: s.turns + 1, speechDuringProcessing: false }, effects: fx }
    case 'turn_done':
      if (s.phase !== 'processing') return { state: s, effects: fx }
      if (s.speechDuringProcessing) {
        // Android's rule: the user is already speaking again — do not talk over them.
        fx.push({ kind: 'skip_playback' })
        return { state: { ...s, phase: 'capturing', lastActivityMs: e.now, speechDuringProcessing: false }, effects: fx }
      }
      return { state: { ...s, phase: e.spoke ? 'speaking' : 'listening', lastActivityMs: e.now }, effects: fx }
    case 'playback_done':
      if (s.phase !== 'speaking') return { state: s, effects: fx }
      return { state: { ...s, phase: 'listening', lastActivityMs: e.now }, effects: fx }
    case 'vad_closed':
      if (s.phase === 'off') return { state: s, effects: fx }
      if (s.phase === 'speaking') fx.push({ kind: 'stop_playback' })
      return { state: { ...s, phase: 'off', speechDuringProcessing: false, notice: `Hands-free stopped — ${e.reason}` }, effects: fx }
    case 'error':
      if (s.phase === 'off') return { state: { ...s, notice: e.message }, effects: fx }
      if (s.phase === 'speaking') fx.push({ kind: 'stop_playback' })
      fx.push({ kind: 'close_vad' })
      return { state: { ...s, phase: 'off', speechDuringProcessing: false, notice: `Hands-free stopped — ${e.message}` }, effects: fx }
    case 'tick':
      if (s.phase !== 'listening') return { state: s, effects: fx }
      if (e.now - s.lastActivityMs < s.idleTimeoutMs) return { state: s, effects: fx }
      fx.push({ kind: 'close_vad' }, { kind: 'auto_off' })
      return { state: { ...s, phase: 'off', notice: `Hands-free turned off after ${Math.round(s.idleTimeoutMs / 1000)} s of quiet` }, effects: fx }
  }
}

/** The one line the composer shows while the mode is on. '' when off and nothing to say. */
export function handsFreeLabel(s: HandsFreeState): string {
  switch (s.phase) {
    case 'off':
      return s.notice
    case 'listening':
      return 'Hands-free: listening…'
    case 'capturing':
      return 'Hands-free: hearing you…'
    case 'processing':
      return 'Hands-free: thinking…'
    case 'speaking':
      return 'Hands-free: speaking — talk to interrupt'
  }
}

/** What main reports to the renderer about the VAD socket (VAD_EVENT). Lives here, not in
 *  src/main, so the renderer/preload can type it without importing main-process code. */
export type VadClientEvent =
  | { type: 'open' }
  | { type: 'event'; event: VadEvent }
  | { type: 'closed'; code: number; reason: string }

// ── VAD wire codec ──────────────────────────────────────────────────────────────────────────

export type VadEvent =
  | { type: 'speech_start'; probability?: number }
  | { type: 'speech_end'; durationMs: number; audioBase64: string }
  | { type: 'reset_ack' }
  | { type: 'pong' }

export function parseVadEvent(text: string): VadEvent | null {
  let o: unknown
  try {
    o = JSON.parse(text)
  } catch {
    return null
  }
  if (!o || typeof o !== 'object') return null
  const m = o as Record<string, unknown>
  switch (m.type) {
    case 'speech_start':
      return { type: 'speech_start', probability: typeof m.probability === 'number' ? m.probability : undefined }
    case 'speech_end':
      // The Android client drops a speech_end without audio ("nothing to send"); so do we.
      if (typeof m.audio_base64 !== 'string' || !m.audio_base64) return null
      return { type: 'speech_end', durationMs: typeof m.duration_ms === 'number' ? m.duration_ms : 0, audioBase64: m.audio_base64 }
    case 'reset_ack':
      return { type: 'reset_ack' }
    case 'pong':
      return { type: 'pong' }
    default:
      return null
  }
}

/** `{"type":"audio","data":"<base64 float32 LE>"}` — exactly what the service decodes with np.float32. */
export function vadAudioMessage(chunk: Float32Array): string {
  const bytes = new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength)
  return JSON.stringify({ type: 'audio', data: bytesToBase64(bytes) })
}

export const VAD_RESET_MESSAGE = JSON.stringify({ type: 'reset' })
export const VAD_PING_MESSAGE = JSON.stringify({ type: 'ping' })

/** A configured VAD port, or the default: only a whole number from 1 to 65535 counts. */
export function vadPortOr(raw: unknown, fallback: number = DEFAULT_VAD_PORT): number {
  return typeof raw === 'number' && Number.isInteger(raw) && raw >= 1 && raw <= 65535 ? raw : fallback
}

/** `http(s)://host[:8015]` (the oara middleware entry) → `ws(s)://host:<vadPort>/vad/stream[?token=…]`.
 *  The VAD service lives beside the middleware on the same host, on `port` (the oara entry's
 *  `options.vadPort`, else DEFAULT_VAD_PORT). The token rides as a query parameter (the service's own
 *  convention, close 4401 on mismatch) — build this in MAIN only and never log the result. */
export function vadUrl(baseUrl: string, token: string | null, port: number = DEFAULT_VAD_PORT): string {
  const u = new URL(baseUrl)
  const scheme = u.protocol === 'https:' ? 'wss' : 'ws'
  const q = token ? `?token=${encodeURIComponent(token)}` : ''
  return `${scheme}://${u.hostname}:${vadPortOr(port)}/vad/stream${q}`
}

// ── resample + chunk (context rate float32 → 16 kHz float32 in exact 512-sample chunks) ──────

export class VadChunker {
  private carry: Float32Array = new Float32Array(0)
  private phase = 0 // fractional read position carried across pushes (keeps resampling continuous)

  constructor(private readonly contextRate: number) {
    if (!(contextRate > 0)) throw new Error(`invalid context rate: ${contextRate}`)
  }

  /** Feed one capture buffer; get back every complete 512-sample 16 kHz chunk. */
  push(samples: Float32Array): Float32Array[] {
    const resampled = this.resample(samples)
    const joined = new Float32Array(this.carry.length + resampled.length)
    joined.set(this.carry, 0)
    joined.set(resampled, this.carry.length)
    const out: Float32Array[] = []
    let off = 0
    while (joined.length - off >= VAD_CHUNK_SAMPLES) {
      out.push(joined.slice(off, off + VAD_CHUNK_SAMPLES))
      off += VAD_CHUNK_SAMPLES
    }
    this.carry = joined.slice(off)
    return out
  }

  private resample(samples: Float32Array): Float32Array {
    if (this.contextRate === VAD_SAMPLE_RATE) return samples
    const ratio = this.contextRate / VAD_SAMPLE_RATE
    const out: number[] = []
    let pos = this.phase
    while (pos < samples.length - 1) {
      const i0 = Math.floor(pos)
      const frac = pos - i0
      out.push(samples[i0] * (1 - frac) + samples[i0 + 1] * frac)
      pos += ratio
    }
    this.phase = pos - samples.length // negative or small positive → continue into the next buffer
    if (this.phase < 0) this.phase = Math.max(this.phase, -ratio) // never re-read a full buffer
    return Float32Array.from(out)
  }
}

// ── speech_end audio → the bridge's pcm16 base64 ────────────────────────────────────────────

/** The service returns the utterance as base64 float32 LE at 16 kHz; /bridge/voice(/stream) wants
 *  pcm16 base64 at 16 kHz. One conversion, through the same clamped helper the PTT path uses. */
export function speechEndToPcm16Base64(audioBase64: string): string {
  const bytes = base64ToBytes(audioBase64)
  const f32 = new Float32Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 4))
  return pcm16ToBase64(float32ToPcm16At16k(f32, VAD_SAMPLE_RATE))
}

// ── base64 (works in main and renderer) ─────────────────────────────────────────────────────

export function bytesToBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64')
  let bin = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  return btoa(bin)
}

export function base64ToBytes(b64: string): Uint8Array {
  if (typeof Buffer !== 'undefined') {
    // Copy out of Node's pooled Buffer: a view would carry a non-zero byteOffset into a shared
    // 8 KB slab, and any caller doing `new Float32Array(bytes.buffer)` would read someone else's bytes.
    return new Uint8Array(Buffer.from(b64, 'base64'))
  }
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}
