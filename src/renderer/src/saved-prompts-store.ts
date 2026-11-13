import { useSyncExternalStore } from 'react'
import { SAVED_PROMPTS_KEY, emptyPromptStore, parsePromptStore, serializePromptStore, type PromptStore } from '@shared/saved-prompts'

// Saved prompts for this window (@shared/saved-prompts): a module singleton, not context, because
// the readers live in different subtrees (the Chat home, the thread composer, the palette, the
// dialog) and ChatShell remounts on every session switch.
//
// Read once from the settings table, and again whenever the window regains focus: a pop-out
// conversation window has its own copy of this module, and a prompt saved in one window should be
// there when the person clicks into the other.

let store: PromptStore = emptyPromptStore()
/** False until a read has succeeded. Nothing is written before that, so a failed read can never
 *  be followed by a save that replaces what is stored with an empty list. */
let loaded = false
let started = false
const subs = new Set<() => void>()

async function read(): Promise<void> {
  const settings = window.beacon?.settings
  if (!settings) return
  try {
    const raw = await settings.get(SAVED_PROMPTS_KEY)
    const next = parsePromptStore(raw)
    loaded = true
    if (serializePromptStore(next) === serializePromptStore(store)) return
    store = next
    subs.forEach((fn) => fn())
  } catch {
    // Unreadable: keep what this window has, and keep `loaded` as it was.
  }
}

function start(): void {
  if (started || !window.beacon) return
  started = true
  window.addEventListener('focus', () => void read())
  void read()
}

export function useSavedPrompts(): PromptStore {
  return useSyncExternalStore(
    (cb) => {
      start()
      subs.add(cb)
      return () => subs.delete(cb)
    },
    () => store
  )
}

/** Apply a change and keep it. Returns false when nothing changed (the model refused the input, or
 *  the stored prompts have not been read yet), so a form can stay open and say so. */
export function updateSavedPrompts(fn: (s: PromptStore) => PromptStore): boolean {
  if (!loaded) return false
  const next = fn(store)
  if (next === store) return false
  store = next
  subs.forEach((cb) => cb())
  void window.beacon?.settings.set(SAVED_PROMPTS_KEY, serializePromptStore(next)).catch(() => undefined)
  return true
}
