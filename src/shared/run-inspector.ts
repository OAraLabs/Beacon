// The run inspector's arithmetic (match spec, step 13).
//
// The interesting tab is TIMELINE: one bar per call, positioned and sized against the run's total
// span, so serial-vs-parallel is visible at a glance instead of being inferred from a list of
// durations. That is entirely a geometry problem, and geometry is exactly the kind of thing that
// looks right in a screenshot while being wrong — a bar that starts at 0 for every call, or one
// whose width divides by a zero-length run. So it lives here, where a smoke can hold it still.
//
// Pure: no React, no DOM.

import type { TimelineCall } from './timeline'

export interface RunSpan {
  /** Earliest observed start, or null when NO call is timestamped (history rows carry none). */
  start: number | null
  end: number | null
  /** Wall time of the whole run in ms, or null when it cannot be known. */
  totalMs: number | null
}

/**
 * The run's wall-clock envelope.
 *
 * History rows arrive WITHOUT timestamps — only live tool frames carry start/end — so "no span" is
 * a normal state, not an error, and it must be distinguishable from a zero-length one. Null says
 * "cannot be known"; the caller then renders the tab's rows without bars rather than drawing every
 * bar at full width, which is what a 0/0 would produce.
 */
export function runSpan(calls: readonly TimelineCall[]): RunSpan {
  let start: number | null = null
  let end: number | null = null
  for (const c of calls) {
    if (typeof c.startTs === 'number') start = start === null ? c.startTs : Math.min(start, c.startTs)
    const e = typeof c.endTs === 'number' ? c.endTs : typeof c.startTs === 'number' ? c.startTs : null
    if (e !== null) end = end === null ? e : Math.max(end, e)
  }
  if (start === null || end === null) return { start: null, end: null, totalMs: null }
  return { start, end, totalMs: Math.max(0, end - start) }
}

export interface BarGeometry {
  /** Percent from the left of the track. */
  offsetPct: number
  /** Percent of the track's width. Never 0 — a call that ran must be visible. */
  widthPct: number
}

/**
 * Where one call's bar sits in the run's track.
 *
 * Two guards, both for cases that produce a plausible-looking wrong picture:
 *   * a run whose total is 0 (every call inside the same millisecond) would divide by zero; the
 *     bars then share the track equally, which is the truth — nothing was slower than anything.
 *   * a sub-millisecond call would compute a 0% width and vanish, so the row would show a name
 *     and no bar and read as "did not run". A floor of 1.5% keeps it visible as the fast call it
 *     is. (Same defect class as fix/sub-millisecond-latency.)
 */
export function barGeometry(call: TimelineCall, span: RunSpan): BarGeometry | null {
  if (span.start === null || span.totalMs === null) return null
  if (typeof call.startTs !== 'number') return null
  if (span.totalMs === 0) return { offsetPct: 0, widthPct: 100 }
  const endTs = typeof call.endTs === 'number' ? call.endTs : span.end ?? call.startTs
  const offset = ((call.startTs - span.start) / span.totalMs) * 100
  const width = ((endTs - call.startTs) / span.totalMs) * 100
  return {
    offsetPct: Math.min(100, Math.max(0, offset)),
    widthPct: Math.min(100 - Math.min(100, Math.max(0, offset)), Math.max(1.5, width))
  }
}

export type CallStatus = 'running' | 'error' | 'ok'

export function callStatus(call: TimelineCall): CallStatus {
  if (call.running) return 'running'
  return call.error ? 'error' : 'ok'
}

/**
 * The right-hand readout for the selected call: `exit 0 · 1.2s`.
 *
 * `exit 0` is a claim about a PROCESS. The daemon reports success/failure, not an exit status, so
 * this says `ok` / `failed` — the thing that is actually known. Inventing a 0 to match a mockup
 * would be a number the tool never returned.
 */
export function callReadout(call: TimelineCall, fmt: (ms?: number) => string): string {
  const state = call.running ? 'running' : call.error ? 'failed' : 'ok'
  const dur = call.running ? '' : fmt(call.durationMs)
  return dur ? `${state} · ${dur}` : state
}

/** Pretty-print the call's arguments for the Args tab. Never throws on a value JSON cannot hold. */
export function formatArgs(args: unknown): string {
  if (args === undefined || args === null) return 'no arguments'
  if (typeof args === 'string') return args
  try {
    return JSON.stringify(args, null, 2)
  } catch {
    return String(args)
  }
}

/** Lines of tool output, flagged so the renderer can paint the failing ones. */
export function outputLines(text: string): { text: string; bad: boolean }[] {
  return (text ?? '').split('\n').map((line) => ({
    text: line,
    // Conservative on purpose: a line SAYING "error" is the signal we have, and over-painting
    // ordinary prose red would make the colour meaningless. Anchored to word starts so "no errors"
    // and "terror" do not light up.
    bad: /(^|\W)(error|traceback|exception|failed|fatal)(\W|$)/i.test(line)
  }))
}
