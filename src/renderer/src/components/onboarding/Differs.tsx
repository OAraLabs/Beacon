import { COPY, fill } from '@shared/onboarding-strings'

interface Props {
  name: string
  onBack: () => void
  onProceed: () => void
}

/** B-differs (S1): a computer under a name this Mac knows now shows a different fingerprint. Going on is
 *  possible, because Prometheus really can have been reinstalled, but it is not the default. */
export function Differs({ name, onBack, onProceed }: Props): React.JSX.Element {
  const t = COPY.main.bDiffers
  return (
    <>
      <h1>{t.title}</h1>
      <div className="setup-error" role="alert">
        {fill(t.body, { name })}
      </div>
      <div className="onb-nav">
        <button className="setup-connect onb-primary" onClick={onBack} autoFocus>
          {t.goBack}
        </button>
        <button className="setup-test" onClick={onProceed}>
          {t.goOn}
        </button>
      </div>
    </>
  )
}
