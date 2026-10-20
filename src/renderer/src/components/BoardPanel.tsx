import { useCallback, useEffect, useState, type CSSProperties, type ReactNode } from 'react'
import type { SessionSummary } from '@shared/ipc'
import {
  STORY_COLUMNS,
  groupStoriesByStatus,
  isAuthError,
  nextStoryPosition,
  asList,
  type ProjectDTO,
  type StoryDTO,
  type StoryStatus,
  type StoryPriority
} from '@shared/daemon-api'
import { NotAuthorized } from './NotAuthorized'
import { DOCS_CONTENT_PATH, docsListPath, docsReadPath, type DocListDTO, type DocReadDTO } from '@shared/documents'
import { httpStatusFromError } from '@shared/daemon-api'
import {
  duplicateStoryIds,
  listHitCap,
  planFileFor,
  planStateFrom,
  DOCS_LIST_CAP,
  PLAN_BANNERS,
  PLAN_DIR,
  type PlanResolution,
  type PlanState,
} from '@shared/plan'
import { setTaskDone } from '@shared/loop'
import { PlanDrawer, MONO, badge, cardBtn } from './PlanSection'


// Board view (Kanban) — projects/stories from the daemon-backed store (/api/projects, /api/stories).
// Four columns (todo / in_progress / blocked / done); drag a card to a column to change its status
// (PUT). Create/edit via a modal; Dispatch sends the story's text to a session (the agent picks it up
// as a chat message). Native HTML5 drag-drop — no dnd dependency. Inline-styled.

const PRIORITY_COLOR: Record<StoryPriority, string> = { low: 'var(--c-text-dim)', medium: 'var(--c-arc)', high: 'var(--c-err)' }

const panel: CSSProperties = { flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }
const head: CSSProperties = { padding: '10px 16px', borderBottom: '1px solid var(--c-line)', background: 'var(--c-raise)', flexShrink: 0, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }
const select: CSSProperties = { fontSize: 12, padding: '5px 8px', borderRadius: 6, border: '1px solid var(--c-line)', background: 'var(--c-base)', color: 'var(--c-text)', cursor: 'pointer', font: 'inherit' }
// Disabled is a visible state (see DevicesPanel btn): the flag drives prop + style together.
const headBtn = (disabled = false): CSSProperties => ({ fontSize: 12, padding: '5px 11px', borderRadius: 6, border: '1px solid var(--c-line)', background: 'var(--c-raise)', color: disabled ? 'var(--c-text-faint)' : 'var(--c-text)', cursor: disabled ? 'not-allowed' : 'pointer', font: 'inherit' })
const columnsWrap: CSSProperties = { flex: 1, display: 'flex', gap: 10, padding: 12, overflowX: 'auto', overflowY: 'hidden' }
const column: CSSProperties = { flex: 1, minWidth: 230, display: 'flex', flexDirection: 'column', background: 'var(--c-base)', border: '1px solid var(--c-line)', borderRadius: 10, overflow: 'hidden' }
const colHead: CSSProperties = { padding: '8px 12px', fontSize: 12, fontWeight: 600, color: 'var(--c-text-dim)', borderBottom: '1px solid var(--c-line)', display: 'flex', justifyContent: 'space-between' }
const colBody: CSSProperties = { flex: 1, overflowY: 'auto', padding: 8, display: 'flex', flexDirection: 'column', gap: 8 }

function cleanErr(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e)
  const match = m.match(/\{"error":"([^"]+)"\}/)
  return match ? match[1] : m
}

function Card({
  story,
  color,
  onDragStart,
  onEdit,
  onDispatch,
  onDelete,
  plan,
  onPlan
}: {
  story: StoryDTO
  color?: string
  onDragStart: () => void
  onEdit: () => void
  onDispatch: () => void
  onDelete: () => void
  plan: PlanResolution
  onPlan: () => void
}) {
  return (
    <div
      draggable
      onDragStart={onDragStart}
      style={{ background: 'var(--c-raise)', border: '1px solid var(--c-line)', borderLeft: `3px solid ${color ?? 'var(--c-line)'}`, borderRadius: 8, padding: '8px 10px', cursor: 'grab' }}
    >
      <div onClick={onEdit} style={{ cursor: 'pointer' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
          <span style={{ ...badge, fontFamily: MONO }}>{story.story_id}</span>
          <span style={{ ...badge, color: PRIORITY_COLOR[story.priority], background: `${PRIORITY_COLOR[story.priority]}22` }}>{story.priority}</span>
          {/* Three renderings, never one. "no plan" is silent; a file present is a chip you can
              open; two files for one story_id is a WARNING, because story_id has no UNIQUE
              constraint and picking one silently would show another story's plan. */}
          {plan.kind === 'one' ? (
            <span
              role="button"
              tabIndex={0}
              onClick={(e) => { e.stopPropagation(); onPlan() }}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); onPlan() } }}
              title="Open this story's plan"
              style={{ ...badge, cursor: 'pointer', color: 'var(--c-arc)', background: 'var(--c-arc-soft)' }}
            >
              plan
            </span>
          ) : plan.kind === 'ambiguous' ? (
            <span
              role="button"
              tabIndex={0}
              onClick={(e) => { e.stopPropagation(); onPlan() }}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); onPlan() } }}
              title={`${plan.paths.length} files match this story_id: ${plan.paths.join(', ')}`}
              style={{ ...badge, cursor: 'pointer', color: 'var(--c-warn)', background: 'var(--c-amber-soft)' }}
            >
              ⚠ {plan.paths.length} plans
            </span>
          ) : plan.nearMisses.length ? (
            /* A near miss has no chip of its own in the code that shipped, which would have made
               the "we never drop a candidate silently" promise false at the only place it is read:
               kind:'none' renders no chip, so the drawer holding the explanation is unreachable. */
            <span
              role="button"
              tabIndex={0}
              onClick={(e) => { e.stopPropagation(); onPlan() }}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); onPlan() } }}
              title={`${plan.nearMisses.length} file(s) start with this story id but are not claimed: ${plan.nearMisses.join(', ')}`}
              style={{ ...badge, cursor: 'pointer', color: 'var(--c-text-dim)', background: 'var(--c-inset)' }}
            >
              ? {plan.nearMisses.length} near
            </span>
          ) : null}
        </div>
        <div style={{ fontSize: 13, color: 'var(--c-text)', lineHeight: 1.35 }}>{story.title}</div>
        {story.labels.length ? (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 5 }}>
            {story.labels.map((l) => (
              <span key={l} style={{ ...badge, fontSize: 9 }}>{l}</span>
            ))}
          </div>
        ) : null}
        {story.session_key ? <div style={{ fontSize: 10, color: 'var(--c-ok)', marginTop: 5, fontFamily: MONO }}>▶ {story.session_key}</div> : null}
      </div>
      <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
        <button style={cardBtn} onClick={onDispatch} title="Send this task to a session">
          Dispatch
        </button>
        <button style={{ ...cardBtn, color: 'var(--c-err)' }} onClick={onDelete} title="Delete story">
          Delete
        </button>
      </div>
    </div>
  )
}

function Overlay({ children, onClose }: { children: ReactNode; onClose: () => void }) {
  return (
    <div
      onClick={onClose}
      style={{ position: 'fixed', inset: 0, zIndex: 60, background: 'var(--c-scrim)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ width: 'min(460px, 94vw)', maxHeight: '88vh', overflowY: 'auto', background: 'var(--c-raise)', border: '1px solid var(--c-line)', borderRadius: 12, padding: 16, display: 'flex', flexDirection: 'column', gap: 10 }}
      >
        {children}
      </div>
    </div>
  )
}

const field: CSSProperties = { fontSize: 13, padding: '7px 10px', borderRadius: 6, border: '1px solid var(--c-line)', background: 'var(--c-base)', color: 'var(--c-text)', outline: 'none', font: 'inherit', width: '100%', boxSizing: 'border-box' }
const modalBtn = (disabled = false, danger = false): CSSProperties => ({
  fontSize: 13,
  padding: '7px 14px',
  borderRadius: 6,
  border: '1px solid var(--c-line)',
  background: disabled ? 'var(--c-base)' : 'var(--c-raise)',
  color: disabled ? 'var(--c-text-faint)' : danger ? 'var(--c-err)' : 'var(--c-ok)',
  cursor: disabled ? 'not-allowed' : 'pointer',
  font: 'inherit'
})
const modalTitle: CSSProperties = { fontSize: 15, fontWeight: 600, color: 'var(--c-text)', margin: 0 }

function StoryModal({
  story,
  projects,
  defaultProject,
  onClose,
  onSaved
}: {
  story: StoryDTO | null
  projects: ProjectDTO[]
  defaultProject: string
  onClose: () => void
  onSaved: () => void
}) {
  const [storyId, setStoryId] = useState(story?.story_id ?? '')
  const [title, setTitle] = useState(story?.title ?? '')
  const [description, setDescription] = useState(story?.description ?? '')
  const [priority, setPriority] = useState<StoryPriority>(story?.priority ?? 'medium')
  const [status, setStatus] = useState<StoryStatus>(story?.status ?? 'todo')
  const [projectId, setProjectId] = useState(story?.project_id ?? defaultProject ?? '')
  const [labels, setLabels] = useState((story?.labels ?? []).join(', '))
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const canSave = storyId.trim().length > 0 && title.trim().length > 0

  const save = async (): Promise<void> => {
    const b = window.beacon
    if (!b) return
    setBusy(true)
    setErr(null)
    const body = {
      story_id: storyId.trim(),
      title: title.trim(),
      description: description.trim() || null,
      priority,
      status,
      project_id: projectId || null,
      labels: labels.split(',').map((s) => s.trim()).filter(Boolean)
    }
    try {
      if (story) await b.daemon.write(`/api/stories/${encodeURIComponent(story.id)}`, body, 'PUT')
      else await b.daemon.write('/api/stories', body, 'POST')
      onSaved()
    } catch (e) {
      setErr(cleanErr(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Overlay onClose={onClose}>
      <h2 style={modalTitle}>{story ? 'Edit story' : 'New story'}</h2>
      <input style={field} placeholder="Story ID (e.g. US-001)" value={storyId} onChange={(e) => setStoryId(e.target.value)} />
      <input style={field} placeholder="Title" value={title} onChange={(e) => setTitle(e.target.value)} />
      <textarea style={{ ...field, minHeight: 70, resize: 'vertical' }} placeholder="Description (sent to the agent on dispatch)" value={description} onChange={(e) => setDescription(e.target.value)} />
      <div style={{ display: 'flex', gap: 8 }}>
        <select style={{ ...select, flex: 1 }} value={status} onChange={(e) => setStatus(e.target.value as StoryStatus)}>
          {STORY_COLUMNS.map((c) => (
            <option key={c.id} value={c.id}>{c.label}</option>
          ))}
        </select>
        <select style={{ ...select, flex: 1 }} value={priority} onChange={(e) => setPriority(e.target.value as StoryPriority)}>
          {(['low', 'medium', 'high'] as StoryPriority[]).map((p) => (
            <option key={p} value={p}>{p}</option>
          ))}
        </select>
      </div>
      <select style={select} value={projectId} onChange={(e) => setProjectId(e.target.value)}>
        <option value="">No project</option>
        {projects.map((p) => (
          <option key={p.id} value={p.id}>{p.name}</option>
        ))}
      </select>
      <input style={field} placeholder="Labels (comma-separated)" value={labels} onChange={(e) => setLabels(e.target.value)} />
      {err ? <div style={{ color: 'var(--c-err)', fontSize: 12 }}>{err}</div> : null}
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <button style={modalBtn()} onClick={onClose}>Cancel</button>
        <button style={modalBtn(!canSave || busy)} disabled={!canSave || busy} onClick={save}>Save</button>
      </div>
    </Overlay>
  )
}

function DispatchModal({
  story,
  sessions,
  active,
  onClose,
  onDone
}: {
  story: StoryDTO
  sessions: SessionSummary[]
  active: string
  onClose: () => void
  onDone: () => void
}) {
  const [key, setKey] = useState(active)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const send = async (): Promise<void> => {
    const b = window.beacon
    if (!b) return
    setBusy(true)
    setErr(null)
    try {
      await b.daemon.write(`/api/stories/${encodeURIComponent(story.id)}/dispatch`, { session_key: key.trim() }, 'POST')
      onDone()
    } catch (e) {
      setErr(cleanErr(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Overlay onClose={onClose}>
      <h2 style={modalTitle}>Dispatch “{story.title}”</h2>
      <p style={{ fontSize: 12, color: 'var(--c-text-dim)', margin: 0 }}>Sends the story to a session as a chat message; the story moves to In Progress.</p>
      <input style={{ ...field, fontFamily: MONO }} placeholder="session key (e.g. desktop:smoke)" value={key} onChange={(e) => setKey(e.target.value)} />
      {sessions.length ? (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {sessions.map((s) => (
            <button key={s.id} style={{ ...cardBtn, fontFamily: MONO }} onClick={() => setKey(s.id)} title="Use this session">
              {s.id}
            </button>
          ))}
        </div>
      ) : null}
      {err ? <div style={{ color: 'var(--c-err)', fontSize: 12 }}>{err}</div> : null}
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <button style={modalBtn()} onClick={onClose}>Cancel</button>
        <button style={modalBtn(!key.trim() || busy)} disabled={!key.trim() || busy} onClick={send}>Dispatch</button>
      </div>
    </Overlay>
  )
}

export function BoardPanel({ sessions, active }: { sessions: SessionSummary[]; active: string }) {
  const [projects, setProjects] = useState<ProjectDTO[]>([])
  const [stories, setStories] = useState<StoryDTO[]>([])
  const [selProject, setSelProject] = useState('')
  const [editing, setEditing] = useState<StoryDTO | 'new' | null>(null)
  const [dispatchFor, setDispatchFor] = useState<StoryDTO | null>(null)
  const [dragId, setDragId] = useState<string | null>(null)
  const [authErr, setAuthErr] = useState(false)
  const [storiesErr, setStoriesErr] = useState<string | null>(null)
  const [planFiles, setPlanFiles] = useState<string[]>([])
  const [planFilesErr, setPlanFilesErr] = useState<string | null>(null)
  // A 404 on loops/ is "nobody has saved a plan yet", not a failure. Kept apart from planFilesErr so
  // a fresh install does not open on a red-adjacent banner reporting a fault that has not happened.
  const [planDirMissing, setPlanDirMissing] = useState(false)
  const [planListCapped, setPlanListCapped] = useState(false)
  const [planFor, setPlanFor] = useState<{ story: StoryDTO; state: PlanState | null; err: string | null } | null>(null)

  const reload = useCallback((): void => {
    const b = window.beacon
    if (!b) return
    // A 401 must read as "Not authorized", never as an empty board (fail-loud contract, Slice 1).
    void b.daemon
      .get('/api/projects')
      .then((d) => {
        setAuthErr(false)
        setProjects(asList<ProjectDTO>(d))
      })
      .catch((e) => {
        if (isAuthError(e)) setAuthErr(true)
      })
    const path = selProject ? `/api/stories?project_id=${encodeURIComponent(selProject)}` : '/api/stories'
    // FAIL-LOUD, same contract as /api/projects above. This used to be `.catch(() => undefined)`,
    // which rendered an empty board on ANY failure — indistinguishable from a board with no
    // stories. That distinction is the whole point of a plan panel: "nothing here" and "I could
    // not find out" are different facts and must not share a rendering.
    void b.daemon
      .get(path)
      .then((d) => {
        setStoriesErr(null)
        setStories(asList<StoryDTO>(d))
      })
      .catch((e) => {
        if (isAuthError(e)) setAuthErr(true)
        else setStoriesErr(cleanErr(e))
      })
    // Plan files, listed once. A miss here is not fatal, but it must not read as "no plan".
    void b.daemon
      .get(docsListPath(PLAN_DIR))
      .then((d) => {
        setPlanFilesErr(null)
        setPlanDirMissing(false)
        const entries = (d as DocListDTO | null)?.entries ?? []
        // The daemon truncates at 2000 and returns 200 with no flag, so the count on the cap is the
        // only tell. Past it, plans exist and render as absent — an absence we must not stay quiet about.
        setPlanListCapped(listHitCap(entries.length))
        setPlanFiles(entries.filter((e) => e.type === 'file').map((e) => e.name))
      })
      .catch((e) => {
        if (httpStatusFromError(e) === 404) {
          setPlanDirMissing(true)
          setPlanFilesErr(null)
          setPlanFiles([])
          setPlanListCapped(false)
        } else setPlanFilesErr(cleanErr(e))
      })
  }, [selProject])

  useEffect(() => reload(), [reload])

  /** Resolve a story's plan file and read it. Never collapses a read failure into "no plan". */
  const openPlan = useCallback((story: StoryDTO): void => {
    const b = window.beacon
    if (!b) return
    const res = planFileFor(planFiles, story.story_id)
    if (res.kind !== 'one') {
      setPlanFor({ story, state: planStateFrom(res, null), err: null })
      return
    }
    setPlanFor({ story, state: null, err: null })
    void b.daemon
      .get(docsReadPath(`${PLAN_DIR}/${res.path}`))
      .then((d) => {
        const doc = d as DocReadDTO | null
        setPlanFor({ story, state: planStateFrom(res, doc?.content ?? '', doc?.truncated === true), err: null })
      })
      .catch((e) => setPlanFor({ story, state: null, err: cleanErr(e) }))
  }, [planFiles])

  /** Tick one line, byte-faithfully, and save it back to the documents tree. */
  const togglePlanTask = useCallback((path: string, content: string, lineIndex: number, done: boolean, truncated: boolean): void => {
    const b = window.beacon
    if (!b) return
    // Guard, not an assert: the content we hold is a 256 KiB PREFIX when the read was capped, and
    // PUT replaces the whole file. Writing it back would delete everything past the cap and report
    // success. Refusing is the only honest option until a partial-write path exists.
    if (truncated) return
    const next = setTaskDone(content, lineIndex, done)
    setPlanFor((cur) => (cur && cur.state && cur.state.kind === 'checklist'
      ? { ...cur, state: planStateFrom({ kind: 'one', path }, next) } : cur))
    void b.daemon
      .write(DOCS_CONTENT_PATH, { path: `${PLAN_DIR}/${path}`, content: next }, 'PUT')
      .catch((e) => setPlanFor((cur) => (cur ? { ...cur, err: cleanErr(e) } : cur)))
  }, [])

  const cols = groupStoriesByStatus(stories)

  const dropTo = (status: StoryStatus): void => {
    const id = dragId
    setDragId(null)
    if (!id) return
    const story = stories.find((s) => s.id === id)
    if (!story || story.status === status) return
    const b = window.beacon
    if (!b) return
    void b.daemon
      .write(`/api/stories/${encodeURIComponent(id)}`, { status, position: nextStoryPosition(stories, status) }, 'PUT')
      .then(reload)
      .catch(() => undefined)
  }

  const del = (id: string): void => {
    const b = window.beacon
    if (!b) return
    void b.daemon.write(`/api/stories/${encodeURIComponent(id)}`, undefined, 'DELETE').then(reload).catch(() => undefined)
  }

  // Inline mini-form (Slice 8): window.prompt() is NOT supported in Electron renderers, so the
  // old prompt-based "+ Project" silently did nothing on desktop.
  const [namingProject, setNamingProject] = useState(false)
  const [projectName, setProjectName] = useState('')
  const newProject = (): void => {
    const name = projectName.trim()
    if (!name) return
    const b = window.beacon
    if (!b) return
    setProjectName('')
    setNamingProject(false)
    void b.daemon.write('/api/projects', { name }, 'POST').then(reload).catch(() => undefined)
  }

  if (authErr) {
    return (
      <div style={panel}>
        <NotAuthorized what="the board" />
      </div>
    )
  }

  return (
    <div style={panel}>
      <div style={head}>
        <span style={{ fontSize: 15, fontWeight: 600, color: 'var(--c-text)', marginRight: 4 }}>Board</span>
        <select style={select} value={selProject} onChange={(e) => setSelProject(e.target.value)} title="Filter by project">
          <option value="">All projects</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
        <span style={{ flex: 1 }} />
        <button style={headBtn()} onClick={reload} title="Refresh">↻</button>
        {namingProject ? (
          <span style={{ display: 'inline-flex', gap: 6 }}>
            <input
              style={{ ...select, cursor: 'text', width: 160 }}
              autoFocus
              placeholder="Project name"
              value={projectName}
              onChange={(e) => setProjectName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') newProject()
                else if (e.key === 'Escape') setNamingProject(false)
              }}
            />
            <button style={headBtn(!projectName.trim())} onClick={newProject} disabled={!projectName.trim()} title={!projectName.trim() ? 'Name the project first' : 'Add the project column'}>
              Add
            </button>
          </span>
        ) : (
          <button style={headBtn()} onClick={() => setNamingProject(true)}>+ Project</button>
        )}
        <button style={{ ...headBtn(), color: 'var(--c-ok)' }} onClick={() => setEditing('new')}>+ Story</button>
      </div>
      {/* Onboarding Phase 2: honest empty state (matches the sessions sidebar's convention). */}
      {projects.length === 0 && stories.length === 0 ? (
        <div style={{ padding: '10px 14px', color: 'var(--c-text-dim)', fontSize: 13 }}>
          Nothing on the board yet — this is the shared kanban you and the agent both work.{' '}
          <strong>+ Project</strong> then <strong>+ Story</strong> to start, or ask the agent to plan something.
        </div>
      ) : null}
      {/* Named failures, never an empty board pretending to be an empty plan. */}
      {storiesErr ? (
        <div style={{ margin: '0 16px 8px', padding: '7px 10px', borderRadius: 6, background: 'var(--c-err-soft)', color: 'var(--c-err)', fontSize: 12 }}>
          {PLAN_BANNERS.storiesUnread(storiesErr)}
        </div>
      ) : null}
      {planFilesErr ? (
        <div style={{ margin: '0 16px 8px', padding: '7px 10px', borderRadius: 6, background: 'var(--c-amber-soft)', color: 'var(--c-warn)', fontSize: 12 }}>
          {PLAN_BANNERS.listFailed(planFilesErr)}
        </div>
      ) : null}
      {/* A 404 is the ordinary state of a machine nobody has saved a plan on yet. It gets the calm
          informational treatment, not the amber one — reading a fresh install as a fault is its own
          kind of lie. */}
      {planDirMissing ? (
        <div style={{ margin: '0 16px 8px', padding: '7px 10px', borderRadius: 6, background: 'var(--c-inset)', color: 'var(--c-text-dim)', fontSize: 12 }}>
          {PLAN_BANNERS.noneSavedYet(PLAN_DIR)}
        </div>
      ) : null}
      {planListCapped ? (
        <div style={{ margin: '0 16px 8px', padding: '7px 10px', borderRadius: 6, background: 'var(--c-amber-soft)', color: 'var(--c-warn)', fontSize: 12 }}>
          {PLAN_BANNERS.listingCapped(DOCS_LIST_CAP)}
        </div>
      ) : null}
      {duplicateStoryIds(stories).length ? (
        <div style={{ margin: '0 16px 8px', padding: '7px 10px', borderRadius: 6, background: 'var(--c-amber-soft)', color: 'var(--c-warn)', fontSize: 12 }}>
          {PLAN_BANNERS.duplicateIds(duplicateStoryIds(stories))}
        </div>
      ) : null}
      <div style={columnsWrap}>
        {STORY_COLUMNS.map((col) => (
          <div key={col.id} style={column} onDragOver={(e) => e.preventDefault()} onDrop={() => dropTo(col.id)}>
            <div style={colHead}>
              <span>{col.label}</span>
              <span>{cols[col.id].length}</span>
            </div>
            <div style={colBody}>
              {cols[col.id].length === 0 ? (
                <div style={{ fontSize: 11, color: 'var(--c-text-faint)', textAlign: 'center', padding: '18px 0' }}>—</div>
              ) : (
                cols[col.id].map((s) => (
                  <Card
                    key={s.id}
                    story={s}
                    color={projects.find((p) => p.id === s.project_id)?.color}
                    onDragStart={() => setDragId(s.id)}
                    onEdit={() => setEditing(s)}
                    onDispatch={() => setDispatchFor(s)}
                    onDelete={() => del(s.id)}
                    plan={planFileFor(planFiles, s.story_id)}
                    onPlan={() => openPlan(s)}
                  />
                ))
              )}
            </div>
          </div>
        ))}
      </div>
      {planFor ? (
        <PlanDrawer
          story={planFor.story}
          state={planFor.state}
          err={planFor.err}
          onClose={() => setPlanFor(null)}
          onToggle={togglePlanTask}
        />
      ) : null}
      {editing ? (
        <StoryModal
          story={editing === 'new' ? null : editing}
          projects={projects}
          defaultProject={selProject}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null)
            reload()
          }}
        />
      ) : null}
      {dispatchFor ? (
        <DispatchModal
          story={dispatchFor}
          sessions={sessions}
          active={active}
          onClose={() => setDispatchFor(null)}
          onDone={() => {
            setDispatchFor(null)
            reload()
          }}
        />
      ) : null}
    </div>
  )
}

