/**
 * Theme smoke (headless) — the pure Skin Codex logic behind the status-bar picker: default is NOX
 * (matches the pre-reskin dark app, so no flash), the cycle is a full orbit over all NINE plates,
 * every plate has a label + epithet, and a garbage/absent persisted value coerces to the default
 * (never an invalid data-theme). FAIL-LOUD + count-guarded.
 *
 * The two 2026-09-03 plates are pinned here as facts, not vibes: NIGREDO is second (so the cycle
 * steps NOX → NIGREDO, the two darks adjacent), and the `rvbedo` KEY still resolves — it now wears
 * the GLAVCVM label, and a persisted 'rvbedo' must keep landing on a real plate rather than being
 * coerced to the default. Deleting that key is the migration bug this guards.
 */
import {
  nextTheme,
  coerceTheme,
  coerceThemeChoice,
  effectiveTheme,
  resolveSystemTheme,
  DEFAULT_THEME,
  SYSTEM_CHOICE,
  SYSTEM_DARK_THEME,
  SYSTEM_LIGHT_THEME,
  THEME_LABEL,
  THEME_EPITHET,
  THEME_KEY,
  THEMES,
  type Theme
} from '@shared/theme'

let failures = 0
let checks = 0
function assert(cond: boolean, label: string): void {
  checks++
  console.log(`[theme-smoke] ${cond ? 'PASS' : 'FAIL'}  ${label}`)
  if (!cond) failures++
}

if (typeof nextTheme !== 'function' || typeof coerceTheme !== 'function') {
  console.error('[theme-smoke] FAIL — required @shared/theme exports missing.')
  process.exit(1)
}

const FIXED = 24

function main(): void {
  assert(DEFAULT_THEME === 'dark', 'default theme is NOX (dark) — matches pre-reskin app, no startup flash')
  assert(THEMES.length === 9 && new Set(THEMES).size === 9, 'the codex holds nine distinct plates')
  assert(THEMES[0] === DEFAULT_THEME, 'codex order opens at the default (NOX)')
  assert(nextTheme('dark') === 'nigredo', 'NOX → NIGREDO (the two darks are adjacent in the cycle)')
  assert(coerceTheme('rvbedo') === 'rvbedo' && THEME_LABEL.rvbedo === 'GLAVCVM', 'the retired RVBEDO key survives and wears the GLAVCVM label — a persisted setting must not fall back to the default')
  assert(THEME_LABEL.nigredo === 'NIGREDO' && THEME_EPITHET.nigredo.endsWith('dark') && THEME_EPITHET.rvbedo.endsWith('light'), 'NIGREDO is dark, GLAVCVM is light')

  let t: Theme = DEFAULT_THEME
  const seen = new Set<Theme>()
  for (let i = 0; i < THEMES.length; i++) {
    seen.add(t)
    t = nextTheme(t)
  }
  assert(t === DEFAULT_THEME && seen.size === THEMES.length, 'cycle is a full orbit — visits every plate, returns home')

  assert(THEMES.every((x) => coerceTheme(x) === x), 'coerce passes through every valid plate')
  assert(coerceTheme(null) === DEFAULT_THEME, 'coerce null → default (no persisted value yet)')
  assert(coerceTheme('observatory') === DEFAULT_THEME, 'coerce garbage → default (never an invalid data-theme)')
  assert(THEME_LABEL.light === 'LVX' && THEME_LABEL.dark === 'NOX', 'reference labels are LVX / NOX')
  assert(THEMES.every((x) => typeof THEME_LABEL[x] === 'string' && THEME_LABEL[x].length > 0), 'every plate has a mono label')
  assert(THEMES.every((x) => typeof THEME_EPITHET[x] === 'string' && THEME_EPITHET[x].includes('·')), 'every plate has an epithet (name · light/dark)')
  assert(typeof THEME_KEY === 'string' && THEME_KEY.length > 0, 'persistence key present')

  // ── SYSTEMA (audit #6): the tenth choice follows the OS ─────────────────────
  assert(resolveSystemTheme(true) === SYSTEM_DARK_THEME && SYSTEM_DARK_THEME === 'dark', 'OS dark → NOX — the system choice lands on the dark REFERENCE plate, not one of the five re-pitched darks')
  assert(resolveSystemTheme(false) === SYSTEM_LIGHT_THEME && SYSTEM_LIGHT_THEME === 'light', 'OS light → LVX — the light reference, same reasoning')
  assert(effectiveTheme(SYSTEM_CHOICE, true) === 'dark' && effectiveTheme(SYSTEM_CHOICE, false) === 'light', 'effectiveTheme resolves the sentinel against the OS appearance')
  assert(THEMES.every((x) => effectiveTheme(x, true) === x && effectiveTheme(x, false) === x), 'a pinned plate is OS-independent — an explicit choice is never repainted by an OS flip')
  assert(coerceThemeChoice(SYSTEM_CHOICE) === SYSTEM_CHOICE, 'coerce accepts the system sentinel')
  assert(THEMES.every((x) => coerceThemeChoice(x) === x), 'coerce accepts every plate')
  assert(coerceThemeChoice(null) === DEFAULT_THEME && coerceThemeChoice('observatory') === DEFAULT_THEME, 'coerce maps garbage/absent → the default PLATE, never the sentinel — following the OS must be opted into, not fallen into')
  assert(coerceTheme(SYSTEM_CHOICE) === DEFAULT_THEME, 'the OLD coerceTheme degrades the sentinel to NOX — an older build reading a newer persisted choice lands on the reference dark, no invalid data-theme')
  assert((THEMES as readonly string[]).includes(SYSTEM_CHOICE) === false, 'the sentinel is NOT in THEMES — the cycle, the picker grid, and every plate-keyed Record stay nine strong')
  assert((THEMES as readonly string[]).includes(effectiveTheme(coerceThemeChoice(SYSTEM_CHOICE), true)), 'the sentinel resolves to a REAL plate for any OS state — data-theme never receives a value tokens.css has no block for')

  if (checks !== FIXED) {
    console.error(`[theme-smoke] FAIL — ran ${checks} checks but expected ${FIXED}.`)
    failures++
  }
  console.log(`\n[theme-smoke] checks=${checks} expected=${FIXED} failures=${failures} → ${failures === 0 ? 'PASS ✓ (nine-plate orbit, retired-key survival, and default-coercion hold)' : 'FAIL ✗'}`)
  process.exit(failures === 0 ? 0 : 1)
}

try {
  main()
} catch (err) {
  console.error('[theme-smoke] FAILED (threw):', err)
  process.exit(1)
}
