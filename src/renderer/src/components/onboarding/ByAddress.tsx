import { useState } from 'react'
import { parseTypedAddress, type DiscoveredComputer } from '@shared/discovery'
import { COPY } from '@shared/onboarding-strings'

interface Props {
  onFound: (c: DiscoveredComputer) => void
  onBack: () => void
}

/** B-adv (Advanced): ask one typed address who it is. The port typed is the port asked and shown. This is
 *  the one path-B screen that may use technical words: it sits behind an "Advanced" link. */
export function ByAddress({ onFound, onBack }: Props): React.JSX.Element {
  const t = COPY.advanced.bAdv
  const [text, setText] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function find(): Promise<void> {
    const ep = parseTypedAddress(text)
    if (!ep) return setError(t.invalid)
    if (busy || !window.beacon?.discovery) return
    setBusy(true)
    setError(null)
    try {
      const r = await window.beacon.discovery.probeAddress(ep)
      if (r.ok) onFound(r.computer)
      else setError(r.reason === 'unreachable' ? t.unreachable : r.reason === 'not-prometheus' ? t.notPrometheus : r.reason === 'not-encrypted' ? t.notEncrypted : r.reason === 'not-encrypted-public' ? t.notEncryptedPublic : t.invalid)
    } catch {
      setError(t.unreachable)
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <h1>{t.title}</h1>
      <p className="setup-sub">{t.body}</p>
      <label className="setup-field">
        {t.label}
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void find()
          }}
          placeholder={t.placeholder}
          spellCheck={false}
          autoFocus
        />
      </label>
      {error ? (
        <div className="setup-error" role="alert">
          {error}
        </div>
      ) : null}
      <div className="onb-nav">
        <button className="setup-test" onClick={onBack}>
          {COPY.main.common.back}
        </button>
        <button className="setup-connect onb-primary" onClick={() => void find()} disabled={busy || text.trim().length === 0}>
          {busy ? t.finding : t.find}
        </button>
      </div>
    </>
  )
}
