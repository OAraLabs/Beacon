// xAI SuperGrok OAuth — pure data layer for the Models tab's "Sign in with
// SuperGrok" panel. Talks to the daemon endpoints added in Prometheus PR 100:
//   GET    /api/providers/xai/oauth        → status
//   POST   /api/providers/xai/oauth/login  → device code (polls in background)
//   DELETE /api/providers/xai/oauth        → logout
// The React panel is effectful; everything decidable lives here so a headless
// smoke can prove it (Beacon has no component-test framework).

export const XAI_OAUTH_PATH = '/api/providers/xai/oauth'
export const XAI_OAUTH_LOGIN_PATH = '/api/providers/xai/oauth/login'

/** Shape of GET /api/providers/xai/oauth (and, minus a couple fields, the login POST). */
export interface XaiOAuthStatusDTO {
  logged_in: boolean
  expires_at: number | null // epoch SECONDS (server clock), or null when unknown
  pending: boolean
  verification_uri: string | null
  user_code: string | null
  last_error: string | null
}

/** Defensive coercion — the panel must never crash on a malformed/old-daemon body. */
export function coerceOAuthStatus(data: unknown): XaiOAuthStatusDTO {
  const d = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>
  const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null)
  return {
    logged_in: d.logged_in === true,
    expires_at: typeof d.expires_at === 'number' && d.expires_at > 0 ? d.expires_at : null,
    pending: d.pending === true,
    verification_uri: str(d.verification_uri),
    user_code: str(d.user_code),
    last_error: str(d.last_error)
  }
}

/** What the poller should do next after reading a fresh status while a login is in flight. */
export type PollDecision = 'logged-in' | 'error' | 'keep-polling'

export function pollDecision(status: XaiOAuthStatusDTO): PollDecision {
  if (status.logged_in) return 'logged-in'
  if (status.pending) return 'keep-polling'
  // Not pending and not logged in — the background poll finished without a token.
  return status.last_error ? 'error' : 'keep-polling'
}

/** Which of the three panel states to render. */
export type OAuthPhase = 'signed-in' | 'awaiting-approval' | 'signed-out'

export function oauthPhase(status: XaiOAuthStatusDTO): OAuthPhase {
  if (status.logged_in) return 'signed-in'
  if (status.pending) return 'awaiting-approval'
  return 'signed-out'
}

/** Humanize the token expiry for the signed-in badge. Pure (nowMs injected for tests). */
export function formatExpiry(expiresAt: number | null, nowMs: number): string {
  if (!expiresAt) return 'active'
  const secs = Math.round((expiresAt * 1000 - nowMs) / 1000)
  if (secs <= 0) return 'refreshing…' // past expiry → the daemon refreshes on next use
  if (secs < 3600) return `expires in ${Math.max(1, Math.round(secs / 60))}m`
  if (secs < 86400) return `expires in ${Math.round(secs / 3600)}h`
  return `expires in ${Math.round(secs / 86400)}d`
}
