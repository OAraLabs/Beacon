import { COPY } from '@shared/onboarding-strings'
import { SETUP_LINKS } from '@shared/setup-links'

interface Props {
  onSetItUp: () => void
  onNotNow: () => void
  onBack: () => void
}

/** C1: what Beacon does, for someone who is just looking. Nothing here needs Prometheus, and both
 *  exits lead somewhere: Set it up goes to the question, Not now to an empty home with a way back. */
export function Tour({ onSetItUp, onNotNow, onBack }: Props): React.JSX.Element {
  const t = COPY.main.c1
  return (
    <>
      <h1>{t.title}</h1>
      <ul className="onb-tour">
        {t.cards.map((c) => (
          <li key={c.title} className="onb-tour-card">
            <span className="onb-choice-title">{c.title}</span>
            <span className="onb-choice-detail">{c.detail}</span>
          </li>
        ))}
      </ul>
      <p className="setup-sub">
        <a className="wiz-link" href={SETUP_LINKS.website} target="_blank" rel="noreferrer">
          {t.website} ↗
        </a>
      </p>
      <div className="onb-nav">
        <button className="setup-test" onClick={onBack}>
          {COPY.main.common.back}
        </button>
        <span className="onb-nav-right">
          <button className="wiz-link" onClick={onNotNow}>
            {t.notNow}
          </button>
          <button className="setup-connect onb-primary" onClick={onSetItUp}>
            {t.setItUp}
          </button>
        </span>
      </div>
    </>
  )
}
