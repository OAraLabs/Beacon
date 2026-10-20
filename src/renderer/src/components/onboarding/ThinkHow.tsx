import { useEffect, useState } from 'react'
import { formatGB } from '@shared/mac-check'
import { COPY, fill } from '@shared/onboarding-strings'

interface Props {
  onContinue: () => void
  onBack: () => void
}

/** A2: "How should your assistant think?" A cloud AI, Recommended and selected on every Mac; privately on this Mac is shown and
 *  not offered yet (the private download is not built). The memory line is information only. */
export function ThinkHow({ onContinue, onBack }: Props): React.JSX.Element {
  const t = COPY.main.a2
  const [memory, setMemory] = useState<number | null>(null)
  useEffect(() => {
    void window.beacon?.pathA
      .check()
      .then((r) => setMemory(r.memoryBytes))
      .catch(() => undefined)
  }, [])
  return (
    <>
      <h1>{t.title}</h1>
      <div className="onb-choices" role="radiogroup" aria-label={t.choicesLabel}>
        <button type="button" role="radio" aria-checked={true} tabIndex={0} className="onb-choice on" data-choice="cloud" onKeyDown={(e) => e.key === 'Enter' && onContinue()}>
          <span className="onb-choice-title">{t.cloud.title}</span>
          <span className="onb-tag">{COPY.main.common.recommended}</span>
          <span className="onb-choice-detail">{t.cloud.detail}</span>
        </button>
        <button type="button" role="radio" aria-checked={false} aria-disabled={true} tabIndex={-1} className="onb-choice" data-choice="private">
          <span className="onb-choice-title">{t.private.title}</span>
          <span className="onb-choice-detail">{t.private.detail}</span>
        </button>
      </div>
      {memory !== null && memory > 0 ? <p className="setup-sub onb-quiet">{fill(t.memory, { memory: formatGB(memory) })}</p> : null}
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
