// Documents Editor (Phase B/C) — shared DTOs + PURE helpers for the confined, disk-backed document
// panel. The daemon's /api/documents returns the SAME shapes as /api/files (path + entries; path +
// content + size + binary), so the list/read DTOs mirror those. The editor adds multi-tab state with
// dirty tracking — kept PURE here so the headless smoke proves the reducers without a renderer. The
// panel fetches via the scoped window.beacon.daemon.get / .write bridge (no new IPC); these helpers
// only shape the requests/responses and own the tab-reducer logic.

export interface DocEntry {
  name: string
  type: 'dir' | 'file'
  size?: number
  mtime?: number
}
export interface DocListDTO {
  path?: string
  entries?: DocEntry[]
}
export interface DocReadDTO {
  path?: string
  size?: number
  truncated?: boolean
  binary?: boolean
  content?: string
}
export interface DocSaveDTO {
  path?: string
  bytes_written?: number
  created?: boolean
}

// ── Daemon path builders (every one an allowed /api/ path — asserted by the smoke) ──────────────

/** GET — list one directory under the documents root (root = ''). */
export function docsListPath(dir: string): string {
  return `/api/documents?path=${encodeURIComponent(dir)}`
}
/** GET — read one file's content. */
export function docsReadPath(path: string): string {
  return `/api/documents/content?path=${encodeURIComponent(path)}`
}
/** PUT (write bridge) — save/overwrite one file. Body: { path, content }. */
export const DOCS_CONTENT_PATH = '/api/documents/content'
/** POST (write bridge) — apply one unique-match edit, returns a diff. Body: { path, old_str, new_str }. (Phase C) */
export const DOCS_EDIT_PATH = '/api/documents/edit'
/** POST (write bridge) — propose redline edits WITHOUT applying. Body: { path, instruction }. (Phase C) */
export const DOCS_SUGGEST_PATH = '/api/documents/suggest'

// ── Path display helpers ────────────────────────────────────────────────────────────────────────

/** Last path segment — the tab label. Pure. */
export function docBaseName(path: string): string {
  const i = path.lastIndexOf('/')
  return i >= 0 ? path.slice(i + 1) : path
}

/** Breadcrumb trail rooted at the documents root. Pure. */
export function docBreadcrumbs(path: string): { name: string; path: string }[] {
  const crumbs = [{ name: 'documents', path: '' }]
  let acc = ''
  for (const seg of path ? path.split('/') : []) {
    acc = acc ? `${acc}/${seg}` : seg
    crumbs.push({ name: seg, path: acc })
  }
  return crumbs
}

// ── Multi-tab editor model (pure reducers — the smoke proves these) ──────────────────────────────

export interface DocTab {
  path: string // documents-root-relative
  content: string // current buffer (may be edited)
  saved: string // last-persisted content; dirty = content !== saved
}

/** A tab is dirty when its buffer diverges from the last save. Pure. */
export function tabDirty(t: DocTab): boolean {
  return t.content !== t.saved
}

/** Any open tab unsaved? Pure. */
export function anyDirty(tabs: DocTab[]): boolean {
  return tabs.some(tabDirty)
}

/** Open `path` with freshly-read `content`. If already open, returns its index WITHOUT clobbering an
 * in-progress edit (re-opening a file you're editing must not discard the buffer). Else appends a
 * clean tab. Pure — returns the next tabs + the index to activate. */
export function openDocTab(tabs: DocTab[], path: string, content: string): { tabs: DocTab[]; index: number } {
  const existing = tabs.findIndex((t) => t.path === path)
  if (existing >= 0) return { tabs, index: existing }
  return { tabs: [...tabs, { path, content, saved: content }], index: tabs.length }
}

/** Replace a tab's buffer (an edit). Pure. */
export function setTabContent(tabs: DocTab[], index: number, content: string): DocTab[] {
  return tabs.map((t, i) => (i === index ? { ...t, content } : t))
}

/** Mark a tab saved: its buffer becomes the persisted baseline (no longer dirty). Pure. */
export function markTabSaved(tabs: DocTab[], index: number, savedContent: string): DocTab[] {
  return tabs.map((t, i) => (i === index ? { ...t, content: savedContent, saved: savedContent } : t))
}

/** Remove a tab. Pure. */
export function closeDocTab(tabs: DocTab[], index: number): DocTab[] {
  return tabs.filter((_, i) => i !== index)
}

/** Which tab index to activate after closing `closing`, given the current `active`. Keeps focus
 * stable: closing before the active one shifts active down; closing the active one falls to the
 * neighbour; emptying yields -1. Pure. */
export function nextActiveAfterClose(tabCount: number, closing: number, active: number): number {
  const remaining = tabCount - 1
  if (remaining <= 0) return -1
  if (closing < active) return active - 1
  if (closing > active) return active
  return Math.min(closing, remaining - 1) // closed the active tab → fall to the former-next, clamped
}

// ── Phase C: AI edits + redline/suggest mode ─────────────────────────────────────────────────────

/** One proposed redline from POST /api/documents/suggest (model-driven, daemon-validated). `applicable`
 * is the daemon's verdict that `find` occurs exactly once right now; `note` says why not when false. */
export interface DocSuggestion {
  find: string
  replace: string
  reason: string
  applicable: boolean
  note: string
}
export interface DocSuggestDTO {
  edits?: DocSuggestion[]
}
/** POST /api/documents/edit result — the canonical server-computed unified diff, or the loud
 * no-match/multi-match error (ok:false). */
export interface DocEditResultDTO {
  ok?: boolean
  diff?: string
  error?: string
}

/** Apply ONE find→replace to `content` (first occurrence only — mirrors the daemon's unique-match
 * str_replace, which we only invoke when the match is unique, so the buffer stays in lock-step with
 * disk without a re-read). Returns content unchanged when `find` is absent. Pure. */
export function applyOnce(content: string, find: string, replace: string): string {
  const i = content.indexOf(find)
  if (i < 0) return content
  return content.slice(0, i) + replace + content.slice(i + find.length)
}

/** Is a new-file name acceptable for the inline create input? Non-empty, no leading slash, no
 * traversal, no NUL. The daemon re-validates under the root; this just keeps the input honest. Pure. */
export function validDocName(name: string): boolean {
  const n = name.trim()
  return n.length > 0 && !n.startsWith('/') && !n.includes('..') && !n.includes('\0')
}

/** Classify a unified-diff line for token-colored rendering. Pure. */
export function diffLineKind(line: string): 'add' | 'del' | 'meta' | 'ctx' {
  if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('@@')) return 'meta'
  if (line.startsWith('+')) return 'add'
  if (line.startsWith('-')) return 'del'
  return 'ctx'
}

// ── Redline review-view (Editor Makeover): inline tracked-changes layout ─────────────────────────
// The makeover renders Ask-AI suggestions as inline redlines IN the document (not a bottom diff
// drawer). These pure helpers lay the still-PENDING edits into the current buffer so the renderer
// just maps segments → spans. Kept pure here so the smoke proves placement / overlap / not-found
// without a DOM. `idx` is each edit's index in the component's items[] so accept/reject callbacks
// stay stable across re-layouts (each accept mutates the buffer → we re-layout the remainder).

export type ReviewStatus = 'pending' | 'approved' | 'rejected' | 'failed' | 'na'

/** A run of unchanged text, or one proposed edit shown in place (find struck-through → replace). */
export type ReviewSegment =
  | { kind: 'text'; text: string }
  | { kind: 'edit'; idx: number; find: string; replace: string; reason: string }

export interface ReviewLayout {
  segments: ReviewSegment[]
  /** Pending edits whose `find` can't be placed inline right now (absent, or overlaps an earlier
   * edit) — surfaced separately so a proposal is never silently dropped. */
  unplaceable: { idx: number; find: string; replace: string; reason: string; note: string }[]
}

/** Place the pending suggestions into `text` as inline tracked-changes, in document order. Pure. */
export function reviewSegments(text: string, pending: { idx: number; sugg: DocSuggestion }[]): ReviewLayout {
  const located: { idx: number; start: number; sugg: DocSuggestion }[] = []
  const unplaceable: ReviewLayout['unplaceable'] = []
  for (const { idx, sugg } of pending) {
    const at = sugg.find ? text.indexOf(sugg.find) : -1
    if (at < 0) {
      unplaceable.push({ idx, find: sugg.find, replace: sugg.replace, reason: sugg.reason, note: sugg.note || 'no longer found in the document' })
    } else {
      located.push({ idx, start: at, sugg })
    }
  }
  located.sort((a, b) => a.start - b.start)
  const segments: ReviewSegment[] = []
  let cursor = 0
  for (const p of located) {
    if (p.start < cursor) {
      unplaceable.push({ idx: p.idx, find: p.sugg.find, replace: p.sugg.replace, reason: p.sugg.reason, note: 'overlaps another edit — decide that one first' })
      continue
    }
    if (p.start > cursor) segments.push({ kind: 'text', text: text.slice(cursor, p.start) })
    segments.push({ kind: 'edit', idx: p.idx, find: p.sugg.find, replace: p.sugg.replace, reason: p.sugg.reason })
    cursor = p.start + p.sugg.find.length
  }
  if (cursor < text.length) segments.push({ kind: 'text', text: text.slice(cursor) })
  return { segments, unplaceable }
}

/** Tally review item statuses for the review header/footer. Pure. */
export function reviewTally(statuses: ReviewStatus[]): Record<ReviewStatus, number> {
  const t: Record<ReviewStatus, number> = { pending: 0, approved: 0, rejected: 0, failed: 0, na: 0 }
  for (const s of statuses) t[s] += 1
  return t
}
