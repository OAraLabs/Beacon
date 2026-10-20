import { toOverlayColor } from '@shared/window-chrome'

/**
 * Keep the OS-drawn window buttons in step with the skin.
 *
 * WHY THIS IS RENDERER-SIDE. Nine plates, each with its own `--paper`, and the chrome bar is
 * `--chrome-ground` = `color-mix(--paper 86%, black)`. A colour table in main would be a tenth copy
 * of the palette that `lint:tokens` and `lint:contrast` cannot see, and it would drift the first
 * time someone retuned a plate. So the renderer resolves the tokens it already owns and pushes the
 * two resulting colours over IPC; main applies them (see @shared/window-chrome for why the value
 * must be CONVERTED before it crosses — Chromium resolves a color-mix custom property to
 * `color(srgb …)`, which Electron's overlay parser rejects).
 *
 * WHY `data-wco` RATHER THAN PLATFORM SNIFFING. `navigator.windowControlsOverlay.visible` is the
 * ground truth about whether the OS reserved a strip of buttons over our bar — true on the Linux
 * and Windows builds, false on macOS, where the traffic lights are the platform's own affordance
 * and sit at the LEFT edge instead. The CSS keys off `[data-wco]` to swap which side gets the
 * inset, so the two families cannot drift apart by guessing a platform string.
 */

/** True when the OS has reserved a window-button strip over the page (Window Controls Overlay). */
export function wcoActive(): boolean {
  return Boolean(navigator.windowControlsOverlay?.visible)
}

/** Resolve a custom property to a concrete colour string.
 *
 *  A probe element is required: `getComputedStyle(root).getPropertyValue('--chrome-ground')`
 *  returns the TOKEN TEXT — literally `color-mix(in srgb, …)` — whereas a computed `color` on a
 *  real element resolves it. Measured on Electron 44.4.1: the resolved form for a color-mix is
 *  `color(srgb 0.0505882 0.0607059 0.0843137)`, which is what `toOverlayColor` exists to convert.
 *
 *  Returns null only when the assignment itself is REJECTED (style.color stays empty) — e.g. a
 *  malformed property name. It cannot detect a MISSING token: `var(--undefined)` parses fine and
 *  resolves to the inherited colour at computed time. Every plate defines both tokens this reads,
 *  and lint:contrast measures them, so that is a documented limit rather than a live gap.
 *  (No sentinel colour literal: lint:tokens forbids them in the renderer, rightly.) */
function resolveColor(prop: string): string | null {
  if (typeof document === 'undefined') return null
  const el = document.createElement('span')
  el.style.cssText = 'position:fixed;width:0;height:0;pointer-events:none;'
  el.style.color = `var(${prop})`
  if (!el.style.color) return null
  document.documentElement.appendChild(el)
  const v = getComputedStyle(el).color
  el.remove()
  return v || null
}

/**
 * Repaint the window buttons for the theme currently on <html>.
 *
 * Best-effort and never throwing: this is a cosmetic repaint, and a failure here must not break
 * applying the skin it was called from. Main validates the payload independently and keeps the
 * current colours if it is unusable, so the worst outcome is buttons that lag one skin change.
 */
export function syncTitlebarOverlay(): void {
  try {
    const b = window.beacon
    if (!b?.setTitlebarOverlay) return
    if (!wcoActive()) return // macOS: the traffic lights are the system's own and cannot be recoloured
    // The bar's own ground, and the plate's primary text colour for the glyphs. `--ink` is the one
    // the codex already lints for contrast against the plate, which beats a hardcoded guess.
    const color = toOverlayColor(resolveColor('--chrome-ground'))
    const symbolColor = toOverlayColor(resolveColor('--ink'))
    if (!color || !symbolColor) return
    b.setTitlebarOverlay({ color, symbolColor })
  } catch {
    /* a cosmetic repaint is not worth breaking the theme change it rode in on */
  }
}

let geometryListenerAttached = false

/** Mark <html> with whether the OS reserved a button strip, and keep it honest as that strip
 *  resizes (maximize/restore changes the reserved width, which follows the toolkit's metrics
 *  rather than a constant). Idempotent. */
export function syncWcoAttribute(): void {
  if (typeof document === 'undefined') return
  document.documentElement.toggleAttribute('data-wco', wcoActive())
  const wco = navigator.windowControlsOverlay
  if (!geometryListenerAttached && wco?.addEventListener) {
    geometryListenerAttached = true
    wco.addEventListener('geometrychange', () => {
      document.documentElement.toggleAttribute('data-wco', wcoActive())
      syncTitlebarOverlay()
    })
  }
}
