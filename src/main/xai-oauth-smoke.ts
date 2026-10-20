/**
 * xAI SuperGrok OAuth panel smoke (headless / ELECTRON_RUN_AS_NODE).
 *
 * Proves the pure data layer the Models-tab OAuth panel rides on, at
 * src/shared/xai-oauth.ts where it would actually break:
 *   1. COERCION — a realistic status body coerces cleanly; malformed/old-daemon
 *      bodies degrade to a safe signed-out shape (never a render crash).
 *   2. PHASE — logged_in → signed-in, pending → awaiting-approval, else signed-out.
 *   3. POLL DECISION — keep polling while pending, stop on logged_in, stop+error
 *      when the background poll ends with last_error and no token.
 *   4. EXPIRY — humanized buckets (m/h/d), past-expiry reads as refreshing.
 *   5. PATHS — status + login paths are bridge-allowlisted (window.beacon.daemon).
 *
 * Cannot assert the rendered DOM (headless) — that's the macOS eyes-on walk.
 * FAIL-LOUD: `checks` must equal EXPECTED at exit.
 */
import { isAllowedDaemonPath } from '@shared/daemon-api'
import {
  coerceOAuthStatus,
  formatExpiry,
  oauthPhase,
  pollDecision,
  XAI_OAUTH_LOGIN_PATH,
  XAI_OAUTH_PATH
} from '@shared/xai-oauth'

let failures = 0
let checks = 0
function assert(cond: boolean, label: string): void {
  checks++
  console.log(`[xai-oauth-smoke] ${cond ? 'PASS' : 'FAIL'}  ${label}`)
  if (!cond) failures++
}

if (
  typeof coerceOAuthStatus !== 'function' ||
  typeof oauthPhase !== 'function' ||
  typeof pollDecision !== 'function' ||
  typeof formatExpiry !== 'function'
) {
  console.error('[xai-oauth-smoke] FAIL — required xai-oauth.ts exports missing. Refusing to vacuously pass.')
  process.exit(1)
}

const EXPECTED = 20

function main(): void {
  // ── 1. coercion ──
  const good = coerceOAuthStatus({
    logged_in: true,
    expires_at: 1783636213.6,
    pending: false,
    verification_uri: null,
    user_code: null,
    last_error: null
  })
  assert(good.logged_in === true && good.expires_at === 1783636213.6, 'well-formed status coerces through')
  const empty = coerceOAuthStatus(null)
  assert(empty.logged_in === false && empty.pending === false, 'null body → safe signed-out shape')
  const junk = coerceOAuthStatus({ logged_in: 'yes', expires_at: -5, user_code: 42 })
  assert(junk.logged_in === false, 'non-boolean logged_in is not truthy-coerced')
  assert(junk.expires_at === null, 'non-positive expires_at → null')
  assert(junk.user_code === null, 'non-string user_code → null')

  // ── 2. phase ──
  assert(oauthPhase(coerceOAuthStatus({ logged_in: true })) === 'signed-in', 'logged_in → signed-in')
  assert(
    oauthPhase(coerceOAuthStatus({ pending: true, user_code: 'ABCD-EFGH' })) === 'awaiting-approval',
    'pending → awaiting-approval'
  )
  assert(oauthPhase(coerceOAuthStatus({})) === 'signed-out', 'nothing → signed-out')
  assert(
    oauthPhase(coerceOAuthStatus({ logged_in: true, pending: true })) === 'signed-in',
    'logged_in wins over pending'
  )

  // ── 3. poll decision ──
  assert(pollDecision(coerceOAuthStatus({ pending: true })) === 'keep-polling', 'pending → keep polling')
  assert(pollDecision(coerceOAuthStatus({ logged_in: true })) === 'logged-in', 'token arrived → logged-in')
  assert(
    pollDecision(coerceOAuthStatus({ pending: false, last_error: 'denied' })) === 'error',
    'poll ended with error → error'
  )
  assert(
    pollDecision(coerceOAuthStatus({ pending: false })) === 'keep-polling',
    'transient not-yet-pending (no error, no token) → keep polling (avoid a false-fail race)'
  )

  // ── 4. expiry humanization ──
  const now = 1_000_000_000_000
  assert(formatExpiry(null, now) === 'active', 'null expiry → active')
  assert(formatExpiry(now / 1000 - 10, now) === 'refreshing…', 'past expiry → refreshing')
  assert(formatExpiry(now / 1000 + 1800, now) === 'expires in 30m', '30 min → minutes bucket')
  assert(formatExpiry(now / 1000 + 6 * 3600, now) === 'expires in 6h', '6 hours → hours bucket')
  assert(formatExpiry(now / 1000 + 3 * 86400, now) === 'expires in 3d', '3 days → days bucket')

  // ── 5. paths bridge-allowlisted ──
  assert(isAllowedDaemonPath(XAI_OAUTH_PATH), 'status path is bridge-allowlisted')
  assert(isAllowedDaemonPath(XAI_OAUTH_LOGIN_PATH), 'login path is bridge-allowlisted')

  if (checks !== EXPECTED) {
    console.error(`[xai-oauth-smoke] FAIL — ran ${checks} checks, expected ${EXPECTED} (a section silently skipped?)`)
    process.exit(1)
  }
  if (failures > 0) {
    console.error(`[xai-oauth-smoke] ${failures}/${checks} checks FAILED`)
    process.exit(1)
  }
  console.log(`[xai-oauth-smoke] all ${checks} checks passed`)
}

main()
