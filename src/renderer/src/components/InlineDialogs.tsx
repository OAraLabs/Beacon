import { useState, type CSSProperties } from 'react'

// Reusable inline replacements for window.prompt / window.confirm, which are unreliable in Electron
// (prompt is a no-op; confirm can be blocked). One home for both so panels stop hand-rolling one-offs
// — the Documents editor uses both (dirty-tab discard, new-document naming) and others will too.
// Token-styled; the confirm renders an absolute scrim, so its host needs position: relative.

const MONO = 'var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)'
const scrim: CSSProperties = {
  position: 'absolute',
  inset: 0,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: 'var(--c-scrim)',
  zIndex: 5
}
const card: CSSProperties = { background: 'var(--c-raise)', border: '1px solid var(--c-line)', borderRadius: 8, padding: 20, maxWidth: 360, textAlign: 'center' }
const btn = (kind: 'ok' | 'err' | 'neutral', enabled = true): CSSProperties => ({
  fontSize: 12,
  padding: '6px 14px',
  borderRadius: 6,
  border: `1px solid var(--c-${kind === 'ok' ? 'arc' : kind === 'err' ? 'err' : 'line'})`,
  background: !enabled ? 'transparent' : kind === 'ok' ? 'var(--c-arc-soft)' : kind === 'err' ? 'var(--c-err-soft)' : 'transparent',
  color: !enabled ? 'var(--c-text-faint)' : kind === 'ok' ? 'var(--c-arc)' : kind === 'err' ? 'var(--c-err)' : 'var(--c-text)',
  cursor: enabled ? 'pointer' : 'default',
  font: 'inherit'
})

/** Modal confirm — replaces window.confirm. Host must be position: relative. */
export function InlineConfirm({
  title,
  detail,
  confirmLabel = 'Confirm',
  danger = false,
  onConfirm,
  onCancel
}: {
  title: string
  detail?: string
  confirmLabel?: string
  danger?: boolean
  onConfirm: () => void
  onCancel: () => void
}) {
  return (
    <div style={scrim}>
      <div style={card}>
        <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--c-text)', marginBottom: detail ? 8 : 16 }}>{title}</div>
        {detail ? <div style={{ fontSize: 13, color: 'var(--c-text-dim)', marginBottom: 16, fontFamily: MONO }}>{detail}</div> : null}
        <div style={{ display: 'flex', gap: 10, justifyContent: 'center' }}>
          <button style={btn('neutral')} onClick={onCancel}>Cancel</button>
          <button style={btn(danger ? 'err' : 'ok')} onClick={onConfirm}>{confirmLabel}</button>
        </div>
      </div>
    </div>
  )
}

/** Inline single-line input with validation — replaces window.prompt. Enter submits (when valid),
 * Escape cancels. Self-manages its draft; calls back with the trimmed value. */
export function InlinePrompt({
  placeholder,
  submitLabel = 'Create',
  validate,
  onSubmit,
  onCancel
}: {
  placeholder?: string
  submitLabel?: string
  validate: (v: string) => boolean
  onSubmit: (v: string) => void
  onCancel: () => void
}) {
  const [v, setV] = useState('')
  const ok = validate(v)
  return (
    <div style={{ padding: '8px 12px', borderBottom: '1px solid var(--c-line)', display: 'flex', gap: 6 }}>
      <input
        autoFocus
        value={v}
        placeholder={placeholder}
        onChange={(e) => setV(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && ok) onSubmit(v.trim())
          else if (e.key === 'Escape') onCancel()
        }}
        style={{ flex: 1, minWidth: 0, fontSize: 13, padding: '6px 10px', borderRadius: 6, border: '1px solid var(--c-line)', background: 'var(--c-void)', color: 'var(--c-text)', font: 'inherit' }}
      />
      <button style={btn('ok', ok)} disabled={!ok} onClick={() => onSubmit(v.trim())}>{submitLabel}</button>
      <button style={btn('neutral')} onClick={onCancel}>Cancel</button>
    </div>
  )
}
