import { COPY } from '@shared/onboarding-strings'

interface Props {
  onContinue: () => void
  onBack: () => void
}

/** B1: why Beacon is about to ask macOS for permission to look at the network, before it asks. Continue
 *  starts the search, which is what makes macOS show its own prompt. Looking connects to nothing. */
export function LanExplain({ onContinue, onBack }: Props): React.JSX.Element {
  const t = COPY.main.b1
  return (
    <>
      <h1>{t.title}</h1>
      <p className="setup-sub">{t.body}</p>
      <p className="setup-sub">{t.reassure}</p>
      <div className="onb-nav">
        <button className="setup-test" onClick={onBack}>
          {COPY.main.common.back}
        </button>
        <button className="setup-connect onb-primary" onClick={onContinue}>
          {COPY.main.common.continue}
        </button>
      </div>
    </>
  )
}
