import { useCallback, useEffect, useRef, useState } from 'react'
import { bindBody, type SessionWorkspaceDTO, type WorkspaceWriteDTO } from '@shared/checkpoints'
import { elsewhereWords, folderChip, folderConfirm, folderDisplay, folderFailure, folderProblem, folderSetWords, type FolderWhere } from '@shared/work-folder'
import { Icon } from './Icon'

// The folder a conversation is working in, always shown in that conversation's header
// (@shared/work-folder). The chip opens a small panel: what the folder is and where, and, when
// Prometheus is on this computer, a button that opens the system's folder picker. Nothing is set
// without the confirmation that says what the assistant will be able to do there.
//
// Not rendered for an approved device (the workspace routes are the owner's; ChatShell passes
// nothing then), and it draws nothing until Prometheus has answered: an older Prometheus with no
// such route gets no chip rather than a wrong one.

type Step =
  | { kind: 'closed' }
  | { kind: 'open' }
  | { kind: 'confirm'; path: string }
  | { kind: 'working' }

export function WorkFolderChip({ sessionId, where, refreshKey }: { sessionId: string; /** The other computer's name, for "on <name>". */ where: string; /** Changes when a turn ends: the folder may have been set by a command. */ refreshKey: number }) {
  const [ws, setWs] = useState<SessionWorkspaceDTO | null | undefined>(undefined)
  const [place, setPlace] = useState<FolderWhere | null>(null)
  const [step, setStep] = useState<Step>({ kind: 'closed' })
  const [note, setNote] = useState<{ words: string; ok: boolean } | null>(null)
  const root = useRef<HTMLDivElement>(null)
  const button = useRef<HTMLButtonElement>(null)
  const path = `/api/sessions/${encodeURIComponent(sessionId)}/workspace`

  const read = useCallback(async (): Promise<void> => {
    const b = window.beacon
    if (!b) return
    try {
      setWs(((await b.daemon.get(path)) as SessionWorkspaceDTO | null) ?? null)
    } catch {
      setWs(null) // no such route, or refused: nothing can be said, so nothing is drawn
    }
  }, [path])

  useEffect(() => {
    setWs(undefined)
    setStep({ kind: 'closed' })
    setNote(null)
    void read()
  }, [read])
  useEffect(() => {
    if (refreshKey > 0) void read()
  }, [refreshKey, read])
  useEffect(() => {
    void window.beacon?.workFolder
      .where()
      .then(setPlace)
      .catch(() => undefined)
  }, [])

  // Esc and a click outside close the panel; focus goes back to the chip.
  const open = step.kind !== 'closed'
  useEffect(() => {
    if (!open) return
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
    document.addEventListener('mousedown', onDown)
    return () => {
      document.removeEventListener('keydown', onKey, true)
      document.removeEventListener('mousedown', onDown)
    }
  }, [open])

  const here = place?.here === true
  const home = place?.home ?? null
  const chip = folderChip(ws, home, here, where)
  if (chip.state === 'hidden') return null

  const choose = async (): Promise<void> => {
    const b = window.beacon
    if (!b) return
    setNote(null)
    const picked = await b.workFolder.pick().catch(() => null)
    if (!picked || picked.kind === 'cancelled') return
    if (picked.kind === 'not-here') {
      setNote({ words: elsewhereWords(where), ok: false })
      return
    }
    const problem = folderProblem(picked.path, home)
    if (problem) {
      setNote({ words: problem, ok: false })
      return
    }
    setStep({ kind: 'confirm', path: picked.path })
  }

  const set = async (chosen: string): Promise<void> => {
    const b = window.beacon
    if (!b) return
    setStep({ kind: 'working' })
    try {
      const r = (await b.daemon.write(path, bindBody(chosen), 'PUT')) as WorkspaceWriteDTO | null
      setNote(folderSetWords(chosen, r?.workspace, home))
    } catch (e) {
      setNote({ words: folderFailure(e instanceof Error ? e.message : String(e)), ok: false })
    }
    await read()
    setStep({ kind: 'open' })
  }

  const clear = async (): Promise<void> => {
    const b = window.beacon
    if (!b) return
    setStep({ kind: 'working' })
    try {
      await b.daemon.write(path, undefined, 'DELETE')
      setNote({ words: 'This conversation no longer works in that folder, from the next reply. The folder and its files are untouched.', ok: true })
    } catch (e) {
      setNote({ words: folderFailure(e instanceof Error ? e.message : String(e)), ok: false })
    }
    await read()
    setStep({ kind: 'open' })
  }

  const confirm = step.kind === 'confirm' ? folderConfirm(step.path, home) : null
  const busy = step.kind === 'working'
  return (
    <div className="work-folder" ref={root}>
      <button
        ref={button}
        className={`work-folder-chip${chip.state === 'bound' ? ' is-bound' : ''}`}
        onClick={() => {
          setNote(null)
          setStep(open ? { kind: 'closed' } : { kind: 'open' })
        }}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={chip.title}
        aria-label={chip.state === 'bound' ? `Working folder: ${chip.text}. ${chip.title}` : chip.title}
        data-testid="work-folder-chip"
      >
        <Icon name="files" size={13} />
        <span className="work-folder-name">{chip.text}</span>
      </button>
      {open ? (
        <div className="work-folder-panel" role="dialog" aria-label="Working folder">
          {confirm ? (
            <>
              <div className="work-folder-title">{confirm.title}</div>
              <div className="work-folder-text">{confirm.body}</div>
              <div className="work-folder-actions">
                <button className="work-folder-btn" onClick={() => setStep({ kind: 'open' })}>
                  Cancel
                </button>
                <button className="work-folder-btn is-primary" onClick={() => void set((step as { path: string }).path)}>
                  {confirm.action}
                </button>
              </div>
            </>
          ) : (
            <>
              <div className="work-folder-title">{chip.state === 'bound' ? 'Working folder' : 'No working folder'}</div>
              {chip.state === 'bound' && chip.path ? (
                <>
                  <div className="work-folder-path" data-testid="work-folder-path">
                    {here ? folderDisplay(chip.path, home) : chip.path}
                  </div>
                  <div className="work-folder-text">
                    {here ? 'On this computer.' : `On ${where || 'the Prometheus computer'}.`} Your assistant can read, change and delete files in this folder, in this conversation.
                  </div>
                </>
              ) : (
                <div className="work-folder-text">This conversation is not working in a folder of yours. Your assistant uses Prometheus’s own workspace.</div>
              )}
              {!here && place ? <div className="work-folder-text">{elsewhereWords(where)}</div> : null}
              {/* Always mounted, so a screen reader hears the words arrive. */}
              <div className={`work-folder-note${note && !note.ok ? ' is-bad' : ''}`} role="status">
                {busy ? 'Asking Prometheus…' : (note?.words ?? '')}
              </div>
              <div className="work-folder-actions">
                {chip.state === 'bound' ? (
                  <button className="work-folder-btn" disabled={busy} onClick={() => void clear()}>
                    Stop using this folder
                  </button>
                ) : null}
                {here ? (
                  <button className="work-folder-btn is-primary" disabled={busy} onClick={() => void choose()}>
                    {chip.state === 'bound' ? 'Choose another folder…' : 'Choose a folder…'}
                  </button>
                ) : null}
              </div>
            </>
          )}
        </div>
      ) : null}
    </div>
  )
}
