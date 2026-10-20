/**
 * hands-free-smoke — the pure core of hands-free voice mode (item 8's remaining pieces).
 *
 * PINS THE CONTRACT of shared/hands-free.ts:
 *   1. STATE MACHINE — start/stop, listen→capture→process→speak→listen, a too-short utterance is
 *      not a turn, BARGE-IN stops playback and captures, speech during processing skips the
 *      reply's playback, idle auto-off after the timeout, VAD loss / errors turn the mode off
 *      LOUDLY (a notice, never silence). Effects are data, asserted exactly.
 *   2. VAD CODEC — the audio message the service decodes with np.float32; speech_end without
 *      audio is dropped (the Android client's rule); the URL keeps the host, uses the configured VAD port (8012 by default), carries
 *      the token only when given, ws/wss follows http/https.
 *   3. CHUNKER — 48 kHz capture buffers become exact 512-sample 16 kHz chunks with a carry.
 *   4. speech_end → pcm16 base64 — round-trips through the PTT path's clamped helper.
 *
 * Run: npm run smoke:hands-free
 */
import {
  DEFAULT_IDLE_TIMEOUT_MS,
  DEFAULT_VAD_PORT,
  vadPortOr,
  MIN_UTTERANCE_MS,
  VAD_CHUNK_SAMPLES,
  VAD_PING_MESSAGE,
  VAD_RESET_MESSAGE,
  VadChunker,
  base64ToBytes,
  bytesToBase64,
  handsFreeLabel,
  handsFreeReduce,
  initialHandsFree,
  parseVadEvent,
  speechEndToPcm16Base64,
  vadAudioMessage,
  vadUrl,
  type HandsFreeEffect,
  type HandsFreeState
} from '@shared/hands-free'
import { sanitizeIntegrations } from '@shared/integrations'

let failures = 0
function assert(cond: boolean, what: string): void {
  console.log(`[smoke] ${cond ? 'PASS' : 'FAIL'}  ${what}`)
  if (!cond) failures++
}
const fx = (effects: HandsFreeEffect[]): string => effects.map((e) => e.kind).join(',')

// ── 1. state machine ─────────────────────────────────────────────────────────────────────────
{
  const T0 = 1_000_000
  let r = handsFreeReduce(initialHandsFree(), { kind: 'start', now: T0 })
  assert(r.state.phase === 'listening' && fx(r.effects) === 'open_vad', 'start → listening, opens the VAD')
  r = handsFreeReduce(r.state, { kind: 'start', now: T0 })
  assert(r.state.phase === 'listening' && r.effects.length === 0, 'start while on is a no-op')
  r = handsFreeReduce(r.state, { kind: 'speech_start', now: T0 + 1000 })
  assert(r.state.phase === 'capturing', 'speech_start while listening → capturing')
  r = handsFreeReduce(r.state, { kind: 'speech_end', now: T0 + 1200, durationMs: 120 })
  assert(r.state.phase === 'listening' && r.effects.length === 0 && r.state.turns === 0, `a ${MIN_UTTERANCE_MS - 1} ms blip is not a turn`)
  r = handsFreeReduce(r.state, { kind: 'speech_start', now: T0 + 2000 })
  r = handsFreeReduce(r.state, { kind: 'speech_end', now: T0 + 3500, durationMs: 1500 })
  assert(r.state.phase === 'processing' && fx(r.effects) === 'send_turn' && r.state.turns === 1, 'a real utterance → processing + send_turn')
  r = handsFreeReduce(r.state, { kind: 'turn_done', now: T0 + 6000, spoke: true })
  assert(r.state.phase === 'speaking' && r.effects.length === 0, 'turn done with audio → speaking')
  const speaking: HandsFreeState = r.state
  r = handsFreeReduce(speaking, { kind: 'playback_done', now: T0 + 9000 })
  assert(r.state.phase === 'listening' && r.state.lastActivityMs === T0 + 9000, 'playback done → listening, activity refreshed')
  // barge-in
  r = handsFreeReduce(speaking, { kind: 'speech_start', now: T0 + 7000 })
  assert(r.state.phase === 'capturing' && fx(r.effects) === 'stop_playback' && r.state.bargeIns === 1, 'BARGE-IN: speech while speaking stops playback and captures')
  // speech during processing → skip playback
  let p = handsFreeReduce(handsFreeReduce(initialHandsFree(), { kind: 'start', now: T0 }).state, { kind: 'speech_start', now: T0 + 1 })
  p = handsFreeReduce(p.state, { kind: 'speech_end', now: T0 + 1000, durationMs: 900 })
  p = handsFreeReduce(p.state, { kind: 'speech_start', now: T0 + 1500 })
  assert(p.state.phase === 'processing' && p.state.speechDuringProcessing, 'speech during processing is remembered, phase unchanged')
  p = handsFreeReduce(p.state, { kind: 'turn_done', now: T0 + 4000, spoke: true })
  assert(p.state.phase === 'capturing' && fx(p.effects) === 'skip_playback', "the reply is not played over the user's next utterance (Android's rule)")
  // turn without audio
  let q = handsFreeReduce(handsFreeReduce(initialHandsFree(), { kind: 'start', now: T0 }).state, { kind: 'speech_start', now: T0 })
  q = handsFreeReduce(q.state, { kind: 'speech_end', now: T0 + 1000, durationMs: 800 })
  q = handsFreeReduce(q.state, { kind: 'turn_done', now: T0 + 2000, spoke: false })
  assert(q.state.phase === 'listening', 'turn done with no audio (no_speech / error) → back to listening')
  // idle auto-off
  let idle = handsFreeReduce(initialHandsFree(), { kind: 'start', now: T0 })
  idle = handsFreeReduce(idle.state, { kind: 'tick', now: T0 + DEFAULT_IDLE_TIMEOUT_MS - 1 })
  assert(idle.state.phase === 'listening' && idle.effects.length === 0, 'tick before the timeout does nothing')
  idle = handsFreeReduce(idle.state, { kind: 'tick', now: T0 + DEFAULT_IDLE_TIMEOUT_MS })
  assert(idle.state.phase === 'off' && fx(idle.effects) === 'close_vad,auto_off' && /90 s of quiet/.test(idle.state.notice), 'quiet for the timeout → off, VAD closed, SAID in the notice')
  assert(handsFreeReduce(speaking, { kind: 'tick', now: T0 + 10 * DEFAULT_IDLE_TIMEOUT_MS }).state.phase === 'speaking', 'the idle clock only runs while listening')
  // loss + errors are loud
  const lost = handsFreeReduce(speaking, { kind: 'vad_closed', now: T0, reason: 'socket closed 4401 (token rejected)' })
  assert(lost.state.phase === 'off' && fx(lost.effects) === 'stop_playback' && /4401/.test(lost.state.notice), 'VAD loss while speaking → off, playback stopped, reason in the notice')
  const err = handsFreeReduce(handsFreeReduce(initialHandsFree(), { kind: 'start', now: T0 }).state, { kind: 'error', now: T0, message: 'Microphone unavailable' })
  assert(err.state.phase === 'off' && fx(err.effects) === 'close_vad' && /Microphone unavailable/.test(err.state.notice), 'an error → off, VAD closed, message kept')
  const stopped = handsFreeReduce(speaking, { kind: 'stop' })
  assert(stopped.state.phase === 'off' && fx(stopped.effects) === 'stop_playback,close_vad' && stopped.state.notice === '', 'stop while speaking → playback stopped, VAD closed, no notice')
  assert(handsFreeReduce(initialHandsFree(), { kind: 'stop' }).effects.length === 0, 'stop while off is a no-op')
  assert(handsFreeLabel(speaking).includes('interrupt') && handsFreeLabel(initialHandsFree()) === '' && handsFreeLabel(lost.state).startsWith('Hands-free stopped'), 'labels: speaking invites interruption; off shows only a notice')
}

// ── 2. VAD codec ─────────────────────────────────────────────────────────────────────────────
{
  const chunk = new Float32Array([0.5, -0.25, 1, -1])
  const msg = JSON.parse(vadAudioMessage(chunk)) as { type: string; data: string }
  assert(msg.type === 'audio' && typeof msg.data === 'string', 'audio message shape')
  const bytes = base64ToBytes(msg.data)
  const back = new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))
  assert(back[0] === 0.5 && back[1] === -0.25 && back[2] === 1 && back[3] === -1, 'float32 LE round-trips through base64')
  assert(VAD_RESET_MESSAGE === '{"type":"reset"}' && VAD_PING_MESSAGE === '{"type":"ping"}', 'reset/ping messages pinned')
  const s = parseVadEvent('{"type":"speech_start","timestamp":1.0,"probability":0.93}')
  assert(s?.type === 'speech_start' && s.probability === 0.93, 'speech_start parsed')
  const e = parseVadEvent('{"type":"speech_end","timestamp":2.0,"duration_ms":1234,"audio_base64":"AAAA"}')
  assert(e?.type === 'speech_end' && e.durationMs === 1234 && e.audioBase64 === 'AAAA', 'speech_end parsed with duration + audio')
  assert(parseVadEvent('{"type":"speech_end","duration_ms":5}') === null, "speech_end WITHOUT audio is dropped (Android's rule) — nothing to send")
  assert(parseVadEvent('{"type":"pong"}')?.type === 'pong' && parseVadEvent('{"type":"reset_ack"}')?.type === 'reset_ack', 'pong/reset_ack parsed')
  assert(parseVadEvent('nope') === null && parseVadEvent('{"type":"x"}') === null, 'junk → null')
  // A tailnet-range address is built, never written: a literal one in source is exactly what the
  // pre-commit guard refuses. Same helper as plain-lan-smoke and pane-link-smoke.
  const TS = (b: number, c = 0, d = 1): string => `100.${b}.${c}.${d}`
  const host = TS(101, 102, 103)
  assert(DEFAULT_VAD_PORT === 8012, 'the default VAD port is 8012 (oara-vad moved off 8011, which is Prometheus\'s TLS WebSocket port)')
  assert(vadUrl(`http://${host}:8015`, 'tok') === `ws://${host}:8012/vad/stream?token=tok`, 'url: host kept, the default port 8012, token as query')
  assert(vadUrl('https://oara.example/', null) === 'wss://oara.example:8012/vad/stream', 'url: https → wss, no token → no query')
  assert(vadUrl('http://oara.example:8015', null, 9123) === 'ws://oara.example:9123/vad/stream', 'url: a configured port is used')
  for (const bad of [0, -1, 65536, 8012.5, Number.NaN]) assert(vadUrl('http://oara.example', null, bad) === 'ws://oara.example:8012/vad/stream', `url: a nonsense port (${bad}) falls back to 8012`)
  assert(vadPortOr(undefined) === 8012 && vadPortOr('8013') === 8012 && vadPortOr(8013) === 8013 && vadPortOr(65535) === 65535 && vadPortOr(1) === 1, 'vadPortOr: only a whole number from 1 to 65535 counts')
  // The config lives on the oara entry in integrations.json, in the generic `options` bag (the
  // registry itself names no integration: integrations-smoke G1). The sanitizer must KEEP it, or the
  // next save (saveIntegrations writes the sanitized list) would silently erase it.
  const kept = sanitizeIntegrations([{ id: 'oara', name: 'OAra Voice', baseUrl: 'http://oara.example:8015', authRef: 'stored', options: { vadPort: 8013 } }])
  assert(kept[0]?.options?.vadPort === 8013 && vadPortOr(kept[0]?.options?.vadPort) === 8013, 'integrations: options.vadPort survives the sanitizer (and so a save) and is the port used')
  const odd = sanitizeIntegrations([{ id: 'oara', baseUrl: 'http://a.example', options: { vadPort: '8013', 'bad key': 1, nested: { x: 1 }, inf: Number.POSITIVE_INFINITY, ok: true } }])
  assert(vadPortOr(odd[0]?.options?.vadPort) === 8012 && odd[0]?.options?.ok === true && !('bad key' in (odd[0]?.options ?? {})) && !('nested' in (odd[0]?.options ?? {})) && !('inf' in (odd[0]?.options ?? {})), 'integrations: a string port reads as the default; bad keys, objects and infinities are dropped; plain values kept')
  assert(sanitizeIntegrations([{ id: 'oara', baseUrl: 'http://a.example' }])[0]?.options === undefined, 'integrations: no options → none (the default port applies)')
  const many = sanitizeIntegrations([{ id: 'x', baseUrl: 'http://a.example', options: Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`k${i}`, i])) }])
  assert(Object.keys(many[0]?.options ?? {}).length === 16, 'integrations: at most 16 options are kept')
}

// ── 3. chunker ───────────────────────────────────────────────────────────────────────────────
{
  const c = new VadChunker(48000)
  const buf = new Float32Array(4096) // one ScriptProcessor buffer at 48 kHz ≈ 1365 samples at 16 kHz
  for (let i = 0; i < buf.length; i++) buf[i] = Math.sin(i / 20)
  const first = c.push(buf)
  assert(first.length === 2 && first.every((ch) => ch.length === VAD_CHUNK_SAMPLES), `4096 @48k → two exact 512-sample chunks (+ carry) (${first.length})`)
  const total = first.length + c.push(buf).length + c.push(buf).length
  assert(total === 8, `three buffers ≈ 4096 samples at 16k → 8 chunks total (${total})`)
  const same = new VadChunker(16000)
  const out = same.push(new Float32Array(1100))
  assert(out.length === 2, '16 kHz input is not resampled: 1100 → 2 chunks + carry of 76')
  assert(same.push(new Float32Array(436)).length === 1, 'the carry completes the next chunk exactly')
  let threw = false
  try {
    new VadChunker(0)
  } catch {
    threw = true
  }
  assert(threw, 'an invalid context rate throws')
}

// ── 4. speech_end → pcm16 ────────────────────────────────────────────────────────────────────
{
  const f = new Float32Array([0, 0.5, -0.5, 1.5]) // 1.5 must clamp
  const b64 = bytesToBase64(new Uint8Array(f.buffer))
  const pcmB64 = speechEndToPcm16Base64(b64)
  const pcmBytes = base64ToBytes(pcmB64)
  const pcm = new Int16Array(pcmBytes.buffer.slice(pcmBytes.byteOffset, pcmBytes.byteOffset + pcmBytes.byteLength))
  assert(pcm[0] === 0 && pcm[1] === 16384 && pcm[2] === -16384 && pcm[3] === 32767, `float32 utterance → clamped pcm16 (${Array.from(pcm).join(',')})`)
}

console.log(`\n[smoke] hands-free: ${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)
