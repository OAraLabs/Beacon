// One Beacon, several Prometheus (docs/MULTI-PROMETHEUS.md): which settings belong to Beacon and which to the Prometheus they
// were written for, and what identifies a Prometheus. Pure, small and Electron-free on purpose: other Beacon clients implement
// these rules from the spec, and smoke:daemon-folders walks every settings key in src/ against this table.
//
// No Node/Electron imports (same rule as the rest of src/shared).

import { CREDENTIAL_KIND_KEY } from './model-setup'
import { DRAFT_PREFIX } from './drafts'
import { LAST_SESSION_KEY } from './chat-home'
import { NOTIFY_PREFS_KEY } from './notification-prefs'
import { FIRST_FLIGHT_DISMISSED_KEY, FIRST_FLIGHT_DONE_KEY, FIRST_FLIGHT_OFFERED_KEY } from './setup-wizard'
import { ONBOARDING_BROWSING_KEY, ONBOARDING_KNOWN_KEY, ONBOARDING_LAN_ASKED_KEY } from './onboarding'
import { PANEL_OPEN_KEY, PANEL_PANE_KEY, PANEL_WIDTH_KEY, SESSION_LIST_WIDTH_SETTING_KEY } from './side-panel'
import { SESSION_GROUPS_SETTING_KEY } from './session-groups'
import { SESSION_PROJECTS_SETTING_KEY, SESSION_UNFILED_SETTING_KEY } from './session-projects'
import { SPLIT_LAYOUT_KEY } from './split-panes'
import { THEME_KEY } from './theme'
import { CLOSE_MODE_KEY, TRAY_HINT_SHOWN_KEY } from './tray-hint'

/** hello's `fp`: the first 16 hex of the SHA-256 of the instance key, which Prometheus never regenerates. */
export const FP_PATTERN = /^[0-9a-f]{16}$/

export function validFp(fp: unknown): fp is string {
  return typeof fp === 'string' && FP_PATTERN.test(fp)
}

/** A TLS profile's fp needs no question: its pin is the SHA-256 of the SPKI of a certificate over the instance key, and hello's fp
 *  is the first 16 hex of that same digest (docs/MULTI-COMPUTER-v0.4.md §3.2). Null for a plain profile, whose fp only hello says. */
export function fpFromPin(pin: string | null | undefined): string | null {
  return typeof pin === 'string' && /^[0-9a-f]{64}$/.test(pin) ? pin.slice(0, 16) : null
}

/** 'beacon': this Beacon's, whichever Prometheus is open (app.db). 'prometheus': written for one Prometheus, kept in its folder. */
export type SettingScope = 'beacon' | 'prometheus'

/** Per-conversation rows, keyed `<prefix><session id>`: the same list as CacheRepo.SESSION_SETTING_PREFIXES. */
export const PROMETHEUS_SETTING_PREFIXES: readonly string[] = ['title:', 'viewed:', 'pinned:', DRAFT_PREFIX]

/** Whole keys that name that Prometheus's conversations. */
export const PROMETHEUS_SETTING_KEYS: readonly string[] = [
  SESSION_GROUPS_SETTING_KEY,
  SESSION_PROJECTS_SETTING_KEY,
  SESSION_UNFILED_SETTING_KEY,
  LAST_SESSION_KEY,
  SPLIT_LAYOUT_KEY,
  'capture:session' // QuickCapture's last target (a session id)
]

/**
 * This Beacon's own. The credential's kind and the remembered device role are a Prometheus's facts, but they stay here, beside
 * the one key file, until PR 2 gives each Prometheus its own key (docs/MULTI-PROMETHEUS.md §3.1 step 3): split from the key,
 * they would describe a key that is not there.
 */
export const BEACON_SETTING_KEYS: readonly string[] = [
  THEME_KEY,
  CLOSE_MODE_KEY,
  TRAY_HINT_SHOWN_KEY,
  NOTIFY_PREFS_KEY,
  PANEL_OPEN_KEY,
  PANEL_PANE_KEY,
  SESSION_LIST_WIDTH_SETTING_KEY,
  FIRST_FLIGHT_OFFERED_KEY,
  FIRST_FLIGHT_DONE_KEY,
  FIRST_FLIGHT_DISMISSED_KEY,
  ONBOARDING_BROWSING_KEY,
  ONBOARDING_KNOWN_KEY,
  ONBOARDING_LAN_ASKED_KEY,
  CREDENTIAL_KIND_KEY,
  'connection.deviceRole', // src/main/index.ts DEVICE_ROLE_KEY
  'daemons:layout' // src/main/cache/daemon-folders.ts LAYOUT_KEY: app.db's own marker that the folders are in place
]

/** Keys that start with one of these are Beacon's: the side panel's width, one row per width group (@shared/side-panel). */
export const BEACON_SETTING_PREFIXES: readonly string[] = [PANEL_WIDTH_KEY]

/** Where a key was classified, or null when it was not (smoke:daemon-folders fails on any such key in src/). */
export function classifiedScope(key: string): SettingScope | null {
  if (PROMETHEUS_SETTING_KEYS.includes(key) || PROMETHEUS_SETTING_PREFIXES.some((p) => key.startsWith(p))) return 'prometheus'
  if (BEACON_SETTING_KEYS.includes(key) || BEACON_SETTING_PREFIXES.some((p) => key.startsWith(p))) return 'beacon'
  return null
}

/** Where a key is kept. A key nobody classified is Beacon's: a preference that survives a switch is the safe mistake, and the
 *  smoke makes sure there is none in src/. */
export function settingScope(key: string): SettingScope {
  return classifiedScope(key) ?? 'beacon'
}
