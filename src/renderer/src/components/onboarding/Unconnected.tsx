import { COPY } from '@shared/onboarding-strings'

/** Where "Not now" lands: an empty home that says what is missing and offers the way in. */
export function Unconnected({ onSetItUp }: { onSetItUp: () => void }): React.JSX.Element {
  const t = COPY.main.unconnected
  return (
    <>
      <h1>{t.title}</h1>
      <p className="setup-sub">{t.body}</p>
      <div className="onb-nav onb-nav-end">
        <button className="setup-connect onb-primary" onClick={onSetItUp}>
          {t.setItUp}
        </button>
      </div>
    </>
  )
}
