// An AI the person already runs (docs/ONBOARDING-LOCAL-FIRST.md): the pure half. What Prometheus's look and probe answers mean
// (§4.1), which card a reason is (§3), what A2 selects by itself (§2.4), and what a local choice sends to configure.
//
// RED: these are stubs. They compile and answer wrongly on purpose, so smoke:local-ai fails until the spec is built.
//
// No Node/Electron imports (same rule as the rest of src/shared).

export const DETECT_ROUTE = '/api/setup/detect'
export const PROBE_ROUTE = '/api/setup/probe'

export type LocalApp = 'ollama' | 'lm_studio' | 'llama_cpp' | 'vllm' | 'openai_compatible'
export type LocalReason = 'bad_target' | 'name_not_found' | 'no_answer' | 'refused' | 'not_ai' | 'needs_key' | 'no_models' | 'no_chat' | 'none_loaded' | 'short_context'
/** A card on the local choice: a reason Prometheus gave, or one of Beacon's own. */
export type LocalCardId = LocalReason | 'nothing-here' | 'unknown' | 'old' | 'look-failed'

/** One usable AI, as main keeps it. `baseUrl` never reaches the page (pageRows). */
export interface LocalRow {
  id: string
  app: LocalApp
  provider: string
  baseUrl: string
  model: string
  loaded: boolean | null
  /** null: this Mac; otherwise the name the person typed. */
  where: string | null
}
/** What the page is sent of a row. */
export interface PageRow {
  id: string
  app: string
  model: string
  where: string
  loaded: boolean | null
}
export interface LocalCard {
  id: LocalCardId
  app?: string
  model?: string
  min?: number
}
export interface LocalRead {
  rows: LocalRow[]
  card: LocalCard | null
  /** Prometheus's own sentence and what was tried, for Copy details. */
  detail: string
}

/** A typed computer, checked before any call: a name, an IPv4 address, a bracketed IPv6 address, any of them with :port, or an
 *  http(s) URL with no path beyond "/". */
export function normalizeTarget(_text: string): { ok: true; target: string } | { ok: false } {
  return { ok: false }
}

/** GET /api/setup/detect: its `local` answer (absent on a Prometheus too old to look: the "old" card). */
export function readDetect(_status: number, _body: unknown): LocalRead {
  return { rows: [], card: null, detail: '' }
}

/** POST /api/setup/probe, for the computer the person typed. */
export function readProbe(_status: number, _body: unknown, _name: string): LocalRead {
  return { rows: [], card: null, detail: '' }
}

export function pageRows(rows: readonly LocalRow[]): PageRow[] {
  return rows.map((r) => ({ id: r.id, app: r.app, model: r.model, where: r.baseUrl, loaded: r.loaded }))
}

/** A card's title and body, in plain words. `where` null is this Mac. */
export function localCard(_card: LocalCard, _where: string | null): { title: string; body: string } {
  return { title: '', body: '' }
}

export interface A2Choice {
  card: 'local' | 'cloud' | null
  row: string | null
}
/** What A2 selects by itself: nothing while looking; then local (a loaded row, else the first) when there is a usable row, cloud
 *  when there is none. A choice the person made is never changed. */
export function pickInitial(_i: { looking: boolean; rows: readonly PageRow[]; touched: A2Choice | null }): A2Choice {
  return { card: 'cloud', row: null }
}
/** Ready on the local card when a usable row exists; Quickest on the cloud card only once looking ended with none and no Test
 *  passed. */
export function a2Tags(_i: { looking: boolean; rows: readonly PageRow[]; testPassed: boolean }): { ready: boolean; quickest: boolean } {
  return { ready: false, quickest: true }
}

/** POST /api/setup/configure for a local choice: no key. */
export function localConfigureBody(_row: Pick<LocalRow, 'provider' | 'baseUrl' | 'model'>): Record<string, string> {
  return {}
}

/** GET /api/setup/status `features`: can Prometheus look (local_probe), and switch to local after setup (model_local)? */
export function localFeatures(_status: number, _body: unknown): { probe: boolean; switch: boolean } {
  return { probe: true, switch: true }
}
