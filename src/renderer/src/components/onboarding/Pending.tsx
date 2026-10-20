import { CONNECTS_FROM, type ScreenId } from '@shared/onboarding'
import { COPY } from '@shared/onboarding-strings'

interface Props {
  screen: ScreenId
  onBack: () => void
  onUseOld: () => void
  /** Fires `connected`, for a stand-in a connection is made on: the dev-only way to walk what follows it. */
  onConnected: () => void
}

/** A screen the machine routes to that is not built yet (PENDING_SCREENS). Only a dev or probe build
 *  can get here (@shared/onboarding-gate). It says so, and it always has a way back and a way into the
 *  existing wizard, so a dev build is never stuck. Deleted with the last pending screen. */
export function Pending({ screen, onBack, onUseOld, onConnected }: Props): React.JSX.Element {
  return (
    <>
      <h1>{COPY.dev.notBuilt}</h1>
      <p className="setup-sub">
        {COPY.dev.notBuiltDetail} ({screen})
      </p>
      <div className="onb-nav">
        <button className="setup-test" onClick={onBack}>
          {COPY.main.common.back}
        </button>
        <span className="onb-nav-right">
          {CONNECTS_FROM.includes(screen) ? (
            <button className="setup-test" onClick={onConnected}>
              {COPY.dev.skipToHello}
            </button>
          ) : null}
          <button className="setup-connect onb-primary" onClick={onUseOld}>
            {COPY.dev.useOld}
          </button>
        </span>
      </div>
    </>
  )
}
