import { useEffect } from 'react'
import { formatGB, type MacVerdict } from '@shared/mac-check'
import { COPY, fill } from '@shared/onboarding-strings'
import { SETUP_LINKS } from '@shared/setup-links'

interface Props {
  /** What the check found, or null while it is being made. */
  verdict: MacVerdict | null
  onChecked: (v: MacVerdict) => void
  onRecheck: () => void
  onElsewhere: () => void
  onConnectToIt: () => void
  onOpenStorage: () => void
  onBack: () => void
}

/** The look at this Mac takes a fraction of a second; the screen stays long enough to be read, because a flash of
 *  a screen with words on it reads as something going wrong. */
const MIN_SHOWN_MS = 700

/** A1: can Prometheus be set up on this Mac? It says what it is doing, then either goes on (the machine moves to the
 *  confirmation) or shows a card in plain words with a button that helps. Nothing here downloads anything. */
export function CheckingMac({ verdict, onChecked, onRecheck, onElsewhere, onConnectToIt, onOpenStorage, onBack }: Props): React.JSX.Element {
  const t = COPY.main.a1

  useEffect(() => {
    if (verdict !== null) return
    let cancelled = false
    void (async () => {
      try {
        const pause = new Promise((r) => setTimeout(r, MIN_SHOWN_MS))
        const result = await window.beacon?.pathA.check()
        await pause
        if (!cancelled) onChecked(result?.verdict ?? { kind: 'ok' })
      } catch {
        // A check that could not be made is not a reason to stop someone: the set-up itself will say what is wrong.
        if (!cancelled) onChecked({ kind: 'ok' })
      }
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [verdict === null])

  const back = (
    <button className="setup-test" onClick={onBack}>
      {COPY.main.common.back}
    </button>
  )

  if (verdict === null || verdict.kind === 'ok') {
    return (
      <>
        <h1>{t.checking.title}</h1>
        <p className="setup-sub" role="status">
          <span className="wiz-spinner" aria-hidden="true" /> {t.checking.body}
        </p>
        <div className="onb-nav">{back}</div>
      </>
    )
  }

  switch (verdict.kind) {
    case 'low-space':
      return (
        <>
          <h1>{t.lowSpace.title}</h1>
          <div className="setup-error" role="alert">
            {fill(t.lowSpace.body, { free: formatGB(verdict.freeBytes) })}
          </div>
          <p className="setup-sub onb-links">
            <button className="wiz-link" onClick={onOpenStorage}>
              {t.lowSpace.openStorage}
            </button>
          </p>
          <div className="onb-nav">
            {back}
            <button className="setup-connect onb-primary" onClick={onRecheck}>
              {t.lowSpace.checkAgain}
            </button>
          </div>
        </>
      )
    case 'old-macos':
      return (
        <>
          <h1>{t.oldMacos.title}</h1>
          <div className="setup-error" role="alert">
            {t.oldMacos.body}
          </div>
          <p className="setup-sub onb-links">
            <a className="wiz-link" href={SETUP_LINKS.macUpdate} target="_blank" rel="noreferrer">
              {t.oldMacos.howToUpdate} ↗
            </a>
          </p>
          <div className="onb-nav">{back}</div>
        </>
      )
    case 'intel':
      return (
        <>
          <h1>{t.intel.title}</h1>
          <div className="setup-error" role="alert">
            {t.intel.body}
          </div>
          <div className="onb-nav">
            {back}
            <button className="setup-connect onb-primary" onClick={onElsewhere}>
              {t.intel.elsewhere}
            </button>
          </div>
        </>
      )
    case 'other-os':
      return (
        <>
          <h1>{t.otherOs.title}</h1>
          <div className="setup-error" role="alert">
            {t.otherOs.body}
          </div>
          <div className="onb-nav">
            {back}
            <button className="setup-connect onb-primary" onClick={onElsewhere}>
              {t.intel.elsewhere}
            </button>
          </div>
        </>
      )
    case 'running':
      return (
        <>
          <h1>{t.running.title}</h1>
          <p className="setup-sub">{t.running.body}</p>
          <div className="onb-nav">
            {back}
            <button className="setup-connect onb-primary" onClick={onConnectToIt}>
              {t.running.connect}
            </button>
          </div>
        </>
      )
  }
}
