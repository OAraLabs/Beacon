import { useCallback, useEffect, useRef, useState, type DragEvent as RDragEvent, type ReactNode } from 'react'
import type { SessionSummary } from '@shared/ipc'
import { Icon } from './Icon'
import {
  groupSessions,
  parseCollapse,
  PINNED_BUCKET,
  UNFILED_BUCKET,
  SESSION_BUCKETS,
  resolveCollapse,
  serializeCollapse,
  sidebarPseudoBuckets,
  SESSION_GROUPS_SETTING_KEY,
  type GroupCollapse
} from '@shared/session-groups'
import { buildSourceChips, chipKeyFor, inSelectedSources, isDefaultVisible, sourceLabel, toggleSource } from '@shared/session-sources'
import { ContextMeter } from './ContextMeter'
import { useGateway } from '../gateway-store'
import { rowIndicator, type SessionTurn } from '@shared/session-activity'
import { SESSION_LIST_WIDTH } from '@shared/side-panel'
import { SESSION_DRAG_TYPE } from '@shared/split-panes'
import {
  assignSession,
  createProject,
  deleteProject,
  dismissSuggestion,
  emptyProjectStore,
  parseProjectStore,
  renameProject,
  rowSuggestion,
  serializeProjectStore,
  SESSION_PROJECTS_SETTING_KEY,
  SESSION_UNFILED_SETTING_KEY,
  parseUnfiledMode,
  type UnfiledMode,
  type ProjectHint,
  type ProjectStore
} from '@shared/session-projects'

/** How often the sidebar re-asks main for project hints while it is open. Hints move slowly (a
 *  session needs several tool calls to shift a majority), and main re-reads only changed sessions. */
const HINT_REFRESH_MS = 120_000

/** The drag payload type: a session id, and only from this sidebar. Shared with the chat area's split
 *  zones (@shared/split-panes), which accept the same drag. */
const DRAG_TYPE = SESSION_DRAG_TYPE

type Menu =
  | { kind: 'row'; sessionId: string; x: number; y: number }
  | { kind: 'project'; projectId: string; x: number; y: number }
  | { kind: 'unfiled'; x: number; y: number }

/** Naming: a new project (optionally filing the session that was dropped to make it), or a rename. */
type Naming = { kind: 'new'; sessionId?: string; value: string } | { kind: 'rename'; projectId: string; value: string }

function pct(share: number): string {
  return `${Math.round(share * 100)}%`
}

/** A context menu at the pointer: fixed, clamped into the window, closed by Escape, an outside
 *  press, or a scroll of the sidebar. Items are plain buttons, so the keyboard reaches them with Tab. */
function ContextMenu({ x, y, onClose, children, label }: { x: number; y: number; onClose: () => void; children: ReactNode; label: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ left: x, top: y })
  useEffect(() => {
    const el = ref.current
    if (el) {
      const r = el.getBoundingClientRect()
      setPos({ left: Math.max(4, Math.min(x, window.innerWidth - r.width - 4)), top: Math.max(4, Math.min(y, window.innerHeight - r.height - 4)) })
      el.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
    }
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    // Close when the SIDEBAR scrolls (the row it points at moved), not on every scroll in the window:
    // a streaming reply auto-scrolls the thread several times a second, and a document-wide listener
    // closed the menu the instant it opened whenever a turn was running.
    const onScroll = (e: Event): void => {
      const t = e.target
      if (t === document || (t instanceof Element && !!t.closest('.sidebar'))) onClose()
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    window.addEventListener('blur', onClose)
    document.addEventListener('scroll', onScroll, true)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('blur', onClose)
      document.removeEventListener('scroll', onScroll, true)
    }
  }, [x, y, onClose])
  return (
    <div ref={ref} className="ctx-menu" role="menu" aria-label={label} style={{ left: pos.left, top: pos.top }}>
      {children}
    </div>
  )
}

/** A turn running in this session. The arc turns a quarter per daemon pulse, never on a CSS timer
 * (the ActivityLine rule), so a frozen arc is itself the signal that the pulse stopped; past the
 * stall threshold it goes hollow and says so. Idle and done render nothing here — done-but-unread
 * is the unread dot beside it. */
function TurnIndicator({ turn, now }: { turn: SessionTurn | undefined; now: number }) {
  const ind = rowIndicator(turn, now)
  if (!ind) return null
  return (
    <span
      className={`turn-ind is-${ind.kind}`}
      role="img"
      aria-label={ind.label}
      title={ind.label}
      style={ind.kind === 'working' ? { transform: `rotate(${ind.tick * 90}deg)` } : undefined}
    />
  )
}

// The sessions panel (design handoff 2026-09-03, screen 3): find one session among 182. Three
// SCOPES — All · Unread · Voice — plus a filter button carrying its active count; the sources
// (Beacon, iOS, Desktop, Web, Telegram, Automated, Harness, Unlabelled) are a facet, not a
// top-level mode, so they live in a popover. The original showed eleven chips across four rows,
// roughly 110px of chrome before the first session. Rows are compact (28px) by default — what
// scales to 182. The footer is the context meter for the open conversation.

type Scope = 'all' | 'unread' | 'voice'

interface Props {
  sessions: SessionSummary[]
  active: string
  unread: Record<string, boolean>
  onSelect: (id: string) => void
  /** Forget a session for good (hover ✕). MainView confirms, calls the bridge, then refreshes. */
  onForget: (id: string) => void
  /** Local display-name overrides (settings `title:<id>`, Slice 6) — the daemon's id stays canonical. */
  titles?: Record<string, string>
  /** Rename (Slice 6): persists a LOCAL title override; never touches the daemon. */
  onRename?: (id: string, title: string) => void
  /** New chat (Slice 6): POST /api/sessions then select the fresh session. */
  onNew?: () => void
  /** Pinned session ids — rendered as the leading group. DAEMON-OWNED (`SessionSummary.pinned`,
   * Prometheus issue 351): every client agrees because none of them owns it. MainView migrates any
   * leftover local `pinned:<id>` setting up to the daemon and clears the local row.
   * (Issue refs in renderer files are written without a hash prefix: lint:tokens reads a
   * hash followed by three hex digits as a colour literal.) */
  pinned?: Record<string, boolean>
  /** Toggle a pin. Writes to the daemon, not to local settings. */
  onTogglePin?: (id: string, pinned: boolean) => void
  /** R2: the chat surface has no pill row (the thread owns its header), so the Chats group's other
   *  section — the Sessions manager — is reached from here. */
  onManage?: () => void
  /** The footer meter's click-through (Status holds the full breakdown). */
  onOpenStatus?: () => void
  /** Rendered width (already fitted to the window by the owner). Absent: the default. */
  width?: number
  /** Commit a dragged width (the owner persists it as the DESIRED width). */
  onWidth?: (w: number) => void
  /** The owner's fit, so a live drag shows exactly the width a release would commit. */
  fitWidth?: (w: number) => number
  /** Sessions open in their own windows (@shared/session-windows). Their rows carry a marker, and a
   *  click brings the window forward (the owner's onSelect does that routing). */
  popped?: ReadonlySet<string>
  onPopOut?: (id: string) => void
  onReturnHere?: (id: string) => void
  /** Sessions on screen in a split pane other than the focused one (@shared/split-panes). */
  onScreen?: ReadonlySet<string>
  /** Open a session in a new pane beside the focused one. `canOpenBeside` false: no room for another. */
  onOpenBeside?: (id: string) => void
  canOpenBeside?: boolean
}

const GATEWAY_BADGE: Record<string, string> = {
  beacon: 'BN',
  telegram: 'TG',
  desktop: 'DT',
  slack: 'SL',
  discord: 'DC'
}

function badge(gateway?: string): string {
  if (!gateway) return '?'
  return GATEWAY_BADGE[gateway] ?? gateway.slice(0, 2).toUpperCase()
}

/** Display name: manual rename > content-derived auto-title (cache, Slice 6 follow-up) > id tail.
 *  NOT truncated here: the list is resizable now, and a character cap cut titles at 24 whatever the
 *  width. Every place that shows it ellipsizes in CSS, so a wider list shows more of the title. */
function shortTitle(s: SessionSummary, override?: string): string {
  const named = override || (s.title && s.title !== s.id ? s.title : '')
  if (named) return named
  const id = s.id
  return id.includes(':') ? id.slice(id.indexOf(':') + 1) : id
}

/** The list's right-edge divider. Same contract as the dock's: drag (pointer capture), arrow keys
 *  on focus (Shift for bigger steps), Home or a double-click for the default. The line itself is the
 *  sidebar's border; this is a wider invisible grab strip over it, so it takes no layout width. */
function ListDivider({
  width,
  live,
  setLive,
  onWidth,
  fit
}: {
  width: number
  live: number | null
  setLive: (w: number | null) => void
  onWidth: (w: number) => void
  fit: (w: number) => number
}) {
  const dragging = live !== null
  useEffect(() => {
    if (!dragging) return
    document.body.classList.add('is-resizing-panel')
    return () => document.body.classList.remove('is-resizing-panel')
  }, [dragging])
  const shown = live ?? width
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return
    e.preventDefault()
    const div = e.currentTarget
    const startX = e.clientX
    const startW = width
    let latest = startW
    setLive(startW)
    try {
      div.setPointerCapture(e.pointerId)
    } catch {
      /* a synthetic pointer (a probe) has no capture; the listeners below still work */
    }
    const move = (ev: PointerEvent): void => {
      // The divider is on the list's RIGHT edge: dragging right widens it. Floored at 1: a drag
      // past the window's left edge asks for a negative width, which the fit reads as "unreadable"
      // and answers with the DEFAULT, so the list jumped back to 264 instead of stopping at its minimum.
      latest = fit(Math.max(1, startW + (ev.clientX - startX)))
      setLive(latest)
    }
    const up = (ev: PointerEvent): void => {
      div.removeEventListener('pointermove', move)
      div.removeEventListener('pointerup', up)
      div.removeEventListener('pointercancel', up)
      try {
        div.releasePointerCapture(ev.pointerId)
      } catch {
        /* already released */
      }
      setLive(null)
      onWidth(latest)
    }
    div.addEventListener('pointermove', move)
    div.addEventListener('pointerup', up)
    div.addEventListener('pointercancel', up)
  }
  const onKey = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    const step = e.shiftKey ? 64 : 16
    if (e.key === 'ArrowRight') onWidth(fit(width + step))
    else if (e.key === 'ArrowLeft') onWidth(fit(width - step))
    else if (e.key === 'Home') onWidth(SESSION_LIST_WIDTH)
    else return
    e.preventDefault()
  }
  return (
    <>
      <div
        className={`sidebar-divider${live !== null ? ' is-dragging' : ''}`}
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize the sessions list"
        aria-valuenow={Math.round(shown)}
        title="Drag to resize · double-click to reset"
        tabIndex={0}
        onPointerDown={onPointerDown}
        onDoubleClick={() => onWidth(SESSION_LIST_WIDTH)}
        onKeyDown={onKey}
      />
      {/* Keeps the pointer in the shell's document while dragging: the browser pane is a separate
          native surface that would otherwise swallow it (the dock's divider does the same). */}
      {live !== null ? <div className="side-panel-drag-shield" aria-hidden /> : null}
    </>
  )
}

/** Relative time — created_at is real now, so this is meaningful (Step 6). */
function relTime(ms?: number): string {
  if (!ms) return ''
  const s = Math.floor((Date.now() - ms) / 1000)
  if (s < 60) return 'now'
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h`
  return `${Math.floor(h / 24)}d`
}

/** Local filter (Slice 6): id + title override, case-insensitive contains. */
function matches(s: SessionSummary, q: string, override?: string): boolean {
  if (!q) return true
  const ql = q.toLowerCase()
  return s.id.toLowerCase().includes(ql) || (override ?? '').toLowerCase().includes(ql)
}

export function Sidebar({ sessions, active, unread, onSelect, onForget, titles, onRename, onNew, pinned, onTogglePin, onManage, onOpenStatus, width, onWidth, fitWidth, popped, onPopOut, onReturnHere, onScreen, onOpenBeside, canOpenBeside }: Props) {
  const [query, setQuery] = useState('')
  // The list's width while its divider is being dragged; null otherwise (then `width` renders).
  const [liveWidth, setLiveWidth] = useState<number | null>(null)
  const { sessionActivity, activityNow } = useGateway()
  const searchRef = useRef<HTMLInputElement>(null)
  // ⌘F focuses the filter — because the field now SAYS `⌘F`, and a hint for a chord that does
  // nothing is a small lie the user pays for every time they try it. Plain ⌘F only: ⌘⇧F is
  // conversation search (MainView) and must keep its shift.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        searchRef.current?.focus()
        searchRef.current?.select()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  const [editing, setEditing] = useState<string | null>(null)
  const [editValue, setEditValue] = useState('')
  // MULTI-SELECT (match spec, step 15): the chips are additive. Empty is not "no matches" —
  // it is the default view, which is how you get back to normal after clearing the last chip.
  const [sources, setSources] = useState<string[]>([])
  const [scope, setScope] = useState<Scope>('all')
  const [filtersOpen, setFiltersOpen] = useState(false)
  const filterRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!filtersOpen) return
    const onDoc = (e: MouseEvent): void => {
      if (filterRef.current && !filterRef.current.contains(e.target as Node)) setFiltersOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [filtersOpen])
  // 'Older' and every registered pseudo-bucket ('Desktop', 'Harness') start
  // collapsed — they hold the long tails. Everything recent stays open.
  //
  // PERSISTED as of this change. This was plain useState, so `Older` re-collapsed
  // on every launch and any toggle was lost on restart — true before Harness
  // existed, and a second collapsed group would have doubled it. Same mechanism
  // the nav rail uses for its groups (settings KV, versioned key, garbage-safe
  // parse), so there is one way to persist a collapse in this app, not two.
  const [collapsed, setCollapsed] = useState<GroupCollapse>(() => resolveCollapse(null))
  useEffect(() => {
    let alive = true
    void window.beacon?.settings
      .get(SESSION_GROUPS_SETTING_KEY)
      .then((raw) => {
        if (alive) setCollapsed(resolveCollapse(parseCollapse(raw)))
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [])

  const toggleGroup = (bucket: string): void => {
    setCollapsed((c) => {
      const next = { ...c, [bucket]: !c[bucket] }
      void window.beacon?.settings.set(SESSION_GROUPS_SETTING_KEY, serializeCollapse(next)).catch(() => undefined)
      return next
    })
  }

  // ── Projects (@shared/session-projects) ──────────────────────────────────
  // Local settings KV, loaded once. `loaded` guards the save: a write before the read resolves
  // would replace the stored projects with an empty store.
  const [store, setStore] = useState<ProjectStore>(emptyProjectStore)
  const loaded = useRef(false)
  useEffect(() => {
    let alive = true
    void window.beacon?.settings
      .get(SESSION_PROJECTS_SETTING_KEY)
      .then((raw) => {
        if (!alive) return
        loaded.current = true
        setStore(parseProjectStore(raw))
      })
      .catch(() => {
        // Unreadable: leave `loaded` false, so nothing this session writes can clobber what is stored.
      })
    return () => {
      alive = false
    }
  }, [])
  const updateStore = useCallback((fn: (s: ProjectStore) => ProjectStore): void => {
    if (!loaded.current) return
    setStore((prev) => {
      const next = fn(prev)
      if (next !== prev) void window.beacon?.settings.set(SESSION_PROJECTS_SETTING_KEY, serializeProjectStore(next)).catch(() => undefined)
      return next
    })
  }, [])

  // Hints come from main's read of the local cache. Re-asked when the open session changes
  // (opening one is what pulls its history into the cache) and on a slow timer.
  const [hints, setHints] = useState<Record<string, ProjectHint>>({})
  useEffect(() => {
    let alive = true
    const load = (): void => {
      void window.beacon?.sessions
        ?.projectHints?.()
        .then((h) => {
          if (alive && h && typeof h === 'object') setHints(h)
        })
        .catch(() => undefined)
    }
    load()
    const t = window.setInterval(load, HINT_REFRESH_MS)
    return () => {
      alive = false
      window.clearInterval(t)
    }
  }, [active])

  // How unfiled sessions show: by date (the default) or as one Unfiled list. Settings KV, like the
  // collapse state; a write before the read resolves is allowed here because the value is a whole
  // replacement, not a merge into something stored.
  const [unfiledMode, setUnfiledMode] = useState<UnfiledMode>('date')
  useEffect(() => {
    let alive = true
    void window.beacon?.settings
      .get(SESSION_UNFILED_SETTING_KEY)
      .then((raw) => {
        if (alive) setUnfiledMode(parseUnfiledMode(raw))
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [])
  const chooseUnfiled = (mode: UnfiledMode): void => {
    setUnfiledMode(mode)
    void window.beacon?.settings.set(SESSION_UNFILED_SETTING_KEY, mode).catch(() => undefined)
  }

  const [menu, setMenu] = useState<Menu | null>(null)
  const closeMenu = useCallback(() => setMenu(null), [])
  const [naming, setNaming] = useState<Naming | null>(null)
  const [reviewOpen, setReviewOpen] = useState(false)
  const [dragging, setDragging] = useState<string | null>(null)
  const [dropOn, setDropOn] = useState<string | null>(null)

  const fileInto = (sessionId: string, projectId: string | null): void => updateStore((s) => assignSession(s, sessionId, projectId))
  /** Accept a suggestion: into the project of the same name if there is one, else a new one. */
  const acceptHint = (sessionIds: string[], label: string): void =>
    updateStore((s) => {
      const made = createProject(s, label)
      if (!made.id) return s
      let next = made.store
      for (const sid of sessionIds) next = assignSession(next, sid, made.id)
      return next
    })
  const dismissHints = (items: Array<{ sessionId: string; key: string }>): void =>
    updateStore((s) => items.reduce((acc, it) => dismissSuggestion(acc, it.sessionId, it.key), s))
  const commitNaming = (): void => {
    const n = naming
    setNaming(null)
    if (!n) return
    if (n.kind === 'rename') updateStore((s) => renameProject(s, n.projectId, n.value))
    else
      updateStore((s) => {
        const made = createProject(s, n.value)
        return made.id && n.sessionId ? assignSession(made.store, n.sessionId, made.id) : made.store
      })
  }

  /**
   * A drop. Dragging is a MOVE, so a pinned row dragged out of Pinned is unpinned: otherwise the
   * pin (which outranks a project) would keep it in Pinned and the drop would appear to do nothing.
   * `target`: a project id, 'unfiled' (any recency or pseudo group), or 'pinned'.
   */
  const dropSession = (sessionId: string, target: string): void => {
    if (target === 'pinned') {
      if (!pinned?.[sessionId]) onTogglePin?.(sessionId, true)
      return
    }
    if (pinned?.[sessionId]) onTogglePin?.(sessionId, false)
    fileInto(sessionId, target === 'unfiled' ? null : target)
  }
  const dropProps = (target: string) => ({
    onDragOver: (e: RDragEvent): void => {
      if (!dragging) return
      e.preventDefault()
      e.dataTransfer.dropEffect = 'move'
      if (dropOn !== target) setDropOn(target)
    },
    onDragLeave: (e: RDragEvent): void => {
      if (!(e.currentTarget as Node).contains(e.relatedTarget as Node | null)) setDropOn((d) => (d === target ? null : d))
    },
    onDrop: (e: RDragEvent): void => {
      e.preventDefault()
      const id = e.dataTransfer.getData(DRAG_TYPE) || dragging
      setDropOn(null)
      setDragging(null)
      if (!id) return
      if (target === 'new') setNaming({ kind: 'new', sessionId: id, value: '' })
      else dropSession(id, target)
    }
  })

  const startRename = (id: string): void => {
    setEditing(id)
    setEditValue(titles?.[id] ?? '')
  }
  const commitRename = (): void => {
    if (editing && onRename) onRename(editing, editValue.trim())
    setEditing(null)
  }

  const q = query.trim()
  // Gateway counts come from the SEARCH-filtered set (not the gateway-filtered
  // one), so a chip's number always reflects what selecting it would show.
  const searched = sessions.filter((s) => matches(s, q, titles?.[s.id]))
  // Chips are built from the SESSIONS, not a gateway→count map: `Harness` is
  // decided by the id's shape, which a count map has already discarded.
  const chips = buildSourceChips(searched)
  // No chip selected → Automated runs (bakeoff, *-verify) stay one click away
  // rather than burying real chats: 69 of 127 sessions on the live box were
  // benchmark runs. Harness AND undeclared-API rows DO stay visible — collected
  // into collapsed groups below rather than hidden, so nothing vanishes
  // unexplained.
  const sourced = inSelectedSources(searched, sources)
  // Scopes are a second cut over the source facet: Unread = rows with the unread mark (never the
  // open one), Voice = the voice gateway. Counts describe what selecting the scope would show.
  const inScope = (s: SessionSummary, sc: Scope): boolean =>
    sc === 'all' ? true : sc === 'unread' ? s.id !== active && !!unread[s.id] : chipKeyFor(s) === 'voice'
  const shown = sourced.filter((s) => inScope(s, scope))
  const scopeCount = (sc: Scope): number => sourced.filter((s) => inScope(s, sc)).length
  const defaultCount = searched.filter(isDefaultVisible).length
  // Never hide a row behind a collapsed header when the operator has ALREADY
  // narrowed to it. Searching was covered; selecting a chip was not — clicking
  // `Desktop` handed you a collapsed `Desktop` group holding exactly the rows you
  // just asked for, and a second click to reveal them. Same wart Harness had.
  const forceOpen = q.length > 0 || sources.length > 0 || scope !== 'all'
  const groups = groupSessions(shown, sidebarPseudoBuckets<SessionSummary>(), new Date(), (s) => !!pinned?.[s.id], {
    list: store.projects,
    of: (s) => store.assign[s.id],
    // An empty project is still somewhere to drop, so it stays while the list is unfiltered; a
    // filter that empties it means "nothing here matches", and an empty header would just be noise.
    keepEmpty: !forceOpen,
    unfiled: unfiledMode
  })
  // The review strip: suggestions for rows the list is SHOWING (a hidden automated run is not
  // offered), grouped by the project they point at. Pinned rows are left out: filing one changes
  // nothing you can see (the pin outranks the project), so "File all" would look broken. Their
  // suggestion is still in the row's right-click menu.
  const suggested = new Map<string, { label: string; existing?: string; rows: Array<{ s: SessionSummary; hint: ProjectHint }> }>()
  for (const row of shown) {
    if (pinned?.[row.id]) continue
    const sug = rowSuggestion(store, row.id, hints[row.id])
    if (!sug) continue
    const g = suggested.get(sug.hint.key) ?? { label: sug.existing?.name ?? sug.hint.label, existing: sug.existing?.name, rows: [] }
    g.rows.push({ s: row, hint: sug.hint })
    suggested.set(sug.hint.key, g)
  }
  const suggestionCount = [...suggested.values()].reduce((n, g) => n + g.rows.length, 0)
  const menuRow = menu?.kind === 'row' ? shown.find((r) => r.id === menu.sessionId) ?? sessions.find((r) => r.id === menu.sessionId) : undefined
  const menuSug = menuRow ? rowSuggestion(store, menuRow.id, hints[menuRow.id]) : null
  const menuProject = menu?.kind === 'project' ? store.projects.find((p) => p.id === menu.projectId) : undefined
  const rowName = (r: SessionSummary): string => shortTitle(r, titles?.[r.id])

  return (
    <aside className="sidebar" style={width !== undefined ? { width: liveWidth ?? width } : undefined}>
      {onWidth && width !== undefined ? (
        <ListDivider width={width} live={liveWidth} setLive={setLiveWidth} onWidth={onWidth} fit={fitWidth ?? ((w) => w)} />
      ) : null}
      {/* R2, the Chats surface's second level. The thread has no pill row of its own — screen 1
          gives that space to the session title — so the Chats group's other destination lives in
          THIS column's header, which is the Chats surface's own navigation. It is the HEADING
          that navigates, carrying the total count and a chevron: as an unlabelled icon the
          Sessions manager was effectively unreachable for anyone who did not already know it
          existed, which is how a "you deleted it" regression looks even when nothing was deleted.
          It is the heading rather than a row of its own because screen 3's complaint is chrome
          height before the first session — a second row put that back over 160px. */}
      <div className="sidebar-head">
        {/* NO COUNT on this heading, and no chevron. A total here (269) sat forty pixels from the
            `All` chip (182) — two numbers for two sets, and either is correct while still reading
            as a contradiction. Picking a winner cannot fix that. So the chips carry the counts
            (`All 182` is the truth about what the list will show), and the gap between the two
            sets is explained where it is actionable — the source popover's Automated facet. The
            heading is still the way into the manager (it is a button); it just says what it is. */}
        {onManage ? (
          <button className="sidebar-manage" onClick={onManage} title="All sessions — the full tree, purge and export">
            <span>Sessions</span>
          </button>
        ) : (
          <span style={{ flex: 1 }}>Sessions</span>
        )}
        {onNew ? (
          <button className="sidebar-action" onClick={onNew} title="New chat" aria-label="New chat">
            <Icon name="plus" size={14} />
          </button>
        ) : null}
      </div>
      <div className="sidebar-search">
        <Icon name="search" size={12} />
        <input
          ref={searchRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter sessions…"
          spellCheck={false}
          aria-label="Filter sessions"
        />
        {/* The chord when the field is empty; the clear button once there is something to clear.
            They share the slot because they are never both useful at the same moment. */}
        {query ? (
          <button onClick={() => setQuery('')} title="Clear" aria-label="Clear filter" className="sidebar-action">
            <Icon name="x" size={12} />
          </button>
        ) : (
          <span className="sidebar-search-key" aria-hidden>⌘F</span>
        )}
      </div>
      <div className="scope-row" role="group" aria-label="Scope">
        {(
          [
            ['all', 'All'],
            ['unread', 'Unread'],
            ['voice', 'Voice']
          ] as [Scope, string][]
        ).map(([sc, label]) => (
          <button
            key={sc}
            className={`scope-chip${scope === sc ? ' is-active' : ''}`}
            onClick={() => setScope(sc)}
            aria-pressed={scope === sc}
          >
            {label} <span className="scope-n">{scopeCount(sc)}</span>
          </button>
        ))}
        {chips.length > 1 ? (
          <div className="filter-wrap" ref={filterRef}>
            <button
              className={`filter-btn${sources.length > 0 ? ' is-active' : ''}`}
              onClick={() => setFiltersOpen((o) => !o)}
              aria-expanded={filtersOpen}
              aria-haspopup="true"
              title="Filter by source"
            >
              <Icon name="sessions" size={11} />
              {/* ALWAYS the digit. `0` says "no source filter is on", which is the answer to the
                  only question this button gets asked; a bare glyph answered nothing. */}
              <span className="filter-btn-n">{sources.length}</span>
            </button>
            {filtersOpen ? (
              <div className="filter-popover" role="group" aria-label="Filter by source">
                <div className="filter-popover-head">SOURCE</div>
                <button
                  className={`gw-chip${sources.length === 0 ? ' is-active' : ''}`}
                  onClick={() => setSources([])}
                  title="Conversations (automated runs hidden — use the Automated chip)"
                >
                  Chats <span className="gw-chip-n">{defaultCount}</span>
                </button>
                {chips.map((c) => (
                  <button
                    key={c.key}
                    className={`gw-chip${sources.includes(c.key) ? ' is-active' : ''}${c.automated ? ' is-automated' : ''}`}
                    onClick={() => setSources((sel) => toggleSource(sel, c.key))}
                    title={
                      c.automated
                        ? `Automated runs (${c.sources.join(', ')}) — ${c.count} session${c.count === 1 ? '' : 's'}`
                        : `${c.label} — ${c.count} session${c.count === 1 ? '' : 's'}`
                    }
                  >
                    {c.label} <span className="gw-chip-n">{c.count}</span>
                  </button>
                ))}
                {/* Not a filter: how the sessions that are in no project are laid out. It lives here
                    because this is the sidebar's one settings surface; it applies at once, like the chips. */}
                <div className="filter-popover-head filter-popover-section">UNFILED SESSIONS</div>
                {(
                  [
                    ['date', 'By date'],
                    ['one', 'One list']
                  ] as [UnfiledMode, string][]
                ).map(([mode, label]) => (
                  <button
                    key={mode}
                    className={`gw-chip${unfiledMode === mode ? ' is-active' : ''}`}
                    aria-pressed={unfiledMode === mode}
                    onClick={() => chooseUnfiled(mode)}
                    title={mode === 'date' ? 'Today, Yesterday, Earlier this week, Older' : 'Everything not pinned and not in a project, under one Unfiled heading'}
                  >
                    {label}
                  </button>
                ))}
                {/* A divider and a way out. NO "Saved view" row: saved views do not exist in this
                    build, and a label naming one would be an affordance for a feature that is not
                    there. `Done` closes; the chips have already applied. */}
                <div className="filter-popover-foot">
                  <button className="filter-done" onClick={() => setFiltersOpen(false)}>
                    Done
                  </button>
                </div>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
      {suggestionCount > 0 ? (
        <div className={`project-review${reviewOpen ? ' is-open' : ''}`}>
          <button
            className="project-review-toggle"
            onClick={() => setReviewOpen((o) => !o)}
            aria-expanded={reviewOpen}
            title="Sessions whose tool calls mostly touched one project folder. Nothing is filed until you say so."
          >
            <Icon name="files" size={11} />
            <span>
              {suggestionCount} session{suggestionCount === 1 ? '' : 's'} could go in a project
            </span>
            <Icon name={reviewOpen ? 'chevron-up' : 'chevron-down'} size={11} />
          </button>
          {reviewOpen ? (
            <div className="project-review-body">
              {[...suggested.entries()].map(([key, g]) => (
                <div key={key} className="project-review-group">
                  <div className="project-review-head">
                    <span className="project-review-name" title={g.existing ? `Files into your project “${g.existing}”` : `Creates a project “${g.label}”`}>
                      {g.label}
                      {g.existing ? null : <span className="project-review-new">new</span>}
                    </span>
                    <button className="project-review-btn" onClick={() => acceptHint(g.rows.map((r) => r.s.id), g.label)}>
                      File {g.rows.length === 1 ? 'it' : `all ${g.rows.length}`}
                    </button>
                    <button
                      className="project-review-btn is-quiet"
                      onClick={() => dismissHints(g.rows.map((r) => ({ sessionId: r.s.id, key })))}
                      title="Stop suggesting this project for these sessions"
                    >
                      Dismiss
                    </button>
                  </div>
                  {g.rows.map(({ s: row, hint }) => (
                    <div key={row.id} className="project-review-row">
                      <span className="project-review-title" title={row.id}>
                        {rowName(row)}
                      </span>
                      <span className="project-review-why" title={`${pct(hint.share)} of the ${hint.calls} tool calls that touched a project folder touched ${hint.label}`}>
                        {pct(hint.share)} of {hint.calls}
                      </span>
                      <button className="project-review-icon" onClick={() => acceptHint([row.id], g.label)} aria-label={`File ${rowName(row)} into ${g.label}`} title={`File into ${g.label}`}>
                        <Icon name="check" size={11} />
                      </button>
                      <button
                        className="project-review-icon"
                        onClick={() => dismissHints([{ sessionId: row.id, key }])}
                        aria-label={`Do not suggest ${g.label} for ${rowName(row)}`}
                        title="Not this project"
                      >
                        <Icon name="x" size={11} />
                      </button>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
      <div className="session-list">
        {naming?.kind === 'new' ? (
          <div className="project-naming">
            <Icon name="files" size={11} />
            <input
              className="session-rename-input"
              value={naming.value}
              autoFocus
              placeholder="Project name"
              maxLength={60}
              onChange={(e) => setNaming({ ...naming, value: e.target.value })}
              onBlur={commitNaming}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitNaming()
                else if (e.key === 'Escape') setNaming(null)
              }}
              aria-label="New project name"
            />
          </div>
        ) : null}
        {dragging ? (
          <div className={`project-dropzone${dropOn === 'new' ? ' is-over' : ''}`} {...dropProps('new')}>
            <Icon name="plus" size={11} /> Drop here for a new project
          </div>
        ) : null}
        {shown.length === 0 ? (
          <div className="sidebar-empty">
            {sessions.length === 0 ? (
              'No sessions yet'
            ) : (
              <>
                {/* Do not empty the panel silently: say that a FILTER is why, and offer the way
                    out in the same breath (match spec, step 18.2). */}
                <span>No sessions match.</span>
                <button
                  className="sidebar-empty-clear"
                  onClick={() => {
                    setQuery('')
                    setSources([])
                    setScope('all')
                  }}
                >
                  Clear filters
                </button>
              </>
            )}
          </div>
        ) : (
          groups.map(({ bucket, rows, pseudo, hint, project }) => {
            const isOpen = forceOpen || !collapsed[bucket]
            const target = project ? project.id : bucket === PINNED_BUCKET ? 'pinned' : 'unfiled'
            const label = project ? project.name : bucket
            return (
              <section
                key={bucket}
                className={`session-group${project ? ' is-project' : ''}${dragging && dropOn === target ? ' is-drop' : ''}`}
                {...dropProps(target)}
              >
                {naming?.kind === 'rename' && project && naming.projectId === project.id ? (
                  <div className="project-naming">
                    <Icon name="files" size={11} />
                    <input
                      className="session-rename-input"
                      value={naming.value}
                      autoFocus
                      maxLength={60}
                      onChange={(e) => setNaming({ ...naming, value: e.target.value })}
                      onBlur={commitNaming}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') commitNaming()
                        else if (e.key === 'Escape') setNaming(null)
                      }}
                      aria-label={`Rename project ${project.name}`}
                    />
                  </div>
                ) : (
                <button
                  className="session-group-head"
                  onClick={() => toggleGroup(bucket)}
                  onContextMenu={
                    project
                      ? (e) => {
                          e.preventDefault()
                          setMenu({ kind: 'project', projectId: project.id, x: e.clientX, y: e.clientY })
                        }
                      : bucket === UNFILED_BUCKET || (SESSION_BUCKETS as readonly string[]).includes(bucket)
                        ? (e) => {
                            e.preventDefault()
                            setMenu({ kind: 'unfiled', x: e.clientX, y: e.clientY })
                          }
                        : undefined
                  }
                  aria-expanded={isOpen}
                  title={
                    project
                      ? `${project.name}: ${rows.length} session${rows.length === 1 ? '' : 's'}. Right-click to rename or delete; drop a session here to file it.`
                      : pseudo
                      ? // "N hidden" was only true while collapsed; say what it holds either way.
                        `${hint ?? bucket} ${rows.length} session${rows.length === 1 ? '' : 's'} — click to ${isOpen ? 'collapse' : 'expand'}`
                      : isOpen
                        ? `Collapse ${bucket}`
                        : `Expand ${bucket}`
                  }
                >
                  <Icon name={isOpen ? 'chevron-down' : 'chevron-right'} size={11} />
                  {project ? <Icon name="files" size={11} /> : null}
                  <span className="session-group-label">{label}</span>
                  {/* The hairline between label and count — see .session-group-rule. */}
                  <span className="session-group-rule" aria-hidden />
                  {/* The count is the point of a collapsed group: it states what it
                      is holding instead of silently omitting it. */}
                  <span className="session-group-n">{rows.length}</span>
                </button>
                )}
                {isOpen && project && rows.length === 0 ? <div className="project-empty">Drag sessions here, or right-click one</div> : null}
                {isOpen ? rows.map((s) => (
            // Wrapper (not a nested <button>) so the row stays a button while the ✕/✎ are their own
            // sibling buttons revealed on hover — valid markup + independent click targets.
            <div key={s.id} className="session-row-wrap">
              {editing === s.id ? (
                <div className="session-row is-active" style={{ cursor: 'default' }}>
                  <span className={`gw gw-${s.gateway ?? 'unknown'}`} title={sourceLabel(s.gateway ?? 'unknown')}>{badge(s.gateway)}</span>
                  <input
                    className="session-rename-input"
                    value={editValue}
                    autoFocus
                    placeholder={s.id}
                    onChange={(e) => setEditValue(e.target.value)}
                    onBlur={commitRename}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') commitRename()
                      else if (e.key === 'Escape') setEditing(null)
                    }}
                    aria-label={`Rename session ${s.id}`}
                  />
                </div>
              ) : (
                <>
                  <button
                    className={`session-row${s.id === active ? ' is-active' : ''}${s.id !== active && onScreen?.has(s.id) ? ' is-onscreen' : ''}${s.id !== active && unread[s.id] ? ' is-unread' : ''}${dragging === s.id ? ' is-dragging' : ''}`}
                    onClick={() => onSelect(s.id)}
                    draggable
                    onDragStart={(e) => {
                      e.dataTransfer.setData(DRAG_TYPE, s.id)
                      e.dataTransfer.effectAllowed = 'move'
                      setMenu(null)
                      setDragging(s.id)
                    }}
                    onDragEnd={() => {
                      setDragging(null)
                      setDropOn(null)
                    }}
                    onContextMenu={(e) => {
                      e.preventDefault()
                      setMenu({ kind: 'row', sessionId: s.id, x: e.clientX, y: e.clientY })
                    }}
                    title={
                      titles?.[s.id]
                        ? `${titles[s.id]} — ${s.id}`
                        : s.title && s.title !== s.id
                          ? `${s.title} — ${s.id}`
                          : s.id
                    }
                  >
                    <span className={`gw gw-${s.gateway ?? 'unknown'}`} title={sourceLabel(s.gateway ?? 'unknown')}>{badge(s.gateway)}</span>
                    <span className="session-title">{shortTitle(s, titles?.[s.id])}</span>
                    <span className="session-meta">
                      {/* The pinned state at rest, IN the row's own flow. It used to be the pin button
                          itself held visible over the row, which a title ran underneath once titles
                          stopped being cut at 24 characters. The button still appears on hover. */}
                      {pinned?.[s.id] ? (
                        <span className="pin-mark" aria-hidden>
                          📌
                        </span>
                      ) : null}
                      {popped?.has(s.id) ? (
                        <span className="popped-mark" title="Open in its own window — click to bring it to the front" aria-label="Open in its own window">
                          <Icon name="popout" size={11} />
                        </span>
                      ) : null}
                      <TurnIndicator turn={sessionActivity[s.id]} now={activityNow} />
                      {s.id !== active && unread[s.id] ? <span className="unread-dot" /> : null}
                      <span className="session-time">{relTime(s.lastActive)}</span>
                    </span>
                  </button>
                  {onTogglePin ? (
                    <button
                      className="session-rename session-pin"
                      title={pinned?.[s.id] ? 'Unpin' : 'Pin to the top'}
                      aria-label={`${pinned?.[s.id] ? 'Unpin' : 'Pin'} session ${s.id}`}
                      aria-pressed={!!pinned?.[s.id]}
                      onClick={(e) => {
                        e.stopPropagation()
                        onTogglePin(s.id, !pinned?.[s.id])
                      }}
                    >
                      📌
                    </button>
                  ) : null}
                  {onRename ? (
                    <button
                      className="session-rename"
                      title="Rename (local display name)"
                      aria-label={`Rename session ${s.id}`}
                      onClick={(e) => {
                        e.stopPropagation()
                        startRename(s.id)
                      }}
                    >
                      ✎
                    </button>
                  ) : null}
                  <button
                    className="session-forget"
                    title="Forget this session"
                    aria-label={`Forget session ${s.id}`}
                    onClick={(e) => {
                      e.stopPropagation() // don't also select the row
                      onForget(s.id)
                    }}
                  >
                    ×
                  </button>
                </>
              )}
            </div>
                )) : null}
              </section>
            )
          })
        )}
      </div>
      {menu?.kind === 'row' && menuRow ? (
        <ContextMenu x={menu.x} y={menu.y} onClose={closeMenu} label={`Project for ${rowName(menuRow)}`}>
          {menuSug ? (
            <button
              className="ctx-menu-item is-suggested"
              role="menuitem"
              onClick={() => {
                acceptHint([menuRow.id], menuSug.existing?.name ?? menuSug.hint.label)
                closeMenu()
              }}
              title={`${pct(menuSug.hint.share)} of the ${menuSug.hint.calls} tool calls that touched a project folder touched ${menuSug.hint.label}`}
            >
              File into {menuSug.existing?.name ?? menuSug.hint.label}
              <span className="ctx-menu-note">{pct(menuSug.hint.share)} of {menuSug.hint.calls}</span>
            </button>
          ) : null}
          {store.projects.map((p) => {
            const here = store.assign[menuRow.id] === p.id
            return (
              <button
                key={p.id}
                className="ctx-menu-item"
                role="menuitem"
                disabled={here}
                onClick={() => {
                  fileInto(menuRow.id, p.id)
                  closeMenu()
                }}
              >
                {here ? `In ${p.name}` : `Move to ${p.name}`}
              </button>
            )
          })}
          <button
            className="ctx-menu-item"
            role="menuitem"
            onClick={() => {
              setNaming({ kind: 'new', sessionId: menuRow.id, value: '' })
              closeMenu()
            }}
          >
            New project…
          </button>
          {popped?.has(menuRow.id) ? (
            <>
              <div className="ctx-menu-rule" role="separator" />
              <button
                className="ctx-menu-item"
                role="menuitem"
                onClick={() => {
                  onSelect(menuRow.id)
                  closeMenu()
                }}
              >
                Bring its window to the front
              </button>
              {onReturnHere ? (
                <button
                  className="ctx-menu-item"
                  role="menuitem"
                  onClick={() => {
                    onReturnHere(menuRow.id)
                    closeMenu()
                  }}
                >
                  Return it to this window
                </button>
              ) : null}
            </>
          ) : onPopOut ? (
            <>
              <div className="ctx-menu-rule" role="separator" />
              {onOpenBeside && menuRow.id !== active && !onScreen?.has(menuRow.id) ? (
                <button
                  className="ctx-menu-item"
                  role="menuitem"
                  disabled={!canOpenBeside}
                  title={canOpenBeside ? 'Show it next to the conversation you have open' : 'No room for another pane at this window size: widen the window, close a pane, or open it in its own window'}
                  onClick={() => {
                    onOpenBeside(menuRow.id)
                    closeMenu()
                  }}
                >
                  {canOpenBeside ? 'Open beside' : 'Open beside (no room)'}
                </button>
              ) : null}
              <button
                className="ctx-menu-item"
                role="menuitem"
                onClick={() => {
                  onPopOut(menuRow.id)
                  closeMenu()
                }}
              >
                Open in its own window
              </button>
            </>
          ) : null}
          {store.assign[menuRow.id] ? (
            <button
              className="ctx-menu-item"
              role="menuitem"
              onClick={() => {
                fileInto(menuRow.id, null)
                closeMenu()
              }}
            >
              Remove from {store.projects.find((p) => p.id === store.assign[menuRow.id])?.name ?? 'project'}
            </button>
          ) : null}
          {menuSug ? (
            <button
              className="ctx-menu-item is-quiet"
              role="menuitem"
              onClick={() => {
                dismissHints([{ sessionId: menuRow.id, key: menuSug.hint.key }])
                closeMenu()
              }}
            >
              Don’t suggest {menuSug.hint.label}
            </button>
          ) : null}
          {pinned?.[menuRow.id] && store.assign[menuRow.id] ? (
            <div className="ctx-menu-foot">Pinned, so it shows under Pinned until you unpin it.</div>
          ) : null}
        </ContextMenu>
      ) : null}
      {menu?.kind === 'project' && menuProject ? (
        <ContextMenu x={menu.x} y={menu.y} onClose={closeMenu} label={`Project ${menuProject.name}`}>
          <button
            className="ctx-menu-item"
            role="menuitem"
            onClick={() => {
              setNaming({ kind: 'rename', projectId: menuProject.id, value: menuProject.name })
              closeMenu()
            }}
          >
            Rename…
          </button>
          <button
            className="ctx-menu-item is-danger"
            role="menuitem"
            onClick={() => {
              updateStore((s) => deleteProject(s, menuProject.id))
              closeMenu()
            }}
          >
            Delete project
          </button>
          <div className="ctx-menu-foot">Deleting keeps its sessions; they go back to the date groups.</div>
        </ContextMenu>
      ) : null}
      {menu?.kind === 'unfiled' ? (
        <ContextMenu x={menu.x} y={menu.y} onClose={closeMenu} label="Unfiled sessions">
          <button
            className="ctx-menu-item"
            role="menuitem"
            onClick={() => {
              chooseUnfiled(unfiledMode === 'one' ? 'date' : 'one')
              closeMenu()
            }}
          >
            {unfiledMode === 'one' ? 'Group unfiled by date' : 'Show unfiled as one list'}
          </button>
          <div className="ctx-menu-foot">Sessions in no project. Drop one here to take it out of its project.</div>
        </ContextMenu>
      ) : null}
      {/* The footer: the open conversation's context window. Nothing when no conversation is open. */}
      {active && onOpenStatus ? (
        <div className="sidebar-foot">
          <ContextMeter sessionId={active} onOpen={onOpenStatus} variant="footer" />
        </div>
      ) : null}
    </aside>
  )
}
