// Saved prompts and starters: the pure model (no DOM, no React, no IO), shared by the Chat home's
// starter row, the composer's `/` popup, the command palette and the headless smoke.
//
// WHAT A SAVED PROMPT IS. Text a person wants to reuse, under a short title. Choosing one puts its
// text in the message box; it never sends. That is the whole behaviour, and it is deliberate: a
// starter that sent on click would start a turn the person had not read.
//
// WHERE THEY LIVE. In Beacon's own settings table on this computer, under one key, so they are
// kept across launches and are the same whichever Prometheus is connected. They do not follow a
// person to another device. The record below is written so it can move to Prometheus later without
// a rewrite: each prompt stands alone, has an id that never changes, and carries `updatedAt`, which
// is what a merge between two devices would compare.
//
// THE SLASH NAME IS DERIVED, NEVER STORED AND NEVER A REASON TO REFUSE. `Plan my day` is
// `/plan-my-day`. A title that derives no usable name (no ASCII letter or digit, a name the slash
// catalog already uses, or one an earlier prompt took) simply has no slash name: the prompt is
// still on the new-chat screen, in the palette and in the dialog. Deriving at read time is what
// makes this safe across releases: a command added to the catalog later takes its name back from
// a prompt without the prompt being dropped, and `/status` always means the daemon's status.

import { SLASH_COMMANDS, type SlashCommand } from './slash-commands'

/** The settings-table key. App-wide, NOT session-scoped, so it is deliberately absent from
 *  CacheRepo.SESSION_SETTING_PREFIXES: forgetting a session must never clear it. */
export const SAVED_PROMPTS_KEY = 'prompts:saved:v1'

export const PROMPT_TITLE_MAX = 40
/** The same ceiling the composer uses before it turns a paste into an attachment. */
export const PROMPT_TEXT_MAX = 8000
export const PROMPTS_MAX = 100
const NAME_MAX = 32

export interface SavedPrompt {
  /** Stable for the prompt's life; the caller mints it (a uuid), so this module stays pure. */
  id: string
  title: string
  text: string
  /** Epoch ms. */
  createdAt: number
  updatedAt: number
}

export interface PromptStore {
  prompts: SavedPrompt[]
  /** Ids of built-in starters the person removed. */
  hiddenBuiltins: string[]
}

/** One row as the UI shows it: a saved prompt or a built-in starter. */
export interface Starter {
  id: string
  title: string
  /** The slash name, or '' when this one has none (see the header). */
  name: string
  text: string
  builtin: boolean
}

/** The starters a new install shows. Each ends where the person's own words begin. */
export const BUILTIN_STARTERS: readonly Starter[] = [
  {
    id: 'builtin:plan-my-day',
    title: 'Plan my day',
    name: 'plan-my-day',
    text: 'Help me plan today. Here is what is on my plate:\n\n',
    builtin: true
  },
  {
    id: 'builtin:summarise-this',
    title: 'Summarise this',
    name: 'summarise-this',
    text: 'Summarise the following. Give me the key points, any decisions, and what I need to do:\n\n',
    builtin: true
  },
  {
    id: 'builtin:draft-a-reply',
    title: 'Draft a reply',
    name: 'draft-a-reply',
    text: 'Draft a reply to the message below. Keep it short and in a friendly, direct tone:\n\n',
    builtin: true
  },
  {
    id: 'builtin:research-a-topic',
    title: 'Research a topic',
    name: 'research-a-topic',
    text: 'Research this on the web and give me a short brief with links to your sources: ',
    builtin: true
  }
]

export function emptyPromptStore(): PromptStore {
  return { prompts: [], hiddenBuiltins: [] }
}

/** `Plan my day!` → `plan-my-day`. Empty when the title has no letter or digit. */
export function slugOf(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, NAME_MAX)
    .replace(/-+$/g, '')
}

const RESERVED = new Set(SLASH_COMMANDS.map((c) => c.name))
const sameTitle = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase()

/** Why this title can't be saved, in words for the form, or null when it can. `exceptId` is the
 *  prompt being edited, which may keep its own title. Only two things refuse a title: it is empty
 *  or too long, or the person already has a prompt called that. */
export function titleProblem(store: PromptStore, title: string, exceptId?: string): string | null {
  const t = title.trim()
  if (!t) return 'Give it a name.'
  if (t.length > PROMPT_TITLE_MAX) return `Keep the name to ${PROMPT_TITLE_MAX} characters.`
  if (store.prompts.some((p) => p.id !== exceptId && sameTitle(p.title, t))) return 'You already have a prompt with that name.'
  return null
}

export function textProblem(text: string): string | null {
  if (!text.trim()) return 'Write the prompt.'
  if (text.length > PROMPT_TEXT_MAX) return `Keep the prompt to ${PROMPT_TEXT_MAX.toLocaleString('en-US')} characters.`
  return null
}

/** Add a prompt. Returns the SAME store when the input is refused, so a caller can tell. */
export function addPrompt(store: PromptStore, input: { title: string; text: string }, id: string, now: number): PromptStore {
  if (!id || store.prompts.some((p) => p.id === id)) return store
  if (store.prompts.length >= PROMPTS_MAX) return store
  if (titleProblem(store, input.title) || textProblem(input.text)) return store
  return { ...store, prompts: [...store.prompts, { id, title: input.title.trim(), text: input.text, createdAt: now, updatedAt: now }] }
}

export function updatePrompt(store: PromptStore, id: string, input: { title: string; text: string }, now: number): PromptStore {
  const cur = store.prompts.find((p) => p.id === id)
  if (!cur) return store
  if (titleProblem(store, input.title, id) || textProblem(input.text)) return store
  const title = input.title.trim()
  if (title === cur.title && input.text === cur.text) return store
  return { ...store, prompts: store.prompts.map((p) => (p.id === id ? { ...p, title, text: input.text, updatedAt: now } : p)) }
}

/** Remove a saved prompt, or hide a built-in starter. */
export function removeStarter(store: PromptStore, id: string): PromptStore {
  if (store.prompts.some((p) => p.id === id)) return { ...store, prompts: store.prompts.filter((p) => p.id !== id) }
  if (BUILTIN_STARTERS.some((b) => b.id === id) && !store.hiddenBuiltins.includes(id)) {
    return { ...store, hiddenBuiltins: [...store.hiddenBuiltins, id] }
  }
  return store
}

export function restoreBuiltins(store: PromptStore): PromptStore {
  return store.hiddenBuiltins.length === 0 ? store : { ...store, hiddenBuiltins: [] }
}

/** Everything on offer, the person's own first (in the order they were made), then the built-ins
 *  they kept. A saved prompt with a built-in's title replaces that built-in. Slash names are
 *  handed out here, in this order, first come first served; see the header for who gets none. */
export function starters(store: PromptStore): Starter[] {
  const taken = new Set<string>()
  const nameFor = (title: string): string => {
    const name = slugOf(title)
    if (!name || RESERVED.has(name) || taken.has(name)) return ''
    taken.add(name)
    return name
  }
  const own: Starter[] = store.prompts.map((p) => ({ id: p.id, title: p.title, name: nameFor(p.title), text: p.text, builtin: false }))
  const hidden = new Set(store.hiddenBuiltins)
  const kept = BUILTIN_STARTERS.filter((b) => !hidden.has(b.id) && !store.prompts.some((p) => sameTitle(p.title, b.title)))
  return [...own, ...kept.map((b) => ({ ...b, name: nameFor(b.title) }))]
}

/** The slash name a title would get if saved now, or '' with the reason it gets none. For the
 *  form's hint; `exceptId` is the prompt being edited. */
export function slashNameFor(store: PromptStore, title: string, exceptId?: string): { name: string; why: '' | 'none' | 'command' | 'taken' } {
  const name = slugOf(title)
  if (!name) return { name: '', why: 'none' }
  if (RESERVED.has(name)) return { name, why: 'command' }
  // Ask the real rule: put the title where the prompt sits (its own place when edited, last when
  // new) and see whether it comes out with the name.
  const probe = exceptId ?? '\u0000new'
  const prompts = exceptId
    ? store.prompts.map((p) => (p.id === exceptId ? { ...p, title } : p))
    : [...store.prompts, { id: probe, title, text: '-', createdAt: 0, updatedAt: 0 }]
  const got = starters({ ...store, prompts }).find((s) => s.id === probe)?.name
  return got ? { name, why: '' } : { name, why: 'taken' }
}

/** A prompt's text into a draft: on its own paragraph after anything already typed, and EXACTLY
 *  as saved. The trailing space or blank line a prompt ends on is where the person's own words
 *  begin, so nothing is trimmed from it. */
export function insertPrompt(draft: string, text: string): string {
  if (!text) return draft
  const head = draft.replace(/\s+$/, '')
  return head ? `${head}\n\n${text}` : text
}

/**
 * The starters as rows for the composer's `/` popup, for what has been typed after the slash.
 * `prompt` is what choosing one inserts. A starter is offered only when its name CONTAINS the
 * query: the popup's fuzzy ranking also matches letters in order, which is right for a short
 * command catalog but would put a prompt under almost any unknown `/word`, and Enter on a
 * listed row inserts it where it used to send the word to the daemon.
 */
export function promptSlashCommands(store: PromptStore, query = ''): SlashCommand[] {
  const q = query.toLowerCase()
  return starters(store)
    .filter((s) => s.name && s.name.includes(q))
    .map((s) => ({ name: s.name, desc: s.title, web: true, prompt: s.text }))
}

/** The slash catalog with the matching starters after it. Catalog names are reserved, so nothing collides. */
export function slashCatalogWith(store: PromptStore, query = ''): SlashCommand[] {
  return [...SLASH_COMMANDS, ...promptSlashCommands(store, query)]
}

// ── Storage ─────────────────────────────────────────────────────────────────────────────────────

export function serializePromptStore(store: PromptStore): string {
  return JSON.stringify({ v: 1, prompts: store.prompts, hiddenBuiltins: store.hiddenBuiltins })
}

function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null
}
function time(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0
}

/** Far above anything the form allows; a record past these is damage, not a long prompt. */
const STORED_TITLE_MAX = 400
const STORED_TEXT_MAX = PROMPT_TEXT_MAX * 8

/**
 * Read a stored row. STRUCTURE is checked, the form's rules are not: a record is dropped only when
 * it is not a prompt at all (no id, a repeated id, no title, no text) or is absurdly large. A
 * title longer than today's limit, or two prompts with one title, are kept as they are, because a
 * record dropped here is erased for good by the next save. A row that is not JSON reads as empty.
 */
export function parsePromptStore(raw: string | null | undefined): PromptStore {
  if (!raw) return emptyPromptStore()
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    return emptyPromptStore()
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return emptyPromptStore()
  const obj = data as Record<string, unknown>
  const prompts: SavedPrompt[] = []
  const seenIds = new Set<string>()
  for (const row of Array.isArray(obj.prompts) ? obj.prompts : []) {
    if (prompts.length >= PROMPTS_MAX) break
    if (!row || typeof row !== 'object') continue
    const r = row as Record<string, unknown>
    const id = str(r.id)
    const title = str(r.title)?.trim()
    const text = str(r.text)
    if (!id || seenIds.has(id) || !title || !text || !text.trim()) continue
    if (title.length > STORED_TITLE_MAX || text.length > STORED_TEXT_MAX) continue
    seenIds.add(id)
    const createdAt = time(r.createdAt)
    prompts.push({ id, title, text, createdAt, updatedAt: Math.max(createdAt, time(r.updatedAt)) })
  }
  const builtinIds = new Set(BUILTIN_STARTERS.map((b) => b.id))
  const hidden = (Array.isArray(obj.hiddenBuiltins) ? obj.hiddenBuiltins : []).filter((x): x is string => typeof x === 'string' && builtinIds.has(x))
  return { prompts, hiddenBuiltins: [...new Set(hidden)] }
}

// ── Loading and saving, as a state machine ──────────────────────────────────────────────────────
// The window's copy of the store, and the three things that can go wrong keeping it:
//   * a save before the stored row has ever been read would replace it with an empty list;
//   * a read that started BEFORE a change and finishes after it would undo the change in memory,
//     and the next edit would then write that older state back;
//   * a save that fails would leave the window showing a prompt that is not kept.
// Pure, so the smoke can walk each one. The renderer store (saved-prompts-store.ts) does the IO.

export interface PromptSync {
  store: PromptStore
  /** False until one read has succeeded. No change is accepted before that. */
  loaded: boolean
  /** Bumped by every accepted change. A read carries the value it started under. */
  gen: number
  /** The last save did not reach the settings table. Cleared by the next one that does. */
  saveFailed: boolean
}

export function emptyPromptSync(): PromptSync {
  return { store: emptyPromptStore(), loaded: false, gen: 0, saveFailed: false }
}

/** A read came back. Ignored when a change was made since it started (`startedAt` is the `gen`
 *  the read began under): the change is newer than what the read saw. */
export function syncRead(state: PromptSync, startedAt: number, raw: string | null | undefined): PromptSync {
  if (startedAt !== state.gen) return state
  const next = parsePromptStore(raw)
  if (state.loaded && serializePromptStore(next) === serializePromptStore(state.store)) return state
  return { ...state, store: next, loaded: true }
}

/** Apply a change. `write` is the row to save, or null when nothing changed (the model refused
 *  the input, or nothing has been read yet), in which case the state is the same object. */
export function syncChange(state: PromptSync, fn: (s: PromptStore) => PromptStore): { state: PromptSync; write: string | null } {
  if (!state.loaded) return { state, write: null }
  const next = fn(state.store)
  if (next === state.store) return { state, write: null }
  return { state: { ...state, store: next, gen: state.gen + 1 }, write: serializePromptStore(next) }
}

/** The save for the change made at `gen` finished. A failure is reported, and the caller reads the
 *  stored row again so the window shows what is really kept. */
export function syncSaved(state: PromptSync, ok: boolean): PromptSync {
  return state.saveFailed === !ok ? state : { ...state, saveFailed: !ok }
}
