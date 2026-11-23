import { useCallback, useEffect, useRef, useState } from 'react'
import { codeWords, isStale, type GymPromotion, type GymStatus, type GymTone } from '@shared/gym'
import {
  GYM_BUTTON_COPY,
  GYM_CONTROL_WORDS,
  GYM_OP_POLL_MS,
  controlView,
  opAfterFacts,
  opFinished,
  opWords,
  runWords,
  type GymControlAction,
  type GymControlSettings,
  type GymOp
} from '@shared/gym-control'
import { useDeviceRole } from './OwnerOnlyNote'

// Activity › Gym › Now › Rehearsal model: what the gym's ledger says, and, for the owner, Promote and Roll back.
//
// THIS PAGE CAN ONLY ASK. A press asks main (window.beacon.gymControl.run) to plan the action; main shows the plan in a window the
// OS draws, and only that window's yes releases the apply. Nothing here holds a plan, a hash or an apply, and nothing here can
// confirm for the person. The state shown is the gym's own record (the status's `promotion` section), read-only.

const NOT = 'Not reported'
const mark = (tone: GymTone): string => (tone === 'ok' ? '✓' : tone === 'err' ? '✕' : tone === 'warn' ? '!' : '·')

const STATE_WORDS: Record<string, { tone: GymTone; text: string }> = {
  none: { tone: 'idle', text: 'Not promoted' },
  promoting: { tone: 'warn', text: 'Promoting' },
  promoted: { tone: 'ok', text: 'Promoted' },
  rolling_back: { tone: 'warn', text: 'Rolling back' },
  rolled_back: { tone: 'idle', text: 'Rolled back' },
  failed: { tone: 'err', text: 'Failed' }
}
function stateWords(state: string): { tone: GymTone; text: string } {
  return Object.prototype.hasOwnProperty.call(STATE_WORDS, state) ? STATE_WORDS[state] : { tone: 'warn', text: codeWords(state) }
}

function ControlForm({ settings, onSaved }: { settings: GymControlSettings; onSaved: () => void }) {
  const [address, setAddress] = useState(settings.address)
  const [token, setToken] = useState('')
  const [error, setError] = useState<string | null>(null)
  useEffect(() => setAddress(settings.address), [settings.address])
  const save = async (): Promise<void> => {
    const b = window.beacon
    if (!b) return
    if (address.trim() === '') return setError('The address is empty. Fill in where the gym’s control service is, or use “Forget this service” to stop using it.')
    const a = await b.gymControl.setAddress(address)
    if (!a.ok) return setError(a.reason)
    if (token.trim() !== '') {
      const t = await b.gymControl.setToken(token)
      if (!t.ok) return setError(t.reason)
      setToken('')
    }
    setError(null)
    onSaved()
  }
  const forget = async (): Promise<void> => {
    const b = window.beacon
    if (!b) return
    const r = await b.gymControl.setAddress('')
    if (!r.ok) return setError(r.reason)
    setError(null)
    onSaved()
  }
  return (
    <form
      className="gym-address"
      data-testid="gym-control-form"
      onSubmit={(e) => {
        e.preventDefault()
        void save()
      }}
    >
      <label htmlFor="gym-control-address">Where the gym’s control service is</label>
      <input id="gym-control-address" data-testid="gym-control-address" value={address} onChange={(e) => setAddress(e.target.value)} placeholder="for example http://name-of-the-computer:18098" spellCheck={false} autoComplete="off" />
      <label htmlFor="gym-control-token">This computer’s write token</label>
      <input
        id="gym-control-token"
        data-testid="gym-control-token"
        type="password"
        value={token}
        onChange={(e) => setToken(e.target.value)}
        placeholder={settings.hasToken ? 'A token is kept. Paste a new one to replace it.' : 'Paste the write token the gym’s computer made for this one'}
        spellCheck={false}
        autoComplete="off"
      />
      <div className="gym-address-row">
        <button type="submit" className="pill" data-testid="gym-control-save">
          Save
        </button>
        {settings.address !== '' ? (
          <button type="button" className="gym-link" data-testid="gym-control-forget" onClick={() => void forget()}>
            Forget this service
          </button>
        ) : null}
      </div>
      <p className="gym-address-note">This is a different service from the one Beacon reads, with a token of its own that is only for making changes. It is kept encrypted on this computer, sent to that service and nowhere else, and never shown again.</p>
      {error ? (
        <p className="gym-address-error" role="alert">
          {error}
        </p>
      ) : null}
    </form>
  )
}

export function GymControlCard({ s, now }: { s: GymStatus; now: number }) {
  const role = useDeviceRole()
  const [settings, setSettings] = useState<GymControlSettings>({ address: '', hasToken: false })
  const [editing, setEditing] = useState(false)
  const [waiting, setWaiting] = useState(false)
  const [said, setSaid] = useState<string | null>(null)
  const [op, setOp] = useState<{ action: GymControlAction; op: GymOp } | null>(null)
  const [pick, setPick] = useState<string | null>(null)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])
  const reload = useCallback((): void => {
    void window.beacon?.gymControl.settings().then(
      (v) => alive.current && setSettings(v),
      () => undefined
    )
  }, [])
  const owner = role === 'owner'
  useEffect(() => {
    if (owner) reload()
  }, [owner, reload])

  // An operation started from here is read, not waited for, until it is over. (A gym that was already running one says so in its
  // own record, which the status shows.)
  const running = op !== null && !opFinished(op.op.status)
  useEffect(() => {
    if (!running) return
    let gone = false
    const poll = (): void => {
      void window.beacon?.gymControl.op().then(
        (r) => {
          if (gone || !alive.current) return
          if (r.kind === 'shown') setOp({ action: r.action, op: r.op })
          else if (r.kind === 'none') setOp(null)
        },
        () => undefined
      )
    }
    const id = setInterval(poll, GYM_OP_POLL_MS)
    return () => {
      gone = true
      clearInterval(id)
    }
  }, [running])

  const p: GymPromotion | null = s.promotion
  const view = controlView({ role: role ?? null, configured: settings.address !== '' && settings.hasToken, promotion: p, stale: isStale(s, now), opRunning: running, waiting })
  const candidate = pick !== null && view.candidates.includes(pick) ? pick : (view.candidates[0] ?? null)

  const ask = async (action: GymControlAction): Promise<void> => {
    const b = window.beacon
    if (!b) return
    setWaiting(true)
    setSaid(null)
    try {
      const r = await b.gymControl.run(action, action === 'promote' ? (candidate ?? undefined) : undefined)
      if (!alive.current) return
      setSaid(runWords(r))
      // Started, or sent with no clear answer: look at the operation (a started one is found; an unknown one has none).
      if (r.kind === 'started') {
        const o = await b.gymControl.op()
        if (alive.current && o.kind === 'shown') setOp({ action: o.action, op: o.op })
      }
    } catch {
      if (alive.current) setSaid('Beacon couldn’t ask the control service. Nothing was changed.')
    } finally {
      if (alive.current) setWaiting(false)
    }
  }

  // Nothing about the rehearsal on a gym that has no such section, and nobody who could act on it.
  if (p === null && !owner) return null
  const st = p ? stateWords(p.state) : null
  const after = p && (p.state === 'promoted' || p.state === 'rolled_back' || p.state === 'failed') ? p : null
  return (
    <section className="gym-card" data-testid="gym-rehearsal">
      <h3 className="gym-card-title">Rehearsal model</h3>
      {p && st ? (
        <>
          <div className="gym-kv">
            <span className="gym-k">State</span>
            <span className="gym-v">
              <span className={`gym-state is-${st.tone}`}>
                <span aria-hidden="true" className="gym-state-mark">
                  {mark(st.tone)}
                </span>
                {st.text}
              </span>
            </span>
          </div>
          {p.candidate ? (
            <div className="gym-kv">
              <span className="gym-k">Model</span>
              <span className="gym-v">{p.candidate}</span>
            </div>
          ) : null}
          {p.steps.length > 0 ? (
            <div className="gym-kv">
              <span className="gym-k">Steps</span>
              <span className="gym-v">{p.steps.map((x) => `${codeWords(x.id)}: ${codeWords(x.status)}`).join(' · ')}</span>
            </div>
          ) : null}
          {after && after.beforeMatch !== null ? (
            <div className="gym-kv">
              <span className="gym-k">Rehearsal files</span>
              <span className="gym-v">{after.beforeMatch ? 'Match what was recorded before' : 'Do NOT match what was recorded before'}</span>
            </div>
          ) : null}
          {after && after.realUntouched !== null ? (
            <div className="gym-kv">
              <span className="gym-k">Real daemon</span>
              <span className="gym-v">{after.realUntouched ? 'The gym reports it was left untouched' : 'The gym does NOT report it as untouched'}</span>
            </div>
          ) : null}
          {p.rollbackAvailable === false ? (
            <div className="gym-kv">
              <span className="gym-k">Rolling back</span>
              <span className="gym-v">Nothing to roll back</span>
            </div>
          ) : null}
        </>
      ) : null}
      {view.shown ? (
        <div className="gym-actions" data-testid="gym-actions">
          {view.candidates.length > 1 ? (
            <select className="gym-select" aria-label="Model to promote" value={candidate ?? ''} onChange={(e) => setPick(e.target.value)} data-testid="gym-candidate">
              {view.candidates.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          ) : null}
          <button className="pill" disabled={!view.promote.enabled} title={view.promote.why || undefined} onClick={() => void ask('promote')} data-testid="gym-promote">
            {GYM_CONTROL_WORDS.promoteButton}
            {view.candidates.length === 1 && candidate ? ` ${candidate}` : ''}…
          </button>
          <button className="pill" disabled={!view.rollback.enabled} title={view.rollback.why || undefined} onClick={() => void ask('rollback')} data-testid="gym-rollback">
            {GYM_CONTROL_WORDS.rollbackButton}…
          </button>
        </div>
      ) : null}
      {view.shown && !view.promote.enabled && view.promote.why !== '' ? (
        <p className="gym-action-note" data-testid="gym-promote-why">
          {view.promote.why}
        </p>
      ) : null}
      {!view.shown && owner ? (
        <p className="gym-action-note" data-testid="gym-control-setup">
          {view.setup}
        </p>
      ) : null}
      {!owner && p !== null ? (
        <p className="gym-action-note" data-testid="gym-not-owner">
          {GYM_BUTTON_COPY.notOwner}
        </p>
      ) : null}
      {waiting ? (
        <p className="gym-action-note" role="status" data-testid="gym-waiting">
          {GYM_BUTTON_COPY.waiting}
        </p>
      ) : null}
      {said ? (
        <p className="gym-action-note" role="status" data-testid="gym-said">
          {said}
        </p>
      ) : null}
      {op ? (
        <div data-testid="gym-op" role="status">
          <span className={`gym-state is-${opWords(op.op, op.action).tone}`}>
            <span aria-hidden="true" className="gym-state-mark">
              {mark(opWords(op.op, op.action).tone)}
            </span>
            {opWords(op.op, op.action).text}
          </span>
          {opFinished(op.op.status) ? opAfterFacts(op.op).map((f) => <p key={f} className="gym-action-note">{f}</p>) : null}
        </div>
      ) : null}
      {owner ? (
        <>
          <button className="gym-link" data-testid="gym-control-toggle" onClick={() => setEditing((v) => !v)}>
            {editing ? 'Done' : settings.address === '' ? 'Set up the control service…' : 'Control service…'}
          </button>
          {editing ? (
            <ControlForm
              settings={settings}
              onSaved={() => {
                setEditing(false)
                reload()
              }}
            />
          ) : null}
        </>
      ) : null}
      {p === null ? <p className="gym-action-note">{NOT}</p> : null}
    </section>
  )
}
