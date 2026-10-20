// The desktop's top-level views. Pure — no React — so the renderer NavRail and the headless
// nav/panels smokes share one registry. Chat is the default and stays the home surface. NAV_VIEWS is
// the canonical registry (id + label); its ORDER and COUNT are a tested contract (panels-smoke pins
// chat[0], mission[1], length 12). NAV_TREE only describes how those SAME views are grouped + ordered
// in the rail — regrouping/relabel never reorders or resizes NAV_VIEWS.
//
// NOT views: the inspector, the browser and the terminal. They are companions of a conversation,
// hosted in the chat view's dock (@shared/side-panel) and opened from the thread header's dock
// group, the composer, the palette, or ⌘1/⌘2/⌘3 — never from the rail (R3).

export type ViewId =
  | 'chat'
  | 'mission'
  | 'activity'
  | 'toolfeed'
  | 'status'
  | 'sessions'
  | 'board'
  | 'files'
  | 'checkpoints'
  | 'artifacts'
  | 'wiki'
  | 'documents'
  | 'coding'
  | 'loop-manager'
  | 'integrations'
  | 'skills'
  | 'config'

export interface NavView {
  id: ViewId
  label: string
}

export const NAV_VIEWS: NavView[] = [
  { id: 'chat', label: 'Chat' },
  { id: 'mission', label: 'Mission' }, // Makeover Slice 7 — the cockpit home (chat stays default)
  { id: 'activity', label: 'Live' }, // IA: relabeled from "Activity" so the leaf ≠ its parent group "Activity"
  { id: 'toolfeed', label: 'Tool Feed' },
  { id: 'status', label: 'Status' },
  { id: 'sessions', label: 'Sessions' },
  { id: 'board', label: 'Board' },
  { id: 'files', label: 'Files' },
  { id: 'checkpoints', label: 'Checkpoints' }, // per-turn file checkpoints of the active session (Prometheus #381) — the undo's evidence
  { id: 'artifacts', label: 'Artifacts' }, // the agent's outbox — a different producer from Files
  { id: 'wiki', label: 'Wiki' }, // what the agent has COMPILED — a different corpus from Documents
  { id: 'documents', label: 'Documents' }, // Documents Editor — confined disk-backed read/save/edit (/api/documents)
  { id: 'coding', label: 'Run' }, // IA: relabeled from "Coding" so the leaf ≠ its parent group "Coding"
  { id: 'loop-manager', label: 'Loop Manager' }, // PM cockpit OVER coding mode — multi-project board
  { id: 'integrations', label: 'Integrations' }, // generic control-surface contract v1 (Sprint 3)
  { id: 'skills', label: 'Skills' }, // GEPA skill-draft review (Gap 4) — accept/reject the agent's proposed skills
  { id: 'config', label: 'Config' }
  // NOT here as of 2026-09-03: `devices`. Phone/tablet enrolment is a SETTING — you go there to
  // mint or revoke a token and leave — so it is a Config tab (CONFIG_TABS in @shared/daemon-api),
  // not a place the rail has to carry. Integrations stayed under Workspace by decision: it was
  // considered for a rail entry of its own and rejected, so R1's six-entry cap is untouched.
]

export const DEFAULT_VIEW: ViewId = 'mission' // the cockpit landing — first thing on launch

/** Normalize an arbitrary id (e.g. from persisted settings) to a known view → fall back to Chat. */
export function resolveView(id: string | null | undefined): ViewId {
  return NAV_VIEWS.some((v) => v.id === id) ? (id as ViewId) : DEFAULT_VIEW
}

/**
 * A view's human label, or the raw id if it is not in the registry.
 *
 * NAV_VIEWS is the one source for labels — the rail, the pill row and StubPanel already read it.
 * This is the accessor for surfaces that need the WORD rather than the id (an error heading, an
 * empty state), so none of them grows a second copy of the mapping.
 *
 * The `?? id` fallback is deliberate and not defensive padding: `resolveView` normalizes ids that
 * came from persisted settings, but a label is also asked for ids that may predate the registry.
 * Returning the raw id is honest; inventing a label or returning '' would not be.
 */
export function viewLabel(id: string): string {
  return NAV_VIEWS.find((v) => v.id === id)?.label ?? id
}

// ── The rail (design handoff 2026-09-03, R1) ────────────────────────────────
// R1: the rail is WHERE YOU ARE. It holds destinations only, it never expands, and it stays at six
// or fewer entries: Mission · Chats · Coding · Workspace · Activity · Config. A rail entry is either
// a standalone view or a GROUP whose children are the surface's second-level views — and those
// children are reached from a pill row at the top of the surface (R2, SubNav.tsx), never from an
// expanded tree in the rail. Clicking a group's rail entry lands on children[0]. Invariants
// (nav-smoke): every ViewId in NAV_VIEWS appears exactly once across NAV_TREE; a group's label is
// never equal to one of its own children's labels (a parent==child repeat reads as a bug); and
// NAV_TREE.length <= RAIL_MAX. Group ids use the `grp:` colon-namespace so they never collide
// with a ViewId. NOTHING is added to the rail when a feature ships — a new view joins a group.

export type NavGroupId = 'grp:conversations' | 'grp:coding' | 'grp:workspace' | 'grp:activity'

export interface NavGroup {
  id: NavGroupId
  label: string
  /** Views nested under this group, in display order. children[0] is the rail's landing. */
  children: ViewId[]
  /**
   * How the surface DRAWS its second level. The children are the second level either way — this
   * only decides presentation, so `subNavForView` stays the one answer to "what else is here".
   *   'pills'  — R2's horizontal row under the page title (Workspace, Activity, Chats).
   *   'column' — a left drill-down that stays put while you work in it (Coding). Chosen because
   *              Run and Loop Manager are not two sections of a page; they are two altitudes on
   *              the same engine, and you keep the list in view while a run is going.
   */
  layout?: 'pills' | 'column'
}

export type NavEntry =
  | { kind: 'view'; id: ViewId } // standalone rail destination
  | { kind: 'group'; group: NavGroup } // a surface with an R2 pill row over its children

/** R1: six or fewer rail entries, forever. */
export const RAIL_MAX = 6

// Group labels are the surface's page title (R2) and stay distinct from every child label. The
// handoff's rail reads "Files" for the workspace entry; it is "Workspace" here because the
// surface's own pill row starts with a "Files" pill and a rail entry must not repeat a child.
export const NAV_TREE: NavEntry[] = [
  // Mission — the cockpit landing + default view.
  { kind: 'view', id: 'mission' },
  // Chats: the thread (with its session panel) and the session manager.
  { kind: 'group', group: { id: 'grp:conversations', label: 'Chats', children: ['chat', 'sessions'] } },
  // "Run" (single-run) and Loop Manager are the same /api/code engine at two altitudes, so they
  // read as a drill-down rather than two tabs — hence layout 'column' (2026-09-03).
  { kind: 'group', group: { id: 'grp:coding', label: 'Coding', children: ['coding', 'loop-manager'], layout: 'column' } },
  // Things you manage. Board lives here (NOT under Coding): it dispatches stories to chat sessions.
  // Artifacts and Board moved up behind Files (2026-09-03): they are what the agent produced and
  // what you have queued, and at the tail of a nine-pill row they were the two nobody found.
  // Devices left for Config (a setting, not a place); Integrations stayed, so this is 8 pills.
  { kind: 'group', group: { id: 'grp:workspace', label: 'Workspace', children: ['files', 'artifacts', 'board', 'documents', 'wiki', 'checkpoints', 'skills', 'integrations'] } },
  // "What's happening": Live · Tool Feed · Status.
  { kind: 'group', group: { id: 'grp:activity', label: 'Activity', children: ['activity', 'toolfeed', 'status'] } },
  // Config is a destination, not a group — it navigates directly.
  { kind: 'view', id: 'config' }
]

/** Every view id reachable through the rail, in display order. Backs the reach test. */
export function flattenNavTree(tree: NavEntry[] = NAV_TREE): ViewId[] {
  const out: ViewId[] = []
  for (const entry of tree) {
    if (entry.kind === 'view') out.push(entry.id)
    else out.push(...entry.group.children)
  }
  return out
}

/** The group containing a view (the rail entry that lights up for it), or null if top-level. */
export function groupForView(id: ViewId, tree: NavEntry[] = NAV_TREE): NavGroup | null {
  for (const entry of tree) {
    if (entry.kind === 'group' && entry.group.children.includes(id)) return entry.group
  }
  return null
}

/** Where a rail entry lands when clicked: the view itself, or a group's first child. */
export function railDestination(entry: NavEntry): ViewId {
  return entry.kind === 'view' ? entry.id : entry.group.children[0]
}

/** True when `view` is what this rail entry represents (the entry, or one of its children). */
export function railEntryActive(entry: NavEntry, view: ViewId): boolean {
  return entry.kind === 'view' ? entry.id === view : entry.group.children.includes(view)
}

/**
 * R2: the second-level navigation for a view — the group whose children share the surface — or
 * null when the surface has no second level (a standalone view, or a group of one).
 */
export function subNavForView(id: ViewId, tree: NavEntry[] = NAV_TREE): NavGroup | null {
  const g = groupForView(id, tree)
  return g && g.children.length > 1 ? g : null
}

/** True when this view's second level is drawn as R2's pill row (the default presentation). */
export function usesPillRow(id: ViewId, tree: NavEntry[] = NAV_TREE): boolean {
  const g = subNavForView(id, tree)
  return !!g && (g.layout ?? 'pills') === 'pills'
}
