import { useCallback, useEffect, useRef, useState } from 'react'
import { bindBody, type SessionWorkspaceDTO, type WorkspaceWriteDTO } from '@shared/checkpoints'
import { elsewhereWords, folderChip, folderConfirm, folderDisplay, folderFailure, folderSetWords, readFailureKind, type FolderRead, type FolderWhere } from '@shared/work-folder'
import { Icon } from './Icon'

// The folder a conversation is working in, always shown in that conversation's header
// (@shared/work-folder). The chip opens a small panel: what the folder is and where, and, when
// Prometheus is PROVED to share this computer's disk, a button that opens the system's folder
// picker. Nothing is set without the confirmation that lists what the assistant will do there.
//
// "Always shown" means: once Prometheus has said which folder it is, the chip does not go away
// because a later check failed. It then says it could not check, and what it last knew. It is
// read again when the connection comes back, when the window is returned to, when a turn ends,
// and when the Checkpoints panel changes the folder (WORKSPACE_CHANGED, both ways).
//
// Not rendered for an approved device, or before main has said which this is (ChatShell gates
// it): the workspace routes are the owner's, and nothing is asked that would be refused.

/** Sent on `window` by whoever changes a conversation's folder, with its session id. */
export const WORKSPACE_CHANGED = 'beacon:workspace-changed'
export function announceWorkspaceChanged(sessionId: string): void {
  window.dispatchEvent(new CustomEvent(WORKSPACE_CHANGED, { detail: sessionId }))
}

type Step =
  | { kind: 'closed' }
  | { kind: 'open' }
  | { kind: 'picking' } // the system picker is up: nothing else can be started
  | { kind: 'confirm'; path: string }
  | { kind: 'working' }

export function WorkFolderChip({ sessionId, where, refreshKey }: { sessionId: string; /** The other computer's name, for "on <name>"; '' when it has none. */ where: string; /** Changes when a turn ends: the folder may have been set by a command. */ refreshKey: number }) {
  const [read, setRead] = useState<FolderRead>({ kind: 'asking' })
  const [place, setPlace] = useState<FolderWhere | null>(null)
  const [step, setStep] = useState<Step>({ kind: 'closed' })
  const [note, setNote] = useState<{ words: string; ok: boolean } | null>(null)
  const root = useRef<HTMLDivElement>(null)
  const button = useRef<HTMLButtonElement>(null)
  const cancel = useRef<HTMLButtonElement>(null)
  const route = `/api/sessions/${encodeURIComponent(sessionId)}/workspace`
  // Only the newest read counts: an older answer that lands late must not replace a newer one.
  const seq = useRef(0)
  const known = useRef<SessionWorkspaceDTO | null>(null)

  const reread = useCallback(async (): Promise<void> => {
    const b = window.beacon
    if (!b) return
    const mine = ++seq.current
    try {
      const ws = ((await b.daemon.get(route)) as SessionWorkspaceDTO | null) ?? null
      if (mine !== seq.current) return
      if (!ws) return setRead({ kind: 'absent' })
      known.current = ws
      setRead({ kind: 'ok', ws })
    } catch (e) {
      if (mine !== seq.current) return
      const kind = readFailureKind(e instanceof Error ? e.message : String(e))
      setRead(kind === 'absent' ? { kind: 'absent' } : { kind: 'failed', last: known.current })
    }
  }, [route])

  useEffect(() => {
    known.current = null
    setRead({ kind: 'asking' })
    setStep({ kind: 'closed' })
    setNote(null)
    void reread()
  }, [reread])
  useEffect(() => {
    if (refreshKey > 0) void reread()
  }, [refreshKey, reread])
  useEffect(() => {
    const b = window.beacon
    const onChanged = (e: Event): void => {
      if ((e as CustomEvent<string>).detail === sessionId) void reread()
    }
    const onFocus = (): void => void reread()
    window.addEventListener(WORKSPACE_CHANGED, onChanged)
    window.addEventListener('focus', onFocus)
    // Back in touch with Prometheus: what could not be checked a moment ago can be now.
    const off = b?.connection.onStatus((s) => {
      if (s.state === 'connected') void reread()
    })
    return () => {
      window.removeEventListener(WORKSPACE_CHANGED, onChanged)
      window.removeEventListener('focus', onFocus)
      off?.()
    }
  }, [sessionId, reread])

  // Where Prometheus is: asked when the chip mounts, and again each time the panel opens (the
  // connection may have been pointed somewhere else since).
  const askWhere = useCallback((): void => {
    void window.beacon?.workFolder
      .where()
      .then(setPlace)
      .catch(() => undefined)
  }, [])
  useEffect(askWhere, [askWhere])

  // Esc and a click outside close the panel; focus goes back to the chip. Not while the system
  // picker is up or a write is on its way: there is nothing to cancel by closing then.
  const open = step.kind !== 'closed'
  const closable = step.kind === 'open' || step.kind === 'confirm'
  useEffect(() => {
    if (!closable) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      setStep({ kind: 'closed' })
      button.current?.focus()
    }
    const onDown = (e: MouseEvent): void => {
      if (root.current && !root.current.contains(e.target as Node)) setStep({ kind: 'closed' })
    }
    document.addEventListener('keydown', onKey, true)
    document.addEventListener('mousedown', onDown, true)
    return () => {
      document.removeEventListener('keydown', onKey, true)
      document.removeEventListener('mousedown', onDown, true)
    }
  }, [closable])
  // The question takes the keyboard when it comes up, on Cancel: the system picker has just
  // closed and left focus nowhere, and the safe answer is the one under Enter.
  const confirming = step.kind === 'confirm'
  useEffect(() => {
    if (confirming) cancel.current?.focus()
  }, [confirming])

  const here = place?.here === true
  const home = place?.home ?? null
  const chip = folderChip(read, home, here, where)
  if (chip.state === 'hidden') return null

  const choose = async (): Promise<void> => {
    const b = window.beacon
    if (!b || step.kind !== 'open') return
    setNote(null)
    setStep({ kind: 'picking' })
    const picked = await b.workFolder.pick().catch(() => null)
    if (!picked || picked.kind === 'cancelled') return setStep({ kind: 'open' })
    if (picked.kind === 'not-here') {
      askWhere()
      setNote({ words: elsewhereWords(where, 'unknown'), ok: false })
      return setStep({ kind: 'open' })
    }
    if (picked.kind === 'refused') {
      setNote({ words: picked.words, ok: false })
      return setStep({ kind: 'open' })
    }
    // `picked.path` is the real path, already through the refusals in main. It is the path the
    // question names, and the only one this panel can set.
    setStep({ kind: 'confirm', path: picked.path })
  }

  const set = async (confirmed: string): Promise<void> => {
    const b = window.beacon
    if (!b) return
    setStep({ kind: 'working' })
    try {
      const r = (await b.daemon.write(route, bindBody(confirmed), 'PUT')) as WorkspaceWriteDTO | null
      const outcome = folderSetWords(confirmed, r?.workspace, home)
      // Prometheus named a different folder than the one agreed to: take it back at once.
      if (outcome.mismatch) await b.daemon.write(route, undefined, 'DELETE').catch(() => undefined)
      setNote({ words: outcome.words, ok: outcome.ok })
    } catch (e) {
      setNote({ words: folderFailure(e instanceof Error ? e.message : String(e)), ok: false })
    }
    announceWorkspaceChanged(sessionId)
    await reread()
    setStep({ kind: 'open' })
  }

  const clear = async (): Promise<void> => {
    const b = window.beacon
    if (!b || step.kind !== 'open') return
    setStep({ kind: 'working' })
    try {
      await b.daemon.write(route, undefined, 'DELETE')
      setNote({ words: 'This conversation no longer works in that folder, from the next reply. The folder and its files are untouched.', ok: true })
    } catch (e) {
      setNote({ words: folderFailure(e instanceof Error ? e.message : String(e)), ok: false })
    }
    announceWorkspaceChanged(sessionId)
    await reread()
    setStep({ kind: 'open' })
  }

  const confirm = step.kind === 'confirm' ? folderConfirm(step.path, home) : null
  const busy = step.kind === 'working' || step.kind === 'picking'
  const status = step.kind === 'working' ? 'Asking Prometheus…' : step.kind === 'picking' ? 'Choose a folder in the window that opened.' : (note?.words ?? '')
  return (
    <div className="work-folder" ref={root}>
      <button
        ref={button}
        className={`work-folder-chip is-${chip.state}`}
        onClick={() => {
          if (busy) return
          setNote(null)
          if (!open) askWhere()
          setStep(open ? { kind: 'closed' } : { kind: 'open' })
        }}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={chip.title}
        aria-label={chip.state === 'bound' ? `Working folder: ${chip.text}. ${chip.title}` : chip.title}
        data-testid="work-folder-chip"
        data-state={chip.state}
      >
        <Icon name="files" size={13} />
        <span className="work-folder-name">{chip.text}</span>
      </button>
      {open ? (
        <div className="work-folder-panel" role="dialog" aria-label={confirm ? confirm.title : 'Working folder'}>
          {confirm ? (
            <>
              <div className="work-folder-title">{confirm.title}</div>
              <div className="work-folder-path" data-testid="work-folder-confirm-path">
                {(step as { path: string }).path}
              </div>
              <div className="work-folder-text">{confirm.body}</div>
              <ul className="work-folder-does">
                {confirm.does.map((d) => (
                  <li key={d}>{d}</li>
                ))}
              </ul>
              <div className="work-folder-text">{confirm.after}</div>
              <div className="work-folder-actions">
                <button ref={cancel} className="work-folder-btn" onClick={() => setStep({ kind: 'open' })}>
                  Cancel
                </button>
                <button className="work-folder-btn is-primary" data-testid="work-folder-use" onClick={() => void set((step as { path: string }).path)}>
                  {confirm.action}
                </button>
              </div>
            </>
          ) : (
            <>
              <div className="work-folder-title">{chip.state === 'bound' ? 'Working folder' : chip.state === 'unknown' ? 'Working folder: could not check' : 'No working folder'}</div>
              {chip.path ? (
                <div className="work-folder-path" data-testid="work-folder-path">
                  {here ? folderDisplay(chip.path, home) : chip.path}
                </div>
              ) : null}
              {chip.state === 'unknown' ? (
                <div className="work-folder-text">{chip.title} Beacon will check again when it can reach Prometheus.</div>
              ) : chip.state === 'bound' ? (
                <div className="work-folder-text">
                  {here ? 'On this computer.' : `On ${where || 'the Prometheus computer'}.`} In this conversation your assistant changes files in this folder without asking each time, runs commands there, and follows instruction files it finds there.
                </div>
              ) : (
                <div className="work-folder-text">This conversation is not working in a folder of yours. Your assistant uses Prometheus’s own workspace.</div>
              )}
              {!here && place ? <div className="work-folder-text">{elsewhereWords(where, place.verdict)}</div> : null}
              <div className="work-folder-actions">
                {chip.state === 'bound' ? (
                  <button className="work-folder-btn" disabled={busy} onClick={() => void clear()}>
                    Stop using this folder
                  </button>
                ) : null}
                {here && chip.state !== 'unknown' ? (
                  <button className="work-folder-btn is-primary" disabled={busy} onClick={() => void choose()}>
                    {chip.state === 'bound' ? 'Choose another folder…' : 'Choose a folder…'}
                  </button>
                ) : null}
              </div>
            </>
          )}
          {/* Mounted in every state of the panel, so a screen reader hears the words arrive. */}
          <div className={`work-folder-note${note && !note.ok && !busy ? ' is-bad' : ''}`} role="status">
            {status}
          </div>
        </div>
      ) : null}
    </div>
  )
}
