import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import type { JoinCode } from '@shared/phone-join'
import { useInstances } from '../instances-store'
import { qrSvg } from '../qr'
import { useDialogFocus } from './useDialogFocus'

// "Add a phone" (the phone-onboarding plan, desktop item 1), from the title bar's switcher and Config → Devices: the QR a phone scans to
// ask one Prometheus to let it join. There is no secret in it (@shared/phone-join): the phone checks the node key in it, sends a join
// request, and Beacon asks the owner to approve it (ApprovePrompt). Nothing is granted by showing or scanning this.

const backdrop: CSSProperties = { position: 'fixed', inset: 0, zIndex: 72, background: 'var(--c-scrim)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }
const modal: CSSProperties = {
  width: 'min(420px, 94vw)',
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
const btn: CSSProperties = { fontSize: 13, padding: '8px 16px', borderRadius: 6, border: '1px solid var(--c-line)', background: 'var(--c-inset)', color: 'var(--c-text)', cursor: 'pointer', font: 'inherit' }
const muted: CSSProperties = { fontSize: 12, color: 'var(--c-text-dim)', lineHeight: 1.45 }

export function AddPhone({ initialId, onClose }: { initialId?: string; onClose: () => void }) {
  const instances = useInstances()
  const [id, setId] = useState<string | undefined>(initialId)
  const [code, setCode] = useState<(JoinCode & { name?: string }) | null>(null)
  const sheet = useRef<HTMLDivElement>(null)
  useDialogFocus(sheet, onClose)

  const chosen = instances.find((i) => i.id === id) ?? instances.find((i) => i.active)
  useEffect(() => {
    let alive = true
    setCode(null)
    void window.beacon
      .phoneJoin(chosen?.id)
      .then((c) => alive && setCode(c))
      .catch((e) => alive && setCode({ ok: false, why: String(e) }))
    return () => {
      alive = false
    }
  }, [chosen?.id])
  const svg = useMemo(() => (code?.ok ? qrSvg(code.url) : ''), [code])

  return (
    <div style={backdrop} onClick={onClose}>
      <div ref={sheet} style={modal} onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Add a phone">
        <h2 style={{ fontSize: 15, fontWeight: 600, color: 'var(--c-text)', margin: 0 }}>Add a phone</h2>
        {instances.length > 1 ? (
          <label style={{ ...muted, display: 'flex', alignItems: 'center', gap: 8 }}>
            To
            <select aria-label="Prometheus" value={chosen?.id ?? ''} onChange={(e) => setId(e.target.value)} style={{ flex: 1, font: 'inherit', fontSize: 13, padding: '5px 8px', borderRadius: 6, border: '1px solid var(--c-line)', background: 'var(--c-base)', color: 'var(--c-text)' }}>
              {instances.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.label || i.host}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        {code === null ? (
          <div style={muted}>Making the code…</div>
        ) : code.ok ? (
          <>
            <div
              data-testid="phone-join"
              data-url={code.url}
              aria-label={`Join code for ${code.name ?? code.host}`}
              style={{ alignSelf: 'center', width: 220, height: 220, background: 'var(--c-qr-quiet)', borderRadius: 8, padding: 8 }}
              dangerouslySetInnerHTML={{ __html: svg }}
            />
            <ol style={{ ...muted, margin: 0, paddingLeft: 18 }}>
              <li>Open Beacon on the phone and scan this.</li>
              <li>The phone asks {code.name ?? 'this Prometheus'} to let it join and shows four digits.</li>
              <li>Beacon asks you here: check the digits match, then approve it.</li>
            </ol>
            <div style={{ ...muted, fontSize: 11 }}>
              The code has no password in it, and nothing is allowed until you approve. The phone reaches it as {code.host}.
              {chosen && !chosen.active ? ` Beacon shows the request while it's on ${chosen.label || chosen.host}: switch to it to approve.` : ''}
            </div>
          </>
        ) : (
          <div role="alert" data-testid="phone-join-why" style={{ fontSize: 13, color: 'var(--c-text)', lineHeight: 1.45 }}>
            {code.why}
          </div>
        )}
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <button style={btn} onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  )
}
