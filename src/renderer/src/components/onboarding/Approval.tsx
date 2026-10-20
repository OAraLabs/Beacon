import { useEffect, useState } from 'react'
import { clockText, joinActions, waitingOffersOtherWay, waitPhrase, type BeginResult, type JoinFailure, type PollOutcome } from '@shared/join'
import type { DiscoveredComputer } from '@shared/discovery'
import { COPY, fill } from '@shared/onboarding-strings'

interface Props {
  computer: Pick<DiscoveredComputer, 'name' | 'fp' | 'tls' | 'endpoints' | 'where'>
  /** This Mac is connected: the token is kept (by the main process; it never comes here). */
  onApproved: () => void
  onBack: () => void
  /** The older setup, for a computer that cannot approve this way. */
  onOtherWay: () => void
}

type View =
  | { phase: 'asking' }
  | { phase: 'waiting'; code: string; device: string; deadline: number; notified: boolean; approveCommand: string | null }
  | { phase: 'ended'; kind: 'denied' | 'expired' | 'canceled' }
  | { phase: 'failed'; failure: JoinFailure }

/** B4: this Mac has asked a computer that already has an owner to let it connect, and waits for someone to say yes. The request,
 *  the wait and the unsealing are the main process's (src/main/pairing/session.ts); this draws them. The four digits are the
 *  ones THIS Mac worked out, which the person compares with the other screen. Leaving this screen any way at all withdraws the
 *  request (the effect's cleanup), unless it was approved. */
export function Approval({ computer, onApproved, onBack, onOtherWay }: Props): React.JSX.Element {
  const t = COPY.main.b4
  const f = COPY.main.joinFailed
  const [view, setView] = useState<View>({ phase: 'asking' })
  const [attempt, setAttempt] = useState(0)
  const [now, setNow] = useState(() => Date.now())
  const [showHow, setShowHow] = useState(false)
  const [copied, setCopied] = useState(false)
  const endpoint = computer.endpoints[0]

  useEffect(() => {
    let cancelled = false
    let finished = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const join = window.beacon?.join
    setView({ phase: 'asking' })
    if (!join || !endpoint) {
      setView({ phase: 'failed', failure: { kind: 'refused' } })
      return
    }
    void (async () => {
      let began: BeginResult
      try {
        began = await join.begin({ host: endpoint.host, apiPort: endpoint.port, name: computer.name, fp: computer.fp, tls: computer.tls })
      } catch {
        began = { ok: false, failure: { kind: 'lost' } }
      }
      if (cancelled) return
      if (!began.ok) {
        setView({ phase: 'failed', failure: began.failure })
        return
      }
      setNow(Date.now())
      setView({ phase: 'waiting', code: began.matchCode, device: began.deviceName, deadline: Date.now() + began.ttlSeconds * 1000, notified: began.notified, approveCommand: began.approveCommand ?? null })
      const look = async (): Promise<void> => {
        if (cancelled) return
        let o: PollOutcome
        try {
          o = await join.poll()
        } catch {
          o = { state: 'failed', failure: { kind: 'lost' } }
        }
        if (cancelled) return
        if (o.state === 'waiting') {
          // The daemon's own word on whether anyone who can approve has been told; it can only become true during a wait.
          setView((v) => (v.phase === 'waiting' && v.notified !== o.notified ? { ...v, notified: o.notified } : v))
          timer = setTimeout(() => void look(), began.pollIntervalSeconds * 1000)
        } else if (o.state === 'connected') {
          finished = true
          onApproved()
        } else if (o.state === 'failed') {
          setView({ phase: 'failed', failure: o.failure })
        } else {
          setView({ phase: 'ended', kind: o.state })
        }
      }
      timer = setTimeout(() => void look(), began.pollIntervalSeconds * 1000)
    })()
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
      if (!finished) void join.cancel().catch(() => undefined)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempt])

  // The countdown only needs the clock while there is something to count down.
  useEffect(() => {
    if (view.phase !== 'waiting') return
    const id = setInterval(() => setNow(Date.now()), 500)
    return () => clearInterval(id)
  }, [view.phase])

  const back = (
    <button className="setup-test" onClick={onBack}>
      {COPY.main.common.back}
    </button>
  )

  if (view.phase === 'asking') {
    return (
      <>
        <h1>{t.title}</h1>
        <p className="setup-sub" role="status">
          <span className="wiz-spinner" aria-hidden="true" /> {fill(t.asking, { name: computer.name })}
        </p>
        <div className="onb-nav">{back}</div>
      </>
    )
  }

  if (view.phase === 'waiting') {
    // Prometheus on THIS Mac: there may be no other Beacon to say yes (a Prometheus installed with pip or brew), so the person can say it
    // here, with Prometheus's own one line. Its words are Advanced's, so they wait behind "Show me how".
    const here = computer.where === 'this-mac' && view.approveCommand !== null
    const a = COPY.advanced.approveHere
    return (
      <>
        <h1>{t.title}</h1>
        {/* On this Mac there may be no other Beacon, so the wait does not send anyone to one (thisMac below says what to do). */}
        <p className="setup-sub">{fill(here ? t.asked : t.body, { name: computer.name })}</p>
        <p className="setup-sub onb-code-intro">{t.codeIntro}</p>
        <div className="onb-code" data-code={view.code} aria-label={view.code.split('').join(' ')}>
          {view.code.split('').join(' ')}
        </div>
        <p className="setup-sub">{fill(t.asName, { device: view.device })}</p>
        <p className="setup-sub" role="status">
          <span className="wiz-spinner" aria-hidden="true" /> {t.waiting} {fill(t.endsIn, { time: clockText((view.deadline - now) / 1000) })}
        </p>
        {here ? (
          <>
            <p className="setup-sub" role="status">
              {t.thisMac}{' '}
              {showHow ? null : (
                <button className="wiz-link" onClick={() => setShowHow(true)}>
                  {t.showHow}
                </button>
              )}
            </p>
            {showHow ? (
              <div className="setup-sub" data-advanced>
                <p className="setup-sub">{a.intro}</p>
                <p className="setup-sub onb-links">
                  <code data-approve-command>{view.approveCommand}</code>{' '}
                  <button className="setup-test" onClick={() => void navigator.clipboard?.writeText(view.approveCommand ?? '').then(() => setCopied(true)).catch(() => undefined)}>
                    {copied ? a.copied : a.copy}
                  </button>
                </p>
              </div>
            ) : null}
          </>
        ) : (
          /* No one connected to take the prompt: say where to go. Someone connected: the quiet reminder is enough. */
          <p className={view.notified ? 'setup-sub onb-quiet' : 'setup-sub'} role={view.notified ? undefined : 'status'}>
            {view.notified ? t.ifNothing : t.nobodyThere}
          </p>
        )}
        <div className="onb-nav">
          {back}
          {/* No one connected to take the prompt (for instance a Prometheus installed from a terminal): the older setup is the way on. */}
          {waitingOffersOtherWay(view.notified) ? (
            <button className="setup-test" onClick={onOtherWay}>
              {f.actions.otherWay}
            </button>
          ) : null}
        </div>
      </>
    )
  }

  const kind = view.phase === 'ended' ? view.kind : view.failure.kind
  const copy = (f as unknown as Record<string, { title: string; body: string }>)[kind]
  const w = waitPhrase(view.phase === 'failed' ? view.failure.retryAfterSeconds : undefined)
  const vars = { name: computer.name, wait: fill(f.wait[w.key], { n: String(w.n) }) }
  const actions = joinActions(kind)
  const label = { 'ask-again': f.actions.askAgain, 'try-again': f.actions.tryAgain, 'other-way': f.actions.otherWay }
  return (
    <>
      <h1>{fill(copy.title, vars)}</h1>
      <div className="setup-error" role="alert">
        {fill(copy.body, vars)}
      </div>
      <div className="onb-nav">
        {back}
        <span className="onb-nav-right">
          {actions.map((a, i) => (
            <button key={a} className={i === 0 ? 'setup-connect onb-primary' : 'setup-test'} onClick={() => (a === 'other-way' ? onOtherWay() : setAttempt((n) => n + 1))}>
              {label[a]}
            </button>
          ))}
        </span>
      </div>
    </>
  )
}
