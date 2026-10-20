import { validHost, validPort } from '@shared/discovery'

export interface GatewayConfig {
  name: string
  apiBase: string
  wsUrl: string
  /** A home-network Prometheus reached over TLS: the SHA-256 of its certificate's SPKI (64 hex), learned when it was joined
   *  (docs/MULTI-COMPUTER-v0.4.md §3). Absent for plain connections (this Mac's loopback, an address typed for a Tailscale
   *  computer). */
  pin?: string | null
}

/**
 * Resolve the Prometheus gateway the main process connects to.
 *
 * CONFIGURABLE and defaulting to the LOCAL daemon — the address must never be hardcoded,
 * and a private gateway IP must NEVER appear in committed source (spec §3.4/§8; a pre-commit
 * hook blocks such refs in non-markdown files). For this smoke it reads env overrides and
 * falls back to localhost; the real per-profile config (gateway_profiles table, entered at
 * first-run setup) arrives in Step 5.
 */
export function resolveGateway(): GatewayConfig {
  const host = process.env.BEACON_GATEWAY_HOST ?? '127.0.0.1'
  const apiPort = process.env.BEACON_GATEWAY_API_PORT ?? '8005'
  const wsPort = process.env.BEACON_GATEWAY_WS_PORT ?? '8010'
  const apiBase = process.env.BEACON_GATEWAY_API ?? `http://${host}:${apiPort}`
  const wsUrl = process.env.BEACON_GATEWAY_WS ?? `ws://${host}:${wsPort}`
  return { name: process.env.BEACON_GATEWAY_NAME ?? 'local', apiBase, wsUrl }
}

/**
 * Build a GatewayConfig from a user-entered address (host or IP, optionally with scheme/port) at
 * first-run setup. Fixed daemon ports (8005 REST / 8010 WS). The address is stored in
 * gateway_profiles (app-data, gitignored) — so a private/Tailscale IP NEVER lands in committed source.
 */
export function gatewayFromAddress(address: string, name = 'mini'): GatewayConfig {
  const host = address
    .trim()
    .replace(/^[a-z]+:\/\//i, '') // strip scheme
    .replace(/\/.*$/, '') // strip path
    .replace(/:\d+$/, '') // strip explicit port
  return { name, apiBase: `http://${host}:8005`, wsUrl: `ws://${host}:8010` }
}

/** The host out of what was entered: scheme and path stripped; an IPv6 literal (bracketed or not) left whole; an
 *  ordinary host loses a trailing ":port" (the ports of an endpoint are given separately). */
function cleanHost(address: string): string {
  const t = address.trim().replace(/^[a-z]+:\/\//i, '').replace(/\/.*$/, '')
  const bracket = /^\[([^\]]+)\](?::\d+)?$/.exec(t)
  if (bracket) return bracket[1]
  if ((t.match(/:/g) ?? []).length >= 2) return t
  return t.replace(/:\d+$/, '')
}

/** A gateway at an explicit endpoint: the host cleaned the way gatewayFromAddress cleans it, and the PORTS the
 *  computer was found on or told us (a discovered or typed port must never be silently replaced by 8005, which is
 *  what gatewayFromAddress does). With no ports at all it is exactly gatewayFromAddress. A half-specified pair, a
 *  port that is not a port, or a host that is not a host is null: refused, never repaired. */
export function gatewayFromEndpoint(address: string, ports: { apiPort?: unknown; wsPort?: unknown } = {}, name = 'mini', tls?: { pin: string }): GatewayConfig | null {
  const { apiPort, wsPort } = ports
  // A TLS endpoint is only ever the one a join learned, ports and pin together (docs/MULTI-COMPUTER-v0.4.md §3.2).
  if (tls && (!/^[0-9a-f]{64}$/.test(tls.pin) || apiPort === undefined || wsPort === undefined)) return null
  if (apiPort === undefined && wsPort === undefined) return gatewayFromAddress(address, name)
  if (!validPort(apiPort) || !validPort(wsPort)) return null
  const host = cleanHost(address)
  if (!validHost(host)) return null
  const at = host.includes(':') ? `[${host}]` : host
  if (tls) return { name, apiBase: `https://${at}:${apiPort}`, wsUrl: `wss://${at}:${wsPort}`, pin: tls.pin }
  return { name, apiBase: `http://${at}:${apiPort}`, wsUrl: `ws://${at}:${wsPort}` }
}

/** True when the gateway is pinned via env (dev/CI) — lets those launches skip first-run setup. */
export function hasEnvGateway(): boolean {
  return !!(process.env.BEACON_GATEWAY_HOST || process.env.BEACON_GATEWAY_API)
}

/**
 * Bearer token from env — SMOKES/DEV ONLY (the app proper reads the OS keychain, never env). The
 * daemon enabled bearer auth 2026-06-06, so the live-send smokes (step2/step4) must present it:
 *   set -a; . ~/.config/prometheus/env; set +a; npm run smoke:step2
 * Never hardcoded, never logged (spec §8).
 */
export function envToken(): string | null {
  return process.env.BEACON_API_TOKEN || process.env.PROMETHEUS_API_TOKEN || null
}
