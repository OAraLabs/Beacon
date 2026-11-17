import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'
import type { ChatProjectError } from '@shared/chat-projects'
import type { ContentOp, ContentResult, Instructions, ProjectFile } from '@shared/chat-projects-content'
import { describeFile, effectiveNote } from '@shared/chat-projects-content-view'
import { useDialogFocus } from './useDialogFocus'

// A project's instructions and reference files, on the Prometheus that keeps the project. They live on its computer, in the project's
// folder: this shows them and changes them there, and keeps no copy. A save carries the revision it was made from, so an edit made
// somewhere else in the meantime is shown to the person, never written over. Nothing here names a path on THIS computer: the files
// to add and the place to save one are chosen in the system's own panels, which main opens.

const backdrop: CSSProperties = { position: 'fixed', inset: 0, zIndex: 72, background: 'var(--c-scrim)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }
const modal: CSSProperties = { width: 'min(640px, 96vw)', maxHeight: '92vh', overflow: 'auto', background: 'var(--c-raise)', border: '1px solid var(--c-line)', borderRadius: 12, padding: 18, display: 'flex', flexDirection: 'column', gap: 14 }
// A button that is off looks off (the disabled-affordance lint: a bare style object cannot carry that, a call can).
const btn = (disabled = false): CSSProperties => ({
  fontSize: 13,
  padding: '7px 12px',
  borderRadius: 6,
  border: '1px solid var(--c-line)',
  background: disabled ? 'var(--c-base)' : 'var(--c-inset)',
  color: disabled ? 'var(--c-text-faint)' : 'var(--c-text)',
  cursor: disabled ? 'not-allowed' : 'pointer',
  font: 'inherit'
})
const small = (disabled = false): CSSProperties => ({ ...btn(disabled), fontSize: 12, padding: '4px 9px' })
const muted: CSSProperties = { fontSize: 12, color: 'var(--c-text-dim)', lineHeight: 1.45 }
const heading: CSSProperties = { fontSize: 13, fontWeight: 600, color: 'var(--c-text)' }
const notice: CSSProperties = { fontSize: 12.5, lineHeight: 1.5, padding: '9px 11px', borderRadius: 8, border: '1px solid var(--c-line)', background: 'var(--c-inset)', color: 'var(--c-text)', display: 'flex', flexDirection: 'column', gap: 8 }

const content = (op: ContentOp): Promise<ContentResult> => window.beacon.chatProjects.content(op)
const failure = (r: ContentResult): r is ChatProjectError => !r.ok

/** What stands between a save and the Prometheus: its own question, answered by the person. */
type Ask =
  /** `shadowOk`: the person had already said to go on past another instructions file, so a save over theirs says so too. */
  | { kind: 'conflict'; theirs: { content: string; rev: string }; shadowOk: boolean }
  /** `baseRev`: the revision the refused save was made from, so "Save anyway" is the same save and not an older one. */
  | { kind: 'shadow'; files: string[]; baseRev: string }
  | { kind: 'discard' }

export function ProjectSettings({ projectId, name, folder, listRev, onClose }: { projectId: string; name: string; folder: string; listRev: number | null; onClose: () => void }) {
  const sheet = useRef<HTMLDivElement>(null)
  const [instr, setInstr] = useState<Instructions | null>(null)
  const [draft, setDraft] = useState('')
  const [files, setFiles] = useState<ProjectFile[] | null>(null)
  /** Why the instructions could not be read, and why they could not be saved: a read that works must not wipe the second. */
  const [problem, setProblem] = useState<string | null>(null)
  const [saveProblem, setSaveProblem] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<string | null>(null)
  const loadSeq = useRef(0)
  const [fileProblem, setFileProblem] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [busy, setBusy] = useState(false)
  const [ask, setAsk] = useState<Ask | null>(null)
  const [saved, setSaved] = useState(false)
  const [changedElsewhere, setChangedElsewhere] = useState(false)
  const [report, setReport] = useState<string[]>([])
  const draftRef = useRef(draft)
  draftRef.current = draft
  const instrRef = useRef(instr)
  instrRef.current = instr
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  const dirty = instr !== null && draft !== instr.content
  const requestClose = (): void => {
    // Escape or a click outside while the question about unsaved text is up is not an answer to it: it puts the question away. Only the
    // button that says so throws the text away.
    if (ask?.kind === 'discard') setAsk(null)
    else if (dirty) setAsk({ kind: 'discard' })
    else onClose()
  }
  useDialogFocus(sheet, requestClose)

  /** Read both again. A draft the person has changed is kept: what changed on the Prometheus is told, and the save will ask. */
  const load = useCallback(async (): Promise<void> => {
    // Only the latest read counts: one that was asked before a save, and lands after it, would put the old text back.
    const mine = ++loadSeq.current
    const [i, f] = await Promise.all([content({ op: 'instructions', id: projectId }), content({ op: 'files', id: projectId })])
    if (!alive.current || mine !== loadSeq.current) return
    if (failure(i)) setProblem(i.message)
    else if (i.instructions) {
      setProblem(null)
      const was = instrRef.current
      const edited = was !== null && draftRef.current !== was.content
      if (edited && i.instructions.rev !== was.rev) setChangedElsewhere(true)
      if (!edited) {
        setDraft(i.instructions.content)
        setChangedElsewhere(false)
      }
      // The revision a save is made from stays the one the draft was made from while it is being edited, so a change elsewhere is a conflict.
      setInstr(edited && was ? { ...i.instructions, content: was.content, rev: was.rev } : i.instructions)
    }
    if (failure(f)) setFileProblem(f.message)
    else if (f.files) {
      setFileProblem(null)
      setFiles(f.files)
    }
  }, [projectId])
  useEffect(() => {
    void load()
  }, [load, listRev])

  const save = async (o: { baseRev?: string; shadowOk?: boolean } = {}): Promise<void> => {
    if (!instr || saving) return
    setSaving(true)
    setAsk(null)
    setSaved(false)
    setSaveProblem(null)
    const base = o.baseRev ?? instr.rev
    const r = await content({ op: 'save-instructions', id: projectId, content: draft, baseRev: base, ...(o.shadowOk ? { shadowOk: true } : {}) })
    if (!alive.current) return
    setSaving(false)
    if (!failure(r)) {
      loadSeq.current++ // a read that was out before this save is about the text before it
      setChangedElsewhere(false)
      setInstr({ ...instr, content: draft, rev: r.rev ?? instr.rev })
      setSaved(true)
      void load()
      return
    }
    if (r.kind === 'conflict' && r.current) setAsk({ kind: 'conflict', theirs: r.current, shadowOk: o.shadowOk === true })
    else if (r.kind === 'would_shadow') setAsk({ kind: 'shadow', files: r.shadowed ?? [], baseRev: base })
    else setSaveProblem(r.message)
  }

  /** `inPlaceOf`: choose one file to put in the place of that reference file (under its name). */
  const add = async (inPlaceOf?: string): Promise<void> => {
    setBusy(true)
    setReport([])
    setFileProblem(null)
    const r = await content({ op: 'upload', id: projectId, ...(inPlaceOf !== undefined ? { replace: true, name: inPlaceOf } : {}) })
    if (!alive.current) return
    setBusy(false)
    if (failure(r)) {
      setFileProblem(r.message)
      return
    }
    const lines: string[] = []
    if (r.existing?.length) lines.push(`${r.existing.join(', ')} ${r.existing.length === 1 ? 'is' : 'are'} already there, so ${r.existing.length === 1 ? 'it was' : 'they were'} left as ${r.existing.length === 1 ? 'it is' : 'they are'}. Use Replace on a file's row to put a new one in its place.`)
    for (const f of r.failed ?? []) lines.push(`${f.name}: ${f.message}`)
    setReport(lines)
    void load()
  }
  const saveAs = async (fileName: string): Promise<void> => {
    setBusy(true)
    setFileProblem(null)
    const r = await content({ op: 'download', id: projectId, name: fileName })
    if (!alive.current) return
    setBusy(false)
    if (failure(r)) setFileProblem(r.message)
  }
  const remove = async (fileName: string): Promise<void> => {
    setDeleting(null)
    setBusy(true)
    const r = await content({ op: 'delete-file', id: projectId, name: fileName })
    if (!alive.current) return
    setBusy(false)
    if (failure(r) && r.kind !== 'unknown_file') setFileProblem(r.message)
    void load()
  }

  // The Prometheus counts characters, not UTF-16 units: an emoji is one.
  const length = [...draft].length
  const over = instr !== null && length > instr.maxChars
  const effective = instr?.effective ?? []

  return (
    <div style={backdrop} onClick={requestClose}>
      <div ref={sheet} style={modal} onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label={`Instructions and files for ${name}`} data-testid="project-settings">
        <div>
          <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--c-text)' }}>{name}</div>
          <div style={muted} title={folder}>
            Kept on Prometheus's computer, in {folder}
          </div>
        </div>

        <section style={{ display: 'flex', flexDirection: 'column', gap: 8 }} aria-label="Instructions">
          <div style={heading}>Instructions</div>
          <div style={muted}>Every conversation in this project reads these first. They are saved in the project's folder as PROMETHEUS.md.</div>
          {instr === null && !problem ? <div style={muted}>Reading…</div> : null}
          {problem ? (
            <div style={notice} role="alert" data-testid="project-settings-problem">
              {problem}
              <div>
                <button style={small()} onClick={() => void load()}>
                  Try again
                </button>
              </div>
            </div>
          ) : null}
          {instr !== null ? (
            <>
              <textarea
                value={draft}
                onChange={(e) => {
                  setDraft(e.target.value)
                  setSaved(false)
                }}
                rows={9}
                spellCheck={false}
                aria-label="Instructions"
                data-testid="project-instructions"
                placeholder="How this project's conversations should go: what it is for, what to do, what to avoid."
                style={{ width: '100%', boxSizing: 'border-box', resize: 'vertical', font: '13px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace', padding: 10, borderRadius: 8, border: `1px solid ${over ? 'var(--c-err)' : 'var(--c-line)'}`, background: 'var(--c-inset)', color: 'var(--c-text)' }}
              />
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <span style={{ ...muted, color: over ? 'var(--c-err)' : undefined }} data-testid="project-instructions-count">
                  {length.toLocaleString()} of {instr.maxChars.toLocaleString()} characters{over ? ': too long for Prometheus to read from one file' : ''}
                </span>
                <span style={{ flex: 1 }} />
                {saved && !dirty ? (
                  <span style={muted} role="status" data-testid="project-instructions-saved">
                    Saved
                  </span>
                ) : null}
                <button style={btn(!dirty || saving || over)} disabled={!dirty || saving || over} onClick={() => void save()} data-testid="project-instructions-save">
                  {saving ? 'Saving…' : 'Save'}
                </button>
              </div>
              {saveProblem ? (
                <div style={notice} role="alert" data-testid="project-instructions-problem">
                  {saveProblem}
                </div>
              ) : null}
              {changedElsewhere && !ask ? (
                <div style={notice} data-testid="project-instructions-changed">
                  These instructions changed on Prometheus while you were editing. Saving will show you both and ask which to keep.
                </div>
              ) : null}
              {ask?.kind === 'conflict' ? (
                <div style={notice} role="alertdialog" aria-label="The instructions changed" data-testid="project-instructions-conflict">
                  <div>
                    <strong>These instructions changed on Prometheus since you opened them.</strong> Nothing was saved. This is what is there now:
                  </div>
                  <pre style={{ margin: 0, maxHeight: 140, overflow: 'auto', whiteSpace: 'pre-wrap', font: '12px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace' }} data-testid="project-instructions-theirs">
                    {ask.theirs.content || '(empty)'}
                  </pre>
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    <button
                      style={small()}
                      data-testid="project-instructions-use-theirs"
                      onClick={() => {
                        const t = ask.theirs
                        setDraft(t.content)
                        if (instr) setInstr({ ...instr, content: t.content, rev: t.rev })
                        setChangedElsewhere(false)
                        setAsk(null)
                      }}
                    >
                      Use what is there (drop mine)
                    </button>
                    <button style={small()} data-testid="project-instructions-keep-mine" onClick={() => void save({ baseRev: ask.theirs.rev, shadowOk: ask.shadowOk })}>
                      Keep mine and save over it
                    </button>
                    <button style={small()} onClick={() => setAsk(null)}>
                      Cancel
                    </button>
                  </div>
                </div>
              ) : null}
              {ask?.kind === 'shadow' ? (
                <div style={notice} role="alertdialog" aria-label="Another instructions file is there" data-testid="project-instructions-shadow">
                  <div>
                    <strong>Prometheus already reads {ask.files.length ? ask.files.join(', ') : 'another instructions file'} in that folder.</strong> Saving these as PROMETHEUS.md would stop it reading {ask.files.length === 1 ? 'that file' : 'those files'}. Nothing was saved.
                  </div>
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    <button style={small()} data-testid="project-instructions-save-anyway" onClick={() => void save({ baseRev: ask.baseRev, shadowOk: true })}>
                      Save anyway
                    </button>
                    <button style={small()} onClick={() => setAsk(null)}>
                      Cancel
                    </button>
                  </div>
                </div>
              ) : null}
              {effective.length > 0 ? (
                <div style={muted} data-testid="project-effective">
                  <div style={{ fontWeight: 600 }}>What Prometheus reads in this folder</div>
                  {effective.map((f) => (
                    <div key={f.path} title={f.path} style={{ overflowWrap: 'anywhere' }}>
                      {f.path} <span>{effectiveNote(f)}</span>
                    </div>
                  ))}
                </div>
              ) : null}
            </>
          ) : null}
        </section>

        <section style={{ display: 'flex', flexDirection: 'column', gap: 8 }} aria-label="Reference files">
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={heading}>Reference files</div>
            <span style={{ flex: 1 }} />
            <button style={small(busy || files === null)} disabled={busy || files === null} onClick={() => void add()} data-testid="project-files-add">
              Add files…
            </button>
          </div>
          <div style={muted}>Files kept with the project, for its conversations to look at. They are copied to Prometheus's computer; your originals are not touched.</div>
          {fileProblem ? (
            <div style={notice} role="alert" data-testid="project-files-problem">
              {fileProblem}
            </div>
          ) : null}
          {report.length > 0 ? (
            <div style={notice} role="status" data-testid="project-files-report">
              {report.map((l) => (
                <div key={l}>{l}</div>
              ))}
            </div>
          ) : null}
          {files === null && !fileProblem ? <div style={muted}>Reading…</div> : null}
          {files !== null && files.length === 0 ? <div style={muted}>No reference files yet.</div> : null}
          {files?.map((f) => (
            <div key={f.name} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 0', borderTop: '1px solid var(--c-line)' }} data-testid="project-file">
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, color: 'var(--c-text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', unicodeBidi: 'isolate' }} title={f.name} dir="auto" data-testid="project-file-name">
                  {f.name}
                </div>
                <div style={muted}>{describeFile(f)}</div>
              </div>
              {deleting === f.name ? (
                <>
                  <span style={muted}>Delete from Prometheus's computer?</span>
                  <button style={{ ...small(), borderColor: 'var(--c-err)' }} data-testid="project-file-delete-yes" onClick={() => void remove(f.name)}>
                    Delete
                  </button>
                  <button style={small()} onClick={() => setDeleting(null)}>
                    Keep
                  </button>
                </>
              ) : (
                <>
                  <button style={small(busy)} disabled={busy} onClick={() => void saveAs(f.name)} aria-label={`Save ${f.name} as`} data-testid="project-file-save">
                    Save as…
                  </button>
                  <button style={small(busy)} disabled={busy} onClick={() => void add(f.name)} aria-label={`Replace ${f.name}`} title="Choose a file to put in its place" data-testid="project-file-replace">
                    Replace…
                  </button>
                  <button style={small(busy)} disabled={busy} onClick={() => setDeleting(f.name)} aria-label={`Delete ${f.name}`} data-testid="project-file-delete">
                    Delete
                  </button>
                </>
              )}
            </div>
          ))}
        </section>

        {ask?.kind === 'discard' ? (
          <div style={notice} role="alertdialog" aria-label="Unsaved changes" data-testid="project-settings-discard">
            <div>You have changes to the instructions that are not saved.</div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button style={small()} data-testid="project-settings-discard-yes" onClick={onClose}>
                Discard them
              </button>
              <button style={small()} onClick={() => setAsk(null)}>
                Keep editing
              </button>
            </div>
          </div>
        ) : null}

        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <button style={btn()} onClick={requestClose} data-testid="project-settings-close">
            Close
          </button>
        </div>
      </div>
    </div>
  )
}
