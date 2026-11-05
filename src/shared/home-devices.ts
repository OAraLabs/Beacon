// "What it can touch" (Integrations → Home): the logic of the screen — pure (no React, no Node), so a smoke
// can hold it still. Contract: docs/HA-UI-DATA-CONTRACT.md §3.2.
//
// BEACON RENDERS, THE DAEMON DECIDES. Everything here comes from new operator-only /api/home/* routes
// (the daemon composes them from the Home Assistant server) and the existing approval-grants routes.
// Beacon never calls Home Assistant. Its only writes are "Ask once" on or off for one device, and Revoke.
//
// Two floors, both toward asking more: a tier Beacon does not recognise (or a device the daemon says is
// unclassified) is shown Sensitive, and a Critical device is read only whatever else the payload says.

import { safeExternalUrl } from './browser-pane'
import { coerceTier, tierPresentation, type HomeTier } from './home-approval'

/** Who is shown the Home row: an owner, or a Beacon that cannot tell (shown everything, as elsewhere). An approved (limited)
 *  device never sees it, and until the role is known (undefined) the row waits instead of flashing. */
export function showHomeFor(role: 'owner' | 'limited' | null | undefined): boolean {
  return role === 'owner' || role === null
}

export const HOME_STATUS_PATH = '/api/home/status'
export const HOME_DEVICES_PATH = '/api/home/devices'
export const GRANTS_PATH = '/api/approvals/grants'

export const askOncePath = (deviceId: string): string => `/api/home/devices/${encodeURIComponent(deviceId)}/ask-once`
export const askOnceBody = (enabled: boolean): { enabled: boolean } => ({ enabled })
export const revokePath = (grantId: string): string => `${GRANTS_PATH}/${encodeURIComponent(grantId)}`

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null)
const isTier = (v: unknown): v is HomeTier => v === 'ordinary' || v === 'sensitive' || v === 'critical'

// ── the connection line ──────────────────────────────────────────────────────

export type HomeConnState = 'connected' | 'degraded' | 'unreachable' | 'auth_failed' | 'not_configured'

export interface HomeStatus {
  state: HomeConnState
  deviceCount: number | null
  /** The daemon's sentence, in words. Shown verbatim. */
  detail: string
  checkedAt: number | null
  /** Where "Open in Home Assistant" goes. A web address or nothing. */
  openUrl: string | null
}

const STATE_WORDS: Record<HomeConnState, string> = {
  connected: 'Connected to Home Assistant',
  degraded: 'Home Assistant is answering with problems',
  unreachable: 'Home Assistant did not answer',
  auth_failed: 'Home Assistant refused the saved access',
  not_configured: 'Home Assistant is not set up on this Prometheus yet'
}

export function coerceStatus(raw: unknown): HomeStatus | undefined {
  if (!isObj(raw)) return undefined
  const known = raw.state === 'connected' || raw.state === 'degraded' || raw.state === 'unreachable' || raw.state === 'auth_failed' || raw.state === 'not_configured'
  // A state Beacon does not know is never shown as connected.
  const state: HomeConnState = known ? (raw.state as HomeConnState) : 'unreachable'
  return {
    state,
    deviceCount: typeof raw.device_count === 'number' && Number.isFinite(raw.device_count) ? raw.device_count : null,
    detail: str(raw.detail) ?? STATE_WORDS[state],
    checkedAt: typeof raw.checked_at === 'number' && Number.isFinite(raw.checked_at) ? raw.checked_at : null,
    openUrl: typeof raw.open_url === 'string' ? safeExternalUrl(raw.open_url) : null
  }
}

/** "Connected to Home Assistant · 42 devices", or the specific failure in the daemon's words. */
export function statusLine(s: HomeStatus): string {
  if (s.state !== 'connected' || s.deviceCount === null) return s.detail
  return `${s.detail} · ${s.deviceCount} device${s.deviceCount === 1 ? '' : 's'}`
}

export function statusTone(s: HomeStatus): 'ok' | 'warn' | 'error' {
  return s.state === 'connected' ? 'ok' : s.state === 'degraded' ? 'warn' : 'error'
}

/** Why the screen could not load, in words. 404 = no Home on this Prometheus, 403 = not an owner. Never a blank. */
export function unavailableLine(err: unknown): { kind: 'unsupported' | 'forbidden' | 'error'; text: string } {
  const msg = String(err instanceof Error ? err.message : err ?? '')
  if (/HTTP 404\b/.test(msg)) return { kind: 'unsupported', text: 'This Prometheus has no Home Assistant support.' }
  if (/HTTP 403\b/.test(msg)) return { kind: 'forbidden', text: 'Only an owner device can see this.' }
  if (/HTTP 401\b/.test(msg)) return { kind: 'error', text: 'Prometheus did not accept this Beacon’s key, so Home cannot be read.' }
  return { kind: 'error', text: msg ? `Couldn't read Home: ${msg.slice(0, 160)}` : "Couldn't read Home." }
}

/** Why Ask once or Revoke did not go through, in words. The same rule as a failed read: said, never swallowed. */
export function writeFailureLine(err: unknown): string {
  const msg = String(err instanceof Error ? err.message : err ?? '')
  if (/HTTP 409\b/.test(msg) && /critical_device/.test(msg)) return 'That device is read only, so it cannot be changed here.'
  if (/HTTP 403\b/.test(msg)) return 'Only an owner device can change this.'
  if (/HTTP 404\b/.test(msg)) return 'That is already gone. The list will refresh.'
  return msg ? `That didn't go through: ${msg.slice(0, 160)}` : "That didn't go through."
}

// ── devices ──────────────────────────────────────────────────────────────────

export interface TouchDevice {
  id: string
  name: string
  room: string | null
  kind: string | null
  state: string | null
  /** The tier SHOWN: Sensitive for an unclassified device. */
  tier: HomeTier
  unclassified: boolean
  relaxed: boolean
  openUrl: string | null
}

export function coerceDevices(raw: unknown): { updatedAt: number | null; devices: TouchDevice[] } | undefined {
  if (!isObj(raw) || !Array.isArray(raw.devices)) return undefined
  const devices: TouchDevice[] = []
  for (const r of raw.devices) {
    if (!isObj(r)) continue
    const id = str(r.id)
    const name = str(r.name)
    if (!id || !name) continue
    const unclassified = r.tier_source === 'unclassified' || !isTier(r.tier)
    devices.push({
      id,
      name,
      room: str(r.room),
      kind: str(r.kind),
      state: str(r.state),
      tier: unclassified ? 'sensitive' : coerceTier(r.tier),
      unclassified,
      relaxed: r.relaxed === true,
      openUrl: typeof r.open_url === 'string' ? safeExternalUrl(r.open_url) : null
    })
  }
  return { updatedAt: typeof raw.updated_at === 'number' && Number.isFinite(raw.updated_at) ? raw.updated_at : null, devices }
}

export type TierFilter = 'all' | HomeTier

export function filterDevices(devices: TouchDevice[], f: { query: string; tier: TierFilter }): TouchDevice[] {
  const q = f.query.trim().toLowerCase()
  return devices.filter(
    (d) => (f.tier === 'all' || d.tier === f.tier) && (q === '' || d.name.toLowerCase().includes(q) || (d.room ?? '').toLowerCase().includes(q))
  )
}

export const NO_ROOM = 'No room'

export function groupByRoom(devices: TouchDevice[]): { room: string | null; label: string; devices: TouchDevice[] }[] {
  const by = new Map<string | null, TouchDevice[]>()
  for (const d of devices) by.set(d.room, [...(by.get(d.room) ?? []), d])
  return [...by.entries()]
    .sort(([a], [z]) => (a === null ? 1 : z === null ? -1 : a.localeCompare(z, undefined, { sensitivity: 'base' })))
    .map(([room, ds]) => ({ room, label: room ?? NO_ROOM, devices: [...ds].sort((a, z) => a.name.localeCompare(z.name, undefined, { sensitivity: 'base' })) }))
}

export interface DeviceRowView {
  id: string
  name: string
  tier: HomeTier
  tierWord: string
  stateText: string
  /** Critical: a lock and "Read only". The tier cannot be changed here. */
  readOnly: boolean
  /** A line under the row (an unclassified device says it is treated as Sensitive). */
  note: string | null
  /** 'offer' = can be relaxed to Ask once; 'on' = Ask once is on and can be undone; null = nothing to offer. */
  askOnce: 'offer' | 'on' | null
  openUrl: string | null
}

export const UNCLASSIFIED_NOTE = 'Not classified yet, so treated as Sensitive.'

export function deviceRowView(d: TouchDevice): DeviceRowView {
  const readOnly = d.tier === 'critical'
  return {
    id: d.id,
    name: d.name,
    tier: d.tier,
    tierWord: tierPresentation(d.tier).word,
    stateText: d.state ?? 'state unknown',
    readOnly,
    note: d.unclassified ? UNCLASSIFIED_NOTE : null,
    askOnce: d.tier === 'sensitive' ? (d.relaxed ? 'on' : 'offer') : null,
    openUrl: d.openUrl
  }
}

/** The confirmation for Ask once, naming the device. It grants nothing by itself. */
export function askOnceDialog(d: Pick<TouchDevice, 'name'>, enabled: boolean): { title: string; body: string; confirmLabel: string } {
  return enabled
    ? {
        title: `Ask once for ${d.name}?`,
        body: `Next time Prometheus wants to change ${d.name}, you'll be offered "Always allow" as well as "Approve once". Nothing is allowed until you choose it.`,
        confirmLabel: 'Turn on Ask once'
      }
    : {
        title: `Ask every time for ${d.name}?`,
        body: `"Always allow" will no longer be offered for ${d.name}. A permission you already gave stays until you revoke it under Always allowed.`,
        confirmLabel: 'Ask every time'
      }
}

// ── the "Always allowed" list ────────────────────────────────────────────────

export interface GrantDevice {
  id: string
  name: string
  room: string | null
}

export interface HomeGrantRow {
  id: string
  tool: string
  tier: HomeTier
  describes: string
  /** Named devices, the whole tier, or null when the daemon sent no home details (an older one). */
  devices: GrantDevice[] | 'all_in_tier' | null
  createdAt: number | null
}

/** The tier a Home control tool belongs to, or null if this is not one (`mcp__{server}__ha_control_ordinary`). */
export function homeGrantTier(tool: string): HomeTier | null {
  const m = /(?:^|__)ha_control_(ordinary|sensitive)$/.exec(tool)
  return m ? (m[1] as HomeTier) : null
}

function coerceGrantDevices(home: unknown): HomeGrantRow['devices'] {
  if (!isObj(home)) return null
  if (home.devices === 'all_in_tier') return 'all_in_tier'
  if (!Array.isArray(home.devices)) return null
  const out: GrantDevice[] = []
  for (const d of home.devices) {
    if (!isObj(d)) continue
    const id = str(d.id)
    const name = str(d.name)
    if (id && name) out.push({ id, name, room: str(d.room) })
  }
  return out
}

/** Only the grants for Home control tools, from GET /api/approvals/grants. A grant with no id is kept (it is still a permission) but cannot be revoked. */
export function coerceGrants(raw: unknown): HomeGrantRow[] {
  if (!Array.isArray(raw)) return []
  const out: HomeGrantRow[] = []
  for (const g of raw) {
    if (!isObj(g)) continue
    const tool = str(g.tool)
    const tier = tool ? homeGrantTier(tool) : null
    if (!tool || !tier) continue
    out.push({
      id: str(g.id) ?? '',
      tool,
      tier,
      describes: str(g.describes) ?? tool,
      devices: coerceGrantDevices(g.home),
      createdAt: typeof g.created_at === 'number' && Number.isFinite(g.created_at) ? g.created_at * 1000 : null
    })
  }
  return out
}

export interface GrantRowView {
  id: string
  tier: HomeTier
  tierWord: string
  describes: string
  devicesLabel: string | null
  canRevoke: boolean
  createdAt: number | null
}

export function grantRowView(g: HomeGrantRow): GrantRowView {
  const tierWord = tierPresentation(g.tier).word
  const label =
    g.devices === 'all_in_tier'
      ? `Every ${tierWord} device`
      : g.devices && g.devices.length > 0
        ? g.devices.map((d) => (d.room ? `${d.name} · ${d.room}` : d.name)).join(', ')
        : null
  return { id: g.id, tier: g.tier, tierWord, describes: g.describes, devicesLabel: label, canRevoke: g.id !== '', createdAt: g.createdAt }
}

/** The confirmation for Revoke: what is being revoked (the daemon's own description), and what happens next. */
export function revokeDialog(g: HomeGrantRow): { title: string; body: string; confirmLabel: string } {
  const v = grantRowView(g)
  return {
    title: v.devicesLabel ? `Revoke Always allow for ${v.devicesLabel}?` : 'Revoke this permission?',
    body: `${v.describes}\n\nPrometheus will ask you again.`,
    confirmLabel: 'Revoke'
  }
}
