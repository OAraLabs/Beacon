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
 * The mode for an install that has none stored yet. Decided once, then written, so it never
 * changes under anyone. `full` whenever there is any sign the install is not new: it is already
 * connected, or it holds conversations (a person who chose Set up again is not a new install).
 */
export function firstUiMode(facts: { needsSetup: boolean; hasConversations: boolean }): UiMode {
  return facts.needsSetup && !facts.hasConversations ? 'everyday' : 'full'
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
const EVERYDAY_CONFIG_TABS: readonly string[] = ['models', 'connectors', 'memory', 'cron', 'usage', 'devices', 'skin']

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
