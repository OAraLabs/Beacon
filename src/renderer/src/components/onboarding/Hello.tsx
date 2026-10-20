import { useEffect, useReducer, useRef } from 'react'
import { BEACON_GATEWAY } from '@shared/session-sources'
import { failureKind, firstReply, helloReduce, initialHello } from '@shared/hello'
import { COPY } from '@shared/onboarding-strings'
import { SETUP_LINKS } from '@shared/setup-links'
import { TextBlock } from '../MessageRenderer'
import { openMakeOwner, useDeviceRole } from '../OwnerOnlyNote'

interface Props {
  /** How long to wait for a first answer before saying so. */
  timeoutMs: number
  /** The first reply arrived: the flow is finished (nothing to go back to). */
  onDone: () => void
  /** Leave onboarding for the app. */
  onFinish: () => void
  onBack: () => void
  /** Prometheus runs on this Mac (path A): this Mac's Beacon is the one that approves another computer. */
  onThisMac: boolean
}

const POLL_MS = 1_500
const TICK_MS = 250
/** Polls that fail in a row before the computer is called gone: one dropped request is not "we lost touch". */
const POLL_FAILURES_BEFORE_LOST = 3

/** F1: the first message. A real conversation in Beacon's own session list (gateway "beacon", not the hidden
 *  "beacon-verify" one the old wizard's smoke test used). The screen sends one message, waits for the first
 *  reply by asking for the session's messages, and says what is happening in plain words, with a button that
 *  fixes each thing that goes wrong. Phones are mentioned here and only here, after the first reply. */
export function Hello({ timeoutMs, onDone, onFinish, onBack, onThisMac }: Props): React.JSX.Element {
  const t = COPY.main.f1
  const [s, dispatch] = useReducer(helloReduce, t.chips[0], initialHello)
  // An approved device (path B) is offered, once, here at the end, the way to become an owner; an owner has nothing to become.
  const limited = useDeviceRole() === 'limited'
  const stale = useRef(false)
  const failures = useRef(0)
  const text = useRef(s.text)
  text.current = s.text
  const session = useRef<string | null>(null)
  session.current = s.session

  useEffect(() => {
    stale.current = false
    return () => {
      stale.current = true
    }
  }, [])

  // Sending: make the conversation once (a retry reuses it), then send the message.
  useEffect(() => {
    if (s.phase !== 'sending') return
    const b = window.beacon
    if (!b) return
    void (async () => {
      try {
        let id = session.current
        if (!id) {
          const created = (await b.daemon.write('/api/sessions', { gateway: BEACON_GATEWAY }, 'POST')) as { session_id?: string } | null
          id = created?.session_id ?? null
          if (!id) throw new Error('HTTP 502: POST /api/sessions returned no session_id')
          // Kept at once: if the send below fails, Try again must reuse this conversation, not make another.
          session.current = id
          if (!stale.current) dispatch({ type: 'session', id })
        }
        await b.daemon.write('/api/chat/send', { session_id: id, message: text.current.trim() })
        failures.current = 0
        if (!stale.current) dispatch({ type: 'sent', session: id, at: Date.now() })
      } catch (e) {
        if (!stale.current) dispatch({ type: 'failed', kind: failureKind(e) })
      }
    })()
  }, [s.phase])

  // Waiting (and slow: a late answer still counts): ask for the messages until there is a reply.
  const waiting = s.phase === 'waiting' || s.phase === 'slow'
  useEffect(() => {
    const b = window.beacon
    if (!waiting || !b || !s.session) return
    const id = s.session
    let busy = false
    const poll = setInterval(() => {
      if (busy || stale.current) return
      busy = true
      void b.daemon
        .get(`/api/sessions/${encodeURIComponent(id)}/messages?since=0`)
        .then((raw) => {
          failures.current = 0
          const reply = firstReply(raw)
          if (reply && !stale.current) {
            dispatch({ type: 'reply', text: reply })
            onDone()
          }
        })
        .catch((e: unknown) => {
          if (++failures.current >= POLL_FAILURES_BEFORE_LOST && !stale.current) dispatch({ type: 'failed', kind: failureKind(e) })
        })
        .finally(() => {
          busy = false
        })
    }, POLL_MS)
    return () => clearInterval(poll)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [waiting, s.session])

  // "No answer yet" after the timeout.
  useEffect(() => {
    if (s.phase !== 'waiting') return
    const tick = setInterval(() => dispatch({ type: 'tick', now: Date.now(), timeoutMs }), TICK_MS)
    return () => clearInterval(tick)
  }, [s.phase, timeoutMs])

  const canSend = s.phase === 'compose' && s.text.trim().length > 0

  async function reconnect(): Promise<void> {
    await window.beacon?.connection.reconnect().catch(() => undefined)
    dispatch({ type: 'retry' })
  }

  if (s.phase === 'done') {
    return (
      <>
        <h1>{t.done.title}</h1>
        <p className="setup-sub">{t.done.says}</p>
        {/* The assistant's own words, in chat's own renderer: models answer in markdown, and the raw text showed `- **Step 1:**` (the
            0.4.5 sweep, M1). Untrusted like any reply: TextBlock refuses relative and non-web links (@shared/markdown-urls). */}
        <blockquote className="onb-reply" data-untrusted>
          <TextBlock text={s.reply} />
        </blockquote>
        <p className="setup-sub">{onThisMac ? t.done.another.here : t.done.another.there}</p>
        {limited ? (
          <p className="setup-sub" data-testid="hello-make-owner">
            {t.done.owner.body}
          </p>
        ) : null}
        <div className="onb-nav onb-nav-end">
          {limited ? (
            <button
              className="setup-test"
              onClick={() => {
                onFinish()
                openMakeOwner() // Settings opens at "Make this Beacon an owner" as the app comes up
              }}
            >
              {t.done.owner.button}
            </button>
          ) : null}
          <button className="setup-connect onb-primary" onClick={onFinish}>
            {t.done.start}
          </button>
        </div>
      </>
    )
  }

  if (s.phase === 'slow') {
    return (
      <>
        <h1>{t.slow.title}</h1>
        <p className="setup-sub">{t.slow.body}</p>
        <div className="onb-nav">
          <button className="setup-test" onClick={onBack}>
            {COPY.main.common.back}
          </button>
          <span className="onb-nav-right">
            <button className="setup-test" onClick={() => dispatch({ type: 'retry' })}>
              {t.slow.tryAgain}
            </button>
            <button className="setup-connect onb-primary" onClick={() => dispatch({ type: 'keepWaiting', at: Date.now() })}>
              {t.slow.keepWaiting}
            </button>
          </span>
        </div>
      </>
    )
  }

  if (s.phase === 'lost') {
    return (
      <>
        <h1>{t.lost.title}</h1>
        <div className="setup-error" role="alert">
          {t.lost.body}
        </div>
        <div className="onb-nav">
          <button className="setup-test" onClick={onBack}>
            {COPY.main.common.back}
          </button>
          <button className="setup-connect onb-primary" onClick={() => void reconnect()}>
            {t.lost.reconnect}
          </button>
        </div>
      </>
    )
  }

  if (s.phase === 'refused') {
    return (
      <>
        <h1>{t.refused.title}</h1>
        <div className="setup-error" role="alert">
          {t.refused.body}
        </div>
        <div className="onb-nav">
          <button className="setup-test" onClick={onBack}>
            {COPY.main.common.back}
          </button>
          <span className="onb-nav-right">
            <a className="wiz-link" href={SETUP_LINKS.guide} target="_blank" rel="noreferrer">
              {t.refused.getHelp} ↗
            </a>
            <button className="setup-connect onb-primary" onClick={() => dispatch({ type: 'retry' })}>
              {t.refused.tryAgain}
            </button>
          </span>
        </div>
      </>
    )
  }

  const busy = s.phase !== 'compose'
  return (
    <>
      <h1>{t.title}</h1>
      <p className="setup-sub">{t.body}</p>
      <label className="setup-field">
        {t.fieldLabel}
        <input
          value={s.text}
          onChange={(e) => dispatch({ type: 'edit', text: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && canSend) dispatch({ type: 'send' })
          }}
          disabled={busy}
          spellCheck
          autoFocus
        />
      </label>
      <div className="onb-chips" role="group" aria-label={t.body}>
        {t.chips.map((c, i) => (
          <button key={c} type="button" data-chip className={s.text === c ? 'onb-chip on' : 'onb-chip'} disabled={busy} onClick={() => dispatch({ type: 'edit', text: c })}>
            {c}
            {i === 0 ? <span className="onb-tag">{COPY.main.common.recommended}</span> : null}
          </button>
        ))}
      </div>
      {busy ? (
        <p className="setup-sub" role="status">
          <span className="wiz-spinner" aria-hidden="true" /> {t.thinking}
        </p>
      ) : null}
      <div className="onb-nav">
        <button className="setup-test" onClick={onBack}>
          {COPY.main.common.back}
        </button>
        {busy ? null : (
          <button className="setup-connect onb-primary" onClick={() => dispatch({ type: 'send' })} disabled={!canSend}>
            {t.send}
          </button>
        )}
      </div>
    </>
  )
}
