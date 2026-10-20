import { COPY } from '@shared/onboarding-strings'
import { SETUP_LINKS } from '@shared/setup-links'

/** W1: what Beacon and Prometheus are, in two sentences, and one button. */
export function Welcome({ onStart }: { onStart: () => void }): React.JSX.Element {
  const t = COPY.main.w1
  return (
    <>
      <h1>{t.title}</h1>
      <p className="setup-sub">{t.body}</p>
      <p className="setup-sub">{t.pace}</p>
      <div className="onb-nav">
        <a className="wiz-link" href={SETUP_LINKS.guide} target="_blank" rel="noreferrer">
          {t.guide} ↗
        </a>
        <button className="setup-connect onb-primary" onClick={onStart}>
          {t.start}
        </button>
      </div>
    </>
  )
}
