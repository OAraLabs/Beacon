import { COPY } from '@shared/onboarding-strings'

/** B2: the search is running. It gives way to B3 on the first result, or to B-empty when it is done and
 *  found nothing; Back stops it. */
export function Looking({ onBack }: { onBack: () => void }): React.JSX.Element {
  const t = COPY.main.b2
  return (
    <>
      <h1>{t.title}</h1>
      <p className="setup-sub" role="status">
        {t.body}
      </p>
      <div className="onb-nav">
        <button className="setup-test" onClick={onBack}>
          {COPY.main.common.back}
        </button>
        <span className="wiz-spinner" aria-hidden="true" />
      </div>
    </>
  )
}
