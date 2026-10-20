// File checkpoints (Prometheus #381) — the Beacon half. Pure model: DTO shapes from the daemon,
// ordering, formatting, the restore-plan sentence and the confirm rule. No React, no fetch, so the
// smoke can pin the contract without a DOM (same approach as @shared/artifacts + artifacts-smoke).
//
// WHY THIS PANEL EXISTS: the daemon takes a checkpoint per turn for sessions WITH a workspace, and a
// checkpoint that cannot be written is logged and the turn PROCEEDS. The only place that gap shows
// is the checkpoint list — so until this list was visible, "undo" could silently not-happen with no
// surface where anyone would notice. This panel is that surface. It claims exactly what the list
// says: a checkpoint exists for a turn, or it does not.

import { httpStatusFromError } from './daemon-api'

export interface CheckpointRow {
  id: string
  session_id?: string
  workspace?: string
  label?: string
  /** ISO-8601 UTC string or epoch seconds — the store writes ISO; be tolerant of a float. */
  created_at?: string | number
  files?: number
  bytes?: number
  skipped?: number
}

export interface CheckpointListDTO {
  session_id?: string
  checkpoints?: CheckpointRow[]
}

export interface CheckpointFile {
  rel_path: string
  sha256?: string
  size?: number
  mtime?: number
  mode?: number
}

/** GET /api/sessions/{id}/checkpoints/{cid} — the row plus its files and what a restore would do now. */
export interface CheckpointDetailDTO extends CheckpointRow {
  files_detail?: CheckpointFile[]
  skipped_detail?: { rel_path?: string; path?: string; reason?: string; size?: number }[]
  diff?: { changed?: string[]; deleted?: string[]; added?: string[]; unchanged?: string[] }
}

/** POST …/restore result — identical shape for dry_run and the real thing (that is the point). */
export interface RestoreResultDTO {
  checkpoint?: string
  dry_run?: boolean
  restored?: string[]
  deleted?: string[]
  unchanged?: string[]
  uncaptured?: string[]
  errors?: { path?: string; error?: string }[]
}

/** GET /api/sessions/{id}/workspace (item W) — `source: 'session'` means a workspace is bound. */
export interface SessionWorkspaceDTO {
  source?: 'session' | 'daemon' | string
  workspace?: string | null
  path?: string | null
  cwd?: string | null
  /**
   * The gate's configured write roots, from the daemon's own `resolve_workspace_root`. This is the
   * candidate list AND the count the bind confirmation quotes. The panel renders
   * `daemon_workspace_roots.length`, never a literal, because a control must not claim a number it
   * did not read. Absent on a daemon vintage that predates the field; see `boundaryEffect`.
   */
  daemon_workspace_roots?: string[]
  /**
   * The daemon process's cwd. A candidate, but NOT necessarily inside a root — see `boundaryEffect`.
   */
  daemon_cwd?: string | null
}

/** PUT/DELETE /api/sessions/{id}/workspace — the write side. `workspace` is the RESOLVED path
 * (the daemon expands `~` and follows symlinks), or null after a clear. Note the asymmetry with
 * the request, which names the field `path`. */
export interface WorkspaceWriteDTO {
  ok?: boolean
  session_id?: string
  workspace?: string | null
}

/** PUT body. The request key is `path`; the response key is `workspace`. A blank path CLEARS,
 * which is why the daemon's own `"a path is required"` refusal is unreachable over REST — it is
 * only produced for a non-blank string, and a blank one never reaches the validator. */
export function bindBody(path: string): { path: string } {
  return { path: path.trim() }
}

// ── ordering / formatting ────────────────────────────────────────────────────────────────────

export function createdAtMs(c: Pick<CheckpointRow, 'created_at'>): number {
  const v = c.created_at
  if (typeof v === 'number') return v > 1e12 ? v : v * 1000
  if (typeof v === 'string' && v) {
    const t = Date.parse(v.endsWith('Z') || /[+-]\d\d:\d\d$/.test(v) ? v : `${v}Z`)
    return Number.isFinite(t) ? t : 0
  }
  return 0
}

/** Newest first. The daemon already sends newest-first; sorting here keeps the panel honest if it stops. */
export function sortCheckpoints(rows: CheckpointRow[]): CheckpointRow[] {
  return [...rows].sort((a, b) => createdAtMs(b) - createdAtMs(a))
}

export function fmtCheckpointTime(c: Pick<CheckpointRow, 'created_at'>, now: number = Date.now()): string {
  const t = createdAtMs(c)
  if (!t) return '—'
  const s = Math.max(0, Math.round((now - t) / 1000))
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

const LABEL_MAX = 72
export function fmtCheckpointLabel(c: Pick<CheckpointRow, 'label' | 'id'>): string {
  const raw = (c.label ?? '').replace(/\s+/g, ' ').trim()
  if (!raw) return `checkpoint ${c.id.slice(0, 8)}`
  return raw.length > LABEL_MAX ? `${raw.slice(0, LABEL_MAX - 1)}…` : raw
}

/** "12 files · 48.2 KB · 1 skipped" — the skipped count is part of the claim, never hidden. */
export function fmtCheckpointStats(c: Pick<CheckpointRow, 'files' | 'bytes' | 'skipped'>): string {
  const files = c.files ?? 0
  const parts = [`${files} file${files === 1 ? '' : 's'}`, fmtKb(c.bytes ?? 0)]
  if ((c.skipped ?? 0) > 0) parts.push(`${c.skipped} skipped`)
  return parts.join(' · ')
}

function fmtKb(b: number): string {
  if (b < 1024) return `${b} B`
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`
  return `${(b / (1024 * 1024)).toFixed(1)} MB`
}

// ── the restore contract ─────────────────────────────────────────────────────────────────────

/** The body the daemon requires. Naming the checkpoint twice IS the confirmation; a dry run needs none. */
export function restoreBody(cid: string, dryRun: boolean): { confirm?: string; dry_run: boolean } {
  return dryRun ? { dry_run: true } : { confirm: cid, dry_run: false }
}

export interface RestorePlan {
  rewrite: number
  remove: number
  unchanged: number
  uncaptured: number
  errors: number
  /** Nothing would change — restoring is a no-op. */
  noop: boolean
}

export function restorePlan(r: RestoreResultDTO | null | undefined): RestorePlan {
  const rewrite = r?.restored?.length ?? 0
  const remove = r?.deleted?.length ?? 0
  const errors = r?.errors?.length ?? 0
  return {
    rewrite,
    remove,
    unchanged: r?.unchanged?.length ?? 0,
    uncaptured: r?.uncaptured?.length ?? 0,
    errors,
    noop: rewrite === 0 && remove === 0 && errors === 0
  }
}

/** One sentence a person can decide on. Counts, not adjectives; says "nothing" when nothing. */
export function restorePlanSentence(p: RestorePlan, dryRun: boolean): string {
  if (p.noop) return dryRun ? 'Nothing would change — the workspace already matches this checkpoint.' : 'Nothing changed — the workspace already matched this checkpoint.'
  const verbRewrite = dryRun ? 'would rewrite' : 'rewrote'
  const verbRemove = dryRun ? 'would remove' : 'removed'
  const bits: string[] = []
  if (p.rewrite > 0) bits.push(`${verbRewrite} ${p.rewrite} file${p.rewrite === 1 ? '' : 's'}`)
  if (p.remove > 0) bits.push(`${verbRemove} ${p.remove} created since`)
  let s = `Restore ${bits.join(' and ')}`
  if (p.uncaptured > 0) s += p.uncaptured === 1 ? '; 1 file was too large to capture and is left as it is' : `; ${p.uncaptured} files were too large to capture and are left as they are`
  if (p.errors > 0) s += `; ${p.errors} error${p.errors === 1 ? '' : 's'}`
  return `${s}.`
}

// ── failure states (typed, not prose-matched in the panel) ────────────────────────────────────

export type CheckpointsUnavailable = 'auth' | 'disabled' | 'no-session' | 'error'

/** 401 → not authorized; 503 → the daemon has checkpoints off; 404 on the list → the session is unknown. */
export function checkpointsUnavailableReason(err: unknown): CheckpointsUnavailable {
  const status = httpStatusFromError(err)
  if (status === 401) return 'auth'
  if (status === 503) return 'disabled'
  if (status === 404) return 'no-session'
  return 'error'
}

/** True when the session has a workspace of its own (item W). Undefined workspace info → unknown → false. */
export function hasBoundWorkspace(ws: SessionWorkspaceDTO | null | undefined): boolean {
  return ws?.source === 'session' && Boolean(ws.workspace ?? ws.path ?? ws.cwd)
}

export function boundWorkspacePath(ws: SessionWorkspaceDTO | null | undefined): string | null {
  if (!hasBoundWorkspace(ws)) return null
  return (ws?.workspace ?? ws?.path ?? ws?.cwd) as string
}

/** The empty state says WHY there is nothing, because "no checkpoints" has two very different causes. */
export function emptyStateText(bound: boolean, canBind = true): string {
  if (bound) return 'No checkpoints yet for this session. One is taken at the start of each turn that runs with this workspace.'
  // `canBind` false means the workspace GET did not answer — an older daemon, or an error. Two
  // claims have to go with it: that nothing is bound (we do not know), and that a control is there
  // to fix it (there is not). Pointing at a button that is not on screen is the worse half.
  if (!canBind) return 'This daemon did not answer for the session’s workspace, so whether checkpoints are taken for it is unknown.'
  return 'This session has no workspace bound, so no checkpoints are taken for it. Use Bind… above — or /workspace <path> in the chat.'
}

// ── binding a workspace: the write side of item W ───────────────────────────
//
// Binding REPLACES the gate's roots for this conversation. agent_loop.py computes
// `run_workspace_roots = (session_workspace,) if session_workspace else None` — a total
// replacement, not an addition — and the daemon logs the set at WARNING for that reason. So every
// candidate is labelled with what it does to the boundary, because one of them can GRANT rather
// than restrict.
//
// Two facts this model exists to keep the UI from misstating:
//   1. binding replaces the write boundary (count read live, never a literal), and
//   2. it lands on the conversation's NEXT turn — agent_loop resolves the workspace once per run,
//      "frozen for the run like the tool catalog".

export type BoundaryEffect = 'narrows' | 'widens' | 'same' | 'unknown'

export interface WorkspaceCandidate {
  path: string
  /** Where the daemon offered it: a configured gate root, or the daemon process cwd. */
  kind: 'root' | 'cwd'
  effect: BoundaryEffect
}

/**
 * Lexical directory form: collapses `//`, drops `.`, resolves `..`, strips a trailing slash.
 * '/' stays '/'. Blank in → blank out.
 *
 * `..` is resolved because the daemon calls `Path.resolve()` before it stores anything, so
 * `/srv/app/../../etc` IS `/etc` by the time it is the write boundary. Comparing the raw string
 * against a root would have called that a NARROWING — the one direction of error that reassures.
 * Symlinks are the part this cannot follow; see `boundaryEffect`.
 */
function normalizeDir(p: string | null | undefined): string {
  const raw = (p ?? '').trim()
  if (!raw) return ''
  const absolute = raw.startsWith('/')
  const out: string[] = []
  for (const seg of raw.split('/')) {
    if (!seg || seg === '.') continue
    if (seg === '..') {
      // Above an absolute root is still the root; on a relative path it has to stay.
      if (out.length && out[out.length - 1] !== '..') out.pop()
      else if (!absolute) out.push('..')
      continue
    }
    out.push(seg)
  }
  const joined = out.join('/')
  return absolute ? `/${joined}` : joined
}

/** A path we can compare: absolute after normalising. `~/x` is not one — only the daemon knows its home. */
function comparable(p: string): boolean {
  return p.startsWith('/')
}

function cleanRoots(roots: string[] | undefined): string[] {
  return (roots ?? []).filter((r) => typeof r === 'string' && r.trim() !== '')
}

/**
 * What binding `path` does to this conversation's write boundary, given the daemon's roots.
 *
 * The brief that asked for this control described every offered candidate as "a reduction in
 * privilege, because the gate already permits it". That holds for `daemon_workspace_roots`. It
 * does NOT hold for `daemon_cwd`: cwd is `Path.cwd()` of the daemon process and has no
 * relationship to `security.workspace_root`, so a cwd outside every root is a directory the gate
 * refuses today — and binding to it lets the agent write there. `validate_workspace_path` only
 * refuses DENIED paths; "not denied" is not "inside a root". Free text has the same exposure.
 *
 * 'unknown' rather than a guess wherever an honest answer is not available here: no roots reported
 * (an older daemon), or a non-absolute path such as `~/x`, which only the daemon can expand. The
 * daemon also `.resolve()`s symlinks, so for free text every label is a PREDICTION — which is why
 * `bindOutcomeText` re-states the effect from the path the PUT actually resolved.
 */
export function boundaryEffect(path: string, baseline: string[] | undefined): BoundaryEffect {
  const p = normalizeDir(path)
  if (!p || !comparable(p)) return 'unknown'
  const rs = cleanRoots(baseline).map(normalizeDir).filter(Boolean)
  if (rs.length === 0) return 'unknown'

  // A root this client cannot read is not a corner case: the SHIPPED default is
  // `~/.prometheus/workspace`, `resolve_workspace_root` returns the config string VERBATIM, and
  // `cli/init.py` writes that tilde into every fresh config. A real box mixes both kinds.
  //
  // THE ASYMMETRY, and why this is decided per row rather than globally. The boundary before
  // binding is the UNION of the roots, so an unreadable root can only make that union LARGER:
  //
  //   inside a readable root  ⇒  p ⊆ r ⊆ union(R) NO MATTER what the unreadable ones expand to.
  //                               `narrows` is sound. They cannot remove p from a union they can
  //                               only add to.
  //   inside no readable root ⇏  `widens`. p may well be inside the unreadable one —
  //                               `~/.prometheus/workspace` could contain it — so asserting a
  //                               GRANT there would be a fabrication.
  //
  // The conservative answer is therefore required in the widens direction only. Refusing to label
  // every row because one root is unreadable (which is what a global rule does) turns off the
  // signal on the ordinary five-root box for no gain in honesty.
  // `${r}/` and not just `r`, or /srv/application would read as inside /srv/app.
  const readable = rs.filter(comparable)
  const unreadable = rs.length - readable.length
  const inside = readable.some((r) => p === r || p.startsWith(r === '/' ? '/' : `${r}/`))

  if (inside) {
    // `same` claims the boundary is UNCHANGED, which needs every root to be this directory — not
    // provable while one is unreadable, since it might expand to something else. `narrows` is the
    // honest fallback there: it can only overstate a restriction, never hide a grant.
    if (unreadable > 0) return 'narrows'
    // Coverage, not count: duplicates and trailing-slash variants of one root collapse to it.
    return readable.every((r) => r === p) ? 'same' : 'narrows'
  }
  // Outside everything we can read. Only when there is nothing we cannot read is `widens` provable.
  return unreadable > 0 ? 'unknown' : 'widens'
}

/**
 * The set this conversation may write to RIGHT NOW — the baseline any change is measured against.
 *
 * A bound session's boundary is its bound directory, NOT the daemon's roots: re-binding an already
 * bound session from `/srv/app/web` to `/srv/app` is a WIDENING, and measuring it against the roots
 * would have called it a narrowing and said so in the confirmation.
 */
export function currentBoundary(bound: string | null | undefined, roots: string[] | undefined): string[] {
  const b = (bound ?? '').trim()
  return b ? [b] : cleanRoots(roots)
}

/** The word on the badge — and the same word the confirmation uses, so the two cannot drift. */
export function boundaryEffectLabel(e: BoundaryEffect): string {
  if (e === 'narrows') return 'narrows'
  if (e === 'widens') return 'widens'
  if (e === 'same') return 'no change'
  return 'effect unknown'
}

/**
 * The bind candidates, out of the GET the panel already makes: the configured roots, then the
 * daemon cwd when it is not already one of them. Deduped on the normalized path, order-stable.
 *
 * NOTHING IS PRE-SELECTED: there is no `default` field and no first-item convention anywhere in
 * this model. A control that replaces a write boundary must not arrive with a choice already made.
 */
export function workspaceCandidates(ws: SessionWorkspaceDTO | null | undefined): WorkspaceCandidate[] {
  const roots = cleanRoots(ws?.daemon_workspace_roots)
  const out: WorkspaceCandidate[] = []
  const seen = new Set<string>()
  for (const r of roots) {
    const key = normalizeDir(r)
    if (!key || seen.has(key)) continue
    seen.add(key)
    out.push({ path: r.trim(), kind: 'root', effect: boundaryEffect(r, roots) })
  }
  const cwd = (ws?.daemon_cwd ?? '').trim()
  const cwdKey = normalizeDir(cwd)
  if (cwdKey && !seen.has(cwdKey)) {
    out.push({ path: cwd, kind: 'cwd', effect: boundaryEffect(cwd, roots) })
  }
  return out
}

/**
 * Whether a forked session's picker shows its parent's path, and — the part that matters — what
 * that does to the selection.
 *
 * This lives here rather than inside the component because the guarantee it encodes ("a fork is
 * never auto-bound; the suggestion is pre-FILLED, never pre-SELECTED") had no assertion anywhere
 * in the gate while it was a handler body: `checkpoints-smoke` has no DOM, and the probe's scratch
 * session was never forked. Flipping the handler to select the suggestion would have gone
 * unnoticed by every test. As a function it is pinnable, and `select: false` is a literal type, so
 * the compiler refuses `true` as well.
 *
 * Returns null when there is nothing to suggest, or when the operator has already typed something
 * — their text outranks a hint.
 */
export interface ForkSuggestion {
  /** Text to place in the free-text box. */
  fill: string
  /** ALWAYS false. A fork must not arrive with a choice already made. */
  select: false
}

export function forkSuggestion(parentPath: string | null | undefined, typed: string): ForkSuggestion | null {
  const p = (parentPath ?? '').trim()
  if (!p) return null
  if ((typed ?? '').trim()) return null
  return { fill: p, select: false }
}

/**
 * The next-turn clause. ONE exported constant because both confirmations, both outcome lines and
 * the smoke must carry the identical sentence — five copies of a fact is five chances to drift.
 */
export const NEXT_TURN_CLAUSE =
  'This takes effect on the conversation’s NEXT turn — a turn already in flight keeps the boundary it started with.'

function rootsPhrase(n: number): string {
  return n === 1 ? 'the daemon’s 1 configured root' : `the daemon’s ${n} configured roots`
}

/** How the CURRENT boundary reads in a sentence — the bound directory when there is one, else the
 *  daemon's roots. The count is always the live one; nothing here is a literal. */
function baselinePhrase(bound: string | null | undefined, roots: string[] | undefined): string {
  const b = (bound ?? '').trim()
  if (b) return `${b} (this conversation’s current boundary)`
  const n = cleanRoots(roots).length
  return n === 0 ? 'the daemon’s own configuration' : rootsPhrase(n)
}

/**
 * The bind confirmation. Carries BOTH facts the control may not misstate — that binding REPLACES
 * the boundary, and that it lands on the next turn — and measures against what this conversation
 * may write to NOW, which for an already-bound session is its bound directory, not the roots.
 */
export function bindConfirmText(
  path: string,
  roots: string[] | undefined,
  bound?: string | null
): string {
  const baseline = currentBoundary(bound, roots)
  const effect = boundaryEffect(path, baseline)
  const scope = `This REPLACES this conversation’s write boundary: ${baselinePhrase(bound, roots)} ${
    // Plural only for two-or-more roots. A bound path, a single root, and the no-roots phrase
    // ("the daemon's own configuration") are all singular subjects.
    (bound ?? '').trim() || cleanRoots(roots).length <= 1 ? 'becomes' : 'become'
  } that one directory.`
  const consequence =
    effect === 'widens'
      ? ' It is not inside that boundary, so this GRANTS write access this conversation does not have today.'
      : effect === 'unknown'
        ? ' Whether that widens or narrows the boundary cannot be told from here — the daemon resolves the path.'
        : ''
  return `${scope}${consequence} It is where the agent may write and where relative paths resolve. ${NEXT_TURN_CLAUSE}`
}

/**
 * The CLEAR confirmation. Clearing is not the harmless half of this control, and it is not always a
 * widening either: it REPLACES the bound directory with the daemon's roots. When the bound
 * directory sits outside those roots — the case the ▲ badge exists for — clearing REVOKES that
 * access rather than granting any, and saying "widens" there would be exactly backwards. Either
 * way it stops the per-turn checkpoints this panel exists to show.
 */
export function clearConfirmText(roots: string[] | undefined, bound?: string | null): string {
  const rs = cleanRoots(roots)
  const target = rs.length === 0 ? 'the daemon’s own configuration' : rootsPhrase(rs.length)
  const b = (bound ?? '').trim()
  const effect = b ? boundaryEffect(b, rs) : 'unknown'
  const direction =
    effect === 'widens'
      ? ` ${b} is not inside them, so this REVOKES write access there rather than granting any.`
      : effect === 'unknown'
        ? ' Whether that widens or narrows the boundary cannot be told from here.'
        : ' That WIDENS the boundary beyond the single directory bound now.'
  return `This REPLACES this conversation’s write boundary with ${target}.${direction} File checkpoints stop being taken for this conversation. ${NEXT_TURN_CLAUSE}`
}

/**
 * What actually happened, stated from the path the daemon RESOLVED rather than the one typed.
 * `~` expansion and symlink resolution happen daemon-side, so a free-text bind can land somewhere
 * the picker's label did not predict. This line is the fact; the badge was the forecast.
 */
export function bindOutcomeText(resolved: string | null | undefined, roots: string[] | undefined): string {
  const p = (resolved ?? '').trim()
  if (!p) return 'The daemon reported no workspace after the bind — nothing is bound.'
  const e = boundaryEffect(p, cleanRoots(roots))
  const tail =
    e === 'widens'
      ? ' That is outside the daemon’s configured roots — this conversation may now write where the gate otherwise refuses.'
      : e === 'narrows'
        ? ' That is inside the daemon’s configured roots — a narrower boundary than the daemon’s own.'
        : e === 'same'
          ? ' That matches the daemon’s configured root exactly — no narrower than the daemon’s own.'
          : ''
  return `Bound to ${p}.${tail} ${NEXT_TURN_CLAUSE}`
}

export function clearOutcomeText(roots: string[] | undefined): string {
  const rs = cleanRoots(roots)
  const where = rs.length === 0 ? 'the daemon’s own configuration' : rootsPhrase(rs.length)
  return `Workspace cleared — the write boundary widens back to ${where}, and checkpoints stop. ${NEXT_TURN_CLAUSE}`
}
