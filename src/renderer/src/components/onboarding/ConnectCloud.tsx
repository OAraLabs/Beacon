import { useState } from 'react'
import { COPY } from '@shared/onboarding-strings'
import { SETUP_LINKS } from '@shared/setup-links'

interface Props {
  /** Open with Other options already showing (coming back from a card that offered them). */
  showOthers?: boolean
  onSignIn: () => void
  onOtherKey: (company: 'anthropic' | 'openai') => void
  onBack: () => void
}

/** A3c-1: "Connect a cloud AI". OpenRouter is Recommended and selected, with what it needs (credit) said plainly on the card. A
 *  pasted Anthropic or OpenAI key sits under Other options, never selected for you. */
export function ConnectCloud({ showOthers = false, onSignIn, onOtherKey, onBack }: Props): React.JSX.Element {
  const t = COPY.main.a3c1
  const [others, setOthers] = useState(showOthers)
  return (
    <>
      <h1>{t.title}</h1>
      <div className="onb-choices" role="radiogroup" aria-label={t.title}>
        <button type="button" role="radio" aria-checked={true} tabIndex={0} className="onb-choice on" data-choice="openrouter" onKeyDown={(e) => e.key === 'Enter' && onSignIn()}>
          <span className="onb-choice-title">{t.openrouter.title}</span>
          <span className="onb-tag">{COPY.main.common.recommended}</span>
          <span className="onb-choice-detail">{t.openrouter.detail}</span>
          <span className="onb-choice-detail">{t.credit}</span>
        </button>
      </div>
      <p className="setup-sub onb-links">
        <a className="wiz-link" href={SETUP_LINKS.openrouterCredits} target="_blank" rel="noreferrer">
          {t.addCredit} ↗
        </a>
      </p>
      {others ? (
        <div className="onb-others" data-testid="other-options">
          <button className="setup-test" onClick={() => onOtherKey('anthropic')}>
            {t.anthropic}
          </button>
          <button className="setup-test" onClick={() => onOtherKey('openai')}>
            {t.openai}
          </button>
        </div>
      ) : (
        <p className="setup-sub onb-links">
          <button className="wiz-link onb-linklike" onClick={() => setOthers(true)}>
            {t.otherOptions}
          </button>
        </p>
      )}
      <div className="onb-nav">
        <button className="setup-test" onClick={onBack}>
          {COPY.main.common.back}
        </button>
        <button className="setup-connect onb-primary" onClick={onSignIn}>
          {COPY.main.common.continue}
        </button>
      </div>
    </>
  )
}
