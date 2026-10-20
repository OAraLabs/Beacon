// Composer drafts that survive a session switch — the pure model plus the in-memory fast path.
// No DOM, no IPC, no fs, and nothing imported: scripts/drafts-smoke.mjs transpiles this file
// standalone (the context-meter-smoke idiom) and asserts it headlessly.
//
// WHY THIS EXISTS. ChatShell is remounted on every session switch — `key={active}` in MainView,
// deliberately, because it is what stops a Stop button from interrupting the wrong session. The
// remount is correct and stays. Its cost is that anything held in ChatShell's own state dies with
// the mount, and the draft was the one thing nobody had lifted: `mode`, `voiceState`,
// `dictateState` and `jumpTo` were each hoisted to MainView with a comment saying why, while the
// text a person was halfway through typing was still local `useState('')`.
//
// THE GENERAL PRINCIPLE, stated once: anything that must survive a session switch has to live
// above ChatShell. This module is that place for drafts — reached from ChatShell, but not owned by
// the mount that gets thrown away.
//
// WHY MEMORY-FIRST RATHER THAN SETTINGS-ONLY. Reading the durable row on mount is a round trip, so
// a fast A → B → A switch races the write A's unmount just fired against the read A's remount
// immediately performs. Two IPC channels and an async boundary would have to preserve send order
// for that to be safe, and "reasoned to be ordered" is not "observed to be ordered". The map below
// makes the fast path local and synchronous: an in-app switch never consults the durable store, so
// there is no race to lose. The store is what survives a RELAUNCH, which is the other half of what
// a person means by "it was still there when I came back".
//
// Same shape the app already uses for everything else: memory is the fast path, SQLite is the
// durable backing, and the cache is never a second source of truth.

/** Settings-table key prefix. Registered in CacheRepo.SESSION_SETTING_PREFIXES so forget-hygiene
 *  and the orphan sweep cover draft rows exactly as they cover `title:` / `viewed:` / `pinned:`. */
export const DRAFT_PREFIX = 'draft:'

/**
 * The longest draft that gets persisted, in UTF-16 code units.
 *
 * A bound, not a truncation point. 64 KiB is ~10,000 words — past anything a person types into a
 * chat box, and past a large paste. The composer itself has no maxLength, so this never limits
 * what can be SENT; it only limits what can be kept across a relaunch.
 *
 * Over the bound the draft is NOT stored in part. Storing a prefix would resurrect half a message
 * on the next launch, and half of what someone wrote reads as all of it — the same defect class as
 * a truncated refusal sentence presented as complete. Clearing instead is honest: the draft keeps
 * working for the whole session in memory, and only the durable copy is declined.
 */
export const DRAFT_STORE_MAX = 64 * 1024

/**
 * How long a keystroke waits before the durable write fires.
 *
 * Long enough that typing one word is one write rather than five, short enough that a crash or a
 * killed app loses a fraction of a sentence rather than the paragraph. 400ms is below the point
 * where switching away feels like it raced you.
 *
 * The in-memory copy is NOT debounced — it is written synchronously on every change, because it is
 * what a same-session-app switch reads back and a debounce there would be a window in which the
 * draft exists nowhere.
 */
export const DRAFT_WRITE_DEBOUNCE_MS = 400

/** Settings key for one session's draft. */
export function draftKey(sessionId: string): string {
  return `${DRAFT_PREFIX}${sessionId}`
}

/**
 * What to write to the durable store for this draft. `''` clears the row.
 *
 * Empty and over-bound both return `''` rather than signalling "skip the write": a skipped write
 * leaves the PREVIOUS draft on disk, so coming back to the session later would resurrect text that
 * was since deleted or replaced. Clearing is the only degradation that cannot show stale words.
 */
export function persistableDraft(text: string): string {
  if (text.length === 0) return ''
  if (text.length > DRAFT_STORE_MAX) return ''
  return text
}

/**
 * A draft read back from the durable store.
 *
 * `null` (no row) and `''` (a cleared row — this codebase's own convention for "empty value means
 * the flag was cleared", see pruneSessionSettings) both mean no draft. Anything else is the text.
 */
export function restorableDraft(raw: string | null | undefined): string {
  return typeof raw === 'string' && raw.length > 0 ? raw : ''
}

// ── the in-memory fast path ───────────────────────────────────────────────────
// Module state, deliberately: it has to outlive every ChatShell mount, and it does outlive a
// `key={connGen}` remount of the whole MainView on a connection rebuild, since the module is not
// re-evaluated. That is a feature — reconnecting to the daemon is not a reason to lose your typing.

const drafts = new Map<string, string>()

/**
 * Sessions forgotten during this app run.
 *
 * A tombstone, and it exists because of an ordering the forget flow cannot change: main deletes the
 * session's settings rows (`deleteSessionSettings`) while the session is still the open one, and the
 * renderer only then switches away — which unmounts ChatShell, whose cleanup flushes the draft to
 * the very key that was just deleted. Without this the durable row comes straight back, reintroducing
 * exactly the leak forget-hygiene was written to close.
 *
 * It also stops a later keystroke in a revived session from resurrecting the deleted draft. A
 * forgotten session that speaks again is a real path (the sidebar revives rather than burying it),
 * and the honest answer there is that its draft went with the forget.
 *
 * Memory-only and bounded by how many sessions one app run forgets. It does not need clearing: the
 * durable rows are gone, so on the next launch there is nothing for a stale tombstone to suppress.
 */
const forgotten = new Set<string>()

/**
 * Record a draft for a session. Synchronous, so the value is recoverable the instant the current
 * mount goes away — which is the whole gap this closes.
 *
 * An empty string REMOVES the entry rather than storing one: recall then misses and the caller
 * falls through to the durable store, which is being cleared by the same write. Keeping a `''`
 * entry would be indistinguishable in behaviour but would leave the map holding a row per session
 * ever visited, for nothing.
 *
 * Non-empty text LIFTS a forget tombstone. The tombstone exists to block one specific write — the
 * unmount flush of the draft that was in the field when forget ran, which would otherwise recreate
 * the row main just deleted. It is not a permanent ban: a forgotten session that speaks again is
 * revived rather than buried, and text typed into a live conversation after that point is a new
 * draft that deserves to persist like any other.
 */
export function rememberDraft(sessionId: string, text: string): void {
  if (text.length === 0) {
    drafts.delete(sessionId)
  } else {
    forgotten.delete(sessionId)
    drafts.set(sessionId, text)
  }
}

/**
 * The in-memory draft, or `undefined` when this module has not seen one for that session.
 *
 * `undefined` and `''` are different answers and must stay different: undefined means "ask the
 * durable store", `''` would mean "known empty, do not bother". Only rememberDraft writes here and
 * it never stores `''`, so a hit is always real text.
 */
export function recallDraft(sessionId: string): string | undefined {
  return drafts.get(sessionId)
}

/**
 * Drop this window's in-memory copy of a session's draft WITHOUT tombstoning it, so the next mount
 * reads the durable row instead.
 *
 * For a session that moves to its own window (@shared/session-windows): from then on the OTHER
 * window owns its draft and writes the durable row. If this window kept its memory copy, the session
 * coming back would show the text from before it left, not what was typed while it was away.
 */
export function dropDraftMemory(sessionId: string): void {
  drafts.delete(sessionId)
}

/** How many sessions currently hold an in-memory draft. Diagnostics and smoke assertions only. */
export function rememberedDraftCount(): number {
  return drafts.size
}

/**
 * Mark a session forgotten, so no later write resurrects its draft row.
 *
 * Called from MainView's forget() beside `b.session.forget(id)` — main deletes the durable rows, and
 * this is the renderer half of the same deletion. Calling it BEFORE the switch-away matters: the
 * switch is what unmounts ChatShell and triggers its flush. A forgotten conversation cannot come back
 * carrying text the durable store just deleted — memory and the store have to agree, or the forget is
 * only half a forget.
 */
export function forgetDraft(sessionId: string): void {
  drafts.delete(sessionId)
  forgotten.add(sessionId)
}

/** Whether a session has been forgotten this run and therefore must not have a draft written. */
export function isDraftForgotten(sessionId: string): boolean {
  return forgotten.has(sessionId)
}

/**
 * The value to write to the durable store for one session's draft, or `null` for "do not write".
 *
 * The one decision point both write paths (debounced and unmount-flush) go through, so they cannot
 * drift on the tombstone rule. `null` means skip entirely: for a forgotten session there is no row to
 * keep current and writing one would recreate what forget just deleted.
 */
export function draftStoreValue(sessionId: string, text: string): string | null {
  if (forgotten.has(sessionId)) return null
  return persistableDraft(text)
}

/** Test/maintenance reset. The smoke needs a clean module between cases; nothing else calls it. */
export function clearRememberedDrafts(): void {
  drafts.clear()
  forgotten.clear()
}
