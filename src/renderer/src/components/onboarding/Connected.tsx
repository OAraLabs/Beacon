import { COPY, fill } from '@shared/onboarding-strings'

interface Props {
  name: string
  onSayHello: () => void
}

/** B-ok: the computer said yes and this Mac is connected. There is nothing to go back to: the request is spent. */
export function Connected({ name, onSayHello }: Props): React.JSX.Element {
  const t = COPY.main.bOk
  return (
    <>
      <h1>{t.title}</h1>
      <p className="setup-sub">{fill(t.body, { name })}</p>
      <div className="onb-nav onb-nav-end">
        <button className="setup-connect onb-primary" onClick={onSayHello} autoFocus>
          {t.sayHello}
        </button>
      </div>
    </>
  )
}
