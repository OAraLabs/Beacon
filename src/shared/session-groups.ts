/**
 * Recency bucketing for the session sidebar.
 *
 * The durable session index (Prometheus #114) made every persisted session
 * visible — a jump from a handful of live sessions to 100+ — so a flat list
 * stopped being navigable. Grouping by last activity is the cheapest fix that
 * scales: no daemon work, no user effort, and the sessions worth reaching are
 * the recent ones.
 *
 * Pure + shared so it can be smoke-tested from the main process (the renderer
 * has no component-test framework).
 */

import { isHarnessId, isUndeclaredApiSession, type ClassifiableSession } from './session-sources'

export const SESSION_BUCKETS = ['Today', 'Yesterday', 'Earlier this week', 'Older'] as const
export type SessionBucket = (typeof SESSION_BUCKETS)[number]

export interface GroupableSession {
  lastActive?: number
}

/**
 * Calendar-day based, deliberately NOT elapsed-hours: "yesterday" has to mean
 * yesterday even when it was 20 minutes ago just after midnight, which an
 * hours-since comparison gets wrong every night.
 *
 * `now` is injected so the boundaries are testable without touching the clock.
 */
export function bucketOf(lastActive: number | undefined, now: Date = new Date()): SessionBucket {
  if (!lastActive) return 'Older'
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const dayMs = 86_400_000
  if (lastActive >= startOfToday) return 'Today'
  if (lastActive >= startOfToday - dayMs) return 'Yesterday'
  if (lastActive >= startOfToday - 7 * dayMs) return 'Earlier this week'
  return 'Older'
}

/**
 * Group rows into fixed-order buckets, preserving each row's relative order
 * (the caller sorts by recency) and omitting empty buckets.
 */
export function groupByRecency<T extends GroupableSession>(
  rows: T[],
  now: Date = new Date()
): Array<{ bucket: SessionBucket; rows: T[] }> {
  const out = new Map<SessionBucket, T[]>()
  for (const s of rows) {
    const b = bucketOf(s.lastActive, now)
    const list = out.get(b)
    if (list) list.push(s)
    else out.set(b, [s])
  }
  return SESSION_BUCKETS.filter((b) => out.has(b)).map((b) => ({ bucket: b, rows: out.get(b)! }))
}

// ── Pseudo-buckets: trailing groups on an axis that is not recency ───────────

/** Scripted-probe sessions, classified by the id's SHAPE. Not a recency bucket. */
export const HARNESS_BUCKET = 'Harness'

/**
 * Sessions from API callers that never declared an origin — the daemon's
 * `desktop` default. See `UNDECLARED_GATEWAY` in session-sources for why this is
 * a category rather than a list of ids.
 */
export const DESKTOP_BUCKET = 'Desktop'

/**
 * EVERY pseudo-bucket, in the order they are appended after the recency buckets.
 *
 * Registration is the point, not decoration: `PseudoBucket.name` is typed to this
 * tuple, so a new trailing group CANNOT be introduced without landing here — and
 * `defaultCollapse()` derives from the same tuple. That closes the drift where a
 * group is added to the sidebar and silently starts life expanded.
 *
 * Desktop before Harness: Desktop still holds real conversations (13 of 30 on the
 * live box), Harness holds only probes. The likelier you are to want it, the
 * higher it sits.
 */
export const PSEUDO_BUCKETS = [DESKTOP_BUCKET, HARNESS_BUCKET] as const

export type PseudoBucketName = (typeof PSEUDO_BUCKETS)[number]

/**
 * The leading group (PARITY-PLAN A6): sessions the operator pinned. Not a recency bucket and not
 * a pseudo-bucket — it is the one group built from an explicit user act, so it sits FIRST and a
 * pin beats every classification below it (a pinned harness probe renders pinned: the operator
 * said so).
 */
export const PINNED_BUCKET = 'Pinned'

/**
 * The one group every unfiled session lands in when the operator turns "Unfiled as one list" on:
 * not pinned, not in a project, not a pseudo-bucket. The default is still by date (Today,
 * Yesterday, ...); this is the same set under one heading, newest first.
 */
export const UNFILED_BUCKET = 'Unfiled'

/** A project group's bucket: keyed by the project's id, never its name, so a project called
 *  "Today" cannot share a collapse entry with the recency bucket. */
export type ProjectBucketName = `project:${string}`

export function projectBucket(projectId: string): ProjectBucketName {
  return `project:${projectId}`
}

/** Every group name the sidebar can render — pinned, projects, recency buckets, pseudo-buckets. */
export type SessionGroupName = SessionBucket | PseudoBucketName | typeof PINNED_BUCKET | ProjectBucketName | typeof UNFILED_BUCKET

/** One trailing group: a registered name, a membership test, and its header copy. */
export interface PseudoBucket<T> {
  name: PseudoBucketName
  match: (row: T) => boolean
  /** Header tooltip. Lives with the definition so the sidebar has no per-group ternary. */
  hint?: string
}

export interface SessionGroup<T> {
  bucket: SessionGroupName
  rows: T[]
  /** True for a pseudo-bucket — the sidebar defaults these collapsed. */
  pseudo: boolean
  hint?: string
  /** Set on a project group: the header shows `name`, and drops onto it file into `id`. */
  project?: { id: string; name: string }
}

/** The operator's project folders (@shared/session-projects), as grouping needs them. */
export interface ProjectGrouping<T> {
  /** Display order. */
  list: Array<{ id: string; name: string }>
  /** The project a row is filed in, or undefined. An id not in `list` is treated as unfiled. */
  of: (row: T) => string | undefined
  /** Render a project with no rows (so there is somewhere to drop). Off while filtering. */
  keepEmpty?: boolean
  /** 'one': every unfiled row in a single `Unfiled` group, newest first, instead of the date
   *  buckets. Default 'date'. Desktop and Harness stay their own groups either way: they are a
   *  classification, not a lack of one. */
  unfiled?: 'date' | 'one'
}

/**
 * Split pseudo-bucket rows out of the recency buckets and append them as trailing
 * groups.
 *
 * These rows are dated like any other session, so recency bucketing scatters them
 * through Today / Yesterday / Earlier — interleaved with the conversations they
 * bury. Recency is the wrong axis for them: nobody looks for "the probe I ran on
 * Tuesday", they look past all of them. Same for a session some script minted
 * without saying who it was.
 *
 * FIRST MATCH WINS, and output order follows `pseudo`, not row order — so a row
 * belongs to exactly one group and the groups render deterministically. The two
 * shipped predicates are disjoint anyway (`isHarnessId` requires no colon;
 * `desktop:` always has one), but precedence is defined rather than left to luck.
 *
 * Pure, and separate from groupByRecency so that function's existing contract
 * (pinned by session-groups-smoke) is untouched.
 */
export function groupSessions<T extends GroupableSession>(
  rows: T[],
  pseudo: Array<PseudoBucket<T>>,
  now: Date = new Date(),
  isPinned?: (row: T) => boolean,
  projects?: ProjectGrouping<T>
): Array<SessionGroup<T>> {
  const held = new Map<PseudoBucketName, T[]>()
  const pinnedRows: T[] = []
  const filed = new Map<string, T[]>()
  const known = new Set((projects?.list ?? []).map((p) => p.id))
  const rest: T[] = []
  for (const r of rows) {
    // Pin first: the one explicit user act outranks every derived classification.
    if (isPinned?.(r)) {
      pinnedRows.push(r)
      continue
    }
    // Filing is the other explicit act, so it outranks the derived pseudo-buckets too: a harness
    // probe the operator filed under a project renders there.
    const pid = projects?.of(r)
    if (pid && known.has(pid)) {
      const list = filed.get(pid)
      if (list) list.push(r)
      else filed.set(pid, [r])
      continue
    }
    const hit = pseudo.find((p) => p.match(r))
    if (!hit) {
      rest.push(r)
      continue
    }
    const list = held.get(hit.name)
    if (list) list.push(r)
    else held.set(hit.name, [r])
  }

  const groups: Array<SessionGroup<T>> =
    projects?.unfiled === 'one'
      ? rest.length > 0
        ? [{ bucket: UNFILED_BUCKET, rows: rest, pseudo: false, hint: 'Sessions that are not pinned and not in a project, newest first.' }]
        : []
      : groupByRecency(rest, now).map((g) => ({
          bucket: g.bucket as SessionGroupName,
          rows: g.rows,
          pseudo: false
        }))
  // Projects sit between Pinned and the recency buckets, in the operator's order. Rows inside keep
  // the caller's recency order.
  const projectGroups: Array<SessionGroup<T>> = []
  for (const p of projects?.list ?? []) {
    const list = filed.get(p.id) ?? []
    if (list.length === 0 && !projects?.keepEmpty) continue
    projectGroups.push({ bucket: projectBucket(p.id), rows: list, pseudo: false, project: { id: p.id, name: p.name } })
  }
  groups.unshift(...projectGroups)
  // Always first, never collapsed by default, omitted when empty — pins exist to be reached.
  if (pinnedRows.length > 0)
    groups.unshift({ bucket: PINNED_BUCKET, rows: pinnedRows, pseudo: false, hint: 'Sessions you pinned — they stay here regardless of age.' })
  // Always last: these are the groups you scroll PAST, so they do not sit above
  // anything you scroll TO. An empty one is omitted rather than rendered blank.
  for (const p of pseudo) {
    const list = held.get(p.name)
    if (list && list.length > 0) groups.push({ bucket: p.name, rows: list, pseudo: true, hint: p.hint })
  }
  return groups
}

/**
 * The pseudo-buckets the sidebar ships, assembled here so the predicates live
 * beside the classifier that defines them rather than inline in a component.
 */
export function sidebarPseudoBuckets<
  T extends GroupableSession & ClassifiableSession
>(): Array<PseudoBucket<T>> {
  return [
    {
      name: DESKTOP_BUCKET,
      match: isUndeclaredApiSession,
      hint: 'Sessions from API callers that did not declare an origin — the daemon defaults those to "desktop". Beacon’s own chats are under Beacon.'
    },
    {
      name: HARNESS_BUCKET,
      match: (row) => isHarnessId(row.id),
      hint: 'Scripted probe sessions (hand-authored ids).'
    }
  ]
}

// ── Collapse persistence ─────────────────────────────────────────────────────

/**
 * Settings key holding the sidebar's {groupName: collapsed?} map. Versioned so
 * the shape can evolve, matching `nav:groups:v1`.
 *
 * PRE-EXISTING GAP THIS CLOSES: the sidebar's collapse was plain `useState`, so
 * `Older` re-collapsed on every launch and any toggle the operator made was lost
 * when the app restarted. That was true before the Harness group existed; adding
 * a second collapsed group would have doubled the annoyance, so it is fixed here
 * rather than left to look incidental.
 */
export const SESSION_GROUPS_SETTING_KEY = 'sessions:groups:v1'

export type GroupCollapse = Record<string, boolean>

/**
 * Collapse-by-default for the groups that hold long tails. Everything recent
 * stays open; `Older` and EVERY registered pseudo-bucket start closed WITH THEIR
 * COUNTS SHOWING, so a collapsed group states what it is holding rather than
 * silently omitting it.
 *
 * Derived from PSEUDO_BUCKETS rather than listed by hand — a new trailing group
 * gets its collapse default from registration, so the two cannot drift.
 */
export function defaultCollapse(): GroupCollapse {
  const out: GroupCollapse = { Older: true }
  for (const name of PSEUDO_BUCKETS) out[name] = true
  return out
}

/** Persisted state layered over the defaults; unknown/garbage keys fall back. */
export function resolveCollapse(persisted: GroupCollapse | null): GroupCollapse {
  return { ...defaultCollapse(), ...(persisted ?? {}) }
}

// The one {name: collapsed?} JSON codec in the app. It used to live in views.ts as the nav rail's
// expansion state; the rail never expands any more (design handoff 2026-09-03, R1), so the sidebar's
// group collapse is the only owner. Garbage-safe: bad JSON / wrong shape → null, and only
// boolean-valued keys survive (an unexpected field can't poison the booleans).
export function parseCollapse(raw: string | null | undefined): GroupCollapse | null {
  if (!raw) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const out: GroupCollapse = {}
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === 'boolean') out[k] = v
    }
    return out
  } catch {
    return null
  }
}

export function serializeCollapse(c: GroupCollapse): string {
  return JSON.stringify(c)
}

