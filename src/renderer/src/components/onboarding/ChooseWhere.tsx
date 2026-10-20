import type { KeyboardEvent } from 'react'
import type { Where } from '@shared/onboarding'
import { COPY, fill } from '@shared/onboarding-strings'

interface Props {
  /** The answers offered, in order (@shared/onboarding whereChoices). */
  choices: readonly Where[]
  where: Where
  /** The answer that carries the Recommended tag (it moves when a Prometheus was found on this Mac). */
  recommended: Where
  /** The name of a Prometheus found on this Mac, if one was: it is named on the "connect to it" card. */
  foundName: string | null
  onChoose: (w: Where) => void
  onContinue: () => void
  onBack: () => void
}

/** W2: "Do you already have Prometheus?" Three answers (five once a Prometheus has answered on this Mac), one selected, one
 *  tagged Recommended. The tag marks the recommendation and stays put when the selection moves: they are different facts. */
export function ChooseWhere({ choices, where, recommended, foundName, onChoose, onContinue, onBack }: Props): React.JSX.Element {
  const t = COPY.main.w2
  const ORDER = choices
  // "Type its address" is Advanced's way in (COPY.advanced.w2Address), held to Advanced's words: marked like orType.
  const words = (w: Where): { title: string; detail: string } => (w === 'address' ? COPY.advanced.w2Address : w === 'existing' && foundName ? { title: t.existing.title, detail: fill(t.existing.detailFound, { name: foundName }) } : t[w])
  const move = (e: KeyboardEvent<HTMLDivElement>): void => {
    const i = ORDER.indexOf(where)
    if (e.key === 'ArrowDown' || e.key === 'ArrowRight') onChoose(ORDER[(i + 1) % ORDER.length])
    else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') onChoose(ORDER[(i + ORDER.length - 1) % ORDER.length])
    else if (e.key === 'Enter') onContinue()
    else return
    e.preventDefault()
  }
  return (
    <>
      <h1>{t.title}</h1>
      <p className="setup-sub">{t.body}</p>
      <div className="onb-choices" role="radiogroup" aria-label={t.choicesLabel} onKeyDown={move}>
        {ORDER.map((w) => {
          const on = w === where
          return (
            <button
              key={w}
              type="button"
              role="radio"
              aria-checked={on}
              tabIndex={on ? 0 : -1}
              className={on ? 'onb-choice on' : 'onb-choice'}
              data-or-type={w === 'address' ? '' : undefined}
              onClick={() => onChoose(w)}
              ref={(el) => {
                if (on && el && document.activeElement?.getAttribute('role') === 'radio') el.focus()
              }}
            >
              <span className="onb-choice-title">{words(w).title}</span>
              {w === recommended ? <span className="onb-tag">{COPY.main.common.recommended}</span> : null}
              <span className="onb-choice-detail">{words(w).detail}</span>
            </button>
          )
        })}
      </div>
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
