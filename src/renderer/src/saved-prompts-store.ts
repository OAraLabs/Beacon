import { useSyncExternalStore } from 'react'
import { SAVED_PROMPTS_KEY, emptyPromptSync, syncChange, syncRead, syncSaved, type PromptStore, type PromptSync } from '@shared/saved-prompts'

// Saved prompts for this window: a module singleton, not context, because the readers live in
// different subtrees (the Chat home, the thread composer, the palette, the dialog) and ChatShell
// remounts on every session switch.
//
// This file only does the IO. What may be read over what, and when a change is accepted, is the
// state machine in @shared/saved-prompts (PromptSync), which the smoke walks.
//
// Read once from the settings table, and again whenever the window regains focus: a pop-out
// conversation window has its own copy of this module, and a prompt saved in one window should be
// there when the person clicks into the other. Between windows the whole row is last-writer-wins;
// the re-read on focus is what keeps a window from writing over a change it never saw.

let state: PromptSync = emptyPromptSync()
let started = false
const subs = new Set<() => void>()

function set(next: PromptSync): void {
  if (next === state) return
  state = next
  subs.forEach((fn) => fn())
}

async function read(): Promise<void> {
  const settings = window.beacon?.settings
  if (!settings) return
  const startedAt = state.gen
  try {
    set(syncRead(state, startedAt, await settings.get(SAVED_PROMPTS_KEY)))
  } catch {
    // Unreadable: keep what this window has. If nothing was ever read, changes stay refused.
  }
}

function start(): void {
  if (started || !window.beacon) return
  started = true
  window.addEventListener('focus', () => void read())
  void read()
}

const subscribe = (cb: () => void): (() => void) => {
  start()
  subs.add(cb)
  return () => subs.delete(cb)
}

export function useSavedPrompts(): PromptStore {
  return useSyncExternalStore(subscribe, () => state.store)
}

/** `loaded`: the stored prompts have been read (before that, show no starters rather than the
 *  built-in ones a person may have removed). `saveFailed`: the last change was not kept. */
export function useSavedPromptsStatus(): { loaded: boolean; saveFailed: boolean } {
  const s = useSyncExternalStore(subscribe, () => state)
  return { loaded: s.loaded, saveFailed: s.saveFailed }
}

/** Apply a change and save it. Returns false when nothing changed (the model refused the input, or
 *  the stored prompts have not been read yet), so a form can stay open and say so. A save that
 *  then fails sets `saveFailed` and reads the stored row back, so the window shows what is kept. */
export function updateSavedPrompts(fn: (s: PromptStore) => PromptStore): boolean {
  const { state: next, write } = syncChange(state, fn)
  if (write === null) return false
  set(next)
  const settings = window.beacon?.settings
  const saved = settings ? settings.set(SAVED_PROMPTS_KEY, write) : Promise.reject(new Error('no bridge'))
  void saved.then(
    () => set(syncSaved(state, true)),
    () => {
      // Say so, and show what is really stored (this read starts under the current gen, so it lands).
      set(syncSaved(state, false))
      void read()
    }
  )
  return true
}
