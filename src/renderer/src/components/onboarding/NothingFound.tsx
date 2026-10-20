import type { LanState } from '@shared/discovery'
import { COPY, fill } from '@shared/onboarding-strings'

interface Props {
  lan: LanState
  /** Computers the search found that need an update to be joined (by name). */
  outdated: readonly string[]
  onLookAgain: () => void
  onSetUpHere: () => void
  onByAddress: () => void
  onOpenSettings: () => void
  onBack: () => void
}

/** B-empty: why the search shows nothing to choose, and a way forward. One reason, the most certain first:
 *   - denied: macOS refused Beacon's look on the network (it is not a guess: the search said so). How to allow it.
 *   - outdated: it found Prometheus, but only in plain on the home network, which Beacon cannot join. Update it, turn on home network.
 *   - none: nothing answered. The usual reasons, and typing its address. */
export function NothingFound({ lan, outdated, onLookAgain, onSetUpHere, onByAddress, onOpenSettings, onBack }: Props): React.JSX.Element {
  const t = COPY.main.bEmpty
  const reason = lan === 'denied' ? 'denied' : outdated.length > 0 ? 'outdated' : 'none'
  const orType = (
    <button className="wiz-link" data-or-type onClick={onByAddress}>
      {COPY.advanced.orType}
    </button>
  )
  return (
    <>
      {reason === 'denied' ? (
        <>
          <h1>{t.deniedTitle}</h1>
          <p className="setup-sub" data-reason="denied">
            {t.howToAllow}{' '}
            <button className="wiz-link" onClick={onOpenSettings}>
              {t.openSettings}
            </button>
          </p>
        </>
      ) : reason === 'outdated' ? (
        <>
          <h1>{outdated.length === 1 ? fill(t.outdatedTitle, { name: outdated[0] }) : fill(t.outdatedTitle, { name: 'Prometheus' })}</h1>
          <p className="setup-sub" data-reason="outdated">
            {t.outdatedBody}
          </p>
        </>
      ) : (
        <div data-reason="none">
          <h1>{t.title}</h1>
          <p className="setup-sub">{t.intro}</p>
          <ul className="onb-reasons">
            <li>{t.asleep}</li>
            <li>{t.wifi}</li>
          </ul>
          <p className="setup-sub">{orType}</p>
        </div>
      )}
      <p className="setup-sub onb-links">
        <button className="wiz-link" onClick={onSetUpHere}>
          {t.setUpHere}
        </button>
        <button className="wiz-link" onClick={onByAddress}>
          {COPY.main.common.advanced}
        </button>
      </p>
      <div className="onb-nav">
        <button className="setup-test" onClick={onBack}>
          {COPY.main.common.back}
        </button>
        <button className="setup-connect onb-primary" onClick={onLookAgain}>
          {t.lookAgain}
        </button>
      </div>
    </>
  )
}
