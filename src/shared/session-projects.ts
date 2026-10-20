/**
 * Session projects: folders the operator files sessions into, plus a suggestion derived from
 * which project folders a session's tool calls touched.
 *
 * WHY BOTH, AND WHY THE USER DECIDES. Claude Code groups by the folder a session started in.
 * Prometheus sessions have no such folder: every one runs in the daemon's default workspace, and
 * binding one with `/workspace` was measured at 0 of 56 sessions (2026-09-16). What does exist is
 * the paths in each session's tool calls. Measured 2026-10-12 against the local cache: 33 of the
 * 50 sessions active in the last 30 days touched a project folder, and 17 had one project with
 * at least 60% of those calls. The rest are genuinely mixed (40% beacon-desktop / 31% beacon-ios
 * / 18% Prometheus), and a label recomputed as the session goes on would move rows around under
 * the operator. So the derived project is only ever a SUGGESTION. Filing is an explicit act
 * (a drop, a menu pick, a click on the suggestion) and nothing moves a row on its own.
 *
 * STORAGE: local settings KV for now (`sessions:projects:v1`), so it does not reach other devices
 * the way a daemon-owned pin does. Moving it to the daemon is the next step if this earns its keep.
 *
 * Pure (no React, no Electron) so the sidebar, main and a smoke share one implementation.
 */

export const SESSION_PROJECTS_SETTING_KEY = 'sessions:projects:v1'

export interface SessionProject {
  id: string
  name: string
}

export interface ProjectStore {
  /** Display order: the order the operator created them. */
  projects: SessionProject[]
  /** sessionId → projectId. An entry naming a project that no longer exists is dropped on parse. */
  assign: Record<string, string>
  /** sessionId → the suggested project key the operator said no to. A NEW suggestion shows again. */
  dismissed: Record<string, string>
}

export function emptyProjectStore(): ProjectStore {
  return { projects: [], assign: {}, dismissed: {} }
}

const MAX_NAME = 60

/** Trimmed, inner whitespace collapsed, capped. Empty means "no name": callers refuse it. */
export function cleanProjectName(raw: string): string {
  return (raw ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME)
}

/** Case-insensitive identity for names: `ReachOut` and `reachout` are one project. */
export function nameKey(name: string): string {
  return cleanProjectName(name).toLowerCase()
}

/**
 * Garbage-safe: bad JSON, a wrong shape, or a malformed entry falls back to empty or drops that
 * entry, never throws. Assignments to a project that is not in `projects` are dropped, so a
 * half-written store cannot render a group with no header.
 */
export function parseProjectStore(raw: string | null | undefined): ProjectStore {
  const out = emptyProjectStore()
  if (!raw) return out
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return out
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return out
  const p = parsed as Record<string, unknown>
  const seenIds = new Set<string>()
  const seenNames = new Set<string>()
  if (Array.isArray(p.projects)) {
    for (const item of p.projects) {
      if (!item || typeof item !== 'object') continue
      const { id, name } = item as Record<string, unknown>
      if (typeof id !== 'string' || !id || typeof name !== 'string') continue
      const clean = cleanProjectName(name)
      if (!clean || seenIds.has(id) || seenNames.has(clean.toLowerCase())) continue
      seenIds.add(id)
      seenNames.add(clean.toLowerCase())
      out.projects.push({ id, name: clean })
    }
  }
  for (const field of ['assign', 'dismissed'] as const) {
    const m = p[field]
    if (!m || typeof m !== 'object' || Array.isArray(m)) continue
    for (const [sid, v] of Object.entries(m as Record<string, unknown>)) {
      if (typeof v !== 'string' || !v) continue
      if (field === 'assign' && !seenIds.has(v)) continue
      out[field][sid] = v
    }
  }
  return out
}

export function serializeProjectStore(s: ProjectStore): string {
  return JSON.stringify(s)
}

export function findProjectByName(s: ProjectStore, name: string): SessionProject | undefined {
  const k = nameKey(name)
  return k ? s.projects.find((p) => p.name.toLowerCase() === k) : undefined
}

function newId(s: ProjectStore): string {
  // Short, collision-checked against this store. Not a uuid: it only has to be unique here.
  for (;;) {
    const id = `p${Math.random().toString(36).slice(2, 9)}`
    if (!s.projects.some((p) => p.id === id)) return id
  }
}

/**
 * Create a project, or return the existing one with the same name (case-insensitive), so
 * accepting `reachout` when `ReachOut` exists files into ReachOut instead of making a twin.
 * Returns `id: null` (store unchanged) for an empty name.
 */
export function createProject(s: ProjectStore, rawName: string): { store: ProjectStore; id: string | null } {
  const name = cleanProjectName(rawName)
  if (!name) return { store: s, id: null }
  const existing = findProjectByName(s, name)
  if (existing) return { store: s, id: existing.id }
  const id = newId(s)
  return { store: { ...s, projects: [...s.projects, { id, name }] }, id }
}

/** Rename; refused (store unchanged) when the name is empty or another project already has it. */
export function renameProject(s: ProjectStore, id: string, rawName: string): ProjectStore {
  const name = cleanProjectName(rawName)
  if (!name) return s
  const clash = findProjectByName(s, name)
  if (clash && clash.id !== id) return s
  if (!s.projects.some((p) => p.id === id)) return s
  return { ...s, projects: s.projects.map((p) => (p.id === id ? { ...p, name } : p)) }
}

/** Delete a project. Its sessions go back to the recency groups; no session is deleted. */
export function deleteProject(s: ProjectStore, id: string): ProjectStore {
  const assign: Record<string, string> = {}
  for (const [sid, pid] of Object.entries(s.assign)) if (pid !== id) assign[sid] = pid
  return { ...s, projects: s.projects.filter((p) => p.id !== id), assign }
}

/** File a session into a project, or unfile it with `null`. An unknown project id is a no-op. */
export function assignSession(s: ProjectStore, sessionId: string, projectId: string | null): ProjectStore {
  const assign = { ...s.assign }
  if (projectId === null) delete assign[sessionId]
  else if (s.projects.some((p) => p.id === projectId)) assign[sessionId] = projectId
  else return s
  return { ...s, assign }
}

/** Drop every trace of a forgotten session. */
export function forgetSession(s: ProjectStore, sessionId: string): ProjectStore {
  if (!(sessionId in s.assign) && !(sessionId in s.dismissed)) return s
  const assign = { ...s.assign }
  const dismissed = { ...s.dismissed }
  delete assign[sessionId]
  delete dismissed[sessionId]
  return { ...s, assign, dismissed }
}

export function dismissSuggestion(s: ProjectStore, sessionId: string, key: string): ProjectStore {
  return { ...s, dismissed: { ...s.dismissed, [sessionId]: key } }
}

// ── Derivation: which project folder a path belongs to ─────────────────────────────────────

/**
 * Directories under home that hold projects rather than being one. `~/projects/beacon-desktop/x`
 * is the project `beacon-desktop`, not `projects`.
 */
const CONTAINERS = new Set(['projects', 'project', 'src', 'code', 'repos', 'repo', 'dev', 'work', 'git', 'github', 'developer', 'workspace', 'workspaces', 'sites'])

/**
 * Home directories that are never a project: the OS's own folders and toolchains. A session that
 * reads `~/Downloads/x.zip` or `~/android-sdk/...` is not "about" that folder.
 */
const NOT_PROJECTS = new Set([
  'library', 'downloads', 'desktop', 'documents', 'applications', 'pictures', 'movies', 'music', 'public',
  'models', 'android-sdk', 'go', 'node_modules', 'bin', 'tmp'
])

/**
 * The project folder a path belongs to, as `{ key, label }` (key is lowercase, label is the folder
 * name with checkout suffixes removed), or null when the path is not inside one.
 *
 * Rules, in order:
 *   - Only paths under a home directory count: `/home/<u>/`, `/Users/<u>/`, or `~/`. A path in
 *     /tmp or /etc says nothing about which project the session is in.
 *   - `~/.prometheus/workspace/<x>` is project `<x>`. Everything else under `~/.prometheus` is the
 *     agent's own home (its outbox, data, logs): not a project. Other dot-directories (~/.config,
 *     ~/.ssh) likewise.
 *   - One container level is skipped: `~/projects/<x>`, `~/src/<x>`.
 *   - A file directly in a container or in home is not a project; a bare directory is.
 *   - Checkout suffixes are folded: `prometheus-deploy` is Prometheus, `beacon-wt-3` is beacon.
 *     Real worktree resolution (`git rev-parse --git-common-dir`) needs the filesystem the paths
 *     live on, which is the daemon's, not Beacon's.
 */
export function projectOfPath(path: string): { key: string; label: string } | null {
  if (typeof path !== 'string') return null
  const m = path.match(/^(?:\/home\/[^/]+|\/Users\/[^/]+|~)(\/.*)?$/)
  if (!m || !m[1]) return null
  let parts = m[1].split('/').filter(Boolean)
  if (parts.length === 0) return null
  if (parts[0] === '.prometheus' && parts[1] === 'workspace' && parts.length >= 3) parts = parts.slice(2)
  if (CONTAINERS.has(parts[0].toLowerCase())) parts = parts.slice(1)
  if (parts.length === 0) return null
  // A project is a directory. `cd ~/pilot` names one; `~/notes.md` is a file sitting in home. With
  // nothing after it, a segment with an extension is read as a file.
  if (parts.length === 1 && /\.[A-Za-z0-9]{1,8}$/.test(parts[0])) return null
  const dir = parts[0]
  if (dir.startsWith('.') || NOT_PROJECTS.has(dir.toLowerCase()) || /^jdk[-\d.]*$/i.test(dir)) return null
  const label = dir.replace(/-(?:deploy|wt|worktree)(?:[-\w]*)?$/i, '') || dir
  return { key: label.toLowerCase(), label }
}

// Absolute or home-relative paths anywhere in a tool call's input: a `path` field, a `cwd`, or
// inside a shell command. Stops at whitespace, quotes and shell punctuation.
const PATH_IN_TEXT = /(?:\/home\/[\w.@+-]+|\/Users\/[\w.@+-]+|~)(?:\/[\w.@+=-]+)+/g

/** The distinct projects one tool call's input touches (each counted once per call). */
export function projectsInToolInput(input: string): Array<{ key: string; label: string }> {
  const seen = new Map<string, { key: string; label: string }>()
  for (const m of (input ?? '').matchAll(PATH_IN_TEXT)) {
    const p = projectOfPath(m[0])
    if (p && !seen.has(p.key)) seen.set(p.key, p)
  }
  return [...seen.values()]
}

export interface ProjectTally {
  /** key → number of tool calls that touched it. */
  counts: Record<string, number>
  /** key → label → occurrences, so the most common spelling wins the display name. */
  labels: Record<string, Record<string, number>>
  /** Tool calls that touched at least one project. The denominator of a share. */
  calls: number
}

export function tallyToolInputs(inputs: Iterable<string>): ProjectTally {
  const t: ProjectTally = { counts: {}, labels: {}, calls: 0 }
  for (const input of inputs) {
    const hit = projectsInToolInput(input)
    if (hit.length === 0) continue
    t.calls += 1
    for (const { key, label } of hit) {
      t.counts[key] = (t.counts[key] ?? 0) + 1
      const l = (t.labels[key] ??= {})
      l[label] = (l[label] ?? 0) + 1
    }
  }
  return t
}

export interface ProjectHint {
  key: string
  /** The most frequent spelling of the folder. */
  label: string
  /** Fraction of project-touching tool calls that touched this one, 0..1. */
  share: number
  /** Tool calls that touched any project: the evidence behind the share. */
  calls: number
}

/** Thresholds, fixed before looking at which sessions they pick. */
export const HINT_MIN_SHARE = 0.6
export const HINT_MIN_CALLS = 3

/**
 * The suggestion for one session, or null. Null when fewer than HINT_MIN_CALLS tool calls touched
 * any project, or when no single project has HINT_MIN_SHARE of them: a mixed session gets no
 * suggestion rather than a coin flip. A tie at the top is also null.
 */
export function suggestProject(t: ProjectTally): ProjectHint | null {
  if (t.calls < HINT_MIN_CALLS) return null
  const ranked = Object.entries(t.counts).sort((a, b) => b[1] - a[1])
  if (ranked.length === 0) return null
  const [key, n] = ranked[0]
  if (ranked.length > 1 && ranked[1][1] === n) return null
  const share = n / t.calls
  if (share < HINT_MIN_SHARE) return null
  const labels = Object.entries(t.labels[key] ?? {}).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  return { key, label: labels[0]?.[0] ?? key, share, calls: t.calls }
}

/**
 * What a session row should offer, given the store: nothing when it is already filed or the
 * operator dismissed this exact suggestion; otherwise the hint, plus the existing project it would
 * land in (by name, case-insensitive) so the chip can say "file into Beacon" instead of making a twin.
 */
export function rowSuggestion(
  s: ProjectStore,
  sessionId: string,
  hint: ProjectHint | undefined
): { hint: ProjectHint; existing?: SessionProject } | null {
  if (!hint || s.assign[sessionId] || s.dismissed[sessionId] === hint.key) return null
  return { hint, existing: findProjectByName(s, hint.label) }
}

// ── How unfiled sessions are shown ────────────────────────────────────────────

/** Settings key for the Unfiled toggle: 'date' (Today, Yesterday, ...) or 'one' (one Unfiled list). */
export const SESSION_UNFILED_SETTING_KEY = 'sessions:unfiled:v1'

export type UnfiledMode = 'date' | 'one'

/** Anything but the exact string 'one' reads as the default, so a missing or garbled value is by date. */
export function parseUnfiledMode(raw: string | null | undefined): UnfiledMode {
  return raw === 'one' ? 'one' : 'date'
}
