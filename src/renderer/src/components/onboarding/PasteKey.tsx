import { useState } from 'react'
import { keyPrefix, type KeyStep } from '@shared/model-setup'
import { COPY, fill } from '@shared/onboarding-strings'
import { SETUP_LINKS } from '@shared/setup-links'

interface Props {
  company: 'anthropic' | 'openai'
  /** Prometheus accepted the key: on to finishing. */
  onAccepted: () => void
  onBack: () => void
}

const NAME = { anthropic: 'Anthropic', openai: 'OpenAI' } as const

/** The company's key page, and its billing page: each written out, so every setup link is a SETUP_LINKS entry (smoke:setup-links). */
function KeysLink({ company, label }: { company: 'anthropic' | 'openai'; label: string }): React.JSX.Element {
  return company === 'anthropic' ? (
    <a className="wiz-link" href={SETUP_LINKS.anthropicKeys} target="_blank" rel="noreferrer">
      {label} ↗
    </a>
  ) : (
    <a className="wiz-link" href={SETUP_LINKS.openaiKeys} target="_blank" rel="noreferrer">
      {label} ↗
    </a>
  )
}
function BillingLink({ company, label }: { company: 'anthropic' | 'openai'; label: string }): React.JSX.Element {
  return company === 'anthropic' ? (
    <a className="wiz-link" href={SETUP_LINKS.anthropicBilling} target="_blank" rel="noreferrer">
      {label} ↗
    </a>
  ) : (
    <a className="wiz-link" href={SETUP_LINKS.openaiBilling} target="_blank" rel="noreferrer">
      {label} ↗
    </a>
  )
}

/** A3c-2: paste a key from Anthropic or OpenAI. The key is sent to main once, checked by Prometheus there, and never comes back to
 *  the page; the field is cleared once it is accepted. */
export function PasteKey({ company, onAccepted, onBack }: Props): React.JSX.Element {
  const t = COPY.main.a3c2
  const c = COPY.main.aInst
  const v = { company: NAME[company], prefix: keyPrefix(company) }
  const [key, setKey] = useState('')
  const [show, setShow] = useState(false)
  const [busy, setBusy] = useState(false)
  const [step, setStep] = useState<KeyStep | null>(null)
  const [copied, setCopied] = useState(false)
  const check = async (): Promise<void> => {
    if (busy || key.trim().length === 0) return
    setBusy(true)
    setCopied(false)
    try {
      const r = (await window.beacon?.model.checkKey(company, key)) ?? { ok: false as const, card: 'unreachable' as const, details: 'Beacon could not ask' }
      if (r.ok) {
        setKey('')
        onAccepted()
        return
      }
      setStep(r)
    } catch {
      setStep({ ok: false, card: 'unreachable', details: 'Beacon could not ask' })
    } finally {
      setBusy(false)
    }
  }
  const again = (): void => {
    setStep(null)
    setCopied(false)
  }

  if (step && !step.ok) {
    const card = step.card === 'shape' ? t.shape : step.card === 'bad_key' ? t.bad : step.card === 'no_credit' ? t.noCredit : t.unreachable
    return (
      <div data-failure={step.card}>
        <h1>{fill(card.title, v)}</h1>
        <p className="setup-sub">{fill(card.body, v)}</p>
        <p className="setup-sub onb-links">
          {step.card === 'shape' ? null : (
            <button className="setup-test" onClick={() => void navigator.clipboard?.writeText(step.details).then(() => setCopied(true)).catch(() => undefined)}>
              {copied ? c.copied : c.copyDetails}
            </button>
          )}
          {step.card === 'bad_key' ? <KeysLink company={company} label={fill(t.bad.open, v)} /> : step.card === 'no_credit' ? <BillingLink company={company} label={fill(t.noCredit.openBilling, v)} /> : null}
        </p>
        <div className="onb-nav">
          <button className="setup-test" onClick={onBack}>
            {COPY.main.common.back}
          </button>
          <button className="setup-connect onb-primary" onClick={again}>
            {step.card === 'shape' ? t.shape.pasteAgain : c.tryAgain}
          </button>
        </div>
      </div>
    )
  }
  return (
    <>
      <h1>{fill(t.title, v)}</h1>
      <ol className="onb-steps onb-howto">
        <li>
          <KeysLink company={company} label={fill(t.openKeys, v)} />
        </li>
        {t.steps.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ol>
      <label className="setup-field">
        {fill(t.fieldLabel, v)}
        <span className="onb-keyfield">
          <input
            type={show ? 'text' : 'password'}
            value={key}
            onChange={(e) => setKey(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void check()
            }}
            spellCheck={false}
            autoComplete="off"
            autoFocus
            data-testid="pasted-key"
          />
          <button type="button" className="setup-test" onClick={() => setShow((x) => !x)}>
            {show ? t.hide : t.show}
          </button>
        </span>
      </label>
      <p className="setup-sub onb-quiet">{fill(t.finePrint, v)}</p>
      <div className="onb-nav">
        <button className="setup-test" onClick={onBack}>
          {COPY.main.common.back}
        </button>
        <button className="setup-connect onb-primary" onClick={() => void check()} disabled={busy || key.trim().length === 0}>
          {busy ? t.checking : t.check}
        </button>
      </div>
    </>
  )
}
