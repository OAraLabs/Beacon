// Pure bits of the hands-free overlay, so a smoke can pin them without a mic.

import type { HandsFreePhase } from './hands-free'

/** `LISTENING`, `HEARING YOU`, … — the phase, said the way the overlay says it. Upper case
 *  because it is a status label, and mono per the font rule; the words come from the state
 *  machine that was already running, never from a separate copy of the truth. */
export function overlayStatus(phase: HandsFreePhase, holding = false): string {
  if (holding) return 'HOLDING'
  switch (phase) {
    case 'off':
      return 'OFF'
    case 'listening':
      return 'LISTENING'
    case 'capturing':
      return 'HEARING YOU'
    case 'processing':
      return 'THINKING'
    case 'speaking':
      return 'SPEAKING'
  }
}

/** `00:12` — mm:ss since the mic opened. Past an hour it grows a field rather than wrapping to
 *  zero, because a session that long is exactly when you want to know. */
export function elapsedClock(ms: number): string {
  const total = Math.max(0, Math.floor((Number.isFinite(ms) ? ms : 0) / 1000))
  const s = total % 60
  const m = Math.floor(total / 60) % 60
  const h = Math.floor(total / 3600)
  const mm = String(m).padStart(2, '0')
  const ss = String(s).padStart(2, '0')
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`
}

/** RMS of a chunk, 0–1 — the level the waveform is drawn from. Not peak: a single clipped sample
 *  would slam every bar to full and stay there, which is a light, not a level. */
export function chunkLevel(chunk: Float32Array): number {
  if (chunk.length === 0) return 0
  let sum = 0
  for (let i = 0; i < chunk.length; i++) sum += chunk[i] * chunk[i]
  return Math.min(1, Math.sqrt(sum / chunk.length))
}
