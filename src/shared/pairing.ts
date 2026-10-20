// Pairing handshake (Onboarding Phase 1) — PURE logic shared by the main process (transport),
// the renderer (FirstRunSetup's "I have a pairing code" path), and the pairing smoke.
//
// Daemon contract (Prometheus src/prometheus/web/setup_server.py):
//   POST /api/setup/pair {code}  → 200 {token, api_base_port, ws_port}
//                                → 401 {error:"invalid_code", attempts_remaining}
//                                → 403 {error:"pairing_locked"|"pairing_expired"|"pairing_used"}
//   GET  /api/setup/status       → 200 {setup_mode:true, configured:true|false, pairing, version}
//                                  (Phase 2: `configured` flips after POST /api/setup/configure)
//   anything else                → 403 {error:"setup_mode"}
//
// No Node/Electron imports here (same rule as shared/ipc.ts).

export const PAIRING_CODE_LENGTH = 6

/** Poll cadence while waiting for the real daemon after a successful pair (~3s per spec). */
export const PAIR_POLL_INTERVAL_MS = 3000

/** Exactly six digits — the daemon mints codes as zero-padded %06d. */
export function isValidPairingCode(code: string): boolean {
  return new RegExp(`^\\d{${PAIRING_CODE_LENGTH}}$`).test(code.trim())
}

/** Host cleaning — the SAME rules as main's gatewayFromAddress (scheme/path/port stripped), so the
 * pairing path and the token path resolve one address identically. */
export function hostFromAddress(address: string): string {
  return address
    .trim()
    .replace(/^[a-z]+:\/\//i, '')
    .replace(/\/.*$/, '')
    .replace(/:\d+$/, '')
}

export type PairOutcome =
  | { kind: 'paired'; token: string; apiBasePort: number | null; wsPort: number | null }
  | { kind: 'invalid-code'; attemptsRemaining: number | null; label: string }
  | { kind: 'locked'; reason: 'locked' | 'expired' | 'used'; label: string }
  | { kind: 'error'; label: string }

const RESTART_HINT = 'restart `oara daemon` on the host for a new code'

/**
 * Classify a /api/setup/pair response into an honest outcome. Defensive about shape — a daemon
 * that answers 200 WITHOUT a token (never expected) is an error, not a silent empty-token pair.
 */
export function parsePairResponse(status: number, body: unknown): PairOutcome {
  const b = (body ?? {}) as Record<string, unknown>
  if (status === 200) {
    // token === '' is a real (deliberately-open) daemon answer; only a MISSING field is malformed.
    if (typeof b.token === 'string') {
      return {
        kind: 'paired',
        token: b.token,
        apiBasePort: typeof b.api_base_port === 'number' ? b.api_base_port : null,
        wsPort: typeof b.ws_port === 'number' ? b.ws_port : null
      }
    }
    return { kind: 'error', label: 'Gateway answered without a token — is this a Prometheus setup daemon?' }
  }
  const err = typeof b.error === 'string' ? b.error : ''
  if (status === 401 && err === 'invalid_code') {
    const n = typeof b.attempts_remaining === 'number' ? b.attempts_remaining : null
    return {
      kind: 'invalid-code',
      attemptsRemaining: n,
      label:
        n === null
          ? 'Wrong pairing code'
          : n <= 0
            ? `Wrong pairing code — pairing is now locked; ${RESTART_HINT}`
            : `Wrong pairing code — ${n} attempt${n === 1 ? '' : 's'} remaining`
    }
  }
  if (status === 403 && err === 'pairing_locked') {
    return { kind: 'locked', reason: 'locked', label: `Pairing locked (too many attempts) — ${RESTART_HINT}` }
  }
  if (status === 403 && err === 'pairing_expired') {
    return { kind: 'locked', reason: 'expired', label: `Pairing code expired — ${RESTART_HINT}` }
  }
  if (status === 403 && err === 'pairing_used') {
    return { kind: 'locked', reason: 'used', label: `That code was already used — ${RESTART_HINT}` }
  }
  if (status === 403 && err === 'setup_mode') {
    // Shouldn't happen for the pair route itself, but answer honestly if it does.
    return { kind: 'error', label: 'Gateway is in setup mode but refused the pairing route (HTTP 403)' }
  }
  // Mirror shared/daemon-api connectionTestLabel conventions for the rest.
  if (status === 404) return { kind: 'error', label: 'No pairing endpoint here — is the daemon in setup mode?' }
  if (status > 0) return { kind: 'error', label: `Gateway error (HTTP ${status})` }
  return { kind: 'error', label: 'Could not reach the gateway' }
}

/** Build the gateway URLs from the pair answer. The daemon reports the ports it (and the future
 * real daemon) serve on; missing/nonsense ports fall back to the fixed defaults gatewayFromAddress
 * uses (8005 REST / 8010 WS). Pure string work — storage is the caller's side effect. */
export function pairedGatewayUrls(
  address: string,
  outcome: { apiBasePort: number | null; wsPort: number | null }
): { apiBase: string; wsUrl: string } {
  const host = hostFromAddress(address)
  const apiPort = outcome.apiBasePort && outcome.apiBasePort > 0 ? outcome.apiBasePort : 8005
  const wsPort = outcome.wsPort && outcome.wsPort > 0 ? outcome.wsPort : 8010
  return { apiBase: `http://${host}:${apiPort}`, wsUrl: `ws://${host}:${wsPort}` }
}

// ── Setup-status probing (Phase 2) ─────────────────────────────────────────────
// GET /api/setup/status grew a real `configured` flag (true after POST /api/setup/configure ran)
// so a client can resume a half-done wizard. One parser for every consumer (Connect diagnosis,
// pairPoll, the wizard's resume detection).

export interface SetupStatusProbe {
  setupMode: boolean
  /** Phase 2: has /api/setup/configure already run on this setup-mode daemon? */
  configured: boolean
  /** 'available' | 'locked' (absent on malformed answers → null). */
  pairing: string | null
}

/** Classify a GET /api/setup/status answer. `null` = NOT a setup-mode daemon answer (non-200, or a
 * body without the setup_mode field) — callers treat that as "real daemon or not Prometheus". */
export function parseSetupStatusResponse(status: number, body: unknown): SetupStatusProbe | null {
  if (status !== 200) return null
  const b = (body ?? {}) as Record<string, unknown>
  if (typeof b.setup_mode !== 'boolean') return null
  return {
    setupMode: b.setup_mode,
    configured: b.configured === true,
    pairing: typeof b.pairing === 'string' ? b.pairing : null
  }
}

// ── Post-pair polling ──────────────────────────────────────────────────────────
// After "Paired ✓" the daemon is STILL in setup mode; the user finishes `oara setup` in its
// terminal and restarts it. Beacon polls until the REAL daemon answers /api/status 200, then enters
// the app exactly like the normal connect path.

/** One poll observation: was /api/setup/status still answering setup_mode, and did an authed
 * GET /api/status succeed? (During the restart gap both are false/null — that's still 'waiting'.) */
export interface PairPollProbe {
  /** true = setup server still up; false = reachable but NOT setup mode; null = unreachable. */
  setupMode: boolean | null
  /** GET /api/status with the stored token returned 200. */
  apiStatusOk: boolean
}

/** The ONLY exit condition is the real daemon answering /api/status 200 — setup-mode-gone alone
 * (restart gap, network blip) must keep waiting, never bail or false-proceed. */
export function pairPollState(probe: PairPollProbe): 'ready' | 'waiting' {
  return probe.apiStatusOk ? 'ready' : 'waiting'
}
