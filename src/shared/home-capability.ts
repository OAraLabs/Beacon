// The Home capability (docs/HA-UI-DATA-CONTRACT.md §0): nothing of Home shows unless the Prometheus Beacon is connected to says it
// has it. A Home row that opens on "this Prometheus has no Home support", or a Home card for a daemon that cannot send the details
// to fill it, is a broken screen nobody asked for; so the daemon advertises `home/1` in `capabilities` on GET /api/status (owner
// only, additive: an older daemon says nothing and Home stays hidden), and Beacon shows Home only when it is there.
//
// Exact match, on the one version Beacon speaks: a future `home/2` is not read as `home/1`.

export const HOME_CAPABILITY = 'home/1'
export const STATUS_PATH = '/api/status'

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Does this GET /api/status answer advertise Home? Anything unreadable is no. */
export function hasHomeCapability(status: unknown): boolean {
  return isObj(status) && Array.isArray(status.capabilities) && status.capabilities.includes(HOME_CAPABILITY)
}

/** The Home approval card, or the generic one: Home details on the approval AND the capability advertised. The generic card shows everything the daemon sent. */
export function showHomeCard(a: { home?: unknown }, capable: boolean): boolean {
  return capable && a.home !== undefined && a.home !== null
}
