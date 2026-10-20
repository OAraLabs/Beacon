import { useEffect, useRef, useState } from 'react'
import { COPY, fill } from '@shared/onboarding-strings'
import { IDLE_VIEW, formatMB, stepState, type InstallFailureKind, type InstallStep, type InstallView } from '@shared/prometheus-app'
import { SETUP_LINKS } from '@shared/setup-links'

interface Props {
  /** Prometheus is in place and the connection is kept: a new install still to set up, or one that was set up before. */
  onInstalled: (daemon: 'setup' | 'configured') => void
  /** Leave for the question (the machine's Back). */
  onBack: () => void
  /** A dev build's skip to the first message (CONNECTS_FROM); null once onboarding is live. */
  onSkipToHello: (() => void) | null
}

const t = COPY.main.aInst
const CARDS: Record<InstallFailureKind, { title: string; body: string }> = {
  download: t.download,
  unsafe: t.unsafe,
  place: t.place,
  approval: t.approval,
  'not-started': t.notStarted,
  'in-the-way': t.inTheWay,
  refused: t.refused,
  'old-macos': t.oldMacos
}
const ROWS: readonly InstallStep[] = ['get', 'check', 'place', 'start']

/** A-inst, "Setting up Prometheus": main does the work (src/main/prometheus-install.ts) and says where it stands; this draws the steps,
 *  the spec's cards, and "Stop setting up?" before Back can throw a download away. Main runs one set-up at a time, so a screen that
 *  mounts twice gets the same run back, and leaving the screen does not stop it: only Back (or Stop setting up) does. */
export function Installing({ onInstalled, onBack, onSkipToHello }: Props): React.JSX.Element {
  const [view, setView] = useState<InstallView>(IDLE_VIEW)
  const [asking, setAsking] = useState(false)
  const [copied, setCopied] = useState(false)
  const finished = useRef(false)

  useEffect(() => {
    const p = window.beacon?.pathA
    if (!p) return
    const off = p.onInstallUpdate((v) => setView(v))
    void p.installStart().then(setView).catch(() => undefined)
    return off
  }, [])

  useEffect(() => {
    if (view.phase === 'done' && view.daemon && !finished.current) {
      finished.current = true
      onInstalled(view.daemon)
    }
  }, [view, onInstalled])

  const leave = (): void => {
    setAsking(false)
    void (window.beacon?.pathA.installCancel() ?? Promise.resolve())
      .catch(() => undefined)
      .then(() => onBack())
  }
  // Only a download that is still coming is worth asking about: once the app is in Applications it stays, and a card has nothing running.
  const back = (): void => (view.phase === 'running' && !view.placed ? setAsking(true) : leave())
  const retry = (): void => {
    setCopied(false)
    void window.beacon?.pathA.installStart().then(setView).catch(() => undefined)
  }
  const copy = (details: string): void => {
    void navigator.clipboard
      ?.writeText(details)
      .then(() => setCopied(true))
      .catch(() => undefined)
  }

  // Esc is Back here too, and asks the same question (Onboarding's own Esc leaves this screen alone).
  const latest = useRef({ asking, back })
  latest.current = { asking, back }
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      if (latest.current.asking) setAsking(false)
      else latest.current.back()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const skip = onSkipToHello ? (
    <button
      className="setup-test"
      onClick={() => {
        void (window.beacon?.pathA.installCancel() ?? Promise.resolve()).catch(() => undefined).then(() => onSkipToHello())
      }}
    >
      {COPY.dev.skipToHello}
    </button>
  ) : null

  const failure = view.phase === 'failed' ? view.failure : undefined
  if (failure) {
    const card = CARDS[failure.kind]
    const approval = failure.kind === 'approval'
    return (
      <div data-failure={failure.kind}>
        <h1>{card.title}</h1>
        <p className="setup-sub">{card.body}</p>
        {approval ? (
          <p className="setup-sub onb-quiet" role="status">
            {t.approval.watching}
          </p>
        ) : null}
        <p className="setup-sub onb-links">
          <button className="setup-test" onClick={() => copy(failure.details)}>
            {copied ? t.copied : t.copyDetails}
          </button>
          {approval || failure.kind === 'download' ? null : (
            <a className="wiz-link" href={SETUP_LINKS.guide} target="_blank" rel="noreferrer">
              {t.getHelp} ↗
            </a>
          )}
        </p>
        <div className="onb-nav">
          <button className="setup-test" onClick={leave}>
            {approval ? t.approval.notNow : COPY.main.common.back}
          </button>
          <span className="onb-nav-right">
            {skip}
            {approval ? (
              <button className="setup-connect onb-primary" onClick={() => void window.beacon?.pathA.openLoginItems().catch(() => undefined)}>
                {t.approval.openLoginItems}
              </button>
            ) : (
              <button className="setup-connect onb-primary" onClick={retry}>
                {t.tryAgain}
              </button>
            )}
          </span>
        </div>
      </div>
    )
  }

  const label = (step: InstallStep): string => {
    if (step === 'get' && view.step === 'get' && view.total > 0) return fill(t.steps.getOf, { got: formatMB(view.received), total: formatMB(view.total) })
    return t.steps[step]
  }
  const rows = view.step === 'connect' || view.phase === 'done' ? [...ROWS, 'connect' as const] : ROWS
  return (
    <>
      <h1>{t.title}</h1>
      <p className="setup-sub">{t.body}</p>
      <ol className="onb-steps" aria-live="polite">
        {rows.map((step) => {
          const state = stepState(view.phase === 'idle' ? { ...view, phase: 'running' } : view, step)
          return (
            <li key={step} className="onb-step" data-step={step} data-state={state}>
              <span className="onb-step-mark" aria-hidden="true">
                {state === 'done' ? '✓' : state === 'doing' ? '•' : ''}
              </span>
              {label(step)}
            </li>
          )
        })}
      </ol>
      <p className="setup-sub onb-quiet">{t.finePrint}</p>
      {asking ? (
        <div className="onb-ask" role="alertdialog" aria-labelledby="onb-ask-title">
          <h2 id="onb-ask-title">{t.stop.title}</h2>
          <p className="setup-sub">{t.stop.body}</p>
          <div className="onb-nav">
            <button className="setup-test" onClick={() => setAsking(false)} autoFocus>
              {t.stop.keepGoing}
            </button>
            <button className="setup-connect onb-primary" onClick={leave}>
              {t.stop.stop}
            </button>
          </div>
        </div>
      ) : (
        <div className="onb-nav">
          <button className="setup-test" onClick={back}>
            {COPY.main.common.back}
          </button>
          <span className="onb-nav-right">{skip}</span>
        </div>
      )}
    </>
  )
}
