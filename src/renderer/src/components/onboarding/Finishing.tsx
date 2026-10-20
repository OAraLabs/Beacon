import { useEffect, useRef, useState } from 'react'
import type { ModelSetupView } from '@shared/model-setup'
import { COPY } from '@shared/onboarding-strings'
import { SETUP_LINKS } from '@shared/setup-links'

interface Props {
  /** Configured, started, and this Mac is the owner: on to the first message. */
  onSetUp: () => void
}

const ROWS = ['save', 'start', 'owner'] as const
type Row = (typeof ROWS)[number]

/** A5: "Finishing setup". Saving the choice, starting the assistant, and connecting this Mac as its owner (the setup credential is
 *  traded for an owner one in main). No Back while it runs: there is nothing to go back to. A failure is a card with Try again. */
export function Finishing({ onSetUp }: Props): React.JSX.Element {
  const t = COPY.main.a5
  const c = COPY.main.aInst
  const [view, setView] = useState<ModelSetupView>({ phase: 'running', step: 'save' })
  const [run, setRun] = useState(0)
  const [copied, setCopied] = useState(false)
  const live = useRef(true)
  useEffect(() => {
    live.current = true
    const off = window.beacon?.model.onUpdate((v) => live.current && setView(v))
    void window.beacon?.model
      .finish()
      .then((v) => {
        if (!live.current) return
        setView(v)
        if (v.phase === 'done') onSetUp()
      })
      .catch(() => live.current && setView({ phase: 'failed', step: 'start', failure: { kind: 'not-started', details: 'Beacon could not ask' } }))
    return () => {
      live.current = false
      off?.()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run])

  if (view.phase === 'failed' && view.failure) {
    const card = view.failure.kind === 'trade' ? t.trade : t.notStarted
    const details = view.failure.details
    return (
      <div data-failure={view.failure.kind}>
        <h1>{card.title}</h1>
        <p className="setup-sub">{card.body}</p>
        <p className="setup-sub onb-links">
          <button className="setup-test" onClick={() => void navigator.clipboard?.writeText(details).then(() => setCopied(true)).catch(() => undefined)}>
            {copied ? c.copied : c.copyDetails}
          </button>
          <a className="wiz-link" href={SETUP_LINKS.guide} target="_blank" rel="noreferrer">
            {c.getHelp} ↗
          </a>
        </p>
        <div className="onb-nav">
          <span />
          <button
            className="setup-connect onb-primary"
            onClick={() => {
              setCopied(false)
              setView({ phase: 'running', step: 'save' })
              setRun((n) => n + 1)
            }}
          >
            {c.tryAgain}
          </button>
        </div>
      </div>
    )
  }
  const at = (row: Row): 'done' | 'doing' | 'todo' => {
    const i = ROWS.indexOf(row)
    const now = view.phase === 'done' ? ROWS.length : Math.max(0, ROWS.indexOf(view.step as Row))
    return i < now ? 'done' : i === now ? 'doing' : 'todo'
  }
  return (
    <>
      <h1>{t.title}</h1>
      <ol className="onb-steps" aria-live="polite">
        {ROWS.map((row) => {
          const state = at(row)
          return (
            <li key={row} className="onb-step" data-step={row} data-state={state}>
              <span className="onb-step-mark" aria-hidden="true">
                {state === 'done' ? '✓' : state === 'doing' ? '•' : ''}
              </span>
              {t.steps[row]}
            </li>
          )
        })}
      </ol>
    </>
  )
}
