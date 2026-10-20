import { differsFromKnown, type DiscoveredComputer } from '@shared/discovery'
import { COPY, fill } from '@shared/onboarding-strings'

interface Props {
  computers: readonly DiscoveredComputer[]
  selected: string | null
  known: Readonly<Record<string, string>>
  onSelect: (id: string) => void
  onConnect: () => void
  onNotSeeing: () => void
  onByAddress: () => void
  onBack: () => void
}

/** What a row says about where a computer is. A typed address is shown as typed (Advanced). */
function whereText(c: DiscoveredComputer): string {
  if (c.where === 'typed') return fill(COPY.advanced.bAdv.where, { address: `${c.endpoints[0].host}:${c.endpoints[0].port}` })
  return COPY.main.b3.where[c.where]
}

/** B3: the computers a search found, to pick one from. One result is selected for you and the title names
 *  it; with several nothing is, until the person chooses. Nothing here connects: Connect asks for approval
 *  next, and a computer whose fingerprint has changed since last time is marked (S1). */
export function ChooseComputer({ computers, selected, known, onSelect, onConnect, onNotSeeing, onByAddress, onBack }: Props): React.JSX.Element {
  const t = COPY.main.b3
  const one = computers.length === 1 ? computers[0] : null
  return (
    <>
      <h1>{one ? fill(t.titleOne, { name: one.name }) : t.title}</h1>
      {one ? null : <p className="setup-sub">{t.body}</p>}
      <div className="onb-choices" role="radiogroup" aria-label={t.listLabel}>
        {computers.map((c) => {
          const on = c.id === selected
          const changed = differsFromKnown(known, c)
          return (
            <button key={c.id} type="button" role="radio" aria-checked={on} className={on ? 'onb-choice on' : 'onb-choice'} onClick={() => onSelect(c.id)}>
              <span className="onb-choice-title">{c.where === 'this-mac' ? t.thisMac : c.name}</span>
              {changed ? <span className="onb-tag">{t.different}</span> : null}
              <span className="onb-choice-detail">
                {whereText(c)}
                {c.agent ? ` · "${c.agent}"` : ''}
              </span>
            </button>
          )
        })}
      </div>
      <p className="setup-sub onb-links">
        <button className="wiz-link" onClick={onNotSeeing}>
          {t.notSeeing}
        </button>
        <button className="wiz-link" onClick={onByAddress}>
          {COPY.main.common.advanced}
        </button>
      </p>
      <div className="onb-nav">
        <button className="setup-test" onClick={onBack}>
          {COPY.main.common.back}
        </button>
        <button className="setup-connect onb-primary" onClick={onConnect} disabled={selected === null}>
          {t.connect}
        </button>
      </div>
    </>
  )
}
