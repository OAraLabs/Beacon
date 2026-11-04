import { inputLabel, pushStep, trailLine, type ViewStep } from '@shared/view-trail'

// The renderer half of @shared/view-trail: the recent changes of view and the input before each, kept here (module state, so it
// outlives MainView's remounts) and written out as one line whenever Settings opens.

let steps: ViewStep[] = []
let current = '?'
let lastInput: { label: string; at: number } | null = null
let listening = false

function listen(): void {
  if (listening || typeof window === 'undefined') return
  listening = true
  window.addEventListener(
    'click',
    (e) => {
      const el = (e.target as Element | null)?.closest?.('button, a, [role="menuitem"], [role="option"], [title], [aria-label]')
      const label = el?.getAttribute('title') || el?.getAttribute('aria-label') || el?.tagName.toLowerCase() || 'page'
      lastInput = { label: inputLabel({ kind: 'click', label }), at: Date.now() }
    },
    true
  )
  window.addEventListener(
    'keydown',
    (e) => {
      lastInput = { label: inputLabel({ kind: 'key', key: e.key, meta: e.metaKey, ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey }), at: Date.now() }
    },
    true
  )
}

/** MainView's view changed, or MainView mounted (from null). */
export function noteView(from: string | null, to: string): void {
  listen()
  const at = Date.now()
  steps = pushStep(steps, { at, from, to, how: from === null ? 'mount' : 'change', input: lastInput?.label ?? null, inputAgoMs: lastInput ? at - lastInput.at : null })
  current = to
}

/** Settings opened (`opener`: how): the trail, to main, which appends it to the log. */
export function writeTrail(opener: string): void {
  try {
    window.beacon?.viewTrail(trailLine({ at: Date.now(), opener, view: current, rendererUpMs: performance.now(), steps }))
  } catch {
    /* a diagnostic must never break opening Settings */
  }
}
