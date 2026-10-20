import { DOWNLOAD_ESTIMATE_MB } from '@shared/mac-check'
import { COPY, fill } from '@shared/onboarding-strings'

interface Props {
  onConfirm: () => void
  onBack: () => void
}

/** A-confirm: the one decision on path A. It says what will happen (where Prometheus comes from, where it goes, that
 *  it keeps running, and that the checks for a newer one can be turned off) and nothing is downloaded before the
 *  button is pressed. */
export function ConfirmSetup({ onConfirm, onBack }: Props): React.JSX.Element {
  const t = COPY.main.aConfirm
  return (
    <>
      <h1>{t.title}</h1>
      <p className="setup-sub">{fill(t.body, { size: `${DOWNLOAD_ESTIMATE_MB} MB` })}</p>
      <div className="onb-nav">
        <button className="setup-test" onClick={onBack}>
          {COPY.main.common.back}
        </button>
        <button className="setup-connect onb-primary" onClick={onConfirm}>
          {t.setUp}
        </button>
      </div>
    </>
  )
}
