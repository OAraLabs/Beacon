import { useEffect, useRef, useState, type CSSProperties, type MouseEvent } from 'react'
import { OFFER_ARM_MS, clickIsAYes, failedWords, offerAcceptable, offerWords, type FileOffer, type TakenFile } from '@shared/os-entry'
import type { PendingFile } from '../attachments-io'
import { useDialogFocus } from './useDialogFocus'

// The confirmation screen for files handed to Beacon from outside it (@shared/os-entry): Open
// with, a drop on its icon, a path on the command line. It shows what was offered (names and
// sizes; main has read nothing) and does nothing until the person answers. Yes reads the files
// and puts them in a message box as attachments. They are not sent.
//
// SOMETHING OUTSIDE BEACON PUT THIS SCREEN UP, possibly while the person was typing somewhere
// else, and Beacon's window may have come to the front under their hands. So a yes here is only
// ever a real pointer click (@shared/os-entry clickIsAYes): the keyboard cannot reach it, whatever
// has focus (Tab and Enter, Tab and Space, a held key), and neither can a click that was already
// on its way when the screen appeared or the window came forward, because the "add" buttons are
// not armed for a moment after either. The keyboard can always say no: Esc, or Enter on "Don't
// add", which is where focus rests.

const backdrop: CSSProperties = { position: 'fixed', inset: 0, zIndex: 74, background: 'var(--c-scrim)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }
const modal: CSSProperties = {
  width: 'min(480px, 94vw)',
  maxHeight: 'calc(100vh - 32px)',
  overflowY: 'auto',
  background: 'var(--c-raise)',
  border: '1px solid var(--c-line)',
  borderRadius: 12,
  padding: 18,
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
  textAlign: 'left'
}
const btn = (primary = false, disabled = false): CSSProperties => ({
  fontSize: 13,
  padding: '7px 14px',
  borderRadius: 6,
  border: `1px solid ${primary && !disabled ? 'var(--c-arc)' : 'var(--c-line)'}`,
  background: disabled ? 'var(--c-base)' : primary ? 'var(--c-arc)' : 'var(--c-inset)',
  color: disabled ? 'var(--c-text-faint)' : primary ? 'var(--c-on-arc)' : 'var(--c-text)',
  cursor: disabled ? 'not-allowed' : 'pointer',
  font: 'inherit'
})
const row: CSSProperties = { display: 'flex', alignItems: 'baseline', gap: 10, padding: '7px 10px', border: '1px solid var(--c-line)', borderRadius: 8, background: 'var(--c-base)' }

const fmtSize = (n: number): string => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / (1024 * 1024)).toFixed(1)} MB`)

/** A file main read, as a composer attachment. */
export function stagedFromTaken(f: TakenFile): PendingFile {
  return { dataUrl: `data:${f.mimeType};base64,${f.base64}`, base64: f.base64, mimeType: f.mimeType, name: f.name, isImage: f.mimeType.startsWith('image/'), size: f.size }
}

export function OfferedFilesDialog({
  offer,
  conversation,
  onAdd,
  onFail,
  onClose
}: {
  offer: FileOffer
  /** The open conversation's name, so "add to it" can say which; null when none is open. */
  conversation: string | null
  /** The files, read, and where the person said to put them. */
  /** `left` says which of the files could not be added after all, or ''. */
  onAdd: (files: PendingFile[], where: 'new' | 'this', left: string) => void
  /** Said by the window, not this screen: once an offer is answered the next one may already be
   *  on screen in its place, and words set here would be lost with it. */
  onFail: (words: string) => void
  onClose: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [hint, setHint] = useState('')
  // When the "add" buttons start counting a click. Pushed forward whenever the window comes to
  // the front, since that is exactly when a stray click lands.
  // Kept in a ref as well as in state: the click handler must see the newest arming time even if
  // React has not drawn since the window came forward.
  const [armedAt, setArmedAtState] = useState(() => Date.now() + OFFER_ARM_MS)
  const armedRef = useRef(armedAt)
  const setArmedAt = (t: number): void => {
    armedRef.current = t
    setArmedAtState(t)
  }
  const busyRef = useRef(false)
  const [now, setNow] = useState(() => Date.now())
  const sheet = useRef<HTMLDivElement>(null)
  const words = offerWords(offer, conversation)
  const can = offerAcceptable(offer) > 0
  const armed = now >= armedAt

  useEffect(() => {
    const rearm = (): void => {
      setArmedAt(Date.now() + OFFER_ARM_MS)
      setNow(Date.now())
    }
    window.addEventListener('focus', rearm)
    return () => window.removeEventListener('focus', rearm)
  }, [])
  useEffect(() => {
    if (armed) return
    const t = setTimeout(() => setNow(Date.now()), Math.max(50, armedAt - Date.now() + 20))
    return () => clearTimeout(t)
  }, [armed, armedAt])

  const dismiss = (): void => {
    // Not while a yes is being carried out: the files are already on their way.
    if (busyRef.current) return
    window.beacon?.osEntry.dismiss(offer.id)
    onClose()
  }
  // Esc is "Don't add". useDialogFocus puts focus on the first control, which is that button.
  useDialogFocus(sheet, dismiss)

  const add = async (e: MouseEvent<HTMLButtonElement>, where: 'new' | 'this'): Promise<void> => {
    const b = window.beacon
    if (!b || busy || !can) return
    if (!clickIsAYes({ detail: e.detail, isTrusted: e.nativeEvent.isTrusted }, armedRef.current, Date.now())) {
      setHint(e.detail === 0 ? 'To add, click the button with the mouse or trackpad. A key press does not add files that came from outside Beacon.' : 'One moment. Read the list, then click again.')
      return
    }
    busyRef.current = true
    setBusy(true)
    setError('')
    setHint('')
    try {
      const r = await b.osEntry.take(offer.id)
      if (!r.ok) {
        // "Read the list, then click again" leaves this offer up; anything else means it is gone.
        if (/click again/.test(r.error)) setHint(r.error)
        else {
          onFail(r.error)
          onClose()
        }
        return
      }
      if (r.files.length === 0) {
        // The offer is answered in main (and the next may already be showing): say so where it stays.
        onFail('None of those files were added: they changed or could not be read after you were shown the list.')
        onClose()
        return
      }
      onAdd(r.files.map(stagedFromTaken), where, failedWords(r.failed))
      onClose()
    } catch {
      setError('Beacon could not read those files. Nothing was added.')
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  return (
    <div style={backdrop}>
      <div ref={sheet} style={modal} role="alertdialog" aria-modal="true" aria-label={words.title} data-testid="offered-files" data-armed={armed ? 'yes' : 'no'}>
        <h2 style={{ fontSize: 15, fontWeight: 600, color: 'var(--c-text)', margin: 0 }}>{words.title}</h2>
        <div style={{ fontSize: 12, color: 'var(--c-text-dim)', lineHeight: 1.5 }}>{words.body}</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {offer.files.map((f, i) => (
            <div key={`${f.name}:${i}`} style={row} data-testid="offered-file">
              <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
                {/* The whole name, wrapped, never cut by the row: the end of a name is where an
                    extension, or a sentence meant for the assistant, would hide. */}
                <span style={{ fontSize: 13, color: f.problem ? 'var(--c-text-dim)' : 'var(--c-text)', overflowWrap: 'anywhere' }}>{f.name}</span>
                <span style={{ fontSize: 11, color: 'var(--c-text-dim)', overflowWrap: 'anywhere' }}>
                  {f.kind} · in {f.folder}
                </span>
              </div>
              <span style={{ fontSize: 12, color: f.problem ? 'var(--c-warn-text)' : 'var(--c-text-dim)', flexShrink: f.problem ? 1 : 0, maxWidth: f.problem ? '55%' : undefined, textAlign: 'right' }}>{f.problem || fmtSize(f.size)}</span>
            </div>
          ))}
        </div>
        {words.mode ? <div style={{ fontSize: 12, color: 'var(--c-text-dim)', lineHeight: 1.5 }}>{words.mode}</div> : null}
        {words.note ? <div style={{ fontSize: 12, color: 'var(--c-text-dim)' }}>{words.note}</div> : null}
        {/* Always mounted, so a screen reader hears the words arrive. */}
        <div role="alert" style={{ fontSize: 12, color: 'var(--c-err-text)' }}>
          {error}
        </div>
        <div role="status" style={{ fontSize: 12, color: 'var(--c-text-dim)' }}>
          {hint}
        </div>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
          {/* First in the dialog, so it has focus when the screen comes up: Enter is "Don't add". */}
          <button style={btn()} onClick={dismiss}>
            {can ? 'Don’t add' : 'Close'}
          </button>
          {can && words.secondary ? (
            <button style={btn(false, busy || !armed)} disabled={busy} aria-disabled={!armed} data-add="this" onClick={(e) => void add(e, 'this')}>
              {words.secondary}
            </button>
          ) : null}
          {can ? (
            <button style={btn(true, busy || !armed)} disabled={busy} aria-disabled={!armed} data-add="new" onClick={(e) => void add(e, 'new')}>
              {words.primary}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  )
}
