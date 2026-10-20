// Codex re-skin — theme system (the Skin Codex: NINE plates as of 2026-09-03). Pure bits, shared
// with the headless smoke; the DOM apply + persistence live in the renderer
// (src/renderer/src/theme/apply-theme.ts). Default is NOX (dark) — the reference default, and what
// today's app already is, so no flash. Every plate is a [data-theme] token block in theme/tokens.css.
//
// KEYS ARE HISTORICAL, LABELS ARE CURRENT. 'dark' is NOX and 'light' is LVX; as of 2026-09-03
// 'rvbedo' is GLAVCVM — that plate was RETUNED IN PLACE (grey stock, slate-green) rather than
// replaced, because RVBEDO's paper sat 4 points off LVX's on one channel and read as the same
// plate. Keeping the key means no persisted setting migrates: anyone wearing RVBEDO simply wakes
// up in GLAVCVM, which is the intent. Do NOT "tidy" the key to match the label — that would strand
// every stored 'rvbedo' on the default.

export type Theme = 'dark' | 'nigredo' | 'light' | 'avrvm' | 'vmbra' | 'aervgo' | 'caervla' | 'rvbedo' | 'aether'

/** Picker/cycle order — the codex page order. NIGREDO sits directly after NOX so the two darks are
 *  adjacent in the picker and the cycle steps NOX → NIGREDO, which is the pairing a user reaches for. */
export const THEMES: readonly Theme[] = ['dark', 'nigredo', 'light', 'avrvm', 'vmbra', 'aervgo', 'caervla', 'rvbedo', 'aether']

/** b.settings KV key (renderer-only persistence; no new IPC). */
export const THEME_KEY = 'theme:v1'

/** NOX (dark) — the reference default; matches the pre-reskin dark app, so startup doesn't flash. */
export const DEFAULT_THEME: Theme = 'dark'

/** Mono label shown on the status-bar picker (Roman orthography: V for U). */
export const THEME_LABEL: Record<Theme, string> = {
  dark: 'NOX',
  nigredo: 'NIGREDO',
  light: 'LVX',
  avrvm: 'AVRVM',
  vmbra: 'VMBRA',
  aervgo: 'AERVGO',
  caervla: 'CAERVLA',
  rvbedo: 'GLAVCVM', // the key is historical — see the note at the top of this file
  aether: 'AETHER'
}

/** One-line epithet per plate — the picker's second voice. */
export const THEME_EPITHET: Record<Theme, string> = {
  dark: 'The Observatory · dark',
  nigredo: 'The Camera Obscura · dark',
  light: 'The Vellum · light',
  avrvm: 'The Gilded Study · dark',
  vmbra: 'Totality · dark',
  aervgo: 'The Bronze Astrolabe · dark',
  caervla: 'The Engineer’s Folio · dark',
  rvbedo: 'The Herbarium · light',
  aether: 'The Frost Codex · light'
}

/** Advance to the next plate in codex order (wraps). Pure. */
export function nextTheme(t: Theme): Theme {
  const i = THEMES.indexOf(t)
  return THEMES[(i + 1) % THEMES.length]
}

/** Narrow an unknown (e.g. a persisted setting) to a Theme, else the default. Pure. */
export function coerceTheme(v: unknown): Theme {
  return typeof v === 'string' && (THEMES as readonly string[]).includes(v) ? (v as Theme) : DEFAULT_THEME
}

// ── System light/dark follow (audit #6) ───────────────────────────────────────
// A tenth choice alongside the nine plates: "match the OS". When worn, the app follows
// nativeTheme — OS flips to dark → NOX, to light → LVX. NOX and LVX are deliberately the two
// REFERENCE plates (the ones every other plate re-pitches), so "match system" lands on the neutral
// pair rather than guessing which of six darks / three lights a user meant. A user who wants a
// specific plate picks that plate and opts out of following; this is for the person who wants
// Beacon to do what their OS does.

/** The sentinel choice meaning "follow the OS". Stored under THEME_KEY exactly like a plate key. */
export const SYSTEM_CHOICE = 'system' as const

/** A persisted theme choice: one of the nine plates, or 'system'. */
export type ThemeChoice = Theme | typeof SYSTEM_CHOICE

/** The label the pickers show for the system choice. Matches the plates' Roman orthography. */
export const SYSTEM_LABEL = 'SYSTEMA'
export const SYSTEM_EPITHET = 'Follow the OS · light & dark'

/** The two plates the system choice resolves to. Split out so the mapping has one home and a smoke
 *  can pin it — 'dark' is NOX and 'light' is LVX by the same historical-key rule as the rest. */
export const SYSTEM_DARK_THEME: Theme = 'dark'
export const SYSTEM_LIGHT_THEME: Theme = 'light'

/** Resolve the system choice to a concrete plate for a given OS appearance. Pure. */
export function resolveSystemTheme(osDark: boolean): Theme {
  return osDark ? SYSTEM_DARK_THEME : SYSTEM_LIGHT_THEME
}

/** The plate actually worn: for a fixed choice it is that choice; for 'system' it is the resolved
 *  plate. This is the single thing that reaches data-theme — the choice is what persists, the
 *  effective theme is what renders. Pure. */
export function effectiveTheme(choice: ThemeChoice, osDark: boolean): Theme {
  return choice === SYSTEM_CHOICE ? resolveSystemTheme(osDark) : choice
}

/** Narrow an unknown persisted value to a ThemeChoice. Accepts every plate key AND the 'system'
 *  sentinel; anything else → the default plate (NOX), matching coerceTheme's safe fallback. Pure. */
export function coerceThemeChoice(v: unknown): ThemeChoice {
  if (v === SYSTEM_CHOICE) return SYSTEM_CHOICE
  return coerceTheme(v)
}
