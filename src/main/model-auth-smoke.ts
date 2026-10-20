/**
 * Provider auth-mode badges smoke (headless / ELECTRON_RUN_AS_NODE).
 *
 * Proves the pure layer the "how is this provider connected?" badges ride on,
 * at src/shared/model-auth.ts where it would actually break:
 *   1. COERCION — only "subscription" / "api_key" pass; junk/old-daemon → null.
 *   2. BADGE TEXT — xai subscription reads "SuperGrok subscription" (the product
 *      the user bought), unknown-provider subscription degrades to the plain
 *      word, api_key → "API key", null → no badge.
 *   3. TOOLTIP SUFFIX — ' · via …' add-on for the model chip; '' when silent.
 *   4. CATALOG INDEX — a realistic GET /api/models body → key→caption map;
 *      auth:null/absent entries and malformed bodies produce NO entries
 *      (old daemons render exactly like today, never a crash).
 *   5. PATH — the catalog path is bridge-allowlisted (window.beacon.daemon).
 *
 * Cannot assert the rendered DOM (headless) — that's the macOS eyes-on walk.
 * FAIL-LOUD: `checks` must equal EXPECTED at exit.
 */
import { isAllowedDaemonPath } from '@shared/daemon-api'
import {
  authBadgeText,
  authTitleSuffix,
  catalogAuthBadges,
  coerceAuthMode,
  MODELS_CATALOG_PATH
} from '@shared/model-auth'

let failures = 0
let checks = 0
function assert(cond: boolean, label: string): void {
  checks++
  console.log(`[model-auth-smoke] ${cond ? 'PASS' : 'FAIL'}  ${label}`)
  if (!cond) failures++
}

if (
  typeof coerceAuthMode !== 'function' ||
  typeof authBadgeText !== 'function' ||
  typeof authTitleSuffix !== 'function' ||
  typeof catalogAuthBadges !== 'function'
) {
  console.error('[model-auth-smoke] FAIL — required model-auth.ts exports missing. Refusing to vacuously pass.')
  process.exit(1)
}

const EXPECTED = 20

function main(): void {
  // ── 1. coercion ──
  assert(coerceAuthMode('subscription') === 'subscription', 'subscription passes coercion')
  assert(coerceAuthMode('api_key') === 'api_key', 'api_key passes coercion')
  assert(coerceAuthMode(null) === null, 'null (no credential) → null')
  assert(coerceAuthMode(undefined) === null, 'absent field (old daemon) → null')
  assert(coerceAuthMode('oauth') === null, 'unknown mode string → null (forward-compat, no badge)')

  // ── 2. badge text ──
  assert(authBadgeText('subscription', 'xai') === 'SuperGrok subscription', 'xai subscription → SuperGrok subscription')
  assert(authBadgeText('subscription', 'someday_ai') === 'subscription', 'unnamed provider subscription → plain word')
  assert(authBadgeText('subscription') === 'subscription', 'no provider given → plain word (never crashes)')
  assert(authBadgeText('api_key', 'anthropic') === 'API key', 'api_key → API key')
  assert(authBadgeText(null, 'xai') === null, 'no credential → no badge')

  // ── 3. tooltip suffix ──
  assert(authTitleSuffix('subscription', 'xai') === ' · via SuperGrok subscription', 'chip tooltip names the subscription')
  assert(authTitleSuffix('api_key', 'openai') === ' · via API key', 'chip tooltip names the key')
  assert(authTitleSuffix(null, 'xai') === '', 'silent suffix is the EMPTY STRING (tooltips concatenate)')
  assert(authTitleSuffix(42, 'xai') === '', 'junk auth → silent, not a crash')

  // ── 4. catalog index ──
  const idx = catalogAuthBadges({
    models: [
      { key: 'local', label: 'Local', provider: 'llama_cpp', is_default: true, available: true, auth: null },
      { key: 'xai', label: 'xAI', provider: 'xai', available: true, auth: 'subscription' },
      { key: 'claude', label: 'Claude', provider: 'anthropic', available: true, auth: 'api_key' },
      { key: 'gpt', label: 'GPT', provider: 'openai', available: false }, // pre-#102 daemon entry
      { key: '', auth: 'api_key' }, // malformed — dropped
      null
    ],
    default_key: 'local'
  })
  assert(idx.xai === 'SuperGrok subscription', 'index: xai → SuperGrok subscription')
  assert(idx.claude === 'API key', 'index: claude → API key')
  assert(!('local' in idx) && !('gpt' in idx), 'index: auth-null and auth-absent entries carry no badge')
  assert(Object.keys(catalogAuthBadges({ models: 'nope' })).length === 0, 'wrong-shape models → empty index')
  assert(Object.keys(catalogAuthBadges(null)).length === 0, 'null body → empty index')

  // ── 5. path bridge-allowlisted ──
  assert(isAllowedDaemonPath(MODELS_CATALOG_PATH), 'models catalog path is bridge-allowlisted')

  if (checks !== EXPECTED) {
    console.error(`[model-auth-smoke] FAIL — ran ${checks} checks, expected ${EXPECTED} (a section silently skipped?)`)
    process.exit(1)
  }
  if (failures > 0) {
    console.error(`[model-auth-smoke] ${failures}/${checks} checks FAILED`)
    process.exit(1)
  }
  console.log(`[model-auth-smoke] all ${checks} checks passed`)
}

main()
