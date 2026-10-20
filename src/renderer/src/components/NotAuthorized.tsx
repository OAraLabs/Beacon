import type { CSSProperties } from 'react'
import { Icon } from './Icon'

// The ONE auth-failure state, shared by every surface (REST-fed panels, the WS, the file preview).
// Shown whenever the gateway rejects the bearer token — a REST 401 or a WS 4401 — so a bad/absent
// token reads as exactly that, NOT as a misleading empty result ("No skills") or a generic error.
// The button opens Connection Settings (also reachable via ⌘,) by dispatching a window event App
// listens for. One component, one fix, every surface.

const wrap: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 10,
  padding: '56px 16px',
  textAlign: 'center'
}
const btn: CSSProperties = {
  fontSize: 12,
  padding: '6px 14px',
  borderRadius: 6,
  border: '1px solid var(--c-amber)',
  background: 'var(--c-amber-soft)',
  color: 'var(--c-amber)',
  cursor: 'pointer',
  font: 'inherit'
}

export function NotAuthorized({ what }: { what?: string }) {
  return (
    <div style={wrap}>
      <div style={{ color: 'var(--c-amber)', display: 'inline-flex' }} aria-hidden>
        <Icon name="lock" size={26} />
      </div>
      <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--c-text)' }}>Authentication failed</div>
      <div style={{ fontSize: 13, color: 'var(--c-text-dim)', maxWidth: 380, lineHeight: 1.45 }}>
        The gateway rejected the token{what ? ` — couldn't load ${what}` : ''}. Set your gateway token in
        Settings (⌘,) to connect.
      </div>
      {/* Opens Settings with Advanced open: the key is what needs fixing. */}
      <button style={btn} onClick={() => window.dispatchEvent(new CustomEvent('beacon:open-settings', { detail: { section: 'connection' } }))}>
        Open Settings
      </button>
    </div>
  )
}
