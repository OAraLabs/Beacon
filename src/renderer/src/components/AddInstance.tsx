import { useRef, useState, type CSSProperties } from 'react'
import { addCheckWords, wsFor, type AddCheck } from '@shared/add-instance'
import { useDialogFocus } from './useDialogFocus'

// Add a Prometheus (docs/MULTI-PROMETHEUS.md §6), opened from the title bar's switcher (and the sidebar's list, and Advanced when a
// new address turned out to be another Prometheus): its address, its socket, its key; Test asks who answers (with no key) and tries
// the key on it alone; Add keeps it beside the others and switches to it. The Prometheus Beacon is on is never touched: Settings →
// Advanced is for that one.

const backdrop: CSSProperties = { position: 'fixed', inset: 0, zIndex: 72, background: 'var(--c-scrim)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }
const modal: CSSProperties = {
  width: 'min(440px, 94vw)',
  maxHeight: 'calc(100vh - 32px)',
  overflowY: 'auto',
  background: 'var(--c-raise)',
  border: '1px solid var(--c-line)',
  borderRadius: 12,
  padding: 18,
  display: 'flex',
  flexDirection: 'column',
  gap: 12
}
const field: CSSProperties = {
  fontSize: 13,
  padding: '8px 10px',
  borderRadius: 6,
  border: '1px solid var(--c-line)',
  background: 'var(--c-base)',
  color: 'var(--c-text)',
  outline: 'none',
  font: 'inherit',
  width: '100%',
  boxSizing: 'border-box'
}
const labelStyle: CSSProperties = { fontSize: 12, color: 'var(--c-text-dim)', display: 'flex', flexDirection: 'column', gap: 5 }
const btn = (primary = false, disabled = false): CSSProperties => ({
  fontSize: 13,
  padding: '8px 16px',
  borderRadius: 6,
  border: `1px solid ${primary && !disabled ? 'var(--c-arc)' : 'var(--c-line)'}`,
  background: disabled ? 'var(--c-base)' : primary ? 'var(--c-arc)' : 'var(--c-inset)',
  color: disabled ? 'var(--c-text-faint)' : primary ? 'var(--c-on-arc)' : 'var(--c-text)',
  cursor: disabled ? 'not-allowed' : 'pointer',
  font: 'inherit'
})
const TONE = { ok: 'var(--c-ok-text)', warn: 'var(--c-warn-text)', err: 'var(--c-err-text)' } as const

export function AddInstance({ initial, onClose }: { initial?: { apiBase?: string; wsUrl?: string }; onClose: () => void }) {
  const [apiBase, setApiBase] = useState(initial?.apiBase ?? '')
  const [wsUrl, setWsUrl] = useState(initial?.wsUrl ?? (initial?.apiBase ? (wsFor(initial.apiBase) ?? '') : ''))
  const [wsTyped, setWsTyped] = useState(!!initial?.wsUrl)
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState<'test' | 'add' | null>(null)
  const [check, setCheck] = useState<{ for: string; result: AddCheck } | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const sheet = useRef<HTMLDivElement>(null)
  useDialogFocus(sheet, onClose)

  const req = { apiBase: apiBase.trim(), wsUrl: wsUrl.trim(), token: token.trim() }
  const asked = JSON.stringify(req)
  const tested = check && check.for === asked ? check.result : null
  const canAdd = tested?.kind === 'ok' && busy === null
  const words = check ? addCheckWords(check.result) : null

  const test = async (): Promise<void> => {
    setBusy('test')
    setErr(null)
    try {
      const result = await window.beacon.instances.check(req)
      setCheck({ for: asked, result })
    } catch (e) {
      setErr(String(e))
    } finally {
      setBusy(null)
    }
  }
  const add = async (): Promise<void> => {
    setBusy('add')
    setErr(null)
    try {
      const r = await window.beacon.instances.add(req)
      if (r.added) return onClose()
      setCheck({ for: asked, result: r.check })
    } catch (e) {
      setErr(String(e))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div style={backdrop} onClick={onClose}>
      <div ref={sheet} style={modal} onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Add a Prometheus">
        <h2 style={{ fontSize: 15, fontWeight: 600, color: 'var(--c-text)', margin: 0 }}>Add a Prometheus</h2>
        <div style={{ fontSize: 12, color: 'var(--c-text-dim)', lineHeight: 1.45 }}>
          Beacon asks who answers there without sending any key, then tries the key on it alone. The Prometheus you are on stays as it is.
        </div>
        <label style={labelStyle}>
          Address
          <input
            style={field}
            aria-label="Address"
            autoFocus
            value={apiBase}
            placeholder="http://localhost:8005"
            spellCheck={false}
            onChange={(e) => {
              setApiBase(e.target.value)
              if (!wsTyped) setWsUrl(wsFor(e.target.value) ?? '')
            }}
          />
        </label>
        <label style={labelStyle}>
          Socket
          <input
            style={field}
            aria-label="Socket"
            value={wsUrl}
            placeholder="ws://localhost:8010"
            spellCheck={false}
            onChange={(e) => {
              setWsUrl(e.target.value)
              setWsTyped(true)
            }}
          />
        </label>
        <label style={labelStyle}>
          Key
          <input style={field} aria-label="Key" type="password" value={token} placeholder="oara token show, on that computer" spellCheck={false} onChange={(e) => setToken(e.target.value)} />
        </label>
        <div data-testid="add-result" role="status" aria-live="polite" style={{ fontSize: 12, lineHeight: 1.45, minHeight: 18, color: busy === 'test' ? 'var(--c-text-dim)' : words ? TONE[words.tone] : 'var(--c-text-dim)' }}>
          {busy === 'test' ? 'Checking…' : busy === 'add' ? 'Adding…' : err ?? (words ? words.text : '')}
          {check && check.for !== asked && !busy ? ' (changed since: test again)' : ''}
        </div>
        {tested?.kind === 'kept' && tested.id ? (
          <button
            style={{ ...btn(false), alignSelf: 'flex-start' }}
            onClick={() =>
              void window.beacon.instances.switch(tested.id).then((ok) => {
                if (ok) onClose()
              })
            }
          >
            Switch to {tested.label}
          </button>
        ) : null}
        <div style={{ display: 'flex', gap: 8 }}>
          <button style={btn(false, busy !== null || !req.apiBase || !req.wsUrl)} disabled={busy !== null || !req.apiBase || !req.wsUrl} onClick={() => void test()}>
            Test
          </button>
          <button style={btn(true, !canAdd)} disabled={!canAdd} onClick={() => void add()}>
            Add
          </button>
          <div style={{ flex: 1 }} />
          <button style={btn(false)} onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}
