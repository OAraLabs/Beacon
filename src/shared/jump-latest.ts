// The jump-to-latest pill.
//
// Adopted from the build — it was not in the original design and should have been; scrolling up
// through a long session with no way back is a real gap.
//
// TWO THRESHOLDS, not one, and conflating them is the bug this module exists to prevent:
//
//   * STICK — "keep following the reply as it streams". Must be tight (a bottom you are within
//     a line or two of), or a user who scrolled up a paragraph gets yanked back mid-read.
//   * SHOW THE PILL — "you are far enough away to need a way back". Must be loose (about a
//     screenful), or the pill flickers in and out on every small scroll and reads as a glitch.
//
// A single threshold has to be wrong for one of them. Pure, so both are pinned by a smoke.

/** Within this many px of the bottom, new content keeps scrolling into view. */
export const STICK_PX = 80

export interface ScrollGeometry {
  scrollTop: number
  scrollHeight: number
  clientHeight: number
}

/** Distance in px from the bottom of the scroller. */
export function distanceFromBottom(g: ScrollGeometry): number {
  return Math.max(0, g.scrollHeight - g.scrollTop - g.clientHeight)
}

/** Should new content keep following? */
export function shouldStick(g: ScrollGeometry): boolean {
  return distanceFromBottom(g) < STICK_PX
}

/**
 * Should the pill show? More than ONE VIEWPORT from the bottom, per the match spec.
 *
 * Deliberately not `!shouldStick`: the gap between the two thresholds is what stops the pill
 * appearing the instant you nudge the wheel.
 */
export function showJumpPill(g: ScrollGeometry): boolean {
  return distanceFromBottom(g) > g.clientHeight
}

/**
 * The pill's label. `Latest` normally; `3 new` when messages ARRIVED while you were scrolled up.
 *
 * The count is what you missed, so it is measured from the moment you detached — not the total,
 * and never negative when the transcript shrinks under you (a fork, a purge, the render window
 * changing). A zero or negative delta is simply "Latest".
 */
export function jumpLabel(rendered: number, baseline: number | null): string {
  if (baseline === null) return 'Latest'
  const n = rendered - baseline
  return n > 0 ? `${n} new` : 'Latest'
}

/** True when the label is a COUNT, so the caller can paint it in the accent. */
export function jumpHasNew(rendered: number, baseline: number | null): boolean {
  return baseline !== null && rendered - baseline > 0
}
