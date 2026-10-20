import { useEffect, type CSSProperties } from 'react'
import { SHORTCUTS } from '@shared/commands'
import { Icon } from './Icon'

// Keyboard cheat sheet (Makeover Slice 5) — `?` outside inputs, or the palette's "Show shortcuts".

const scrim: CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: 'var(--z-modal)' as unknown as number,
  background: 'var(--c-scrim)',
  backdropFilter: 'blur(8px)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 16
}
const panel: CSSProperties = {
  width: 'min(420px, 92vw)',
  background: 'var(--c-raise)',
  border: '1px solid var(--c-line-bright)',
  borderRadius: 'var(--r-4)',
  boxShadow: 'var(--elev-3)',
  padding: 18,
  display: 'flex',
  flexDirection: 'column',
  gap: 12
}
const kbd: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 11,
  padding: '2px 7px',
  borderRadius: 'var(--r-1)',
  border: '1px solid var(--c-line-bright)',
  background: 'var(--c-inset)',
  color: 'var(--c-arc)',
  whiteSpace: 'nowrap'
}

export function ShortcutSheet({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div style={scrim} onClick={onClose}>
      <div style={panel} onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Keyboard shortcuts">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <h2 style={{ fontSize: 15, fontWeight: 600, margin: 0, color: 'var(--c-text)' }}>Keyboard shortcuts</h2>
          <button
            onClick={onClose}
            aria-label="Close"
            style={{ background: 'transparent', border: 'none', color: 'var(--c-text-dim)', cursor: 'pointer', display: 'inline-flex' }}
          >
            <Icon name="x" size={15} />
          </button>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {SHORTCUTS.map((s) => (
            <div key={s.keys} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
              <span style={{ fontSize: 13, color: 'var(--c-text-dim)' }}>{s.does}</span>
              <span style={kbd}>{s.keys}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
