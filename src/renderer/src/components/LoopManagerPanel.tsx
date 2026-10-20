import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type Ref } from 'react'
import {
  addTask,
  compilePayload,
  contractPickerEntries,
  extractDaemonError,
  parseLoopContract,
  parseTasks,
  removeTask,
  setTaskDone,
  taskRatio,
  DEFAULT_LOOP_MD,
  DEFAULT_TASKS_MD,
  LOOP_PROJECT_COLORS,
  type LoopProject,
  type LoopProjectColor,
  type LoopTask
} from '@shared/loop'
import type { CodingLaunchRequest, CodingLaunchResult } from '@shared/coding'
import { isAuthError, joinFilePath } from '@shared/daemon-api'
import { docBreadcrumbs, docsListPath, docsReadPath, type DocEntry, type DocListDTO, type DocReadDTO } from '@shared/documents'
import { LoopRunView } from './LoopRunView'

// Loop Manager — the PM cockpit OVER the coding mode that shipped this session. A project board
// above the developer's single-run Coding panel: register local repos, edit TASKS.md / LOOP.md from
// the board, compile a run, fire /api/code, and watch it stream live (reusing the Coding panel's
// stream + helpers, never editing CodingPanel). Three modes — Autonomous, Composed, weak-Supervised
// (watch + Stop; NO pause/inject, that's Sprint 2). Local-only v1 (Phase 0 SSH decision).

export type LoopMode = 'autonomous' | 'composed' | 'supervised'

const MONO = 'var(--font-mono)'

const panel: CSSProperties = { flex: 1, minWidth: 0, minHeight: 0, display: 'flex', overflow: 'hidden' }
const sidebar: CSSProperties = { width: 260, flexShrink: 0, minHeight: 0, display: 'flex', flexDirection: 'column', borderRight: '1px solid var(--c-line)', background: 'var(--c-raise)' }
const head: CSSProperties = { padding: '10px 14px', borderBottom: '1px solid var(--c-line)', flexShrink: 0, display: 'flex', alignItems: 'center', gap: 8 }
const workspace: CSSProperties = { flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }
const body: CSSProperties = { flex: 1, overflowY: 'auto', padding: 16, display: 'flex', flexDirection: 'column', gap: 14 }
const card: CSSProperties = { border: '1px solid var(--c-line)', borderRadius: 9, padding: 14, background: 'var(--c-raise)' }
const dim: CSSProperties = { color: 'var(--c-text-dim)', fontSize: 13 }
const label: CSSProperties = { fontSize: 11, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--c-text-faint)' }
const input: CSSProperties = { width: '100%', padding: '7px 10px', borderRadius: 6, border: '1px solid var(--c-line)', background: 'var(--c-inset)', color: 'var(--c-text)', font: 'inherit', fontSize: 13, boxSizing: 'border-box' }
const mono: CSSProperties = { fontFamily: MONO, fontSize: 12 }
const btn = (tone: 'arc' | 'line' = 'line', disabled = false): CSSProperties => ({
  fontSize: 13,
  padding: '7px 14px',
  borderRadius: 6,
  cursor: disabled ? 'default' : 'pointer',
  border: `1px solid ${tone === 'arc' ? 'var(--c-arc)' : 'var(--c-line)'}`,
  background: disabled ? 'var(--c-base)' : tone === 'arc' ? 'var(--c-arc)' : 'var(--c-inset)',
  color: disabled ? 'var(--c-text-faint)' : tone === 'arc' ? 'var(--c-on-arc)' : 'var(--c-text)',
  font: 'inherit',
  fontWeight: 600,
  opacity: disabled ? 0.7 : 1
})

const COLOR_VAR: Record<LoopProjectColor, string> = {
  arc: 'var(--c-arc)',
  amber: 'var(--c-amber)',
  violet: 'var(--c-violet)',
  ok: 'var(--c-ok)',
  err: 'var(--c-err)'
}

/** Join a project root + a loop filename (linux; local-only v1). Trailing slash tolerated. */
function joinPath(root: string, name: string): string {
  return `${root.replace(/\/+$/, '')}/${name}`
}

/** A read error that means "file doesn't exist yet" (vs a real failure / auth). */
function isMissing(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e)
  return /ENOENT|no such file/i.test(msg)
}

/** The specific failure reason the daemon surfaced (main re-throws it) — so the UI shows "not a git
 * repository …" / "path does not exist …" rather than a generic "could not". */
function reason(e: unknown): string {
  return e instanceof Error && e.message ? e.message : 'unknown error'
}

/** Human-readable failure for the From-Documents picker — a 401 names the fix, anything else shows
 * the daemon's specific error. */
function pickerError(e: unknown): string {
  return isAuthError(e) ? 'Not authorized — set the daemon token in Connection Settings.' : extractDaemonError(reason(e))
}

// ── top-level panel: registry sidebar + selected workspace ────────────────────

export function LoopManagerPanel() {
  const [projects, setProjects] = useState<LoopProject[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [ratios, setRatios] = useState<Record<string, { done: number; total: number } | null>>({})
  const [runningId, setRunningId] = useState<string | null>(null)
  const [addOpen, setAddOpen] = useState(false)

  const refresh = useCallback(async () => {
    const b = window.beacon
    if (!b) return
    const list = await b.loop.listProjects().catch(() => [] as LoopProject[])
    setProjects(list)
    setLoading(false)
    const entries = await Promise.all(
      list.map(async (p) => {
        try {
          const { content } = await b.loop.readFile(joinPath(p.rootPath, 'TASKS.md'))
          return [p.id, taskRatio(parseTasks(content).tasks)] as const
        } catch {
          return [p.id, null] as const
        }
      })
    )
    setRatios(Object.fromEntries(entries))
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // Keep the sidebar ratios fresh against external edits — a gentle cadence; the open workspace
  // reconciles its own files faster.
  useEffect(() => {
    const id = setInterval(() => void refresh(), 4000)
    return () => clearInterval(id)
  }, [refresh])

  const addProject = useCallback(
    async (p: { label: string; rootPath: string; color: LoopProjectColor }) => {
      const b = window.beacon
      if (!b) return
      const prevIds = new Set(projects.map((x) => x.id))
      const next = [...projects, { id: crypto.randomUUID(), label: p.label, rootPath: p.rootPath, color: p.color }]
      const saved = await b.loop.saveProjects(next).catch(() => next)
      setProjects(saved)
      setAddOpen(false)
      const created = saved.find((x) => !prevIds.has(x.id))
      if (created) setSelectedId(created.id)
      void refresh()
    },
    [projects, refresh]
  )

  const removeProject = useCallback(
    async (id: string) => {
      const b = window.beacon
      if (!b) return
      const proj = projects.find((p) => p.id === id)
      if (!window.confirm(`Remove "${proj?.label ?? id}" from the board?\n\nThis only forgets it in Beacon — the local files are untouched.`)) return
      const next = projects.filter((p) => p.id !== id)
      const saved = await b.loop.saveProjects(next).catch(() => next)
      setProjects(saved)
      if (selectedId === id) setSelectedId(null)
      void refresh()
    },
    [projects, selectedId, refresh]
  )

  const selected = projects.find((p) => p.id === selectedId) ?? null

  return (
    <div style={panel}>
      <div style={sidebar}>
        <div style={head}>
          <span style={{ fontSize: 12, color: 'var(--c-text-dim)', flex: 1 }}>projects</span>
          <button style={btn('arc')} onClick={() => setAddOpen((o) => !o)} title="Register a local project">＋</button>
        </div>
        {addOpen ? <AddProjectForm onAdd={addProject} onCancel={() => setAddOpen(false)} /> : null}
        <div style={{ flex: 1, overflowY: 'auto' }}>
          {loading ? (
            <div style={{ padding: 14, ...dim }}>Loading projects…</div>
          ) : projects.length === 0 ? (
            <div style={{ padding: 14, ...dim }}>No projects yet. Click ＋ to register a local repo with a TASKS.md.</div>
          ) : (
            projects.map((p) => (
              <ProjectRow
                key={p.id}
                project={p}
                active={p.id === selectedId}
                ratio={ratios[p.id] ?? null}
                running={runningId === p.id}
                onSelect={() => setSelectedId(p.id)}
                onRemove={() => void removeProject(p.id)}
              />
            ))
          )}
        </div>
      </div>

      {selected ? (
        <LoopWorkspace
          key={selected.id}
          project={selected}
          onTasksChanged={() => void refresh()}
          onRunStateChange={(active) => setRunningId(active ? selected.id : null)}
        />
      ) : (
        <div style={{ ...workspace, alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ ...dim, textAlign: 'center', maxWidth: 420 }}>
            <div style={{ fontSize: 15, color: 'var(--c-text)', marginBottom: 6 }}>Pick a project</div>
            The board reads each project&apos;s <code style={mono}>TASKS.md</code> and <code style={mono}>LOOP.md</code>, compiles a run, and
            fires it on the daemon&apos;s coding engine — then streams it live.
          </div>
        </div>
      )}
    </div>
  )
}

function ProjectRow({
  project,
  active,
  ratio,
  running,
  onSelect,
  onRemove
}: {
  project: LoopProject
  active: boolean
  ratio: { done: number; total: number } | null
  running: boolean
  onSelect: () => void
  onRemove: () => void
}) {
  const status: { text: string; color: string } = running
    ? { text: 'running', color: 'var(--c-amber)' }
    : ratio && ratio.total > 0 && ratio.done === ratio.total
      ? { text: 'done', color: 'var(--c-ok)' }
      : { text: 'idle', color: 'var(--c-idle)' }
  return (
    <div style={{ display: 'flex', alignItems: 'center', borderLeft: `2px solid ${active ? 'var(--c-arc)' : 'transparent'}`, background: active ? 'var(--c-inset)' : 'transparent' }}>
      <button onClick={onSelect} style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', background: 'transparent', border: 'none', cursor: 'pointer', textAlign: 'left', font: 'inherit', color: 'var(--c-text)' }}>
        <span style={{ width: 9, height: 9, borderRadius: '50%', background: COLOR_VAR[project.color], flexShrink: 0 }} />
        <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 13 }}>{project.label}</span>
        <span style={{ ...dim, fontFamily: MONO, fontSize: 11 }}>{ratio ? `${ratio.done}/${ratio.total}` : '—'}</span>
        <span style={{ fontSize: 10, color: status.color }}>●</span>
      </button>
      <button onClick={onRemove} title="Remove from board" style={{ padding: '4px 8px', background: 'transparent', border: 'none', color: 'var(--c-text-faint)', cursor: 'pointer', font: 'inherit', flexShrink: 0 }}>✕</button>
    </div>
  )
}

function AddProjectForm({ onAdd, onCancel }: { onAdd: (p: { label: string; rootPath: string; color: LoopProjectColor }) => void; onCancel: () => void }) {
  const [labelText, setLabelText] = useState('')
  const [rootPath, setRootPath] = useState('')
  const [color, setColor] = useState<LoopProjectColor>('arc')
  const ready = rootPath.trim().length > 0
  return (
    <div style={{ padding: 12, borderBottom: '1px solid var(--c-line)', display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={label}>New project</div>
      <input style={input} placeholder="Label (optional)" value={labelText} onChange={(e) => setLabelText(e.target.value)} />
      <input style={{ ...input, fontFamily: MONO }} placeholder="/abs/path/to/local/repo" value={rootPath} onChange={(e) => setRootPath(e.target.value)} spellCheck={false} />
      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        {LOOP_PROJECT_COLORS.map((c) => (
          <button key={c} onClick={() => setColor(c)} title={c} style={{ width: 18, height: 18, borderRadius: '50%', background: COLOR_VAR[c], border: color === c ? '2px solid var(--c-text)' : '2px solid transparent', cursor: 'pointer', padding: 0 }} />
        ))}
        <span style={{ flex: 1 }} />
        <button style={btn('line')} onClick={onCancel}>Cancel</button>
        <button style={btn('arc', !ready)} disabled={!ready} onClick={() => onAdd({ label: labelText.trim() || rootPath.trim(), rootPath: rootPath.trim(), color })}>Add</button>
      </div>
      <div style={{ ...dim, fontSize: 11 }}>Local path on the daemon host — the engine runs the repo in place. No remote/SSH in v1.</div>
    </div>
  )
}

// ── per-project workspace ─────────────────────────────────────────────────────

function LoopWorkspace({
  project,
  onTasksChanged,
  onRunStateChange
}: {
  project: LoopProject
  onTasksChanged: () => void
  onRunStateChange: (active: boolean) => void
}) {
  const tasksPath = joinPath(project.rootPath, 'TASKS.md')
  const loopPath = joinPath(project.rootPath, 'LOOP.md')

  const [mode, setMode] = useState<LoopMode>('autonomous')
  const [tasks, setTasks] = useState<string | null>(null)
  const [tasksMissing, setTasksMissing] = useState(false)
  const tasksRef = useRef<string | null>(null)
  const tasksMtime = useRef(0)
  const [contract, setContract] = useState<string | null>(null)
  const [contractMissing, setContractMissing] = useState(false)
  const [selectedLine, setSelectedLine] = useState<number | null>(null)
  const [newTask, setNewTask] = useState('')
  const [run, setRun] = useState<{ codingId: string; managedId: string } | null>(null)
  const [firing, setFiring] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [authErr, setAuthErr] = useState(false)

  // Walkthrough plumbing — the readiness checklist (step 3 card) jumps the user to the card that
  // still needs input: scroll+focus for tasks, expand+scroll for the contract.
  const tasksCardRef = useRef<HTMLDivElement | null>(null)
  const addTaskInputRef = useRef<HTMLInputElement | null>(null)
  const contractCardRef = useRef<HTMLDivElement | null>(null)
  const [contractExpandNonce, setContractExpandNonce] = useState(0)

  useEffect(() => {
    tasksRef.current = tasks
  }, [tasks])

  useEffect(() => {
    onRunStateChange(!!run)
  }, [run, onRunStateChange])

  // Initial load of both files.
  useEffect(() => {
    const b = window.beacon
    if (!b) return
    let alive = true
    void b.loop
      .readFile(tasksPath)
      .then((r) => {
        if (!alive) return
        setTasks(r.content)
        tasksMtime.current = r.mtimeMs
        const undone = parseTasks(r.content).tasks.find((t) => !t.done)
        setSelectedLine(undone?.lineIndex ?? null)
      })
      .catch((e) => {
        if (!alive) return
        if (isAuthError(e)) setAuthErr(true)
        else if (isMissing(e)) setTasksMissing(true)
        else setErr(`Could not read TASKS.md: ${reason(e)}`)
      })
    void b.loop
      .readFile(loopPath)
      .then((r) => alive && setContract(r.content))
      .catch((e) => {
        if (!alive) return
        if (isMissing(e)) setContractMissing(true)
        else if (!isAuthError(e)) setErr(`Could not read LOOP.md: ${reason(e)}`)
      })
    return () => {
      alive = false
    }
  }, [tasksPath, loopPath])

  // Reconcile external TASKS.md edits (a finished run writing back, or you editing on disk) — re-read
  // on a short cadence and adopt only when the bytes actually changed (so our own optimistic writes
  // don't churn). Paused while a run is active.
  useEffect(() => {
    if (run) return
    const b = window.beacon
    if (!b) return
    let alive = true
    const id = setInterval(() => {
      void b.loop
        .readFile(tasksPath)
        .then((r) => {
          if (!alive) return
          setTasksMissing(false)
          if (r.content !== tasksRef.current) {
            setTasks(r.content)
            tasksMtime.current = r.mtimeMs
          }
        })
        .catch(() => undefined)
    }, 1500)
    return () => {
      alive = false
      clearInterval(id)
    }
  }, [tasksPath, run])

  const writeTasks = useCallback(
    async (next: string) => {
      const b = window.beacon
      if (!b) return
      setTasks(next) // optimistic
      try {
        const { mtimeMs } = await b.loop.writeFile(tasksPath, next)
        tasksMtime.current = mtimeMs
        onTasksChanged()
      } catch (e) {
        if (isAuthError(e)) setAuthErr(true)
        else setErr(`Could not write TASKS.md: ${reason(e)}`)
      }
    },
    [tasksPath, onTasksChanged]
  )

  const parsed = useMemo(() => (tasks != null ? parseTasks(tasks) : null), [tasks])
  const selectedTask: LoopTask | null = useMemo(
    () => parsed?.tasks.find((t) => t.lineIndex === selectedLine) ?? null,
    [parsed, selectedLine]
  )

  const parsedContract = useMemo(() => (contract != null ? parseLoopContract(contract) : null), [contract])

  const compiled = useMemo(() => {
    if (parsedContract == null) return null
    return compilePayload(parsedContract, selectedTask?.text ?? '', project.rootPath)
  }, [parsedContract, selectedTask, project.rootPath])

  // The three run ingredients, tracked live — same checks compilePayload blocks on, computed here so
  // the checklist works even before a LOOP.md exists (compiled == null).
  const readiness = {
    project: project.rootPath.trim().length > 0,
    task: (selectedTask?.text ?? '').trim().length > 0,
    acceptance: !!parsedContract?.acceptanceCommand?.trim()
  }

  const focusTasks = useCallback(() => {
    tasksCardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    addTaskInputRef.current?.focus()
  }, [])

  const focusContract = useCallback(() => {
    setContractExpandNonce((n) => n + 1)
    contractCardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [])

  const fire = useCallback(async () => {
    const b = window.beacon
    if (!b || !compiled || compiled.errors.length > 0) return
    setFiring(true)
    setErr(null)
    try {
      const res = (await b.daemon.write('/api/code', compiled.payload)) as CodingLaunchResult
      setRun({ codingId: res.coding_task_id, managedId: res.task_id })
    } catch (e) {
      if (isAuthError(e)) setAuthErr(true)
      else setErr('Launch failed — the daemon rejected the run (check the repo path is a git repo and the token in Settings).')
    } finally {
      setFiring(false)
    }
  }, [compiled])

  const createFile = useCallback(
    async (which: 'tasks' | 'loop') => {
      const b = window.beacon
      if (!b) return
      const path = which === 'tasks' ? tasksPath : loopPath
      const seed = which === 'tasks' ? DEFAULT_TASKS_MD : DEFAULT_LOOP_MD
      try {
        await b.loop.writeFile(path, seed)
        if (which === 'tasks') {
          setTasks(seed)
          setTasksMissing(false)
          onTasksChanged()
        } else {
          setContract(seed)
          setContractMissing(false)
        }
      } catch (e) {
        if (isAuthError(e)) setAuthErr(true)
        else setErr(`Could not create ${which === 'tasks' ? 'TASKS.md' : 'LOOP.md'}: ${reason(e)}`)
      }
    },
    [tasksPath, loopPath, onTasksChanged]
  )

  const fireLabel = mode === 'composed' ? 'Review & fire' : mode === 'supervised' ? 'Fire & watch' : 'Fire & walk away'

  return (
    <div style={workspace}>
      <div style={{ ...head, justifyContent: 'space-between' }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--c-text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{project.label}</div>
          <div style={{ ...dim, fontFamily: MONO, fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{project.rootPath}</div>
        </div>
        <ModeSelector mode={mode} onChange={setMode} disabled={!!run} />
      </div>

      <div style={body}>
        {authErr ? (
          <div style={{ ...card, color: 'var(--c-err)' }}>Not authorized — the daemon rejected a request. Check the API token in Settings (⌘,).</div>
        ) : null}
        {err ? <div style={{ ...card, color: 'var(--c-err)' }}>{err}</div> : null}

        {run ? (
          <>
            <div style={{ ...dim }}>
              {mode === 'supervised' ? 'Supervised: watch the run stream and Stop it if it goes wrong (no pause/inject in v1).' : mode === 'autonomous' ? 'Autonomous: fired — you can walk away; it runs to green or a cap.' : 'Composed run is live.'}
            </div>
            <LoopRunView codingId={run.codingId} managedId={run.managedId} onClear={() => setRun(null)} />
          </>
        ) : (
          <>
            {/* Step 1 — task board */}
            <TaskBoard
              cardRef={tasksCardRef}
              addInputRef={addTaskInputRef}
              parsed={parsed}
              missing={tasksMissing}
              selectedLine={selectedLine}
              newTask={newTask}
              onNewTaskChange={setNewTask}
              onSelect={setSelectedLine}
              onToggle={(line, done) => tasks != null && void writeTasks(setTaskDone(tasks, line, done))}
              onAdd={() => {
                if (tasks == null || !newTask.trim()) return
                void writeTasks(addTask(tasks, newTask))
                setNewTask('')
              }}
              onDelete={(line) => {
                if (tasks == null) return
                if (selectedLine === line) setSelectedLine(null)
                void writeTasks(removeTask(tasks, line))
              }}
              onCreate={() => void createFile('tasks')}
            />

            {/* Step 2 — LOOP.md contract. Auto-expands (same expanded prop Composed mode uses) when
                the contract is missing or has no Acceptance command — the walkthrough's blocked step
                opens itself. */}
            <ContractEditor
              cardRef={contractCardRef}
              contract={contract}
              missing={contractMissing}
              loopPath={loopPath}
              expanded={mode === 'composed' || contractMissing || (parsedContract != null && !readiness.acceptance)}
              expandNonce={contractExpandNonce}
              onChange={setContract}
              onSave={async (text) => {
                const b = window.beacon
                if (!b) return
                try {
                  await b.loop.writeFile(loopPath, text)
                  setContract(text)
                } catch (e) {
                  if (isAuthError(e)) setAuthErr(true)
                  else setErr(`Could not write LOOP.md: ${reason(e)}`)
                }
              }}
              onGenerate={() => void createFile('loop')}
            />

            {/* Step 3 — compiled payload preview + Fire, with a live readiness checklist while any
                ingredient is missing. Each ✗ names the fix and jumps to the card that provides it. */}
            <div style={card}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
                <span style={label}>Step 3 · Compiled run</span>
                <span style={{ flex: 1 }} />
                <button style={btn('arc', !compiled || compiled.errors.length > 0 || firing)} disabled={!compiled || compiled.errors.length > 0 || firing} onClick={() => void fire()}>
                  {firing ? 'Firing…' : fireLabel}
                </button>
              </div>
              {compiled && compiled.errors.length === 0 ? (
                <PayloadPreview payload={compiled.payload} selectedTask={selectedTask?.text ?? ''} />
              ) : (
                <ReadinessChecklist
                  steps={[
                    {
                      ok: readiness.project,
                      what: 'Project registered',
                      detail: readiness.project ? project.rootPath : undefined,
                      fix: 'register a local repo path with ＋ in the sidebar'
                    },
                    {
                      ok: readiness.task,
                      what: 'Task selected',
                      fix: 'pick a task in Step 1 (or add one)',
                      onFix: focusTasks
                    },
                    {
                      ok: readiness.acceptance,
                      what: 'LOOP.md has an Acceptance command',
                      fix: contractMissing
                        ? 'create LOOP.md in Step 2 (Generate template)'
                        : 'add an "Acceptance: <command>" line in Step 2',
                      onFix: focusContract
                    }
                  ]}
                />
              )}
            </div>
          </>
        )}
      </div>
    </div>
  )
}

function ModeSelector({ mode, onChange, disabled }: { mode: LoopMode; onChange: (m: LoopMode) => void; disabled: boolean }) {
  const modes: { id: LoopMode; label: string; hint: string }[] = [
    { id: 'autonomous', label: 'Autonomous', hint: 'fire & walk away' },
    { id: 'composed', label: 'Composed', hint: 'edit contract, review payload, fire' },
    { id: 'supervised', label: 'Supervised', hint: 'fire, watch, stop' }
  ]
  return (
    <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
      {modes.map((m) => (
        <button
          key={m.id}
          disabled={disabled}
          title={m.hint}
          onClick={() => onChange(m.id)}
          style={{
            fontSize: 12,
            padding: '6px 10px',
            borderRadius: 6,
            border: `1px solid ${mode === m.id ? 'var(--c-arc)' : 'var(--c-line)'}`,
            background: mode === m.id ? 'var(--c-arc-soft)' : 'transparent',
            color: mode === m.id ? 'var(--c-arc)' : 'var(--c-text-dim)',
            cursor: disabled ? 'default' : 'pointer',
            font: 'inherit',
            opacity: disabled ? 0.6 : 1
          }}
        >
          {m.label}
        </button>
      ))}
    </div>
  )
}

/** The live walkthrough in the Step 3 card — one row per run ingredient, ✓/✗, and for each ✗ the
 * concrete fix as a jump-link to the card that provides it. */
function ReadinessChecklist({
  steps
}: {
  steps: { ok: boolean; what: string; detail?: string; fix: string; onFix?: () => void }[]
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {steps.map((s, i) => (
        <div key={s.what} style={{ display: 'flex', alignItems: 'baseline', gap: 8, fontSize: 13 }}>
          <span style={{ fontFamily: MONO, color: s.ok ? 'var(--c-ok)' : 'var(--c-warn)', flexShrink: 0 }}>{s.ok ? '✓' : '✗'}</span>
          <span style={{ color: s.ok ? 'var(--c-text-dim)' : 'var(--c-text)', minWidth: 0 }}>
            {i + 1}. {s.what}
            {s.ok && s.detail ? (
              <span style={{ color: 'var(--c-text-faint)', fontFamily: MONO, fontSize: 11 }}> — {s.detail}</span>
            ) : null}
            {!s.ok ? (
              <>
                {' — '}
                {s.onFix ? (
                  <button
                    onClick={s.onFix}
                    style={{ background: 'transparent', border: 'none', padding: 0, cursor: 'pointer', font: 'inherit', fontSize: 13, color: 'var(--c-arc)', textDecoration: 'underline' }}
                  >
                    {s.fix}
                  </button>
                ) : (
                  <span style={{ color: 'var(--c-text-dim)' }}>{s.fix}</span>
                )}
              </>
            ) : null}
          </span>
        </div>
      ))}
    </div>
  )
}

function TaskBoard({
  cardRef,
  addInputRef,
  parsed,
  missing,
  selectedLine,
  newTask,
  onNewTaskChange,
  onSelect,
  onToggle,
  onAdd,
  onDelete,
  onCreate
}: {
  cardRef: Ref<HTMLDivElement>
  addInputRef: Ref<HTMLInputElement>
  parsed: ReturnType<typeof parseTasks> | null
  missing: boolean
  selectedLine: number | null
  newTask: string
  onNewTaskChange: (s: string) => void
  onSelect: (line: number) => void
  onToggle: (line: number, done: boolean) => void
  onAdd: () => void
  onDelete: (line: number) => void
  onCreate: () => void
}) {
  return (
    <div style={card} ref={cardRef}>
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 10 }}>
        <span style={label}>Step 1 · Tasks</span>
        <span style={{ flex: 1 }} />
        {parsed ? <span style={dim}>{taskRatio(parsed.tasks).done}/{taskRatio(parsed.tasks).total} done</span> : null}
      </div>
      {missing ? (
        <div>
          <div style={{ ...dim, marginBottom: 8 }}>No TASKS.md in this project yet.</div>
          <button style={btn('arc')} onClick={onCreate}>Create TASKS.md</button>
        </div>
      ) : parsed == null ? (
        <div style={dim}>Loading…</div>
      ) : (
        <>
          {parsed.tasks.length === 0 ? <div style={{ ...dim, marginBottom: 8 }}>No tasks yet — add one below.</div> : null}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            {parsed.tasks.map((t) => {
              const sel = t.lineIndex === selectedLine
              return (
                <div key={t.lineIndex} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px', borderRadius: 6, background: sel ? 'var(--c-arc-soft)' : 'transparent', border: `1px solid ${sel ? 'var(--c-arc)' : 'transparent'}` }}>
                  <button onClick={() => onToggle(t.lineIndex, !t.done)} title={t.done ? 'Mark not done' : 'Mark done'} style={{ width: 18, height: 18, flexShrink: 0, borderRadius: 4, border: `1px solid ${t.done ? 'var(--c-ok)' : 'var(--c-line-bright)'}`, background: t.done ? 'var(--c-ok-soft)' : 'transparent', color: 'var(--c-ok)', cursor: 'pointer', padding: 0, lineHeight: 1, fontSize: 12 }}>
                    {t.done ? '✓' : ''}
                  </button>
                  <button onClick={() => onSelect(t.lineIndex)} style={{ flex: 1, minWidth: 0, textAlign: 'left', background: 'transparent', border: 'none', cursor: 'pointer', font: 'inherit', color: t.done ? 'var(--c-text-faint)' : 'var(--c-text)', fontSize: 13, textDecoration: t.done ? 'line-through' : 'none', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {t.text || '(empty)'}
                  </button>
                  {t.tag ? <span style={{ fontSize: 11, color: 'var(--c-violet)', background: 'var(--c-violet-soft)', padding: '1px 6px', borderRadius: 999, flexShrink: 0 }}>{t.tag}</span> : null}
                  <button onClick={() => onDelete(t.lineIndex)} title="Delete task" style={{ padding: '2px 6px', background: 'transparent', border: 'none', color: 'var(--c-text-faint)', cursor: 'pointer', font: 'inherit', flexShrink: 0 }}>✕</button>
                </div>
              )
            })}
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
            <input
              ref={addInputRef}
              style={input}
              placeholder="Fix the failing test in tests/test_api.py [Bugfix]"
              value={newTask}
              onChange={(e) => onNewTaskChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') onAdd()
              }}
            />
            <button style={btn('line', !newTask.trim())} disabled={!newTask.trim()} onClick={onAdd}>Add</button>
          </div>
          <div style={{ ...dim, fontSize: 11, marginTop: 8 }}>Click a task to select it as the run target. The selected task becomes the run&apos;s description; a trailing [Tag] adds a label.</div>
        </>
      )}
    </div>
  )
}

function ContractEditor({
  cardRef,
  contract,
  missing,
  loopPath,
  expanded,
  expandNonce,
  onChange,
  onSave,
  onGenerate
}: {
  cardRef: Ref<HTMLDivElement>
  contract: string | null
  missing: boolean
  loopPath: string
  expanded: boolean
  expandNonce: number
  onChange: (s: string) => void
  onSave: (text: string) => void
  onGenerate: () => void
}) {
  const [open, setOpen] = useState(expanded)
  const [dirty, setDirty] = useState(false)
  // "From Documents…" — browse the daemon's confined documents root. pickFile opens a native dialog
  // on the BEACON host, so a remote Mac can't reach docs living on the mini; /api/documents can.
  const [picker, setPicker] = useState<{ path: string; entries: DocEntry[] | null; error: string | null } | null>(null)
  const pickerSeq = useRef(0)

  // Auto-expand when the walkthrough needs eyes here (Composed mode, missing file, no Acceptance) or
  // the checklist jump-link fires (nonce). Expand-only — never auto-collapses a card the user opened.
  useEffect(() => {
    if (expanded) setOpen(true)
  }, [expanded, expandNonce])

  const dropIn = useCallback(async () => {
    const b = window.beacon
    if (!b) return
    const picked = await b.loop.pickFile().catch(() => null)
    if (picked) {
      onChange(picked.content)
      setDirty(true)
      setOpen(true)
    }
  }, [onChange])

  const browseDocs = useCallback(async (dir: string) => {
    const b = window.beacon
    if (!b) return
    const seq = ++pickerSeq.current
    setPicker({ path: dir, entries: null, error: null })
    try {
      const d = (await b.daemon.get(docsListPath(dir))) as DocListDTO | null
      if (pickerSeq.current !== seq) return
      setPicker({ path: dir, entries: contractPickerEntries(d?.entries), error: null })
    } catch (e) {
      if (pickerSeq.current !== seq) return
      setPicker({ path: dir, entries: [], error: pickerError(e) })
    }
  }, [])

  const closePicker = useCallback(() => {
    pickerSeq.current++
    setPicker(null)
  }, [])

  const loadDoc = useCallback(
    async (rel: string) => {
      const b = window.beacon
      if (!b) return
      const seq = ++pickerSeq.current
      try {
        const d = (await b.daemon.get(docsReadPath(rel))) as DocReadDTO | null
        if (pickerSeq.current !== seq) return
        if (!d || d.binary) throw new Error(`not a text file: ${rel}`)
        onChange(d.content ?? '')
        setDirty(true)
        setOpen(true)
        setPicker(null)
      } catch (e) {
        if (pickerSeq.current !== seq) return
        setPicker((p) => (p ? { ...p, error: pickerError(e) } : p))
      }
    },
    [onChange]
  )

  return (
    <div style={card} ref={cardRef}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <button onClick={() => setOpen((o) => !o)} style={{ ...label, background: 'transparent', border: 'none', cursor: 'pointer', font: 'inherit', letterSpacing: '0.06em' }}>
          {open ? '▾' : '▸'} Step 2 · LOOP.md contract
        </button>
        <span style={{ flex: 1 }} />
        <button
          style={btn('line')}
          onClick={() => void (picker ? closePicker() : browseDocs(''))}
          title="Load a contract from the daemon's documents library (works from a remote Beacon)"
        >
          From Documents…
        </button>
        <button style={btn('line')} onClick={() => void dropIn()} title="Load a Markdown contract from elsewhere">Drop in .md</button>
        {missing ? <button style={btn('arc')} onClick={onGenerate}>Generate template</button> : null}
      </div>
      {picker ? (
        <div style={{ marginTop: 10, border: '1px solid var(--c-line)', borderRadius: 6, background: 'var(--c-inset)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '7px 10px', borderBottom: '1px solid var(--c-line)' }}>
            {docBreadcrumbs(picker.path).map((c, i, arr) => (
              <span key={c.path} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, minWidth: 0 }}>
                {i > 0 ? <span style={{ color: 'var(--c-text-faint)', fontSize: 11 }}>/</span> : null}
                <button
                  onClick={() => void browseDocs(c.path)}
                  disabled={i === arr.length - 1}
                  style={{
                    background: 'transparent',
                    border: 'none',
                    cursor: i === arr.length - 1 ? 'default' : 'pointer',
                    font: 'inherit',
                    fontSize: 12,
                    color: i === arr.length - 1 ? 'var(--c-text)' : 'var(--c-text-dim)',
                    padding: 0,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap'
                  }}
                >
                  {c.name}
                </button>
              </span>
            ))}
            <span style={{ flex: 1 }} />
            <button onClick={closePicker} title="Close" style={{ background: 'transparent', border: 'none', color: 'var(--c-text-faint)', cursor: 'pointer', font: 'inherit', padding: '0 2px' }}>✕</button>
          </div>
          {picker.error ? (
            <div style={{ color: 'var(--c-err)', fontSize: 12, padding: 10 }}>{picker.error}</div>
          ) : picker.entries == null ? (
            <div style={{ ...dim, padding: 10 }}>Loading…</div>
          ) : picker.entries.length === 0 ? (
            <div style={{ ...dim, padding: 10 }}>No .md files here.</div>
          ) : (
            <div style={{ maxHeight: 220, overflowY: 'auto' }}>
              {picker.entries.map((en) => {
                const rel = joinFilePath(picker.path, en.name)
                return (
                  <button
                    key={en.name}
                    onClick={() => void (en.type === 'dir' ? browseDocs(rel) : loadDoc(rel))}
                    style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left', padding: '6px 10px', background: 'transparent', border: 'none', cursor: 'pointer', font: 'inherit', fontSize: 13, color: 'var(--c-text)' }}
                  >
                    <span style={{ color: en.type === 'dir' ? 'var(--c-arc)' : 'var(--c-text-faint)', fontSize: 11, width: 14, flexShrink: 0 }}>{en.type === 'dir' ? '▸' : '≡'}</span>
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{en.type === 'dir' ? `${en.name}/` : en.name}</span>
                  </button>
                )
              })}
            </div>
          )}
        </div>
      ) : null}
      {open ? (
        <div style={{ ...dim, fontSize: 12, marginTop: 8 }}>
          Acceptance is the shell command that must exit 0 for the run to be done — the agent iterates until this goes green or a cap hits.
        </div>
      ) : null}
      {open ? (
        missing ? (
          <div style={{ ...dim, marginTop: 10 }}>No LOOP.md yet. Generate a template (done-signal + caps + conventions) or drop one in.</div>
        ) : contract == null ? (
          <div style={{ ...dim, marginTop: 10 }}>Loading…</div>
        ) : (
          <div style={{ marginTop: 10 }}>
            <textarea
              style={{ ...input, fontFamily: MONO, minHeight: 150, resize: 'vertical', lineHeight: 1.5 }}
              value={contract}
              spellCheck={false}
              onChange={(e) => {
                onChange(e.target.value)
                setDirty(true)
              }}
            />
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
              <span style={{ ...dim, fontFamily: MONO, fontSize: 11, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{loopPath}</span>
              <button
                style={btn('arc', !dirty)}
                disabled={!dirty}
                onClick={() => {
                  onSave(contract)
                  setDirty(false)
                }}
              >
                {dirty ? 'Save' : 'Saved'}
              </button>
            </div>
          </div>
        )
      ) : null}
    </div>
  )
}

function PayloadPreview({ payload, selectedTask }: { payload: CodingLaunchRequest; selectedTask: string }) {
  const copy = (): void => void navigator.clipboard?.writeText(JSON.stringify(payload, null, 2)).catch(() => undefined)
  return (
    <div>
      <div style={{ ...dim, marginBottom: 8 }}>
        Task: <span style={{ color: 'var(--c-text)' }}>{selectedTask || '(none selected)'}</span>
      </div>
      <pre style={{ ...mono, margin: 0, padding: 10, background: 'var(--c-void)', borderRadius: 6, overflowX: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: 'var(--c-text)' }}>
        {JSON.stringify(payload, null, 2)}
      </pre>
      <button style={{ ...btn('line'), marginTop: 8 }} onClick={copy}>Copy payload</button>
    </div>
  )
}
