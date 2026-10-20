// The mission-plan model — PURE (no DOM, no Node, no IO), shared by the Board's plan section and
// the headless smoke, like @shared/loop and @shared/coding.
//
// A plan is a markdown file in the daemon's confined documents tree under `loops/`, written by the
// agent (the system prompt points it there) or by a human. The story row carries the STATE; the
// file carries the PROSE. They are joined by the story's `story_id` appearing at the head of the
// filename — see planFileFor.
//
// THE THREE STATES ARE THE POINT. "No plan" and "a plan with nothing tickable" are different facts
// and must never render the same. Observed 2026-09-18: the first real plan a model wrote under the
// documents instruction came back as `1.` numbered steps, so parseTasks found zero tasks and the
// checklist was 0/0 — visually identical to a story with no plan at all. A panel that collapses
// those two teaches the reader that a plan does not exist when it does.

import { parseTasks, taskRatio, type LoopTask } from './loop'

/**
 * The line the daemon stamps onto a DISPATCHED story's chat message, and the only place a story's
 * key ever reaches a conversation.
 *
 * Prometheus builds it from `_TASK_ID_LABEL = "Task ID"` (web/server.py stamps
 * `f"_Task ID: {story['story_id']}_"`), so this pattern is a TRANSCRIPTION of a contract owned by
 * the other repo — the same shape as Beacon's TASK_RE and the daemon's task-list example. It can
 * drift silently; the daemon-side test pins its half, and outputs-smoke pins this half against a
 * CAPTURED dispatch rather than a hand-written string.
 */
const TASK_ID_LINE = /^_Task ID:\s*(.+?)_\s*$/m

/**
 * The story a conversation is about, read from its own transcript. `null` when the conversation was
 * never dispatched from the Board — which is most of them, and is not an error.
 *
 * LAST match wins: a session dispatched twice is working on the newer task.
 */
export function taskIdFromText(text: string | null | undefined): string | null {
  if (!text) return null
  let found: string | null = null
  for (const m of text.matchAll(new RegExp(TASK_ID_LINE.source, 'gm'))) {
    const id = (m[1] ?? '').trim()
    if (id) found = id
  }
  return found
}

/** Where plans live under the confined documents root. One definition; surfaces import it. */
export const PLAN_DIR = 'loops'

/** Files a plan may live in: markdown only, directly under the loops/ directory. */
const PLAN_EXT = /\.md$/i

/**
 * The slug may not open with an all-digit segment, because `<LETTERS>-<DIGITS>` is itself the shape
 * of a story id. `US-001-plan.md` reads as US-001's plan, not as US's plan with the slug "001-plan".
 *
 * Without this, a plain `startsWith(id + '-')` let story `US` claim `US-001-plan.md` as kind:'one' —
 * a CONFIDENT SINGLE ANSWER to a question that has another answer, which is the exact failure this
 * module exists to refuse. Numeric siblings were already safe (`BC-1` never matched `BC-10-x.md`,
 * because the `-` in the prefix does not match the `0`); the hole was only at a hyphen boundary.
 */
const SLUG_OPENS_NUMERIC = /^\d+(?:-|$)/

/**
 * Which file belongs to a story.
 *
 * The join is `<story_id>-<slug>.md`, matched case-insensitively, where the slug may not open with
 * an all-digit segment (see SLUG_OPENS_NUMERIC). `story_id` is already TEXT NOT NULL on every row, already
 * rendered on every card, and already appended to each dispatch as `_Task ID: …_`, so the agent can
 * derive the path from what it is told — no schema change.
 *
 * AMBIGUITY IS A STATE, NOT A TIE-BREAK. `story_id` has NO UNIQUE constraint in the kanban schema
 * (verified against the live sqlite_master: no CHECK, no FK, no unique index), so two projects can
 * mint the same key, and separately a directory can simply hold two files with the same prefix.
 * Either way "pick the first" would silently show one story's plan under another's card. The caller
 * is told instead.
 */
export type PlanResolution =
  | { kind: 'none'; nearMisses: string[] }
  | { kind: 'one'; path: string }
  | { kind: 'ambiguous'; paths: string[] }

export function planFileFor(fileNames: readonly string[], storyId: string): PlanResolution {
  const id = storyId.trim()
  if (!id) return { kind: 'none', nearMisses: [] }
  // Case-insensitive, to match the extension test beside it. `bc-4-plan.md` was invisible to story
  // `BC-4` and the panel said "no plan" — true of its own predicate, and a lie about the disk.
  const prefix = `${id.toLowerCase()}-`
  const hits: string[] = []
  const nearMisses: string[] = []
  for (const n of fileNames) {
    if (!PLAN_EXT.test(n)) continue
    const lower = n.toLowerCase()
    if (!lower.startsWith(prefix)) continue
    // Everything after `<id>-` and before `.md` is the slug.
    if (SLUG_OPENS_NUMERIC.test(lower.slice(prefix.length).replace(PLAN_EXT, ''))) nearMisses.push(n)
    else hits.push(n)
  }
  hits.sort()
  nearMisses.sort()
  // A near miss is NOT silence. Dropping these on the floor would put a file that plainly mentions
  // this story back into the "no plan" rendering — the same collapse the three states exist to stop.
  if (hits.length === 0) return { kind: 'none', nearMisses }
  if (hits.length === 1) return { kind: 'one', path: hits[0] }
  return { kind: 'ambiguous', paths: hits }
}

/** The filename a NEW plan for this story should take. Slug is advisory; the prefix is the join. */
export function planFilename(storyId: string, slug: string): string {
  const clean = slug.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return `${storyId.trim()}-${clean || 'plan'}.md`
}

/** What the panel renders. Four shapes, and none of them is "empty list". */
export type PlanState =
  | { kind: 'no-plan'; nearMisses: string[] }
  | { kind: 'ambiguous'; paths: string[] }
  | { kind: 'untickable'; path: string; content: string; hasContent: boolean; truncated: boolean }
  | {
      kind: 'checklist'
      path: string
      content: string
      tasks: LoopTask[]
      done: number
      total: number
      /**
       * The daemon capped the READ at 256 KiB and said so. Ticking writes back exactly the content
       * we hold, so a write here would save the prefix over the whole file and delete the rest.
       * The panel must refuse the tick rather than perform it — silent truncation dressed as a
       * successful save is the worst shape available.
       */
      truncated: boolean
    }

/**
 * Fold a resolution plus its file content into the state to render.
 *
 * `content === null` means "resolved to a file we have not read yet or could not read" — the caller
 * decides whether that is a spinner or an error; it is NOT no-plan, and this never returns no-plan
 * for a file that exists.
 */
export function planStateFrom(
  resolution: PlanResolution,
  content: string | null,
  truncated = false
): PlanState {
  if (resolution.kind === 'none') return { kind: 'no-plan', nearMisses: resolution.nearMisses }
  if (resolution.kind === 'ambiguous') return { kind: 'ambiguous', paths: resolution.paths }
  const text = content ?? ''
  const tasks = parseTasks(text).tasks
  if (tasks.length === 0) {
    return {
      kind: 'untickable',
      path: resolution.path,
      content: text,
      hasContent: text.trim().length > 0,
      truncated,
    }
  }
  const { done, total } = taskRatio(tasks)
  return { kind: 'checklist', path: resolution.path, content: text, tasks, done, total, truncated }
}

/**
 * Did the daemon's directory listing hit its own ceiling?
 *
 * /api/documents truncates at 2000 entries and returns HTTP 200 with NO flag, so a loops/ that
 * outgrows the cap quietly demotes every plan past the boundary to "no plan" while planFilesErr
 * stays null. The count landing exactly on the cap is the only signal there is. A directory holding
 * exactly 2000 files warns without being truncated — the false positive is the safe direction,
 * because the alternative is a plan that exists and renders as absent.
 */
export const DOCS_LIST_CAP = 2000
export function listHitCap(entryCount: number): boolean {
  return entryCount >= DOCS_LIST_CAP
}

/**
 * How many plan files the Mission card will READ to show a done/total ratio.
 *
 * Mission is the default landing, so this runs on every launch: one listing plus one read per
 * story that has a plan. The cap bounds that, and the card NAMES it when it bites — a summary
 * that quietly stops counting at eight is a summary that lies about the ninth.
 */
export const PLAN_SUMMARY_READ_CAP = 8

/**
 * The banner copy, in ONE place.
 *
 * These four facts are reported by every surface that shows plans, and by 2026-09-18 the Board and
 * Mission already worded all four differently — the same failure described two ways, which is how a
 * reader learns to distrust both. The strings live here, beside the model they describe, so a third
 * surface inherits the wording instead of inventing a fifth variant; each surface still supplies its
 * own markup and palette, because the Board and Mission do not share a visual language.
 *
 * Plain strings on purpose: a shared React node would drag one surface's tokens into the other, and
 * these are testable headlessly only as strings.
 */
export const PLAN_BANNERS = {
  /** The stories read failed. Board's wording won — it names the call, not a vague "the board". */
  storiesUnread: (err: string): string =>
    `Could not load stories: ${err} — this board is not empty, it is unread.`,
  /** The plan listing failed. Mission's tighter present tense won over the Board's "will read". */
  listFailed: (err: string): string =>
    `Could not list plans: ${err} — a story with a plan reads as having none until this clears.`,
  /** loops/ does not exist yet. Board's won: it names the folder, which is the actionable part. */
  noneSavedYet: (dir: string): string =>
    `No plans saved yet. The ${dir}/ folder appears the first time a plan is written.`,
  /** The daemon truncated the listing. Board's won decisively — Mission's dropped the number. */
  listingCapped: (cap: number): string =>
    `The plan folder listing hit its ${cap}-entry ceiling, and the daemon truncates it without ` +
    `saying so. Plans past the cut exist but read as "no plan" — treat any story showing none as ` +
    `unverified until this clears.`,
  /** Two stories share an id. Only the Board says this today; the wording is carried over as-is. */
  duplicateIds: (ids: readonly string[]): string =>
    `Duplicate story ids: ${ids.join(', ')} — story_id has no UNIQUE constraint, so these stories ` +
    `resolve to the same plan file. Rename one before relying on its plan.`
}

/**
 * One line of the Mission card, per story, WITHOUT reading any file.
 *
 * Deliberately separate from the ratio: resolution is pure and total, while ratios cost a read
 * each and are capped. Keeping them apart means the counts below are never the capped subset.
 */
export type PlanRollupRow = {
  storyId: string
  title: string
  resolution: PlanResolution
}

export type PlanRollup = {
  rows: PlanRollupRow[]
  /** Stories whose id resolves to exactly one plan file. */
  withPlan: number
  /** Stories with two or more candidates — shown as a warning, never tie-broken. */
  ambiguous: number
  /** Stories with a file that starts with their id but is not claimed (see SLUG_OPENS_NUMERIC). */
  nearMiss: number
  /** Stories with nothing at all. Not an error — most stories start here. */
  noPlan: number
  /** Stories carrying a blank story_id: unkeyable in both directions, and invisible everywhere else. */
  unkeyable: number
}

export function rollUpPlans(
  stories: readonly { story_id?: string | null; title?: string | null }[],
  fileNames: readonly string[]
): PlanRollup {
  const rows: PlanRollupRow[] = []
  let withPlan = 0
  let ambiguous = 0
  let nearMiss = 0
  let noPlan = 0
  let unkeyable = 0
  for (const s of stories) {
    const storyId = (s.story_id ?? '').trim()
    if (!storyId) {
      // A blank id can never match a file and never receives a Task ID line on dispatch. It is
      // counted, not silently skipped, because nothing else on any surface reports it.
      unkeyable++
      continue
    }
    const resolution = planFileFor(fileNames, storyId)
    rows.push({ storyId, title: (s.title ?? '').trim(), resolution })
    if (resolution.kind === 'one') withPlan++
    else if (resolution.kind === 'ambiguous') ambiguous++
    else if (resolution.nearMisses.length) nearMiss++
    else noPlan++
  }
  return { rows, withPlan, ambiguous, nearMiss, noPlan, unkeyable }
}

/** Sum ticked/total across the plans actually read. Never invents a denominator for unread files. */
export function sumRatios(
  ratios: readonly { done: number; total: number }[]
): { done: number; total: number } {
  return ratios.reduce(
    (acc, r) => ({ done: acc.done + r.done, total: acc.total + r.total }),
    { done: 0, total: 0 }
  )
}

/**
 * story_ids that appear more than once across the loaded stories.
 *
 * The schema does not enforce uniqueness, so this is the only place the collision can be caught.
 * Two stories sharing a key both resolve to the same plan file, and the card would show a plan that
 * belongs to the other story with nothing to indicate it.
 */
export function duplicateStoryIds(stories: readonly { story_id?: string | null }[]): string[] {
  const seen = new Map<string, number>()
  for (const s of stories) {
    const id = (s.story_id ?? '').trim()
    if (!id) continue
    seen.set(id, (seen.get(id) ?? 0) + 1)
  }
  return [...seen.entries()].filter(([, n]) => n > 1).map(([id]) => id).sort()
}
