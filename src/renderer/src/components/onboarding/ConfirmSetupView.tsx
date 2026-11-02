import { downloadEstimateMB } from '@shared/mac-check'
import { COPY, fill } from '@shared/onboarding-strings'

interface Props {
  /** The zip's size from the release manifest, or null for DOWNLOAD_ESTIMATE_MB. */
  downloadBytes: number | null
  onConfirm: () => void
  onBack: () => void
}

/** A-confirm for a given size (ConfirmSetup supplies it). No bridge here, so smoke:download-estimate renders it headless. */
export function ConfirmSetupView({ downloadBytes, onConfirm, onBack }: Props): React.JSX.Element {
  const t = COPY.main.aConfirm
  return (
    <>
      <h1>{t.title}</h1>
      <p className="setup-sub">{fill(t.body, { size: `${downloadEstimateMB(downloadBytes)} MB` })}</p>
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
