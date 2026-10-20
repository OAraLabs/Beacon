import type { UiTracePoint, UiTraceEvent } from '@shared/ui-trace'

/**
 * Renderer-side breadcrumb emitter.
 *
 * Stamps the two clocks and hands the row to main, which is where the dev gate
 * and the bounded table live. Fire-and-forget: `send`, never `invoke`, because
 * instrumentation must not add a round-trip to the path it is measuring — and
 * an awaited breadcrumb on the resolve path could itself change the timing the
 * breadcrumbs exist to observe.
 *
 * ⚠ `mono` here is the RENDERER's performance.now(). Main stamps its own, from a
 * different origin. Only `at` (wall clock) aligns the two processes; comparing a
 * renderer mono to a main mono is meaningless and the schema comment says so.
 *
 * Never throws. A missing bridge (preload not ready, or a test harness) is a
 * silently dropped breadcrumb, not a broken click.
 */
export function trace(e: Omit<UiTraceEvent, 'at' | 'mono' | 'proc'> & { point: UiTracePoint }): void {
  try {
    window.beacon?.trace({
      ...e,
      at: Date.now(),
      mono: typeof performance !== 'undefined' ? performance.now() : 0,
      proc: 'renderer'
    })
  } catch {
    /* diagnostics must never break the path they measure */
  }
}
