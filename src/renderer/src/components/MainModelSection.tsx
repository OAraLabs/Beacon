import { useEffect, useState, type CSSProperties } from 'react'
import { MAIN_MODEL_COPY as C, type CheckOutcome, type MainModelRead, type ModelChoice } from '@shared/main-model'
import { RESTART_COPY, RESTARTING, type RestartOutcome } from '@shared/network-setting'

// Config → Models → Main model (@shared/main-model, Prometheus PR 737): which AI the connected Prometheus thinks with, and changing it.
// The owner's only: an approved device is told no by Prometheus and there is no section. A change is SAVED and applies when
// Prometheus restarts, so a saved change offers [Restart now] (the network setting's restart: it waits until Prometheus answers
// again as the same computer). A typed key must pass its check before Save; a signed-in key is checked in main and never comes here.

const box: CSSProperties = { background: 'var(--c-base)', border: '1px solid var(--c-line)', borderRadius: 8, padding: '10px 14px', marginBottom: 14, display: 'flex', flexDirection: 'column', gap: 6 }
const head: CSSProperties = { fontSize: 13, fontWeight: 600, color: 'var(--ink)' }
const line: CSSProperties = { fontSize: 13, color: 'var(--c-text)' }
const hint: CSSProperties = { fontSize: 12, color: 'var(--c-text-dim)', lineHeight: 1.4 }
const err: CSSProperties = { ...hint, color: 'var(--c-err)' }
const btn = (disabled: boolean): CSSProperties => ({
  fontSize: 12,
  padding: '4px 12px',
  borderRadius: 6,
  border: '1px solid var(--c-line)',
  background: 'var(--c-raise)',
  color: disabled ? 'var(--c-text-faint)' : 'var(--c-text)',
  cursor: disabled ? 'not-allowed' : 'pointer',
  font: 'inherit',
  alignSelf: 'flex-start'
})
const input: CSSProperties = { maxWidth: 420, fontSize: 12, padding: '5px 8px', borderRadius: 6, border: '1px solid var(--c-line)', background: 'var(--c-inset)', color: 'var(--c-text)', outline: 'none', font: 'inherit', minWidth: 260 }
const chip = (on: boolean): CSSProperties => ({ fontSize: 10, color: on ? 'var(--online-text)' : 'var(--ink4)', marginLeft: 6 })
const fill = (s: string, vars: Record<string, string>): string => s.replace(/\{(\w+)\}/g, (m, k: string) => vars[k] ?? m)

type Busy = 'checking' | 'signing-in' | 'saving' | 'restarting' | null

export function MainModelSection() {
  const [read, setRead] = useState<MainModelRead | null>(null)
  const [editing, setEditing] = useState(false)
  const [choiceId, setChoiceId] = useState<string | null>(null)
  const [version, setVersion] = useState('')
  const [key, setKey] = useState('')
  const [verdict, setVerdict] = useState<CheckOutcome | null>(null)
  const [busy, setBusy] = useState<Busy>(null)
  const [status, setStatus] = useState<string[]>([])
  const [refusal, setRefusal] = useState<{ message: string; detail: string } | null>(null)
  const [restarted, setRestarted] = useState<Exclude<RestartOutcome['kind'], 'back'> | null>(null)
  const [copied, setCopied] = useState(false)

  const load = async (): Promise<void> => {
    try {
      setRead((await window.beacon?.mainModel.get()) ?? { kind: 'hidden' })
    } catch {
      setRead({ kind: 'unreadable', detail: 'Beacon could not ask' })
    }
  }
  useEffect(() => {
    void load()
  }, [])

  if (!read || read.kind === 'hidden') return null
  const title = (
    <div style={head} data-testid="main-model-title">
      {C.title}
    </div>
  )
  if (read.kind === 'old' || read.kind === 'unreadable')
    return (
      <div style={box} data-testid="main-model">
        {title}
        <div style={hint}>{read.kind === 'old' ? C.old : C.unreadable}</div>
        {read.kind === 'unreadable' ? (
          <button style={btn(false)} onClick={() => void load()}>
            {C.tryAgain}
          </button>
        ) : null}
      </div>
    )

  const v = read.view
  const choice: ModelChoice | null = v.choices.find((c) => c.id === choiceId) ?? null
  // A key may be saved once its check let it through (a bad key never does); with the field empty, the saved key is kept.
  const accepted = verdict?.kind === 'verdict' && verdict.verdict !== 'bad'
  const canSave = !!choice && !busy && (accepted || (key.trim() === '' && choice.keySaved))

  const begin = (): void => {
    setEditing(true)
    setChoiceId(v.saved.provider)
    setVersion('')
    setKey('')
    setVerdict(null)
    setRefusal(null)
    setStatus([])
  }
  const pick = (id: string): void => {
    setChoiceId(id)
    setVersion('')
    setKey('')
    setVerdict(null)
    setRefusal(null)
    if (busy === 'signing-in') void window.beacon?.mainModel.cancelSignIn()
  }
  const check = async (): Promise<void> => {
    const b = window.beacon
    if (!b || !choice || busy || !key.trim()) return
    setBusy('checking')
    setRefusal(null)
    try {
      setVerdict(await b.mainModel.check(choice.id, key, choice.checkable))
    } finally {
      setBusy(null)
    }
  }
  const signIn = async (): Promise<void> => {
    const b = window.beacon
    if (!b || busy) return
    setBusy('signing-in')
    setRefusal(null)
    setKey('')
    try {
      setVerdict(await b.mainModel.signIn())
    } finally {
      setBusy(null)
    }
  }
  const save = async (): Promise<void> => {
    const b = window.beacon
    if (!b || !choice || !canSave) return
    setBusy('saving')
    setRefusal(null)
    try {
      const r = await b.mainModel.save(choice.id, version, accepted)
      if (r.kind === 'refused') setRefusal({ message: r.message, detail: r.detail })
      else {
        setRead(r.read)
        setEditing(false)
        setKey('')
        setVerdict(null)
        setRestarted(null)
        setStatus([C.saved, ...r.notes])
      }
    } finally {
      setBusy(null)
    }
  }
  const restart = async (): Promise<void> => {
    const b = window.beacon
    if (!b || busy) return
    setBusy('restarting')
    setRestarted(null)
    try {
      const r = await b.network.restart()
      if (r.kind === 'back') {
        setStatus([])
        await load()
      } else setRestarted(r.kind)
    } catch {
      setRestarted('failed')
    } finally {
      setBusy(null)
    }
  }

  const offerRestart = v.restartNeeded && restarted !== 'unavailable' && busy !== 'restarting'
  return (
    <div style={box} data-testid="main-model">
      {title}
      <div style={hint}>{C.intro}</div>
      <div style={line} data-testid="main-model-now">
        {v.now}
      </div>
      {v.next ? (
        <div style={line} data-testid="main-model-next">
          {v.next}
        </div>
      ) : null}
      {v.keyLine ? <div style={hint}>{v.keyLine}</div> : null}
      {v.notes.map((n) => (
        <div key={n} style={hint}>
          {n}
        </div>
      ))}
      {status.length > 0 ? (
        <div style={hint} data-testid="main-model-status">
          {status.join(' ')}
        </div>
      ) : null}
      {busy === 'restarting' ? <div style={hint}>{RESTARTING}</div> : null}
      {offerRestart ? (
        <button style={btn(!!busy)} disabled={!!busy} onClick={() => void restart()} data-testid="main-model-restart">
          Restart now
        </button>
      ) : null}
      {restarted ? <div style={restarted === 'unavailable' ? hint : err}>{RESTART_COPY[restarted]}</div> : null}
      {!v.canChange ? <div style={hint}>{v.why}</div> : null}
      {v.canChange && !editing ? (
        <button style={btn(!!busy)} disabled={!!busy} onClick={begin} data-testid="main-model-change">
          {C.change}
        </button>
      ) : null}

      {editing ? (
        <div data-testid="main-model-editor" style={{ display: 'flex', flexDirection: 'column', gap: 8, borderTop: '1px solid var(--line3)', paddingTop: 8 }}>
          <div style={{ ...hint, fontWeight: 600 }}>{C.pick}</div>
          <div role="radiogroup" style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            {v.choices.map((c) => (
              <label key={c.id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--c-text)', cursor: busy ? 'default' : 'pointer', minHeight: 24 }}>
                <input type="radio" name="main-model-choice" checked={c.id === choiceId} disabled={!!busy && busy !== 'signing-in'} onChange={() => pick(c.id)} data-testid={`main-model-choice-${c.id}`} />
                <span>{c.label}</span>
                <span style={{ fontSize: 11, color: 'var(--ink4)', fontFamily: 'var(--font-mono)' }} data-untrusted>
                  {c.defaultVersion}
                </span>
                <span style={chip(c.keySaved)}>{c.keySaved ? C.chipKey : C.chipNoKey}</span>
              </label>
            ))}
          </div>
          {choice ? (
            <>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                <span style={hint}>{C.version}</span>
                <input style={input} value={version} placeholder={choice.defaultVersion} spellCheck={false} onChange={(e) => setVersion(e.target.value)} data-testid="main-model-version" />
                <span style={hint}>{fill(C.versionHint, { default: choice.defaultVersion })}</span>
              </label>
              {choice.signIn ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <div style={hint}>{C.signInBody}</div>
                  {busy === 'signing-in' ? (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={hint}>{C.waiting}</span>
                      <button style={btn(false)} onClick={() => void window.beacon?.mainModel.cancelSignIn()}>
                        {C.stop}
                      </button>
                    </div>
                  ) : (
                    <button style={btn(!!busy)} disabled={!!busy} onClick={() => void signIn()} data-testid="main-model-signin">
                      {C.signIn}
                    </button>
                  )}
                </div>
              ) : null}
              <label style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                <span style={hint}>{choice.signIn ? C.orPaste : fill(C.keyLabel, { company: choice.label })}</span>
                <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <input
                    type="password"
                    autoComplete="off"
                    spellCheck={false}
                    style={{ ...input, color: busy === 'signing-in' ? 'var(--c-text-faint)' : 'var(--c-text)' }}
                    value={key}
                    disabled={busy === 'signing-in'}
                    onChange={(e) => {
                      setKey(e.target.value)
                      setVerdict(null) // a changed key is checked again before it can be saved
                    }}
                    data-testid="main-model-key"
                  />
                  <button style={btn(!key.trim() || !!busy)} disabled={!key.trim() || !!busy} onClick={() => void check()} data-testid="main-model-check">
                    {busy === 'checking' ? C.checking : C.check}
                  </button>
                </span>
                {choice.keySaved ? <span style={hint}>{C.keepSaved}</span> : null}
              </label>
              {verdict ? (
                <div style={verdict.kind === 'verdict' && verdict.verdict !== 'bad' ? hint : err} data-testid="main-model-verdict">
                  {verdict.kind === 'verdict' ? verdict.line : verdict.message}
                </div>
              ) : null}
              {key.trim() && !accepted && !verdict ? <div style={hint}>{C.needsCheck}</div> : null}
              {!key.trim() && !accepted && !choice.keySaved ? <div style={hint}>{fill(C.needsKey, { company: choice.label })}</div> : null}
            </>
          ) : null}
          <div style={{ display: 'flex', gap: 8 }}>
            <button style={btn(!canSave)} disabled={!canSave} onClick={() => void save()} data-testid="main-model-save">
              {busy === 'saving' ? C.saving : C.save}
            </button>
            <button
              style={btn(busy === 'saving')}
              disabled={busy === 'saving'}
              onClick={() => {
                if (busy === 'signing-in') void window.beacon?.mainModel.cancelSignIn()
                setEditing(false)
                setRefusal(null)
              }}
            >
              {C.cancel}
            </button>
          </div>
          {refusal ? (
            <div style={{ ...err, display: 'flex', flexDirection: 'column', gap: 4 }}>
              {refusal.message}
              <button
                style={btn(false)}
                onClick={() =>
                  void navigator.clipboard
                    ?.writeText(refusal.detail)
                    .then(() => setCopied(true))
                    .catch(() => undefined)
                }
              >
                {copied ? C.copied : C.copyDetails}
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
