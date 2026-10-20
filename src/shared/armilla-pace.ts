// Armilla's frame pacing: how long the Mission sky waits before its next redraw.
//
// The sky used to redraw on every display frame (120 a second on a ProMotion Mac) for as long as
// Mission was on screen, including at rest, when it turns once every three minutes and moves a
// small fraction of a pixel per frame. Measured 2026-10-04 on an M2 Pro, connected and idle: Mission
// cost ~4% CPU and an Activity Monitor energy impact of 42–56; Chat cost 1% / 14; Mission with the
// sky static cost ~0.
//
// Motion is telemetry, so the pace follows what the sky is showing:
//   resting (no work heat, no ripple or comet in flight) → IDLE_FRAME_MS. At rest the fastest thing
//     on screen is the equator at S·RATE_IDLE ≈ 8.8 viewBox units a second, so a step stays near
//     one unit: the turn still reads as smooth.
//   working, window focused → every display frame, as before.
//   working, window not focused → UNFOCUSED_FRAME_MS. Still moving, because a sky frozen while the
//     agent works would say nothing is happening. The wait plus the next display frame comes to
//     ~24 redraws a second on a 120 Hz screen, a fifth of the frames.
// A hidden or minimised window needs no rule here: Chromium stops animation frames on its own.

export const IDLE_FRAME_MS = 100
export const UNFOCUSED_FRAME_MS = 33

export interface SkyActivity {
  /** Work heat, 0..1. Every chat delta, tool call or gateway frame raises it; it decays to 0 within 6 s. */
  heat: number
  /** A tool-call ripple or a signal comet is mid-flight. */
  transients: boolean
  /** The shell page has focus (document.hasFocus()). */
  focused: boolean
}

/** Milliseconds before the next redraw; 0 means the next display frame. */
export function nextFrameDelay(a: SkyActivity): number {
  if (a.heat <= 0 && !a.transients) return IDLE_FRAME_MS
  return a.focused ? 0 : UNFOCUSED_FRAME_MS
}
