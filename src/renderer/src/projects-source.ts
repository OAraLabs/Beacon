import { useCallback, useEffect, useRef, useState } from 'react'
import { noChatProjects, type ChatProjectsOp, type ChatProjectsState } from '@shared/chat-projects'
import {
  CHAT_PROJECTS_MIGRATED_KEY,
  batchNote,
  filingOutcome,
  hintsFromDaemon,
  parseMigrated,
  projectsMode,
  questionWords,
  storeFromDaemon,
  type FilingQuestion,
  type ProjectsMode
} from '@shared/chat-projects-view'
import {
  SESSION_PROJECTS_SETTING_KEY,
  assignSession,
  createProject,
  deleteProject,
  dismissSuggestion,
  emptyProjectStore,
  findProjectByName,
  parseProjectStore,
  renameProject,
  serializeProjectStore,
  type ProjectHint,
  type ProjectStore
} from '@shared/session-projects'

/**
 * The projects the sidebar draws and changes (@shared/chat-projects-view says which: the daemon's, or this computer's).
 *
 * LOCAL is the sidebar as it always was: the store in the settings KV, changed by the same pure functions. It is the only thing used
 * until the Prometheus says it serves projects AND this Beacon is its owner AND the local projects have been moved to it (or there are
 * none): nothing about it changes for a Prometheus that does not.
 *
 * DAEMON: the projects and the filings are the Prometheus's, read through main; every change is asked of main, which asks the
 * Prometheus. What stays on this computer is the dismissed suggestions, in the same local store, with its projects and filings left
 * exactly as they are.
 */
export interface ProjectsSource {
  mode: ProjectsMode
  /** What the sidebar draws. */
  store: ProjectStore
  /** The Prometheus's suggestions, in daemon mode; null in local mode (the caller uses the hints main works out from the cache). */
  hints: Record<string, ProjectHint> | null
  fileInto(sessionId: string, projectId: string | null, title?: string): void
  acceptHint(sessionIds: string[], label: string): void
  dismissHints(items: Array<{ sessionId: string; key: string }>): void
  createProject(name: string, sessionId?: string, title?: string): void
  renameProject(projectId: string, name: string): void
  removeProject(projectId: string): void
  /** Daemon mode only: start a conversation inside a project, and open it. */
  startIn(projectId: string): void
  /** The project's folder on the Prometheus's computer (daemon mode), for a tooltip. */
  folderOf(projectId: string): string | null
  /** A question the Prometheus asked back about a filing; null when none. */
  question: { words: ReturnType<typeof questionWords>; q: FilingQuestion } | null
  /** Answer it with one of its choices, or null to cancel (nothing is sent). */
  answer(choice: number | null): void
  /** One line about what just happened, in words; null when none. */
  note: string | null
  clearNote(): void
}

const NOTE_MS = 9000

export function useProjectsSource(onOpenSession: (sessionId: string) => void): ProjectsSource {
  // ── this computer's store, loaded once. `loaded` guards the save: a write before the read resolves would replace what is stored. ──
  const [local, setLocal] = useState<ProjectStore>(emptyProjectStore)
  const [localLoaded, setLocalLoaded] = useState(false)
  const loaded = useRef(false)
  useEffect(() => {
    let alive = true
    void window.beacon?.settings
      .get(SESSION_PROJECTS_SETTING_KEY)
      .then((raw) => {
        if (!alive) return
        loaded.current = true
        setLocal(parseProjectStore(raw))
        setLocalLoaded(true)
      })
      .catch(() => {
        // Unreadable: leave `loaded` false, so nothing this session writes can clobber what is stored.
      })
    return () => {
      alive = false
    }
  }, [])
  const updateLocal = useCallback((fn: (s: ProjectStore) => ProjectStore): void => {
    if (!loaded.current) return
    setLocal((prev) => {
      const next = fn(prev)
      if (next !== prev) void window.beacon?.settings.set(SESSION_PROJECTS_SETTING_KEY, serializeProjectStore(next)).catch(() => undefined)
      return next
    })
  }, [])

  // ── the Prometheus's projects, from main ───────────────────────────────────────────────────────────────────────────────────────
  const [state, setState] = useState<ChatProjectsState>(noChatProjects)
  useEffect(() => {
    const cp = window.beacon?.chatProjects
    if (!cp) return
    let alive = true
    void cp.state().then((s) => alive && setState(s)).catch(() => undefined)
    const off = cp.onState((s) => alive && setState(s))
    return () => {
      alive = false
      off()
    }
  }, [])

  // Whether the local projects have been moved to this Prometheus. Read again when what main knows changes (the move writes it).
  const [migrated, setMigrated] = useState<boolean | null>(null)
  useEffect(() => {
    let alive = true
    void window.beacon?.settings
      .get(CHAT_PROJECTS_MIGRATED_KEY)
      .then((raw) => alive && setMigrated(parseMigrated(raw)))
      .catch(() => alive && setMigrated(false))
    return () => {
      alive = false
    }
  }, [state.available, state.list?.rev])

  const mode = projectsMode({ state, migrated, local: localLoaded ? local : null })
  const daemon = mode === 'daemon'
  const store = daemon ? storeFromDaemon(state, local.dismissed) : local

  // ── what just happened ─────────────────────────────────────────────────────────────────────────────────────────────────────────
  const [note, setNote] = useState<string | null>(null)
  const noteTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const say = useCallback((text: string | null): void => {
    if (noteTimer.current) clearTimeout(noteTimer.current)
    setNote(text)
    if (text) noteTimer.current = setTimeout(() => setNote(null), NOTE_MS)
  }, [])
  useEffect(
    () => () => {
      if (noteTimer.current) clearTimeout(noteTimer.current)
    },
    []
  )
  const [asked, setAsked] = useState<FilingQuestion | null>(null)

  const run = useCallback(async (op: ChatProjectsOp) => window.beacon.chatProjects.run(op), [])
  const projectOf = (id: string): { id: string; name: string; folder: string } | null => {
    const p = state.list?.projects.find((x) => x.id === id)
    return p ? { id: p.id, name: p.name, folder: p.folder } : null
  }

  /** One filing on the Prometheus. Returns whether it was filed; a question is shown and a refusal said, neither decided for the person. */
  const fileDaemon = async (
    sessionId: string,
    projectId: string | null,
    title: string,
    o: { keep?: boolean; replace?: boolean } = {},
    // A project made a moment ago is not in the state this function captured: the caller says which it is.
    known?: { id: string; name: string; folder: string }
  ): Promise<boolean> => {
    const result = await run({ op: 'file', sessionId, projectId, ...(o.keep ? { keep: true } : {}), ...(o.replace ? { replace: true } : {}) })
    const outcome = filingOutcome(result, { sessionId, title, project: projectId ? (known ?? projectOf(projectId)) : null, keep: o.keep === true, unfiling: projectId === null })
    if (outcome.kind === 'done') {
      if (outcome.note) say(outcome.note)
      return true
    }
    if (outcome.kind === 'ask') setAsked(outcome.question)
    else say(outcome.message)
    return false
  }

  const fileInto = (sessionId: string, projectId: string | null, title = ''): void => {
    if (!daemon) return updateLocal((s) => assignSession(s, sessionId, projectId))
    void fileDaemon(sessionId, projectId, title)
  }

  const createDaemon = async (name: string): Promise<{ id: string; name: string; folder: string } | null> => {
    const r = await run({ op: 'create', name })
    if (!r.ok) {
      say(r.message)
      return null
    }
    return r.project ? { id: r.project.id, name: r.project.name, folder: r.project.folder } : null
  }

  const acceptHint = (sessionIds: string[], label: string): void => {
    if (!daemon) {
      updateLocal((s) => {
        const made = createProject(s, label)
        if (!made.id) return s
        let next = made.store
        for (const sid of sessionIds) next = assignSession(next, sid, made.id)
        return next
      })
      return
    }
    void (async () => {
      // Into the project of the same name if there is one (the Prometheus says so itself), else a new one.
      const existing = findProjectByName(store, label)
      const project = existing ? projectOf(existing.id) : await createDaemon(label)
      if (!project) return
      let left = 0
      for (const sid of sessionIds) {
        const filed = await fileDaemon(sid, project.id, '', {}, project)
        if (!filed) {
          // A question came back (a folder already chosen): in a batch it is filed as a label, never moved. The person is told.
          setAsked(null)
          if (await fileDaemon(sid, project.id, '', { keep: true }, project)) left++
        }
      }
      if (left > 0) say(batchNote(left))
    })()
  }

  const dismissHints = (items: Array<{ sessionId: string; key: string }>): void =>
    updateLocal((s) => items.reduce((acc, it) => dismissSuggestion(acc, it.sessionId, it.key), s))

  const createProjectAction = (name: string, sessionId?: string, title = ''): void => {
    if (!daemon) {
      updateLocal((s) => {
        const made = createProject(s, name)
        return made.id && sessionId ? assignSession(made.store, sessionId, made.id) : made.store
      })
      return
    }
    void (async () => {
      const project = await createDaemon(name)
      if (project && sessionId) await fileDaemon(sessionId, project.id, title, {}, project)
    })()
  }

  const renameProjectAction = (projectId: string, name: string): void => {
    if (!daemon) return updateLocal((s) => renameProject(s, projectId, name))
    void run({ op: 'rename', id: projectId, name }).then((r) => {
      if (!r.ok) say(r.message)
    })
  }

  const removeProjectAction = (projectId: string): void => {
    if (!daemon) return updateLocal((s) => deleteProject(s, projectId))
    void run({ op: 'remove', id: projectId }).then((r) => {
      if (!r.ok) return say(r.message)
      const n = r.unfiled ?? 0
      say(n > 0 ? `Project deleted. ${n} conversation${n === 1 ? ' is' : 's are'} unfiled. Its folder and files are still on that computer.` : 'Project deleted. Its folder and files are still on that computer.')
    })
  }

  const startIn = (projectId: string): void => {
    if (!daemon) return
    void run({ op: 'start', projectId }).then((r) => {
      if (!r.ok) return say(r.message)
      if (r.sessionId) onOpenSession(r.sessionId)
    })
  }

  const answer = (choice: number | null): void => {
    const q = asked
    setAsked(null)
    if (!q || choice === null) return
    const pick = questionWords(q).choices[choice]
    if (pick) void fileDaemon(q.sessionId, q.projectId, q.title, pick.send, { id: q.projectId, name: q.projectName, folder: q.projectFolder ?? '' })
  }

  return {
    mode,
    store,
    hints: daemon ? hintsFromDaemon(state) : null,
    fileInto,
    acceptHint,
    dismissHints,
    createProject: createProjectAction,
    renameProject: renameProjectAction,
    removeProject: removeProjectAction,
    startIn,
    folderOf: (id) => (daemon ? (projectOf(id)?.folder ?? null) : null),
    question: asked ? { words: questionWords(asked), q: asked } : null,
    answer,
    note,
    clearNote: () => say(null)
  }
}
