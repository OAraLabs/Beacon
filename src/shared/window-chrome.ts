/**
 * Window chrome — which platform draws its own window buttons, and what colour they get.
 *
 * THE PROBLEM THIS EXISTS FOR. macOS uses `titleBarStyle: 'hiddenInset'`, which keeps the traffic
 * lights and hands the bar to the renderer. Every other platform used `frame: false`, which removes
 * the buttons outright — and Beacon drew no replacements, so on the AppImage/deb the window could
 * not be closed, minimized or maximized with a mouse at all. Alt+F4 and the tray menu were the only
 * exits, and neither is discoverable from a window you are looking at.
 *
 * THE FIX IS MEASURED, NOT CHOSEN. `titleBarOverlay` is documented `@platform win32,linux`, but it
 * only produces buttons if the window still HAS standard controls. Measured on Electron 44.4.1 /
 * Linux (GNOME, X11) with scripts/wco-probe.cjs:
 *
 *   frame: false            + overlay -> wcoVisible FALSE, no titlebar area   (still no buttons)
 *   titleBarStyle: 'hidden' + overlay -> wcoVisible TRUE, area x0 w287 h38    (buttons present)
 *
 * So the Linux/Windows window takes `titleBarStyle: 'hidden'` + `titleBarOverlay`, and the renderer
 * keeps `env(titlebar-area-*)` free for its own bar. The first draft of that probe used `show:
 * false`; an unrealized window reports WCO unavailable for EVERY configuration, which read as
 * "Linux has no WCO" and would have sent this down the wrong path. Hence the script.
 *
 * WHY THE COLOUR IS PUSHED FROM THE RENDERER AND NOT TABLED HERE. There are nine skins and each has
 * its own `--paper`, and the chrome bar is `--chrome-ground` = `color-mix(--paper 86%, #000)`. A
 * colour table in main would be a tenth copy of the palette that `lint:tokens` and `lint:contrast`
 * cannot see, and it would drift the first time someone retuned a plate. Instead the renderer
 * resolves the tokens it already owns and sends the two resulting CSS colours; main applies them.
 */

/** True when the OS draws its own window buttons over our bar (Window Controls Overlay).
 *  macOS is excluded: it uses the traffic lights, which are the platform's own affordance and
 *  cannot be recoloured — `setTitleBarOverlay` throws there. */
export function usesWindowControlsOverlay(platform: string): boolean {
  return platform === 'linux' || platform === 'win32'
}

/**
 * Convert a computed colour to a form `setTitleBarOverlay` accepts.
 *
 * THIS EXISTS BECAUSE OF A MEASURED INCOMPATIBILITY, not caution. `--chrome-ground` is
 * `color-mix(in srgb, var(--paper) 86%, #000)`, and Chromium resolves a custom property holding
 * `color-mix` to the **`color(srgb 0.05 0.06 0.08)`** form, not `rgb()`. Electron's overlay parser
 * rejects that form outright — measured on 44.4.1/Linux:
 *
 *   'rgb(12, 14, 19)'                        -> accepted
 *   'color(srgb 0.0505882 0.0607059 0.0843137)' -> THROWS 'Could not parse color as CSS color'
 *   '#0c0e13'                                 -> accepted
 *
 * So a renderer that forwards `getComputedStyle(...).color` verbatim would have its repaint
 * rejected for EVERY skin that uses color-mix — and rejected silently, because the window was
 * created with colours matching the default plate. The bug would be invisible on NOX and wrong on
 * the other eight. The conversion has to happen before the value crosses IPC.
 *
 * Returns null when the value is not one of the three shapes below; callers treat null as "do not
 * repaint" rather than "repaint with a guess".
 */
export function toOverlayColor(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const t = value.trim()
  if (!t) return null
  // `color(srgb R G B[, A])` with components in 0..1 — what color-mix resolves to.
  const srgb = /^color\(srgb\s+([\d.eE+-]+)\s+([\d.eE+-]+)\s+([\d.eE+-]+)(?:\s*\/\s*[\d.eE%-]+)?\)$/i.exec(t)
  if (srgb) {
    const chan = (raw: string): number | null => {
      const n = Number(raw)
      if (!Number.isFinite(n) || n < 0 || n > 1) return null
      return Math.round(n * 255)
    }
    const [r, g, b] = [chan(srgb[1]), chan(srgb[2]), chan(srgb[3])]
    if (r === null || g === null || b === null) return null
    return `rgb(${r}, ${g}, ${b})`
  }
  return CSS_COLOR.test(t) ? t : null
}

/** A CSS colour we are willing to hand to the OS: `rgb()/rgba()` or `#rgb`/`#rrggbb`. Anything
 *  else is dropped — `toOverlayColor` is what turns the computed forms INTO this set. This is a
 *  trust boundary in the boring direction: the value comes over IPC from our own renderer, but a
 *  malformed string reaching `setTitleBarOverlay` throws in main, and an exception on a cosmetic
 *  repaint is a bad trade for validating one regex. */
const CSS_COLOR = /^(#[0-9a-fA-F]{3}|#[0-9a-fA-F]{6}|rgb\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*\)|rgba\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*(0|1|0?\.\d+)\s*\))$/

export function sanitizeOverlayColor(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const t = v.trim()
  return CSS_COLOR.test(t) ? t : null
}

/** The overlay options main will apply, or null when the payload is unusable. Both colours must
 *  survive: a bar with a valid ground and an invalid glyph colour would render buttons you cannot
 *  see, which is the failure mode this whole file exists to remove. */
export function overlayOptionsFrom(payload: unknown): { color: string; symbolColor: string } | null {
  if (!payload || typeof payload !== 'object') return null
  const p = payload as Record<string, unknown>
  const color = sanitizeOverlayColor(p.color)
  const symbolColor = sanitizeOverlayColor(p.symbolColor)
  if (!color || !symbolColor) return null
  return { color, symbolColor }
}

/** The overlay's height must match the bar the renderer draws, or the OS buttons sit over content.
 *  AppChrome is 38px in styles.css; this is the one number that has to agree across main and
 *  renderer, which is why it is exported rather than written twice. */
export const TITLEBAR_OVERLAY_HEIGHT = 38

/**
 * The window-chrome half of the BrowserWindow options, per platform.
 *
 * PURE AND EXPORTED SO IT CANNOT DRIFT. This is the exact decision that regressed: main once
 * branched to `{ frame: false }` off darwin, which silently deleted the window buttons on Linux and
 * Windows. Keeping the branch inline in `createWindow()` meant the only way to test it was to build
 * the whole app and look — so nobody did, and the defect shipped. As a pure function the smoke can
 * assert the shape (and that `frame: false` is NOT what non-darwin gets), and a probe can construct
 * a real window FROM IT rather than from a copy of it.
 */
export interface WindowChromeOptions {
  titleBarStyle?: 'hiddenInset' | 'hidden'
  titleBarOverlay?: { color: string; symbolColor: string; height: number }
  frame?: false
}

/** The chrome ground/glyph pair the window is CREATED with, before the renderer pushes the active
 *  skin's. Matches the default plate (NOX) so a first paint is never wrong-coloured. */
export const INITIAL_OVERLAY_COLORS = { color: '#0c0e13', symbolColor: '#ece3cc' } as const

export function windowChromeOptions(platform: string): WindowChromeOptions {
  if (platform === 'darwin') {
    // Traffic lights, kept and inset into the bar the renderer draws. Not recolourable, and
    // setTitleBarOverlay throws here — hence no overlay key at all.
    return { titleBarStyle: 'hiddenInset' }
  }
  if (usesWindowControlsOverlay(platform)) {
    return {
      titleBarStyle: 'hidden',
      titleBarOverlay: { ...INITIAL_OVERLAY_COLORS, height: TITLEBAR_OVERLAY_HEIGHT }
    }
  }
  // An unmeasured platform: keep the OS's own frame rather than removing the buttons and drawing
  // nothing. Ugly next to our bar, but a window you can still close.
  return {}
}
