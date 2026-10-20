// The host chip's distance reading.
//
// One GET is not a measurement: a renderer→main→daemon round trip picks up GC pauses, IPC
// scheduling and whatever else the machine was doing, so consecutive samples of a HEALTHY local
// gateway routinely read 18ms, 91ms, 24ms. A chip that prints the latest sample flickers, and a
// flickering number reads as instability the link does not actually have.
//
// So the chip shows the MEDIAN of a short window. The median (not the mean) because the noise is
// one-sided — a stall inflates a sample, nothing ever makes one arrive early — and a single 300ms
// outlier drags a mean of five by 55ms while moving the median not at all.
//
// Pure, so a smoke can pin the window and the ordering without a daemon.

export const LATENCY_WINDOW = 5

/** Append a sample, keeping at most `LATENCY_WINDOW` of the most recent. Never mutates. */
export function pushSample(window: number[], ms: number, size = LATENCY_WINDOW): number[] {
  if (!Number.isFinite(ms) || ms < 0) return window
  return [...window, Math.round(ms)].slice(-size)
}

/** The median of the window, rounded, or null while nothing has been sampled. */
export function medianMs(window: number[]): number | null {
  if (window.length === 0) return null
  const sorted = [...window].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  // Even window → the LOWER of the two middles, not their average. Averaging invents a value
  // that was never observed; the chip should only ever show a number the link actually produced.
  return sorted.length % 2 === 1 ? sorted[mid] : sorted[mid - 1]
}
