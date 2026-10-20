import { useEffect, useRef, useState } from 'react'
import { Icon } from './Icon'
import {
  AUTOMATIC,
  profileChoices,
  profileLabel,
  profileTooltip,
  selectedChoice,
  type SessionProfile
} from '@shared/session-profile'

// Per-session agent profile (roadmap item 6). Sits beside the ModelSwitcher because they answer
// adjacent questions about the same turn: which MODEL serves it, and which CAPABILITIES it has.
//
// Reuses the model-switcher's classes so the two controls are visually one family — a second
// bespoke popover next to an existing one reads as an accident.
//
// The menu's first row is "Automatic", not a re-pick of the default, because pinning a chat to
// the profile that happens to be default today is a different fact from following the default.
// The daemon models that distinction (`source`), and a picker that flattened it would make
// "reset to automatic" impossible to offer.

export function ProfilePicker({
  state,
  names,
  onSelect,
  disabled
}: {
  state: SessionProfile
  names: { name: string; description?: string }[]
  onSelect: (choice: string) => void
  /** No profile store on the daemon → render read-only rather than a menu that cannot apply. */
  disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  const label = profileLabel(state)
  const tip = profileTooltip(state)
  const current = selectedChoice(state)

  if (disabled || names.length === 0) {
    return (
      <span className="model-switcher model-switcher-topbar is-readonly" title={tip}>
        <span className="model-switcher-label">{label}</span>
      </span>
    )
  }

  return (
    <div className="model-switcher model-switcher-topbar" ref={ref}>
      <button
        className="model-switcher-btn"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Agent profile: ${label}`}
        title={tip}
      >
        {/* MATCH_SPEC R3.1: bolt 11px, label 11px, chevron 9px. The chip is the one control in
            the header that says what the agent is allowed to do on its own — it reads as a
            control, and as sanguine, because both facts matter at a glance. */}
        <Icon name="zap" size={11} />
        <span className="model-switcher-label">{label}</span>
        {/* A pin that no longer resolves is not a styling detail — the chat is running under
            something other than what it says, and the control is the only place that shows it. */}
        {state.dangling ? <span className="model-switcher-warn">· missing</span> : null}
        <Icon name="chevron-down" size={9} />
      </button>
      {open ? (
        <div className="model-switcher-menu" role="listbox">
          {profileChoices(names, state.effective).map((c) => (
            <button
              key={c.id}
              role="option"
              aria-selected={c.id === current}
              className={`model-switcher-opt${c.id === current ? ' is-active' : ''}`}
              onClick={() => {
                setOpen(false)
                if (c.id !== current) onSelect(c.id)
              }}
            >
              <span className="opt-main">
                <span className="opt-label">{c.label}</span>
                {c.hint ? <span className="opt-hint">{c.hint}</span> : null}
              </span>
            </button>
          ))}
          {/* Where the choice APPLIES. Without this the menu looks like it is setting a global,
              and the user has no way to know the next session will not inherit it. */}
          <div className="menu-foot">Session only · default in Config</div>
        </div>
      ) : null}
    </div>
  )
}

export { AUTOMATIC }
