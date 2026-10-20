/**
 * voice-smoke — the pure core of voice turns (feat/voice-turns).
 *
 * PINS THE CONTRACT of shared/voice.ts:
 *   1. float32ToPcm16At16k — resample math + clamping (the one place a wrong
 *      guess costs a rewrite; STT gets garbage if this is off).
 *   2. pcm16ToBase64 — little-endian byte order, chunk-safe on long turns.
 *   3. parseVoiceOutcome — EVERY bridge status maps to ONE visible state;
 *      the silent path is the defect class this exists to prevent (#277).
 *
 * Capture/playback are hands-on (no mic/audio in headless CI); everything
 * that CAN be asserted headlessly is asserted here.
 *
 * Run: npm run smoke:voice
 */
import {
  VOICE_SAMPLE_RATE,
  VOICE_SESSION_ID,
  float32ToPcm16At16k,
  parseVoiceOutcome,
  pcm16ToBase64,
  type BridgeVoiceResponse
} from '@shared/voice'

// Node has no btoa/atob pre-16... 20 has both; the renderer has them always.
// Provide deterministic shims ONLY if absent so the smoke is environment-safe.
const g = globalThis as Record<string, unknown>
if (typeof g.btoa !== 'function') {
  g.btoa = (s: string) => Buffer.from(s, 'binary').toString('base64')
}
if (typeof g.atob !== 'function') {
  g.atob = (s: string) => Buffer.from(s, 'base64').toString('binary')
}
// Headless electron-as-node has no DOM URL.createObjectURL — the renderer
// path uses the real one; the smoke only asserts the url is produced.
if (typeof URL.createObjectURL !== 'function') {
  ;(URL as unknown as Record<string, unknown>).createObjectURL = () => 'blob:smoke-stub'
}

let failures = 0
function check(cond: boolean, label: string): void {
  if (cond) console.log(`  ok   ${label}`)
  else {
    console.error(`  FAIL ${label}`)
    failures += 1
  }
}

console.log('\n=== 1. float32 → pcm16 @16k ===')
check(VOICE_SESSION_ID === 'voice:beacon', 'session id is the frozen constant')
check(VOICE_SAMPLE_RATE === 16000, 'sample rate is the bridge contract')

// Same-rate passthrough: amplitude preserved, int16 range honored.
const same = float32ToPcm16At16k(Float32Array.from([0, 0.5, -0.5, 1, -1]), 16000)
check(same.length === 5, 'same-rate: sample count preserved')
check(same[0] === 0, 'same-rate: zero maps to zero')
check(same[1] > 16000 && same[1] < 16600, 'same-rate: +0.5 ≈ +16k')
check(same[3] === 32767, 'same-rate: +1.0 clamps to INT16_MAX')
check(same[4] === -32768, 'same-rate: -1.0 clamps to INT16_MIN')

// Resample 48k→16k: exactly 1/3 the samples.
const in48 = new Float32Array(4800).fill(0.25)
const out16 = float32ToPcm16At16k(in48, 48000)
check(out16.length === 1600, '48k→16k: 1/3 sample count')
check(out16.every((v) => v > 8000 && v < 8300), '48k→16k: amplitude survives resample')

// Over-range floats CLIP, never wrap (wrapping corrupts STT silently).
const clip = float32ToPcm16At16k(Float32Array.from([2.5, -2.5]), 16000)
check(clip[0] === 32767 && clip[1] === -32768, 'over-range input clips, never wraps')

// Empty + degenerate inputs.
check(float32ToPcm16At16k(new Float32Array(0), 48000).length === 0, 'empty input → empty output')
let threw = false
try {
  float32ToPcm16At16k(Float32Array.from([1]), 0)
} catch {
  threw = true
}
check(threw, 'zero context rate throws (a silent divide-by-zero would ship garbage)')

console.log('\n=== 2. pcm16 → base64 (little-endian) ===')
const b64 = pcm16ToBase64(Int16Array.from([1, -1]))
// 0x0001 → bytes 01 00; -1 → FF FF. base64 of [01,00,ff,ff] = 'AQD//w=='.
check(b64 === 'AQD//w==', `little-endian byte order (got ${b64})`)
const long = new Int16Array(300_000).fill(7) // ~10s of audio, chunked encode path
check(pcm16ToBase64(long).length > 0, 'long turn encodes without stack overflow')

console.log('\n=== 3. parseVoiceOutcome — every status is VISIBLE ===')
const complete: BridgeVoiceResponse = {
  status: 'complete',
  transcript: 'what is my company called',
  full: 'Your company is OAra Labs.',
  audio_base64: null
}
const ok = parseVoiceOutcome(complete)
check(ok.kind === 'spoken', 'complete → spoken')
check(ok.kind === 'spoken' && ok.transcript === complete.transcript, 'transcript carried')

// A 44-byte minimal WAV so the spoken-with-audio path exercises url creation.
const wavB64 = Buffer.from('RIFF$   WAVEfmt ').toString('base64')
const withAudio = parseVoiceOutcome({ status: 'complete', transcript: 'hi', full: 'hello', audio_base64: wavB64 })
check(withAudio.kind === 'spoken' && typeof withAudio.audioUrl === 'string', 'audio reply → playable url')

const noSpeech = parseVoiceOutcome({ status: 'no_speech', transcript: '' })
check(noSpeech.kind === 'no_speech' && noSpeech.notice.length > 0, 'no_speech → VISIBLE notice (never silent)')
check(noSpeech.kind === 'no_speech' && /catch/i.test(noSpeech.notice), 'no_speech notice is actionable')

const timeout = parseVoiceOutcome({ status: 'timeout' })
check(timeout.kind === 'timeout' && timeout.notice.length > 0, 'timeout → visible notice')

const err = parseVoiceOutcome({ status: 'error' })
check(err.kind === 'error' && err.notice.length > 0, 'unknown/error status → visible notice')

console.log('\n=== result ===')
if (failures > 0) {
  console.error(`${failures} assertion(s) failed`)
  process.exit(1)
}
console.log('all assertions passed')
