import { THEME_KEY, coerceThemeChoice } from '@shared/theme'
import { THEME_INSTANCE_KEY, THEME_SEEDED_KEY, isThemeChoice, seedPlan } from '@shared/theme-instance'

/** What the seeding needs of the store: Beacon's own settings, and a Prometheus's by folder id. */
export interface SkinStore {
  app: { getSetting(key: string): string | null; setSetting(key: string, value: string): void }
  getSettingFor(id: string, key: string): string | null
  setSettingFor(id: string, key: string, value: string): void
}

/**
 * Once, at the first launch that has a skin per Prometheus: the one skin this Beacon had becomes each Prometheus's own,
 * so nothing changes on screen. A Prometheus added after this starts on whatever is showing (the window adopts it).
 * Idempotent, and the marker is written last, so a crash part-way is finished by the next launch.
 */
export function seedInstanceSkins(store: SkinStore, ids: readonly string[]): number {
  const done = store.app.getSetting(THEME_SEEDED_KEY) === '1'
  const plan = seedPlan(done, store.app.getSetting(THEME_KEY), ids, (id) => isThemeChoice(store.getSettingFor(id, THEME_INSTANCE_KEY)))
  for (const id of plan.ids) store.setSettingFor(id, THEME_INSTANCE_KEY, plan.value)
  if (!done) store.app.setSetting(THEME_SEEDED_KEY, '1')
  return plan.ids.length
}

/**
 * The skin a Prometheus opens on, settled in main the moment its folder opens (so no write from a window can land in another
 * Prometheus's folder): its own if it has one, else the skin last worn here, which is written as its own from then on.
 * Returns what the window should wear.
 */
export function ensureInstanceSkin(own: string | null, lastWorn: string | null, write: (value: string) => void): string {
  if (isThemeChoice(own)) return own
  const value = coerceThemeChoice(lastWorn)
  write(value)
  return value
}
