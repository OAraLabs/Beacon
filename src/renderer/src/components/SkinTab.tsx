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
import { useEffect, useState } from 'react'
import { currentThemeChoice, setThemeChoice } from '../theme/apply-theme'

// Config → Skin. The handoff is explicit: "the skin label belongs in Config, not the header of
// every session", so the plate moved off the thread header and this is where it landed. Screen 4
// describes it as a grid of plates, each a three-band swatch with its roman label and epithet —
// each tile carries its own `data-theme`, so it previews that plate's real tokens through the
// cascade with no hardcoded colour anywhere (which is what keeps check-tokens.mjs happy).
//
// SYSTEMA (audit #6) is a tenth card, not a plate: it follows the OS appearance and resolves to
// NOX or LVX live. Its card carries NO data-theme of its own — its bands preview the plate worn
// right now, re-read on every OS flip, because a fixed-tone preview would lie half the day.
// The checked state tracks the CHOICE (from apply-theme's module state), not the DOM's data-theme:
// data-theme only ever carries the resolved plate, so reading it would show NOX as worn while the
// user is on SYSTEMA.

export function SkinTab() {
  const [choice, setLocal] = useState<ThemeChoice>(() => currentThemeChoice() ?? THEMES[0])
  const [worn, setWorn] = useState<Theme>(() => (document.documentElement.getAttribute('data-theme') as Theme) ?? THEMES[0])

  useEffect(() => {
    setLocal(currentThemeChoice() ?? THEMES[0])
    setWorn((document.documentElement.getAttribute('data-theme') as Theme) ?? THEMES[0])
  }, [])

  // While SYSTEMA is worn, an OS flip changes the resolved plate — apply-theme re-skins the document,
  // and this keeps the preview card honest without the tab re-deciding anything.
  useEffect(() => {
    if (choice !== SYSTEM_CHOICE) return
    const off = window.beacon?.systemTheme.onChange(() => {
      setWorn((document.documentElement.getAttribute('data-theme') as Theme) ?? THEMES[0])
    })
    return off
  }, [choice])

  const pick = (c: ThemeChoice): void => {
    setLocal(c)
    // Read the worn plate back from the pick: `worn` drives SYSTEMA's preview, and only an OS flip
    // updated it, so right after picking SYSTEMA the preview showed the plate worn before it.
    void setThemeChoice(c).then(setWorn)
  }
  return (
    <div className="skin-tab">
      <p className="skin-tab-lede">
        Nine plates, plus SYSTEMA to follow the OS. NOX and LVX are the references — the plates
        SYSTEMA resolves between — and the rest re-pitch the accents. Layout, spacing and the
        meaning of the status colours are identical in every one; only the pigment changes.
      </p>
      <div className="skin-grid" role="radiogroup" aria-label="Skin">
        <button
          className={`skin-card${choice === SYSTEM_CHOICE ? ' is-active' : ''}`}
          role="radio"
          aria-checked={choice === SYSTEM_CHOICE}
          onClick={() => pick(SYSTEM_CHOICE)}
          title={choice === SYSTEM_CHOICE ? `${SYSTEM_LABEL} — wearing ${THEME_LABEL[worn]} right now` : SYSTEM_EPITHET}
        >
          <span className="skin-card-bands" aria-hidden data-theme={worn}>
            <span className="skin-band-paper" />
            <span className="skin-band-geo" />
            <span className="skin-band-accent" />
          </span>
          <span className="skin-card-name">{SYSTEM_LABEL}</span>
          <span className="skin-card-epithet">{SYSTEM_EPITHET}</span>
        </button>
        {THEMES.map((t) => (
          <button
            key={t}
            className={`skin-card${choice === t ? ' is-active' : ''}`}
            data-theme={t}
            role="radio"
            aria-checked={choice === t}
            onClick={() => pick(t)}
          >
            <span className="skin-card-bands" aria-hidden>
              <span className="skin-band-paper" />
              <span className="skin-band-geo" />
              <span className="skin-band-accent" />
            </span>
            <span className="skin-card-name">{THEME_LABEL[t]}</span>
            <span className="skin-card-epithet">{THEME_EPITHET[t]}</span>
          </button>
        ))}
      </div>
    </div>
  )
}
