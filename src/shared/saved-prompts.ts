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
// THE SLASH NAME is derived from the title (`Plan my day` is `/plan-my-day`), never typed, so there
// is one thing to name. It may not equal a command in the slash catalog: `/status` has to keep
// meaning the daemon's status, whatever a person saves.

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
  /** The slash name, derived from the title by `slugOf`. */
  name: string
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

/** Why this title can't be saved, in words for the form, or null when it can. `exceptId` is the
 *  prompt being edited, which may keep its own name. */
export function titleProblem(store: PromptStore, title: string, exceptId?: string): string | null {
  const t = title.trim()
  if (!t) return 'Give it a name.'
  if (t.length > PROMPT_TITLE_MAX) return `Keep the name to ${PROMPT_TITLE_MAX} characters.`
  const name = slugOf(t)
  if (!name) return 'Use letters or numbers in the name.'
  if (RESERVED.has(name)) return `/${name} is already a command. Pick another name.`
  if (store.prompts.some((p) => p.name === name && p.id !== exceptId)) return 'You already have a prompt with that name.'
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
  const title = input.title.trim()
  return { ...store, prompts: [...store.prompts, { id, title, name: slugOf(title), text: input.text, createdAt: now, updatedAt: now }] }
}

export function updatePrompt(store: PromptStore, id: string, input: { title: string; text: string }, now: number): PromptStore {
  const cur = store.prompts.find((p) => p.id === id)
  if (!cur) return store
  if (titleProblem(store, input.title, id) || textProblem(input.text)) return store
  const title = input.title.trim()
  if (title === cur.title && input.text === cur.text) return store
  return { ...store, prompts: store.prompts.map((p) => (p.id === id ? { ...p, title, name: slugOf(title), text: input.text, updatedAt: now } : p)) }
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
 *  they kept. A saved prompt with a built-in's name replaces that built-in. */
export function starters(store: PromptStore): Starter[] {
  const own: Starter[] = store.prompts.map((p) => ({ id: p.id, title: p.title, name: p.name, text: p.text, builtin: false }))
  const taken = new Set(own.map((s) => s.name))
  const hidden = new Set(store.hiddenBuiltins)
  return [...own, ...BUILTIN_STARTERS.filter((b) => !hidden.has(b.id) && !taken.has(b.name))]
}

/** The starters as entries for the composer's `/` popup. `prompt` is what choosing one inserts. */
export function promptSlashCommands(store: PromptStore): SlashCommand[] {
  return starters(store).map((s) => ({ name: s.name, desc: s.title, web: true, prompt: s.text }))
}

/** The slash catalog with the starters after it. Catalog names are reserved, so nothing collides. */
export function slashCatalogWith(store: PromptStore): SlashCommand[] {
  return [...SLASH_COMMANDS, ...promptSlashCommands(store)]
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

/** Read a stored row. Anything unreadable is dropped, record by record: one bad prompt never costs
 *  the others, and a row that is not JSON at all reads as empty. The name is re-derived from the
 *  title, so a hand-edited row can't claim a reserved or mismatched name. */
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
  let store = emptyPromptStore()
  const seenIds = new Set<string>()
  for (const row of Array.isArray(obj.prompts) ? obj.prompts : []) {
    if (store.prompts.length >= PROMPTS_MAX) break
    if (!row || typeof row !== 'object') continue
    const r = row as Record<string, unknown>
    const id = str(r.id)
    const title = str(r.title)?.trim()
    const text = str(r.text)
    if (!id || seenIds.has(id) || !title || text === null) continue
    if (titleProblem(store, title) || textProblem(text)) continue
    seenIds.add(id)
    const createdAt = time(r.createdAt)
    store = { ...store, prompts: [...store.prompts, { id, title, name: slugOf(title), text, createdAt, updatedAt: Math.max(createdAt, time(r.updatedAt)) }] }
  }
  const builtinIds = new Set(BUILTIN_STARTERS.map((b) => b.id))
  const hidden = (Array.isArray(obj.hiddenBuiltins) ? obj.hiddenBuiltins : []).filter((x): x is string => typeof x === 'string' && builtinIds.has(x))
  return { ...store, hiddenBuiltins: [...new Set(hidden)] }
}
