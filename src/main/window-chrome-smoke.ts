// Headless smoke for @shared/window-chrome (ELECTRON_RUN_AS_NODE electron out/main/window-chrome-smoke.js).
//
// WHAT THIS PINS, AND WHY IT IS NOT JUST "the regex works". The Linux window used `frame: false`,
// which removes the OS window buttons and leaves no replacements — a window that cannot be closed,
// minimized or maximized with a mouse. The fix keeps `titleBarStyle: 'hidden'` plus a
// `titleBarOverlay`, and repaints that overlay to match the active skin.
//
// Two of the facts below were MEASURED on the real engine (Electron 44.4.1/Linux), not reasoned:
//   * WCO only yields buttons with `titleBarStyle: 'hidden'` — `frame: false` + overlay reports
//     wcoVisible:false and reserves no titlebar area (scripts/wco-probe.cjs).
//   * `setTitleBarOverlay` REJECTS the `color(srgb …)` form, which is exactly what Chromium
//     computes for our `--chrome-ground` (a `color-mix`). Accepted: rgb()/rgba()/#hex.
// The smoke asserts the conversion those two facts force. Run: npm run smoke:window-chrome

import {
  INITIAL_OVERLAY_COLORS,
  overlayOptionsFrom,
  sanitizeOverlayColor,
  toOverlayColor,
  usesWindowControlsOverlay,
  windowChromeOptions,
  TITLEBAR_OVERLAY_HEIGHT
} from '@shared/window-chrome'

let failures = 0
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) console.log(`  ✓ ${name}`)
  else {
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`)
    failures++
  }
}

console.log('usesWindowControlsOverlay (who draws the buttons):')
check('linux → WCO', usesWindowControlsOverlay('linux'))
check('win32 → WCO', usesWindowControlsOverlay('win32'))
check('darwin → false (traffic lights are the system\'s own; setTitleBarOverlay throws there)', !usesWindowControlsOverlay('darwin'))
check('unknown platform → false (fail closed: no overlay for a platform we did not measure)', !usesWindowControlsOverlay('plan9'))
check('empty → false', !usesWindowControlsOverlay(''))

console.log('toOverlayColor (the computed form → a form Electron will accept):')
// The real value, read off Chromium for NOX's --chrome-ground = color-mix(--paper 86%, #000).
check(
  'color(srgb …) from color-mix converts — this is THE case; verbatim it throws in main',
  // 0.0505882*255=12.9, 0.0607059*255=15.5, 0.0843137*255=21.50 -> 13, 15, 21 after rounding.
  toOverlayColor('color(srgb 0.0505882 0.0607059 0.0843137)') === 'rgb(13, 15, 21)',
  String(toOverlayColor('color(srgb 0.0505882 0.0607059 0.0843137)'))
)
check('a LIGHT plate converts too (LVX paper)', toOverlayColor('color(srgb 0.9004 0.8978 0.8894)') === 'rgb(230, 229, 227)', String(toOverlayColor('color(srgb 0.9004 0.8978 0.8894)')))
check('pure black and pure white clamp to 0 and 255', toOverlayColor('color(srgb 0 0 0)') === 'rgb(0, 0, 0)' && toOverlayColor('color(srgb 1 1 1)') === 'rgb(255, 255, 255)')
check('color() with an alpha suffix converts (alpha is dropped — the overlay is opaque)', toOverlayColor('color(srgb 0.05 0.06 0.08 / 1)') === 'rgb(13, 15, 20)', String(toOverlayColor('color(srgb 0.05 0.06 0.08 / 1)')))
check('rgb() passes through unchanged', toOverlayColor('rgb(12, 14, 19)') === 'rgb(12, 14, 19)')
check('rgb() without spaces passes through', toOverlayColor('rgb(12,14,19)') === 'rgb(12,14,19)')
check('rgba() passes through', toOverlayColor('rgba(12, 14, 19, 1)') === 'rgba(12, 14, 19, 1)')
check('#rrggbb passes through', toOverlayColor('#0c0e13') === '#0c0e13')
check('#rgb passes through', toOverlayColor('#abc') === '#abc')
check('surrounding whitespace is trimmed', toOverlayColor('  rgb(1, 2, 3)  ') === 'rgb(1, 2, 3)')

console.log('toOverlayColor refusals (never hand main something that throws):')
check('out-of-range channel refused (2 > 1) — a silent clamp would repaint the wrong colour', toOverlayColor('color(srgb 2 0 0)') === null)
check('negative channel refused', toOverlayColor('color(srgb -0.1 0 0)') === null)
check('garbage refused', toOverlayColor('garbage') === null)
check('empty string refused', toOverlayColor('') === null)
check('null refused', toOverlayColor(null) === null)
check('undefined refused', toOverlayColor(undefined) === null)
check('number refused', toOverlayColor(12345) === null)
check('hsl() refused — Electron does not accept it, and we do not emit it', toOverlayColor('hsl(210, 20%, 6%)') === null)
check('a non-srgb color() space refused', toOverlayColor('color(display-p3 0.1 0.2 0.3)') === null)

console.log('sanitizeOverlayColor (main\'s own gate, defence in depth):')
check('accepts rgb()', sanitizeOverlayColor('rgb(1, 2, 3)') === 'rgb(1, 2, 3)')
check('accepts #hex', sanitizeOverlayColor('#0c0e13') === '#0c0e13')
// Main validates what arrives over IPC rather than trusting the renderer's conversion. If this ever
// accepted color(srgb …) the two gates would disagree and main would throw on a value it had passed.
check('REFUSES color(srgb …) — the renderer converts before sending; main never forwards it', sanitizeOverlayColor('color(srgb 0.05 0.06 0.08)') === null)
check('refuses garbage', sanitizeOverlayColor('garbage') === null)
check('refuses non-string', sanitizeOverlayColor({ color: 'rgb(1,2,3)' }) === null)

console.log('overlayOptionsFrom (both colours, or nothing):')
check('both valid → options', JSON.stringify(overlayOptionsFrom({ color: 'rgb(13, 15, 22)', symbolColor: 'rgb(236, 227, 204)' })) === '{"color":"rgb(13, 15, 22)","symbolColor":"rgb(236, 227, 204)"}')
// A bar with a valid ground and an invalid glyph colour renders buttons you cannot see — the exact
// failure this whole module exists to prevent. Both or neither.
check('one bad colour → null (invisible buttons are worse than stale ones)', overlayOptionsFrom({ color: 'rgb(1, 2, 3)', symbolColor: 'garbage' }) === null)
check('missing colour → null', overlayOptionsFrom({ color: 'rgb(1, 2, 3)' }) === null)
check('null payload → null', overlayOptionsFrom(null) === null)
check('non-object payload → null', overlayOptionsFrom('rgb(1, 2, 3)') === null)
check('extra keys ignored, the two colours kept', JSON.stringify(overlayOptionsFrom({ color: '#111111', symbolColor: '#eeeeee', height: 999 })) === '{"color":"#111111","symbolColor":"#eeeeee"}')

console.log('windowChromeOptions (the shipped BrowserWindow config, per platform):')
// This is THE assertion that would have caught the shipped defect. main built this inline as
// `{ frame: false }` for every non-darwin platform, which removes the OS window buttons and left
// nothing drawn in their place: on the AppImage/deb the window could not be closed, minimized or
// maximized with a mouse at all. Extracting the branch here is what makes it assertable, and
// scripts/window-chrome-probe then builds a REAL window from this same function so the config
// tested and the config shipped cannot diverge.
{
  const linux = windowChromeOptions('linux')
  const win = windowChromeOptions('win32')
  const mac = windowChromeOptions('darwin')
  const other = windowChromeOptions('plan9')
  check('linux keeps its window buttons — NO frame:false', linux.frame !== false, JSON.stringify(linux))
  check('win32 keeps its window buttons — NO frame:false', win.frame !== false, JSON.stringify(win))
  check('linux uses titleBarStyle hidden (the ONLY pairing that yields WCO buttons — measured)', linux.titleBarStyle === 'hidden', String(linux.titleBarStyle))
  check('win32 uses titleBarStyle hidden', win.titleBarStyle === 'hidden', String(win.titleBarStyle))
  check('linux carries an overlay sized to the bar', linux.titleBarOverlay?.height === TITLEBAR_OVERLAY_HEIGHT, JSON.stringify(linux.titleBarOverlay))
  check('the initial overlay colours are a pair Electron accepts (not the computed color(srgb …) form)', overlayOptionsFrom({ color: INITIAL_OVERLAY_COLORS.color, symbolColor: INITIAL_OVERLAY_COLORS.symbolColor }) !== null, JSON.stringify(INITIAL_OVERLAY_COLORS))
  check('darwin keeps hiddenInset (traffic lights) and NO overlay — setTitleBarOverlay throws there', mac.titleBarStyle === 'hiddenInset' && mac.titleBarOverlay === undefined, JSON.stringify(mac))
  check('darwin does not disable the frame either', mac.frame !== false, JSON.stringify(mac))
  check('an unmeasured platform keeps the OS frame rather than losing its buttons', Object.keys(other).length === 0 && other.frame !== false, JSON.stringify(other))
  check('linux and win32 get the same treatment', JSON.stringify(linux) === JSON.stringify(win))
}

console.log('TITLEBAR_OVERLAY_HEIGHT (the one number main and the CSS bar must agree on):')
// AppChrome is 38px in styles.css. If these disagree the OS buttons overlap content or float above
// the bar. Asserted as a value rather than re-derived: the agreement is the contract.
check('overlay height is 38, matching .app-chrome in styles.css', TITLEBAR_OVERLAY_HEIGHT === 38, String(TITLEBAR_OVERLAY_HEIGHT))

console.log(failures === 0 ? `\nPASS (${failures} failures)` : `\nFAIL ${failures}`)
process.exit(failures === 0 ? 0 : 1)
