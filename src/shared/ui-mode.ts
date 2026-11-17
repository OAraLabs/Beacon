// Everyday mode: which views and settings a person sees. Pure (no React, no IO), shared by the
// rail, the pill rows, the palette, the Config tabs and the headless smoke.
//
// TWO MODES, ONE REGISTRY. `full` is Beacon as it has always been: every view in NAV_TREE, every
// Config tab, Mission as the home. `everyday` is the same app with the operator's surfaces put
// away: no Coding, no Activity, no Board, Checkpoints, Skills or Integrations, and the Config tabs
// that are a daemon's internals. Nothing is removed or renamed in the registry (@shared/views
// stays the one list, and its order and count stay a pinned contract); everyday mode is a VIEW of
// it, built here.
//
// THE HOME is the `mission` view in both modes. In everyday mode it is drawn as Today (what needs
// you, what happened since you looked, what is coming up) and the rail calls it Today; in full
// mode it is Mission, unchanged. One view id, so nothing that says "go home" has to know the mode.
//
// WHO GETS WHICH. An install that already exists keeps everything: it is `full` and stays `full`
// until its owner says otherwise. A new install starts `everyday`. The choice is one switch in
// Settings, and it changes nothing but what is shown: no data, no connection, no permission.

import { CONFIG_TABS } from './daemon-api'
import { NOTIFY_PREFS_KEY } from './notification-prefs'
import { ONBOARDING_KNOWN_KEY } from './onboarding'
import { FIRST_FLIGHT_DISMISSED_KEY, FIRST_FLIGHT_DONE_KEY, FIRST_FLIGHT_OFFERED_KEY } from './setup-wizard'
import { THEME_KEY } from './theme'
import { CLOSE_MODE_KEY, TRAY_HINT_SHOWN_KEY } from './tray-hint'
import { NAV_TREE, flattenNavTree, type NavEntry, type ViewId } from './views'

export type UiMode = 'everyday' | 'full'

/** Settings key. Beacon-wide (classified in @shared/daemon-profiles): the mode is how this person
 *  likes Beacon, whichever Prometheus is open. */
export const UI_MODE_KEY = 'ui:mode:v1'

/** A stored value, or null when nothing (readable) is stored. */
export function parseUiMode(raw: string | null | undefined): UiMode | null {
  return raw === 'everyday' || raw === 'full' ? raw : null
}

/**
 * Settings a Beacon that has been USED has written, and that survive Set up again (they are
 * Beacon-wide, so forgetting a Prometheus does not clear them). Any one of them present means this
 * is not a new install, whatever else is missing. None of them is written at launch, before the
 * person has done anything; the probe checks that against a fresh profile.
 */
export const USED_INSTALL_KEYS: readonly string[] = [
  THEME_KEY,
  NOTIFY_PREFS_KEY,
  CLOSE_MODE_KEY,
  TRAY_HINT_SHOWN_KEY,
  FIRST_FLIGHT_OFFERED_KEY,
  FIRST_FLIGHT_DONE_KEY,
  FIRST_FLIGHT_DISMISSED_KEY,
  ONBOARDING_KNOWN_KEY
]

/** What the first decision reads and writes. Injected, so the smoke can make each read fail. */
export interface FirstModeIo {
  getSetting(key: string): Promise<string | null>
  setSetting(key: string, value: string): Promise<void>
  /** Conversations in the open cache. Empty once a Prometheus is forgotten, so never the only test. */
  conversations(): Promise<unknown[]>
  /** Every Prometheus this Beacon keeps. */
  kept(): Promise<unknown[]>
}

/**
 * Decide the mode ONCE for an install that has none stored, and write it. Returns the mode now in
 * force, or null when nothing could be decided (a read failed): then nothing is written, Beacon
 * shows everything for this launch, and the decision is made at the next one.
 *
 * NEW means all of: setup is still needed, no Prometheus is kept, no conversation is held, and no
 * setting a used Beacon writes is present. Anything else is an install that already exists, and
 * it keeps everything. The mistake this leans away from is the one that cannot be shrugged off:
 * a person who has used Beacon for months opening it to find their views gone.
 */
export async function decideFirstUiMode(io: FirstModeIo, needsSetup: boolean): Promise<UiMode | null> {
  try {
    const stored = parseUiMode(await io.getSetting(UI_MODE_KEY))
    if (stored) return stored
    let isNew = needsSetup
    if (isNew) isNew = (await io.kept()).length === 0
    if (isNew) isNew = (await io.conversations()).length === 0
    if (isNew) for (const k of USED_INSTALL_KEYS) if ((await io.getSetting(k)) !== null) isNew = false
    const first: UiMode = isNew ? 'everyday' : 'full'
    await io.setSetting(UI_MODE_KEY, first)
    return first
  } catch {
    return null
  }
}

/** What everyday mode keeps, in rail order. Every id here is in NAV_TREE (the smoke checks). */
const EVERYDAY_TREE: NavEntry[] = [
  { kind: 'view', id: 'mission' },
  { kind: 'group', group: { id: 'grp:conversations', label: 'Chats', children: ['chat', 'sessions'] } },
  // What you and your assistant have written and made. Files last: it is the folder behind them.
  { kind: 'group', group: { id: 'grp:workspace', label: 'Workspace', children: ['documents', 'artifacts', 'wiki', 'files'] } },
  { kind: 'view', id: 'config' }
]

/** The rail and pill rows for a mode. */
export function navTreeFor(mode: UiMode): NavEntry[] {
  return mode === 'everyday' ? EVERYDAY_TREE : NAV_TREE
}

/** Whether a view has a place in this mode's navigation. */
export function viewVisible(view: ViewId, mode: UiMode): boolean {
  return flattenNavTree(navTreeFor(mode)).includes(view)
}

/** The view to show when `view` is asked for: itself, or the home when this mode has put it away
 *  (a remembered view from before the switch, a palette entry, a link from a card). */
export function viewInMode(view: ViewId, mode: UiMode): ViewId {
  return viewVisible(view, mode) ? view : 'mission'
}

/** What the home is called in the rail, the palette and the window. */
export function homeLabel(mode: UiMode): string {
  return mode === 'everyday' ? 'Today' : 'Mission'
}

/** The Config tabs everyday mode keeps: the ones a person sets something in. The rest report on
 *  the daemon's internals and stay one switch away. */
// Grants stays: the approval card offers lasting grants in every mode, and a grant that can be
// given has to have a place where it can be seen and taken back.
const EVERYDAY_CONFIG_TABS: readonly string[] = ['models', 'connectors', 'memory', 'cron', 'usage', 'grants', 'devices', 'skin']

export function configTabVisible(tabId: string, mode: UiMode): boolean {
  return mode === 'full' || EVERYDAY_CONFIG_TABS.includes(tabId)
}

/** The tab to open when `tabId` is asked for: itself, or the first tab this mode shows. */
export function configTabInMode(tabId: string | null | undefined, mode: UiMode): string {
  const shown = CONFIG_TABS.filter((t) => configTabVisible(t.id, mode))
  return shown.some((t) => t.id === tabId) ? (tabId as string) : shown[0].id
}

/** Words for the switch in Settings. */
export const UI_MODE_COPY = {
  title: 'Views',
  label: 'Show everything',
  on: 'Every view and setting is shown: Mission, Coding, Activity, the Board, and the settings that report on how Prometheus is running.',
  off: 'The everyday views are shown: Today, Chats, Workspace and the settings you change. Turn this on for Mission, Coding, Activity and the rest. Nothing is removed either way.'
} as const
