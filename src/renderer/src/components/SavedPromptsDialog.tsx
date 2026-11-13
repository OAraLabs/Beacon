import { useRef, useState, type CSSProperties } from 'react'
import {
  PROMPTS_MAX,
  PROMPT_TEXT_MAX,
  PROMPT_TITLE_MAX,
  addPrompt,
  removeStarter,
  restoreBuiltins,
  slugOf,
  starters,
  textProblem,
  titleProblem,
  updatePrompt,
  type Starter
} from '@shared/saved-prompts'
import { updateSavedPrompts, useSavedPrompts } from '../saved-prompts-store'
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

type Editing = { id: string | null; title: string; text: string }

export function SavedPromptsDialog({ draft, onUse, onClose }: { draft?: string; onUse: (text: string) => void; onClose: () => void }) {
  const store = useSavedPrompts()
  const list = starters(store)
  const [editing, setEditing] = useState<Editing | null>(draft !== undefined ? { id: null, title: '', text: draft } : null)
  // Opened straight on the form ("Save as a prompt"): Cancel closes the dialog, not just the form.
  const [direct, setDirect] = useState(draft !== undefined)
  const [removing, setRemoving] = useState<string | null>(null)
  const [saveFailed, setSaveFailed] = useState(false)
  const sheet = useRef<HTMLDivElement>(null)
  useDialogFocus(sheet, onClose)

  const full = store.prompts.length >= PROMPTS_MAX
  const titleErr = editing ? titleProblem(store, editing.title, editing.id ?? undefined) : null
  const textErr = editing ? textProblem(editing.text) : null
  const canSave = editing !== null && !titleErr && !textErr

  const save = (): void => {
    if (!editing || !canSave) return
    const input = { title: editing.title, text: editing.text }
    const now = Date.now()
    const id = editing.id
    const unchanged = id !== null && store.prompts.some((p) => p.id === id && p.title === input.title.trim() && p.text === input.text)
    const kept = unchanged || updateSavedPrompts((s) => (id === null ? addPrompt(s, input, crypto.randomUUID(), now) : updatePrompt(s, id, input, now)))
    if (!kept) return setSaveFailed(true)
    setSaveFailed(false)
    setDirect(false)
    setEditing(null)
  }

  const edit = (s: Starter): void => {
    setSaveFailed(false)
    setRemoving(null)
    // Changing a built-in makes a prompt of your own with its name, which then replaces it.
    setEditing({ id: s.builtin ? null : s.id, title: s.title, text: s.text })
  }

  return (
    <div style={backdrop} onClick={onClose}>
      <div ref={sheet} style={modal} onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Saved prompts">
        <h2 style={{ fontSize: 15, fontWeight: 600, color: 'var(--c-text)', margin: 0 }}>{editing ? (editing.id ? 'Change prompt' : 'New prompt') : 'Saved prompts'}</h2>

        {editing ? (
          <>
            <label style={labelStyle}>
              Name
              <input
                style={field}
                value={editing.title}
                maxLength={PROMPT_TITLE_MAX + 20}
                placeholder="Weekly review"
                onChange={(e) => setEditing({ ...editing, title: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && canSave) save()
                }}
              />
              <span style={{ color: editing.title.trim() && titleErr ? 'var(--c-err-text)' : 'var(--c-text-faint)' }}>
                {editing.title.trim() && titleErr ? titleErr : slugOf(editing.title) ? `Type /${slugOf(editing.title)} in a message box to use it.` : 'Shown on the new-chat screen.'}
              </span>
            </label>
            <label style={labelStyle}>
              Prompt
              <textarea
                style={{ ...field, minHeight: 140, resize: 'vertical', lineHeight: 1.45 }}
                value={editing.text}
                placeholder="What should it say?"
                onChange={(e) => setEditing({ ...editing, text: e.target.value })}
              />
              {editing.text.length > PROMPT_TEXT_MAX ? <span style={{ color: 'var(--c-err-text)' }}>{textErr}</span> : null}
            </label>
            {saveFailed ? (
              <div role="alert" style={{ fontSize: 12, color: 'var(--c-err-text)' }}>
                {full && editing.id === null ? `You have ${PROMPTS_MAX} prompts, which is the most Beacon keeps. Remove one first.` : 'Beacon could not save that. Close this and try again.'}
              </div>
            ) : null}
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button style={btn()} onClick={() => (direct ? onClose() : setEditing(null))}>
                Cancel
              </button>
              <button style={btn(true, !canSave)} disabled={!canSave} onClick={save}>
                Save
              </button>
            </div>
          </>
        ) : (
          <>
            <div style={{ fontSize: 12, color: 'var(--c-text-dim)', lineHeight: 1.45 }}>
              Choosing a prompt puts its text in the message box. Nothing is sent until you send it. Prompts are kept on this computer.
            </div>
            {list.length === 0 ? <div style={{ fontSize: 13, color: 'var(--c-text-dim)' }}>No prompts yet.</div> : null}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {list.map((s) => (
                <div key={s.id} style={row}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, color: 'var(--c-text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.title}</div>
                    <div style={{ fontSize: 12, color: 'var(--c-text-dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.text.trim()}</div>
                  </div>
                  {removing === s.id ? (
                    <>
                      <button
                        style={btn()}
                        onClick={() => {
                          updateSavedPrompts((st) => removeStarter(st, s.id))
                          setRemoving(null)
                        }}
                      >
                        Remove
                      </button>
                      <button style={btn()} onClick={() => setRemoving(null)}>
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
                <button style={btn(true, full)} disabled={full} title={full ? `${PROMPTS_MAX} is the most Beacon keeps` : undefined} onClick={() => setEditing({ id: null, title: '', text: '' })}>
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
