import { COPY, fill } from '@shared/onboarding-strings'

interface Props {
  name: string
  onBack: () => void
  onOtherWay: () => void
}

/** B-nojoin: the chosen computer answered, but not with an offer to approve a new device (it is still being set up, has no
 *  password, or is too old to say). The way on is the older setup. */
export function NoJoin({ name, onBack, onOtherWay }: Props): React.JSX.Element {
  const t = COPY.main.bNojoin
  return (
    <>
      <h1>{fill(t.title, { name })}</h1>
      <div className="setup-error" role="alert">
        {t.body}
      </div>
      <div className="onb-nav">
        <button className="setup-test" onClick={onBack}>
          {COPY.main.common.back}
        </button>
        <button className="setup-connect onb-primary" onClick={onOtherWay}>
          {t.otherWay}
        </button>
      </div>
    </>
  )
}
