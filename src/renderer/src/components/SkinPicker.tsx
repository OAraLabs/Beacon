import { useEffect, useRef, useState } from 'react'
import {
  SYSTEM_CHOICE,
  SYSTEM_EPITHET,
  SYSTEM_LABEL,
  THEME_EPITHET,
  THEME_LABEL,
  THEMES,
  type Theme,
  type ThemeChoice
} from '@shared/theme'
import { currentThemeChoice, setThemeChoice } from '../theme/apply-theme'

/** Skin Codex picker for the status bar (successor to the LVX/NOX ThemeToggle). A line pill
 * showing the worn plate's mono label; clicking opens a menu of the nine plates plus SYSTEMA —
 * the tenth choice, which follows the OS appearance (audit #6). Each menu row's tile carries its
 * own [data-theme], so the tile previews that plate's tokens (paper/geo/accent) regardless of the
 * active skin — zero hardcoded colors, the cascade does the work.
 *
 * CHOICE vs PLATE: the pill and the menu's checked state track the CHOICE (SYSTEMA or a plate),
 * read from apply-theme's module state. The DOM's data-theme only ever carries the resolved PLATE,
 * so initializing from the attribute (as this used to) would show NOX as worn while the user is on
 * SYSTEMA — the resolved tone and the choice are different facts, and the picker is about the
 * choice. SYSTEMA's tile previews the plate actually worn right now. */

function PlateTile({ t }: { t: Theme }) {
  // data-theme on the wrapper scopes that plate's tokens to this tile only.
  return (
    <span className="skin-tile" data-theme={t} aria-hidden="true">
      <svg width="20" height="20" viewBox="0 0 20 20">
        <rect className="skin-tile-paper" x="0.5" y="0.5" width="19" height="19" rx="5.5" />
        <circle className="skin-tile-ring" cx="10" cy="10" r="6" />
        <circle className="skin-tile-core" cx="10" cy="10" r="2.6" />
      </svg>
    </span>
  )
}

export function SkinPicker() {
  const [choice, setChoice] = useState<ThemeChoice>(() => currentThemeChoice() ?? THEMES[0])
  const [worn, setWorn] = useState<Theme>(() => (document.documentElement.getAttribute('data-theme') as Theme) ?? THEMES[0])
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setChoice(currentThemeChoice() ?? THEMES[0])
    setWorn((document.documentElement.getAttribute('data-theme') as Theme) ?? THEMES[0])
  }, [])

  // While SYSTEMA is worn, an OS flip changes which plate renders. apply-theme owns the re-skin;
  // this keeps the pill's tooltip current ("NOX right now") without the picker re-deciding anything.
  useEffect(() => {
    if (choice !== SYSTEM_CHOICE) return
    const off = window.beacon?.systemTheme.onChange(() => {
      setWorn((document.documentElement.getAttribute('data-theme') as Theme) ?? THEMES[0])
    })
    return off
  }, [choice])

  // Close on outside click / Escape while open.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  // Focus the worn choice's row when the menu opens (keyboard flow starts from "you are here").
  useEffect(() => {
    if (open) menuRef.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus()
  }, [open])

  const pick = (c: ThemeChoice): void => {
    setChoice(c)
    setOpen(false)
    // Read the worn plate back from the pick: `worn` drives SYSTEMA's preview, and only an OS flip
    // updated it, so right after picking SYSTEMA the preview showed the plate worn before it.
    void setThemeChoice(c).then(setWorn)
  }

  const pillLabel = choice === SYSTEM_CHOICE ? SYSTEM_LABEL : THEME_LABEL[choice]
  const pillEpithet = choice === SYSTEM_CHOICE ? `${SYSTEM_EPITHET} — ${THEME_LABEL[worn]} right now` : THEME_EPITHET[choice]

  return (
    <div className="skin-picker" ref={rootRef}>
      <button
        className="skin-pill"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        title={`Skin: ${pillLabel} — ${pillEpithet}`}
        aria-label={`Choose skin (currently ${pillLabel})`}
      >
        <svg className="skin-pill-glyph" width="13" height="13" viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="12" cy="12" r="6.5" />
        </svg>
        <span>{pillLabel}</span>
      </button>
      {open ? (
        <div className="skin-menu" role="menu" aria-label="Skin Codex" ref={menuRef}>
          <div className="skin-menu-title">The Skin Codex</div>
          <button
            role="menuitemradio"
            aria-checked={choice === SYSTEM_CHOICE}
            className="skin-item"
            onClick={() => pick(SYSTEM_CHOICE)}
          >
            {/* SYSTEMA's tile previews the plate worn RIGHT NOW — a split-tone preview would need a
                second data-theme scope; the honest cheap version is "this is what you'd get". */}
            <PlateTile t={worn} />
            <span className="skin-item-name">{SYSTEM_LABEL}</span>
            <span className="skin-item-epithet">{SYSTEM_EPITHET}</span>
          </button>
          {THEMES.map((t) => (
            <button key={t} role="menuitemradio" aria-checked={choice === t} className="skin-item" onClick={() => pick(t)}>
              <PlateTile t={t} />
              <span className="skin-item-name">{THEME_LABEL[t]}</span>
              <span className="skin-item-epithet">{THEME_EPITHET[t]}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}
