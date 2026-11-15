import { useCallback, useEffect, useRef, useState } from 'react'
import { noChatProjects, type ChatProjectsOp, type ChatProjectsState } from '@shared/chat-projects'
import { migrationNote } from '@shared/chat-projects-migration'
import {
  CHAT_PROJECTS_MIGRATED_KEY,
  CHAT_PROJECTS_SERVED_KEY,
  batchSummary,
  filingOutcome,
  hintsFromDaemon,
  parseMigrated,
  projectsMode,
  questionWords,
  storeFromDaemon,
  writeDismissedOnly,
  type FilingOutcome,
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
 * WAIT is the moment before that is known (and a Prometheus that has served projects but is not answering): the local projects are
 * drawn, and nothing that would make or change a project is done, so nothing made here can pin the sidebar to the local ones.
 *
 * DAEMON: the projects and the filings are the Prometheus's, read through main; every change is asked of main, which asks the
 * Prometheus. What stays on this computer is the dismissed suggestions, written into the stored local store with every project and
 * filing in it left exactly as it is.
 */
export interface ProjectsSource {
  mode: ProjectsMode
  /** What the sidebar draws. */
  store: ProjectStore
  /** The Prometheus's suggestions, in daemon mode; null otherwise (the caller uses the hints main works out from the cache). */
  hints: Record<string, ProjectHint> | null
  /** `after` runs once the conversation is filed, however long a question takes (the caller's unpin of a dragged pinned row). */
  fileInto(sessionId: string, projectId: string | null, title?: string, after?: () => void): void
  acceptHint(sessionIds: string[], label: string): void
  dismissHints(items: Array<{ sessionId: string; key: string }>): void
  createProject(name: string, sessionId?: string, title?: string): void
  renameProject(projectId: string, name: string): void
  removeProject(projectId: string): void
  /** Daemon mode only: start a conversation inside a project, and open it. */
  startIn(projectId: string): void
  /** The project's folder on the Prometheus's computer (daemon mode), for a tooltip. */
  folderOf(projectId: string): string | null
  /** The Prometheus's revision of its project list: it moves when a project's instructions or files change (daemon mode; else null). */
  listRev: number | null
  /** A question the Prometheus asked back about a filing; null when none. */
  question: { words: ReturnType<typeof questionWords>; q: FilingQuestion } | null
  /** Answer it with one of its choices, or null to cancel (nothing is sent). */
  answer(choice: number | null): void
  /** One line about what just happened, in words; null when none. */
  note: string | null
  clearNote(): void
}

const NOTE_MS = 9000
const WAIT_NOTE = 'Projects are still loading from Prometheus. Try again in a moment.'
/** Refusals that say the whole batch will fail the same way: it stops. */
const SYSTEMIC = new Set(['unreachable', 'not_owner', 'unknown_project', 'unsupported', 'bad_folder'])

type Tried = { kind: 'done'; note: string | null; workspace?: string | null } | { kind: 'asked'; question: FilingQuestion } | { kind: 'refused'; message: string; systemic: boolean }

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

  // Whether the local projects have been moved to this Prometheus, and whether it has ever served projects. Read again when what main
  // knows changes (the move writes the first, main writes the second).
  const [migrated, setMigrated] = useState<boolean | null>(null)
  const [servedBefore, setServedBefore] = useState<boolean | null>(null)
  useEffect(() => {
    let alive = true
    void window.beacon?.settings
      .get(CHAT_PROJECTS_MIGRATED_KEY)
      .then((raw) => alive && setMigrated(parseMigrated(raw)))
      .catch(() => alive && setMigrated(false))
    void window.beacon?.settings
      .get(CHAT_PROJECTS_SERVED_KEY)
      .then((raw) => alive && setServedBefore(raw === '1'))
      .catch(() => alive && setServedBefore(false))
    return () => {
      alive = false
    }
  }, [state.known, state.available, state.list?.rev, state.migration?.status])

  const mode = projectsMode({ state, migrated, local: localLoaded ? local : null, servedBefore })
  const daemon = mode === 'daemon'
  const waiting = mode === 'wait'
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
  // The move of this computer's projects to the Prometheus: told once for each way it ends.
  const toldAbout = useRef('')
  useEffect(() => {
    const m = state.migration
    const line = m ? migrationNote(m) : null
    const key = m ? `${m.status}|${m.projects}|${m.moved}|${m.leftovers}` : ''
    if (!line || toldAbout.current === key) return
    toldAbout.current = key
    say(line)
  }, [state.migration, say])
  const [asked, setAsked] = useState<FilingQuestion | null>(null)
  /** What to do once the filing a question is about has gone through. */
  const afterAsked = useRef<(() => void) | undefined>(undefined)
  const batching = useRef(false)

  const run = useCallback(async (op: ChatProjectsOp) => window.beacon.chatProjects.run(op), [])
  const projectOf = (id: string): { id: string; name: string; folder: string } | null => {
    const p = state.list?.projects.find((x) => x.id === id)
    return p ? { id: p.id, name: p.name, folder: p.folder } : null
  }
  const hold = (): boolean => {
    if (!waiting) return false
    say(WAIT_NOTE)
    return true
  }

  /** One filing on the Prometheus, with no effect on the screen: the caller decides what to show. */
  const tryFile = async (
    sessionId: string,
    projectId: string | null,
    title: string,
    o: { keep?: boolean; replace?: boolean } = {},
    // A project made a moment ago is not in the state this function captured: the caller says which it is.
    known?: { id: string; name: string; folder: string }
  ): Promise<Tried> => {
    const result = await run({ op: 'file', sessionId, projectId, ...(o.keep ? { keep: true } : {}), ...(o.replace ? { replace: true } : {}) })
    const outcome: FilingOutcome = filingOutcome(result, { sessionId, title, project: projectId ? (known ?? projectOf(projectId)) : null, keep: o.keep === true, unfiling: projectId === null })
    if (outcome.kind === 'done') return { kind: 'done', note: outcome.note, workspace: result.ok ? result.workspace : null }
    if (outcome.kind === 'ask') return { kind: 'asked', question: outcome.question }
    return { kind: 'refused', message: outcome.message, systemic: !result.ok && SYSTEMIC.has(result.kind) }
  }

  /** One filing the person asked for: a note when it went through, a question when the Prometheus asks, the sentence when it refuses. */
  const fileDaemon = async (
    sessionId: string,
    projectId: string | null,
    title: string,
    o: { keep?: boolean; replace?: boolean } = {},
    known?: { id: string; name: string; folder: string },
    after?: () => void
  ): Promise<boolean> => {
    const t = await tryFile(sessionId, projectId, title, o, known)
    if (t.kind === 'done') {
      if (t.note) say(t.note)
      after?.()
      return true
    }
    if (t.kind === 'asked') {
      afterAsked.current = after
      setAsked(t.question)
    } else say(t.message)
    return false
  }

  const fileInto = (sessionId: string, projectId: string | null, title = '', after?: () => void): void => {
    if (hold()) return
    if (!daemon) {
      updateLocal((s) => assignSession(s, sessionId, projectId))
      after?.()
      return
    }
    void fileDaemon(sessionId, projectId, title, {}, undefined, after)
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
    if (hold()) return
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
    if (batching.current) return // a second click on the same button
    batching.current = true
    void (async () => {
      try {
        // Into the project of the same name if there is one (the Prometheus says so itself), else a new one.
        const existing = findProjectByName(store, label)
        const project = existing ? projectOf(existing.id) : await createDaemon(label)
        if (!project) return
        let moved = 0
        let labelled = 0
        let refused = 0
        let why: string | null = null
        for (const sid of sessionIds) {
          let t = await tryFile(sid, project.id, '', {}, project)
          // A question about a folder somebody chose: in a batch the conversation is filed as a label, never moved, and the person is told.
          if (t.kind === 'asked') {
            t = await tryFile(sid, project.id, '', { keep: true }, project)
            if (t.kind === 'done') labelled++
          } else if (t.kind === 'done') moved++
          if (t.kind === 'refused') {
            refused++
            why ??= t.message
            if (t.systemic) break
          } else if (t.kind === 'asked') refused++
        }
        say(batchSummary({ project: project.name, folder: project.folder || null, moved, labelled, refused, why }))
      } finally {
        batching.current = false
      }
    })()
  }

  const dismissHints = (items: Array<{ sessionId: string; key: string }>): void => {
    if (!daemon) return updateLocal((s) => items.reduce((acc, it) => dismissSuggestion(acc, it.sessionId, it.key), s))
    // Daemon mode: only the dismissed suggestions are written, into the stored store as it stands. Re-serialising what was parsed would
    // drop whatever this version reads as invalid, from a copy the person was told is kept.
    if (!loaded.current) return
    setLocal((prev) => {
      const dismissed = items.reduce((acc, it) => dismissSuggestion(acc, it.sessionId, it.key), prev).dismissed
      void (async () => {
        const raw = await window.beacon?.settings.get(SESSION_PROJECTS_SETTING_KEY).catch(() => undefined)
        if (raw === undefined) return
        const out = writeDismissedOnly(raw, dismissed)
        if (out) await window.beacon.settings.set(SESSION_PROJECTS_SETTING_KEY, out).catch(() => undefined)
      })()
      return { ...prev, dismissed }
    })
  }

  const createProjectAction = (name: string, sessionId?: string, title = ''): void => {
    if (hold()) return
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
    if (hold()) return
    if (!daemon) return updateLocal((s) => renameProject(s, projectId, name))
    void run({ op: 'rename', id: projectId, name }).then((r) => {
      if (!r.ok) say(r.message)
    })
  }

  const removeProjectAction = (projectId: string): void => {
    if (hold()) return
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
    const after = afterAsked.current
    afterAsked.current = undefined
    setAsked(null)
    if (!q || choice === null) return
    const pick = questionWords(q).choices[choice]
    if (pick) void fileDaemon(q.sessionId, q.projectId, q.title, pick.send, { id: q.projectId, name: q.projectName, folder: q.projectFolder ?? '' }, after)
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
    listRev: daemon ? (state.list?.rev ?? null) : null,
    question: asked ? { words: questionWords(asked), q: asked } : null,
    answer,
    note,
    clearNote: () => say(null)
  }
}
