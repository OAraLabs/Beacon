// Loop Manager — PURE domain core (no DOM, no Node, no IO). Shared by the renderer panel and the
// headless smoke (one source of truth, like @shared/coding and @shared/gateway-events).
//
// Three concerns, all pure and byte-faithful:
//   1. TASKS.md  — GFM task-list parse + single-line write-back (toggle/add/remove). Non-task lines
//      are preserved VERBATIM; only the targeted line changes. Round-trips bytes.
//   2. LOOP.md   — a run contract in prose → parsed fields (acceptance / rounds / wall / conventions).
//   3. compile   — (contract + selected task) → an /api/code CodingLaunchRequest, reusing the exact
//      coding-surface DTO + defaults so the board fires the SAME engine the Coding panel does.

import { CODING_DEFAULTS, type CodingLaunchRequest } from './coding'

// ── 1. TASKS.md ──────────────────────────────────────────────────────────────

/** One GFM task-list item, with everything needed to rewrite ONLY its line byte-faithfully. */
export interface LoopTask {
  /** 0-based index into the file's `\n`-split lines (the write-back address). */
  lineIndex: number
  done: boolean
  /** Display text WITHOUT the trailing `[Tag]` (trimmed). */
  text: string
  /** The trailing `[Tag]` value, or null. */
  tag: string | null
}

export interface ParsedTasks {
  /** The file split on `\n` (join('\n') reproduces the original bytes, trailing newline included). */
  lines: string[]
  tasks: LoopTask[]
}

// A GFM task line: indent, bullet (-/*/+), checkbox ([ ] / [x] / [X]), then the text.
const TASK_RE = /^(\s*)([-*+])\s+\[([ xX])\]\s?(.*)$/
// Just the checkbox cell — the FIRST bracket pair on the line (never a trailing `[Tag]`).
const CHECKBOX_RE = /\[[ xX]\]/
// A trailing "[Tag]" at the very end of the task text.
const TAG_RE = /\s*\[([^[\]]+)\]\s*$/

/** Split bytes-faithfully: `"a\nb\n".split('\n')` → ['a','b',''] and join('\n') restores it. */
function splitLines(content: string): string[] {
  return content.split('\n')
}

/** Parse a TASKS.md body into its lines + the task items found (non-task lines are kept in `lines`
 * only). Pure — never reformats. */
export function parseTasks(content: string): ParsedTasks {
  const lines = splitLines(content)
  const tasks: LoopTask[] = []
  lines.forEach((line, lineIndex) => {
    const m = TASK_RE.exec(line)
    if (!m) return
    const done = m[3] !== ' '
    let text = m[4]
    let tag: string | null = null
    const tagM = TAG_RE.exec(text)
    if (tagM) {
      tag = tagM[1].trim()
      text = text.slice(0, tagM.index)
    }
    tasks.push({ lineIndex, done, text: text.trim(), tag })
  })
  return { lines, tasks }
}

/** Count of done vs total task items. */
export function taskRatio(tasks: LoopTask[]): { done: number; total: number } {
  return { done: tasks.filter((t) => t.done).length, total: tasks.length }
}

/** Toggle exactly one task line's checkbox, preserving every other byte (indent, bullet, text, tag,
 * and all other lines). Flips the FIRST `[ ]`/`[x]`/`[X]` on the line — the checkbox, never a
 * `[Tag]`. No-op (returns input unchanged) if the line isn't a task line. */
export function setTaskDone(content: string, lineIndex: number, done: boolean): string {
  const lines = splitLines(content)
  const line = lines[lineIndex]
  if (line === undefined || !TASK_RE.test(line)) return content
  lines[lineIndex] = line.replace(CHECKBOX_RE, done ? '[x]' : '[ ]')
  return lines.join('\n')
}

/** Append a new unchecked task. Inserted right AFTER the last existing task line (keeping tasks
 * grouped); if there are none, appended at end-of-body. Everything else is untouched. Returns the
 * input unchanged if `text` is blank. */
export function addTask(content: string, text: string, tag?: string | null): string {
  const trimmed = text.trim()
  if (!trimmed) return content
  const suffix = tag && tag.trim() ? ` [${tag.trim()}]` : ''
  const newLine = `- [ ] ${trimmed}${suffix}`
  const lines = splitLines(content)
  const { tasks } = parseTasks(content)
  if (tasks.length > 0) {
    lines.splice(tasks[tasks.length - 1].lineIndex + 1, 0, newLine)
    return lines.join('\n')
  }
  // No tasks yet: append, but keep a trailing-newline sentinel (the final '') last.
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.splice(lines.length - 1, 0, newLine)
  else lines.push(newLine)
  return lines.join('\n')
}

/** Remove exactly one task line. No-op if `lineIndex` isn't a task line. */
export function removeTask(content: string, lineIndex: number): string {
  const lines = splitLines(content)
  const line = lines[lineIndex]
  if (line === undefined || !TASK_RE.test(line)) return content
  lines.splice(lineIndex, 1)
  return lines.join('\n')
}

export const DEFAULT_TASKS_MD = `# Tasks

- [ ] First task [Setup]
`

// ── 2. LOOP.md (a run contract in prose) ─────────────────────────────────────

/** The machine-relevant fields a LOOP.md contributes to a run. Everything else in the file is human
 * prose the compiler ignores. */
export interface LoopContract {
  /** Acceptance command (the "done signal") — REQUIRED to compile a run. */
  acceptanceCommand: string | null
  /** Max iterate-to-green rounds (retry policy). null → engine default (30). */
  maxRounds: number | null
  /** Max wall-clock seconds. null → engine default (1200). */
  maxWallSeconds: number | null
  /** Optional conventions/preamble prepended to each task's run description. */
  conventions: string | null
}

// "Key: value" lines, case-insensitive keys. Synonyms collapse to one field.
const CONTRACT_KEYS: Record<string, keyof LoopContract> = {
  acceptance: 'acceptanceCommand',
  'acceptance command': 'acceptanceCommand',
  'done signal': 'acceptanceCommand',
  done: 'acceptanceCommand',
  'max rounds': 'maxRounds',
  rounds: 'maxRounds',
  'max wall seconds': 'maxWallSeconds',
  'max wall': 'maxWallSeconds',
  'wall seconds': 'maxWallSeconds',
  conventions: 'conventions'
}

const KV_RE = /^\s*([A-Za-z][A-Za-z ]*?)\s*:\s*(.*\S)\s*$/

/** Parse the prose contract. Recognized `Key: value` lines fill the fields; unrecognized lines are
 * ignored (they're human notes). The first occurrence of a key wins. Pure. */
export function parseLoopContract(content: string): LoopContract {
  const out: LoopContract = { acceptanceCommand: null, maxRounds: null, maxWallSeconds: null, conventions: null }
  for (const line of splitLines(content)) {
    const m = KV_RE.exec(line)
    if (!m) continue
    const field = CONTRACT_KEYS[m[1].trim().toLowerCase()]
    if (!field) continue
    const value = m[2].trim()
    if (field === 'maxRounds' || field === 'maxWallSeconds') {
      if (out[field] !== null) continue // first wins
      const n = Number.parseInt(value, 10)
      if (Number.isFinite(n) && n > 0) out[field] = n
    } else if (out[field] === null) {
      out[field] = value
    }
  }
  return out
}

export const DEFAULT_LOOP_MD = `# Loop contract

How this project's runs are composed. The board compiles the fields below into a coding-mode run;
the prose around them is just for humans.

Acceptance: PYTHONPATH=src python3 -m pytest -q
Max rounds: 30
Max wall seconds: 1200

## Conventions (optional — prepended to each run's task)
Conventions: Match the surrounding code style; keep the diff minimal.
`

// ── 3. compile → /api/code ───────────────────────────────────────────────────

export interface CompileResult {
  /** The launch payload — ready to POST to /api/code when `errors` is empty. */
  payload: CodingLaunchRequest
  /** Human-readable reasons the run can't fire yet (empty = ready). */
  errors: string[]
}

/** Compile a contract + a chosen task into an /api/code launch payload. `rootPath` is the project's
 * local git repo (the daemon runs it in-place). Reuses CODING_DEFAULTS so an unspecified cap matches
 * the engine's own (30 rounds / 1200 s). Returns the payload AND a list of blocking errors, so the UI
 * can show both the preview and exactly why Fire is disabled. */
export function compilePayload(contract: LoopContract, taskText: string, rootPath: string): CompileResult {
  const errors: string[] = []
  const repo = rootPath.trim()
  const task = taskText.trim()
  const acceptance = (contract.acceptanceCommand ?? '').trim()
  if (!repo) errors.push('No project root — register a local repo path first.')
  if (!task) errors.push('No task selected — pick or type a task to run.')
  if (!acceptance) errors.push('LOOP.md has no Acceptance / Done-signal — the run needs a command that must exit 0.')
  const description =
    contract.conventions && contract.conventions.trim() ? `${contract.conventions.trim()}\n\n${task}` : task
  const payload: CodingLaunchRequest = {
    repo,
    description,
    acceptance_command: acceptance,
    max_rounds: contract.maxRounds ?? CODING_DEFAULTS.maxRounds,
    max_wall_seconds: contract.maxWallSeconds ?? CODING_DEFAULTS.maxWallSeconds
  }
  return { payload, errors }
}

// ── 4. WS routing key ────────────────────────────────────────────────────────

/** The live-stream session id for a launched run: the daemon keys coding telemetry + WS events as
 * `coding:<coding_task_id>` (see prometheus coding/livestream.py), so the board reads
 * `codingRuns[codingSessionId(coding_task_id)]` to route each stream to its project card. */
export function codingSessionId(codingTaskId: string): string {
  return `coding:${codingTaskId}`
}

// ── 5. Project registry (shape + validation; persistence lives in main/loop-store.ts) ──

/** A token color NAME for a project's sidebar dot — mapped to a design token in the renderer (never
 * a raw hex here; raw colors are confined to theme/tokens.css). */
export const LOOP_PROJECT_COLORS = ['arc', 'amber', 'violet', 'ok', 'err'] as const
export type LoopProjectColor = (typeof LOOP_PROJECT_COLORS)[number]

/** A registered local project. NO remote host/IP — local-only v1 (Phase 0 SSH decision). */
export interface LoopProject {
  id: string
  label: string
  /** Absolute local path to the project's git repo (becomes the /api/code `repo`). */
  rootPath: string
  color: LoopProjectColor
}

function isColor(v: unknown): v is LoopProjectColor {
  return typeof v === 'string' && (LOOP_PROJECT_COLORS as readonly string[]).includes(v)
}

/** Validate/normalize a persisted registry blob into clean LoopProjects. Drops malformed/duplicate
 * entries (never throws) so a corrupt file degrades to fewer projects, not a crash. Pure. */
export function sanitizeProjects(raw: unknown): LoopProject[] {
  if (!Array.isArray(raw)) return []
  const out: LoopProject[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const o = item as Record<string, unknown>
    const id = typeof o.id === 'string' ? o.id.trim() : ''
    const rootPath = typeof o.rootPath === 'string' ? o.rootPath.trim() : ''
    const label = typeof o.label === 'string' ? o.label.trim() : ''
    if (!id || !rootPath || seen.has(id)) continue
    seen.add(id)
    out.push({ id, label: label || rootPath, rootPath, color: isColor(o.color) ? o.color : 'arc' })
  }
  return out
}

// ── 6. Local project-file wire DTOs (shared by ipc.ts + main/loop-fs.ts) ──────

/** Result of reading a confined project file. `mtimeMs` lets the board detect EXTERNAL edits (a run
 * writing back, or you editing on disk) without clobbering an in-flight optimistic change. */
export interface LoopFileRead {
  content: string
  mtimeMs: number
}

export interface LoopFileWrite {
  mtimeMs: number
}

/** A user-picked Markdown file (the "drop in a contract from elsewhere" flow). The dialog IS the
 * user's consent, so this read is unconfined — distinct from readFile, which stays under a root. */
export interface LoopPickedFile {
  path: string
  name: string
  content: string
}

/** Pull the daemon's specific `{ "error": … }` out of a rest-client error message (the form is
 * `HTTP 400: PUT /api/project-file — {json}`) so the UI shows the real reason ("not a git
 * repository …") rather than the raw HTTP string. Pure; falls back to the message itself when there
 * is no embedded JSON error. */
export function extractDaemonError(message: string): string {
  const m = message.match(/—\s*(\{[\s\S]*\})\s*$/)
  if (m) {
    try {
      const body = JSON.parse(m[1]) as { error?: unknown }
      if (typeof body.error === 'string' && body.error) return body.error
    } catch {
      /* not JSON — fall through to the raw message */
    }
  }
  return message
}

// ── 7. Contract-from-Documents picker (pure — the smoke proves the filter) ────

/** One row of the ContractEditor's "From Documents…" picker — a structural subset of the documents
 * DTO's DocEntry, so this module stays decoupled from @shared/documents. */
export interface ContractDocEntry {
  name: string
  type: 'dir' | 'file'
}

/** Filter a /api/documents listing down to what the contract picker shows: directories (to walk
 * into) and .md files (to load), dirs first, each group alphabetical. Everything else the daemon
 * may list — binaries, .txt, images — is noise for a Markdown-contract picker. Pure. */
export function contractPickerEntries<T extends ContractDocEntry>(entries: T[] | undefined): T[] {
  return (entries ?? [])
    .filter((e) => e.type === 'dir' || /\.md$/i.test(e.name))
    .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1))
}
