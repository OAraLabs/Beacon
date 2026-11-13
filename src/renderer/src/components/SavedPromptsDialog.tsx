import { useEffect, useRef, useState, type CSSProperties } from 'react'
import {
  PROMPTS_MAX,
  PROMPT_TEXT_MAX,
  PROMPT_TITLE_MAX,
  addPrompt,
  removeStarter,
  restoreBuiltins,
  slashNameFor,
  starters,
  textProblem,
  titleProblem,
  updatePrompt,
  type Starter
} from '@shared/saved-prompts'
import { updateSavedPrompts, useSavedPrompts, useSavedPromptsStatus } from '../saved-prompts-store'
import { useDialogFocus } from './useDialogFocus'

// Saved prompts: the list, and the form that adds or changes one. Opened from the Chat home and
// from the command palette. `draft` opens straight on a new prompt holding that text ("Save as a
// prompt" from a message box).

const backdrop: CSSProperties = { position: 'fixed', inset: 0, zIndex: 72, background: 'var(--c-scrim)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }
const modal: CSSProperties = {
  width: 'min(520px, 94vw)',
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
const field: CSSProperties = {
  fontSize: 13,
  padding: '8px 10px',
  borderRadius: 6,
  border: '1px solid var(--c-line)',
  background: 'var(--c-base)',
  color: 'var(--c-text)',
  outline: 'none',
  font: 'inherit',
  width: '100%',
  boxSizing: 'border-box'
}
const labelStyle: CSSProperties = { fontSize: 12, color: 'var(--c-text-dim)', display: 'flex', flexDirection: 'column', gap: 5 }
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
const linkBtn: CSSProperties = { background: 'transparent', border: 'none', padding: 0, color: 'var(--c-text-dim)', cursor: 'pointer', font: 'inherit', fontSize: 12, textDecoration: 'underline' }
const row: CSSProperties = { display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', border: '1px solid var(--c-line)', borderRadius: 8, background: 'var(--c-base)' }

type Editing = { id: string | null; title: string; text: string; from: { title: string; text: string } }

export function SavedPromptsDialog({ draft, onUse, onClose }: { draft?: string; onUse: (text: string) => void; onClose: () => void }) {
  const store = useSavedPrompts()
  const { loaded, saveFailed } = useSavedPromptsStatus()
  const list = starters(store)
  const [editing, setEditing] = useState<Editing | null>(draft !== undefined ? { id: null, title: '', text: draft, from: { title: '', text: draft } } : null)
  // Opened straight on the form ("Save as a prompt"): Cancel closes the dialog, not just the form.
  const [direct, setDirect] = useState(draft !== undefined)
  const [removing, setRemoving] = useState<string | null>(null)
  const [refused, setRefused] = useState(false)
  const [discarding, setDiscarding] = useState(false)
  const sheet = useRef<HTMLDivElement>(null)
  const heading = useRef<HTMLHeadingElement>(null)
  const nameInput = useRef<HTMLInputElement>(null)

  const dirty = editing !== null && (editing.title !== editing.from.title || editing.text !== editing.from.text)
  const leaveForm = (): void => {
    setDiscarding(false)
    setRefused(false)
    if (direct) onClose()
    else setEditing(null)
  }
  // Esc: out of the form first (asking before it throws typed text away), then out of the dialog.
  const onEsc = (): void => {
    if (!editing) return onClose()
    if (dirty && !discarding) return setDiscarding(true)
    leaveForm()
  }

  // useDialogFocus traps Tab, handles Esc and remembers where focus was. It also focuses the
  // dialog's first control, which in the list is a row's Use button; the effect after it moves
  // focus on in the same commit, so focus never RESTS on a button that acts: the list opens on
  // its heading (an Enter still held from the palette then presses nothing), the form on Name.
  useDialogFocus(sheet, onEsc)
  const mode = editing ? 'form' : 'list'
  useEffect(() => {
    ;(mode === 'form' ? nameInput.current : heading.current)?.focus()
  }, [mode])

  const full = store.prompts.length >= PROMPTS_MAX
  const titleErr = editing ? titleProblem(store, editing.title, editing.id ?? undefined) : null
  const textErr = editing ? textProblem(editing.text) : null
  const canSave = editing !== null && !titleErr && !textErr && loaded
  const slash = editing ? slashNameFor(store, editing.title, editing.id ?? undefined) : null
  const nameHint = !editing
    ? ''
    : !slash || slash.why === 'none'
      ? 'Shown on the new-chat screen and in the command palette.'
      : slash.why === 'command'
        ? `/${slash.name} is a command, so this prompt has no / name. It is still on the new-chat screen and in the command palette.`
        : slash.why === 'taken'
          ? `Another prompt already uses /${slash.name}, so this one has no / name. It is still on the new-chat screen and in the command palette.`
          : `In a conversation, type /${slash.name} in the message box to use it.`

  const save = (): void => {
    if (!editing || !canSave) return
    const input = { title: editing.title, text: editing.text }
    const now = Date.now()
    const id = editing.id
    const unchanged = id !== null && store.prompts.some((p) => p.id === id && p.title === input.title.trim() && p.text === input.text)
    const kept = unchanged || updateSavedPrompts((s) => (id === null ? addPrompt(s, input, crypto.randomUUID(), now) : updatePrompt(s, id, input, now)))
    if (!kept) return setRefused(true)
    setRefused(false)
    setDiscarding(false)
    setDirect(false)
    setEditing(null)
  }

  const edit = (s: Starter): void => {
    setRefused(false)
    setRemoving(null)
    // Changing a built-in makes a prompt of your own with its title, which then replaces it.
    setEditing({ id: s.builtin ? null : s.id, title: s.title, text: s.text, from: { title: s.title, text: s.text } })
  }

  return (
    <div
      style={backdrop}
      onMouseDown={(e) => {
        // Only a press that STARTS on the backdrop, and never while the form is open: dragging a
        // selection out of the text box, or a stray click, must not throw the text away.
        if (e.target === e.currentTarget && !editing) onClose()
      }}
    >
      <div ref={sheet} style={modal} role="dialog" aria-modal="true" aria-label="Saved prompts">
        <h2 ref={heading} tabIndex={-1} style={{ fontSize: 15, fontWeight: 600, color: 'var(--c-text)', margin: 0, outline: 'none' }}>
          {editing ? (editing.id ? 'Change prompt' : editing.from.title ? 'Your version of this starter' : 'New prompt') : 'Saved prompts'}
        </h2>

        {saveFailed ? (
          <div role="alert" style={{ fontSize: 12, color: 'var(--c-err-text)' }}>
            Beacon could not keep your last change, so it has been undone. Try it again.
          </div>
        ) : null}

        {editing ? (
          <>
            <label style={labelStyle}>
              Name
              <input
                ref={nameInput}
                style={field}
                value={editing.title}
                maxLength={PROMPT_TITLE_MAX + 20}
                placeholder="Weekly review"
                aria-invalid={!!(editing.title.trim() && titleErr)}
                aria-describedby="saved-prompt-name-hint"
                onChange={(e) => setEditing({ ...editing, title: e.target.value })}
                onKeyDown={(e) => {
                  // Not while an input method is composing, and not a key still held from elsewhere.
                  if (e.key === 'Enter' && !e.nativeEvent.isComposing && !e.repeat && canSave) save()
                }}
              />
            </label>
            <div id="saved-prompt-name-hint" style={{ fontSize: 12, marginTop: -6, color: editing.title.trim() && titleErr ? 'var(--c-err-text)' : 'var(--c-text-faint)' }}>
              {editing.title.trim() && titleErr ? titleErr : nameHint}
            </div>
            <label style={labelStyle}>
              Prompt
              <textarea
                style={{ ...field, minHeight: 140, resize: 'vertical', lineHeight: 1.45 }}
                value={editing.text}
                placeholder="What should it say?"
                aria-invalid={editing.text.length > PROMPT_TEXT_MAX}
                onChange={(e) => setEditing({ ...editing, text: e.target.value })}
              />
            </label>
            {editing.text.length > PROMPT_TEXT_MAX ? <div style={{ fontSize: 12, marginTop: -6, color: 'var(--c-err-text)' }}>{textErr}</div> : null}
            {refused ? (
              <div role="alert" style={{ fontSize: 12, color: 'var(--c-err-text)' }}>
                {full && editing.id === null
                  ? `You have ${PROMPTS_MAX} prompts, which is the most Beacon keeps. Remove one first; what you typed stays here.`
                  : 'Beacon could not save that just now. What you typed is still here: try Save again.'}
              </div>
            ) : null}
            {discarding ? (
              <div role="alertdialog" aria-label="Discard what you typed?" style={{ display: 'flex', gap: 8, alignItems: 'center', justifyContent: 'flex-end', fontSize: 12, color: 'var(--c-text-dim)' }}>
                <span>Discard what you typed?</span>
                <button style={btn()} onClick={leaveForm}>
                  Discard
                </button>
                <button style={btn(true)} onClick={() => setDiscarding(false)}>
                  Keep editing
                </button>
              </div>
            ) : (
              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                <button style={btn()} onClick={() => (dirty ? setDiscarding(true) : leaveForm())}>
                  Cancel
                </button>
                <button style={btn(true, !canSave)} disabled={!canSave} onClick={save}>
                  Save
                </button>
              </div>
            )}
          </>
        ) : (
          <>
            <div style={{ fontSize: 12, color: 'var(--c-text-dim)', lineHeight: 1.45 }}>
              Choosing a prompt puts its text in the message box. Nothing is sent until you send it. Prompts are kept on this computer.
            </div>
            {loaded && list.length === 0 ? <div style={{ fontSize: 13, color: 'var(--c-text-dim)' }}>No prompts yet.</div> : null}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {list.map((s) => (
                <div key={s.id} style={row}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, color: 'var(--c-text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.title}</div>
                    <div style={{ fontSize: 12, color: 'var(--c-text-dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.text.trim().slice(0, 200)}</div>
                  </div>
                  {removing === s.id ? (
                    <>
                      <button
                        style={btn()}
                        onClick={() => {
                          updateSavedPrompts((st) => removeStarter(st, s.id))
                          setRemoving(null)
                          heading.current?.focus()
                        }}
                      >
                        Remove
                      </button>
                      <button
                        style={btn()}
                        autoFocus
                        onClick={() => {
                          setRemoving(null)
                          heading.current?.focus()
                        }}
                      >
                        Keep
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        style={btn()}
                        onClick={() => {
                          onUse(s.text)
                          onClose()
                        }}
                      >
                        Use
                      </button>
                      <button style={linkBtn} onClick={() => edit(s)} aria-label={`Change ${s.title}`}>
                        Change
                      </button>
                      <button style={linkBtn} onClick={() => setRemoving(s.id)} aria-label={`Remove ${s.title}`}>
                        Remove
                      </button>
                    </>
                  )}
                </div>
              ))}
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', justifyContent: 'space-between' }}>
              {store.hiddenBuiltins.length > 0 ? (
                <button style={linkBtn} onClick={() => updateSavedPrompts(restoreBuiltins)}>
                  Bring back the starters you removed
                </button>
              ) : (
                <span />
              )}
              <div style={{ display: 'flex', gap: 8 }}>
                <button style={btn()} onClick={onClose}>
                  Done
                </button>
                <button
                  style={btn(true, full || !loaded)}
                  disabled={full || !loaded}
                  title={full ? `${PROMPTS_MAX} is the most Beacon keeps` : undefined}
                  onClick={() => setEditing({ id: null, title: '', text: '', from: { title: '', text: '' } })}
                >
                  New prompt
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
