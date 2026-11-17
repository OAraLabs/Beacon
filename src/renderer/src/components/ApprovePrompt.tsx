import { useEffect, useRef, useState, type CSSProperties } from 'react'
import type { DecideOutcome, WaitingRequest } from '@shared/join-owner'
import { fill } from '@shared/onboarding-strings'
import { OWNER_COPY } from '@shared/owner-strings'
import { ownerSteps } from '@shared/join-notice'
import { useInstances } from '../instances-store'

const T = OWNER_COPY

/** What each way the daemon can answer is called on screen. */
const SAYS: Record<Exclude<DecideOutcome, 'ok'>, string> = {
  'wrong-code': T.wrongCode,
  handled: T.handled,
  gone: T.handled,
  expired: T.expired,
  'not-owner': T.notOwner,
  'signed-out': T.signedOut,
  lost: T.lost,
  refused: T.refused
}

/** "Approve new device?": a new device is asking this Prometheus to let it connect, and this Beacon is its owner's. The owner must TYPE
 *  the four digits the new device shows; the daemon checks them, so a tap cannot approve a stranger. The digits the daemon lists are not
 *  passed here at all. Shown over the app (one request at a time, the one that has waited longest) and gone when nobody is waiting. */
export function ApprovePrompt(): React.JSX.Element | null {
  const [requests, setRequests] = useState<WaitingRequest[]>([])
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(new Set())
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())
  // "Review" on Config → Devices: bring back a request set aside with Not now, first.
  const [focusId, setFocusId] = useState<string | null>(null)
  const [owner, setOwner] = useState(false)
  const [copied, setCopied] = useState(false)
  const field = useRef<HTMLInputElement>(null)
  const instances = useInstances()
  const on = instances.find((i) => i.active)
  const steps = ownerSteps({ thisMac: /^(localhost|127\.|\[?::1\]?)/.test(on?.host ?? ''), instance: on?.label || 'Prometheus' })

  useEffect(() => {
    const review = (e: Event): void => {
      const id = (e as CustomEvent<{ requestId?: unknown } | null>).detail?.requestId
      if (typeof id !== 'string') return
      setDismissed((d) => {
        const next = new Set(d)
        next.delete(id)
        return next
      })
      setFocusId(id)
    }
    window.addEventListener('beacon:review-join', review)
    return () => window.removeEventListener('beacon:review-join', review)
  }, [])

  useEffect(() => {
    const p = window.beacon?.pairing
    if (!p) return
    let alive = true
    void p.requests().then((r) => alive && setRequests(r)).catch(() => undefined)
    const off = p.onRequests((r) => setRequests(r))
    return () => {
      alive = false
      off()
    }
  }, [])

  // A request whose time is up leaves without waiting for the next update.
  useEffect(() => {
    if (requests.length === 0) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [requests.length])

  const open = requests.filter((r) => !dismissed.has(r.requestId) && r.deadlineMs > now)
  const current = open.find((r) => r.requestId === focusId) ?? open[0] ?? null
  const currentId = current?.requestId ?? null

  // A different request starts with an empty field and the cursor in it.
  useEffect(() => {
    setCode('')
    setMessage(null)
    setOwner(false)
    setCopied(false)
    if (currentId) field.current?.focus()
  }, [currentId])

  if (!current) return null

  const answer = async (verb: 'approve' | 'deny'): Promise<void> => {
    const p = window.beacon?.pairing
    if (!p || busy) return
    setBusy(true)
    setMessage(null)
    try {
      const outcome = verb === 'approve' ? await p.approve({ requestId: current.requestId, code }) : await p.deny(current.requestId)
      if (outcome === 'wrong-code') setCode('')
      if (outcome !== 'ok') setMessage(SAYS[outcome])
    } catch {
      setMessage(T.lost)
    } finally {
      setBusy(false)
    }
  }
  const notNow = (): void => setDismissed((d) => new Set(d).add(current.requestId))
  const ready = /^[0-9]{4}$/.test(code) && !busy

  return (
    <div style={scrim} role="presentation" data-pair-prompt>
      <div
        style={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby="pair-prompt-title"
        onKeyDown={(e) => {
          if (e.key === 'Escape') notNow()
          if (e.key === 'Enter' && ready && e.target === field.current) void answer('approve') // only from the code field: Enter on Copy copies
        }}
      >
        <h2 id="pair-prompt-title" style={title}>
          {T.title}
        </h2>
        <p style={line}>
          <strong data-untrusted>{fill(T.wants, { name: current.deviceName })}</strong>
        </p>
        <p style={dim} data-untrusted>
          {fill(T.where, { platform: current.platform, source: current.sourceIp })}
        </p>
        <p style={line}>{T.typeCode}</p>
        <input
          ref={field}
          style={codeInput}
          value={code}
          inputMode="numeric"
          autoComplete="off"
          maxLength={4}
          aria-label={T.codeLabel}
          onChange={(e) => setCode(e.target.value.replace(/[^0-9]/g, '').slice(0, 4))}
        />
        <p style={dim}>{T.careful}</p>
        <button
          className="setup-test"
          style={{ alignSelf: 'flex-start', padding: '4px 10px', fontSize: 12 }}
          aria-expanded={owner}
          onClick={() => setOwner((o) => !o)}
          data-testid="make-owner-how"
        >
          {T.makeOwner}
        </button>
        {owner ? (
          <div data-testid="owner-steps" style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12, color: 'var(--c-text-dim)', lineHeight: 1.45 }}>
            <div>{T.ownerWhy}</div>
            <ol style={{ margin: 0, paddingLeft: 18 }}>
              {steps.steps.map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ol>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <code data-testid="owner-command" style={{ flex: 1, fontFamily: 'var(--font-mono)', fontSize: 12, padding: '6px 8px', borderRadius: 6, background: 'var(--c-inset)', color: 'var(--c-text)', userSelect: 'all' }}>
                {steps.command}
              </code>
              <button
                className="setup-test"
                style={{ padding: '4px 10px', fontSize: 12 }}
                onClick={() =>
                  void navigator.clipboard
                    ?.writeText(steps.command)
                    .then(() => setCopied(true))
                    .catch(() => undefined)
                }
                data-testid="owner-copy"
              >
                {copied ? T.copied : T.copy}
              </button>
            </div>
          </div>
        ) : null}
        {message ? (
          <div className="setup-error" role="alert">
            {message}
          </div>
        ) : null}
        <div style={buttons}>
          <button className="setup-test" onClick={notNow}>
            {T.notNow}
          </button>
          <span style={{ display: 'flex', gap: 10 }}>
            <button className="setup-test" disabled={busy} onClick={() => void answer('deny')}>
              {T.deny}
            </button>
            <button className="setup-connect" style={{ width: 'auto', minWidth: 120 }} disabled={!ready} onClick={() => void answer('approve')}>
              {T.approve}
            </button>
          </span>
        </div>
        {open.length > 1 ? <p style={dim}>{fill(T.more, { n: String(open.length - 1) })}</p> : null}
      </div>
    </div>
  )
}

const scrim: CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: 'var(--z-modal)' as unknown as number,
  background: 'var(--c-scrim)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center'
}
const panel: CSSProperties = {
  width: 'min(440px, 92vw)',
  background: 'var(--c-raise)',
  border: '1px solid var(--c-line-bright)',
  borderRadius: 12,
  padding: '20px 22px',
  color: 'var(--c-text)'
}
const title: CSSProperties = { margin: '0 0 10px', fontSize: 18 }
const line: CSSProperties = { margin: '0 0 8px', fontSize: 14, lineHeight: 1.5, overflowWrap: 'anywhere' }
const dim: CSSProperties = { margin: '0 0 10px', fontSize: 12, lineHeight: 1.5, color: 'var(--c-text-dim)', overflowWrap: 'anywhere' }
const codeInput: CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  margin: '2px 0 12px',
  padding: '10px 12px',
  fontSize: 28,
  letterSpacing: '0.35em',
  textAlign: 'center',
  fontVariantNumeric: 'tabular-nums',
  background: 'var(--bg-input)',
  color: 'var(--text)',
  border: '1px solid var(--border)',
  borderRadius: 9
}
const buttons: CSSProperties = { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, marginTop: 6 }
