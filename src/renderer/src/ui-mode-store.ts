import { useSyncExternalStore } from 'react'
import { UI_MODE_KEY, firstUiMode, parseUiMode, type UiMode } from '@shared/ui-mode'

// Everyday or full (@shared/ui-mode), for this window: a module singleton so the rail, the pill
// rows, the palette, Config and Settings all read one value, and MainView's remount on a switch of
// Prometheus does not lose it.
//
// `full` until the stored value has been read. That is the safe direction: an existing install
// never sees its views flicker away at launch, and a new install is decided before the app view
// mounts (decideFirstUiMode runs from App's setup check).

let mode: UiMode = 'full'
let started = false
const subs = new Set<() => void>()

function set(next: UiMode): void {
  if (next === mode) return
  mode = next
  subs.forEach((fn) => fn())
}

async function read(): Promise<void> {
  const raw = await window.beacon?.settings.get(UI_MODE_KEY).catch(() => null)
  const stored = parseUiMode(raw)
  if (stored) set(stored)
}

function start(): void {
  if (started || !window.beacon) return
  started = true
  // Another window may have flipped the switch.
  window.addEventListener('focus', () => void read())
  void read()
}

export function useUiMode(): UiMode {
  return useSyncExternalStore(
    (cb) => {
      start()
      subs.add(cb)
      return () => subs.delete(cb)
    },
    () => mode
  )
}

/** The Settings switch. Shown at once; if the save fails the stored value is read back. */
export function setUiMode(next: UiMode): void {
  set(next)
  const saved = window.beacon?.settings.set(UI_MODE_KEY, next)
  if (saved) void saved.catch(() => read())
}

/**
 * Decide the mode ONCE for an install that has none stored, and write it (@shared/ui-mode
 * firstUiMode): a new install starts everyday, anything else keeps everything. Called from App's
 * setup check, before either the setup screens or the app mount. Does nothing once a mode is stored.
 */
export async function decideFirstUiMode(needsSetup: boolean): Promise<void> {
  const b = window.beacon
  if (!b) return
  try {
    const stored = parseUiMode(await b.settings.get(UI_MODE_KEY))
    if (stored) return set(stored)
    const conversations = await b.sessions.list().catch(() => [])
    const first = firstUiMode({ needsSetup, hasConversations: conversations.length > 0 })
    await b.settings.set(UI_MODE_KEY, first)
    set(first)
  } catch {
    // Unreadable or unwritable: stay on `full` for this launch and decide next time.
  }
}
