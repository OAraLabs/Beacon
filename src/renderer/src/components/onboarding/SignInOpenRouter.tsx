import { useEffect, useRef, useState } from 'react'
import type { KeyStep } from '@shared/model-setup'
import { COPY } from '@shared/onboarding-strings'
import { SETUP_LINKS } from '@shared/setup-links'

interface Props {
  /** Signed in, and Prometheus accepted the key: on to finishing. */
  onSignedIn: () => void
  /** Back, or "pick another option" (`others`): the sign-in is stopped first. */
  onBack: (others?: boolean) => void
}

/** A3c-or: Beacon opens OpenRouter in the browser and waits. The key never comes to this page: main receives it, has Prometheus
 *  check it, and keeps it for the finish. What comes here is "on", or a card. */
export function SignInOpenRouter({ onSignedIn, onBack }: Props): React.JSX.Element {
  const t = COPY.main.a3cOr
  const c = COPY.main.aInst
  const [step, setStep] = useState<KeyStep | null>(null)
  const [run, setRun] = useState(0)
  const [copied, setCopied] = useState(false)
  const live = useRef(true)
  useEffect(() => {
    live.current = true
    setStep(null)
    void window.beacon?.model
      .signIn()
      .then((r) => {
        if (!live.current) return
        if (r.ok) onSignedIn()
        else setStep(r)
      })
      .catch(() => live.current && setStep({ ok: false, card: 'unreachable', details: 'Beacon could not start the sign-in' }))
    return () => {
      live.current = false
      void window.beacon?.model.cancelSignIn().catch(() => undefined)
    }
    // onSignedIn is the parent's and stable in meaning; a new run is only ever asked for by `run`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run])
  const again = (): void => {
    setCopied(false)
    setRun((n) => n + 1)
  }
  const copy = (details: string): void => {
    void navigator.clipboard
      ?.writeText(details)
      .then(() => setCopied(true))
      .catch(() => undefined)
  }

  if (step && !step.ok) {
    const card = step.card === 'no_credit' ? t.noCredit : step.card === 'declined' ? t.declined : step.card === 'bad_key' ? t.refused : step.card === 'unreachable' ? t.unreachable : t.notFinished
    return (
      <div data-failure={step.card}>
        <h1>{card.title}</h1>
        <p className="setup-sub">{card.body}</p>
        <p className="setup-sub onb-links">
          <button className="setup-test" onClick={() => copy(step.details)}>
            {copied ? c.copied : c.copyDetails}
          </button>
          {step.card === 'no_credit' ? (
            <a className="wiz-link" href={SETUP_LINKS.openrouterCredits} target="_blank" rel="noreferrer">
              {COPY.main.a3c1.addCredit} ↗
            </a>
          ) : null}
        </p>
        <div className="onb-nav">
          <button className="setup-test" onClick={() => onBack(step.card === 'declined' || step.card === 'bad_key')}>
            {step.card === 'declined' || step.card === 'bad_key' ? COPY.main.a3c1.otherOptions : COPY.main.common.back}
          </button>
          <button className="setup-connect onb-primary" onClick={again}>
            {step.card === 'not-finished' ? t.notFinished.startAgain : c.tryAgain}
          </button>
        </div>
      </div>
    )
  }
  return (
    <>
      <h1>{t.title}</h1>
      <p className="setup-sub">{t.body}</p>
      <p className="setup-sub">{COPY.main.a3c1.credit}</p>
      <p className="setup-sub onb-quiet" role="status" data-testid="signin-waiting">
        {t.waiting}
      </p>
      <div className="onb-nav">
        <button className="setup-test" onClick={() => onBack()}>
          {COPY.main.common.back}
        </button>
      </div>
    </>
  )
}
