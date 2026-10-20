/**
 * Pairing smoke (headless / ELECTRON_RUN_AS_NODE) — Onboarding Phase 1.
 *
 * Proves the PURE pairing logic the first-run "I have a pairing code" path rides on, where it would
 * actually break:
 *   1. CODE VALIDATION — exactly six digits (leading zeros are real: the daemon mints %06d).
 *   2. RESPONSE PARSING — every daemon answer (paired / wrong code with attempts / locked / expired /
 *      used / not-a-setup-daemon / unreachable) maps to a DISTINCT honest outcome + label.
 *   3. GATEWAY URLS — the pair answer's ports are honored; absent/nonsense ports fall back to the
 *      fixed 8005/8010 defaults; address cleaning matches gatewayFromAddress (scheme/port/path).
 *   4. POST-PAIR POLLING — the ONLY 'ready' signal is /api/status 200; setup-mode-still-up and the
 *      restart gap (unreachable) both keep waiting — never a false proceed.
 *
 * The actual fetch + keychain writes live in main (pairWithCode/pairPoll — thin transport over
 * these functions); the UI walk is the macOS eyes-on debt, same as every other first-run change.
 *
 * FAIL-LOUD: every check increments `checks`; at the end `checks === FIXED` or the run FAILS (a
 * skipped section can't false-pass). A thrown error exits non-zero.
 */
import { readFileSync } from 'node:fs'
import {
  PAIRING_CODE_LENGTH,
  PAIR_POLL_INTERVAL_MS,
  hostFromAddress,
  isValidPairingCode,
  pairPollState,
  pairedGatewayUrls,
  parsePairResponse,
  parseSetupStatusResponse
} from '@shared/pairing'

let failures = 0
let checks = 0
function assert(cond: boolean, label: string): void {
  checks++
  console.log(`[pairing-smoke] ${cond ? 'PASS' : 'FAIL'}  ${label}`)
  if (!cond) failures++
}

if (
  typeof isValidPairingCode !== 'function' ||
  typeof parsePairResponse !== 'function' ||
  typeof pairedGatewayUrls !== 'function' ||
  typeof pairPollState !== 'function' ||
  typeof hostFromAddress !== 'function'
) {
  console.error('[pairing-smoke] FAIL — required @shared/pairing exports missing. Refusing to vacuously pass.')
  process.exit(1)
}

const FIXED = 48

// ── 1. code validation ── [7]
assert(PAIRING_CODE_LENGTH === 6, 'contract: codes are 6 digits')
assert(isValidPairingCode('123456'), 'valid: 123456')
assert(isValidPairingCode('000042'), 'valid: leading zeros (daemon mints %06d)')
assert(isValidPairingCode('  123456  '), 'valid: surrounding whitespace trimmed')
assert(!isValidPairingCode('12345'), 'invalid: 5 digits')
assert(!isValidPairingCode('1234567'), 'invalid: 7 digits')
assert(!isValidPairingCode('12a456'), 'invalid: non-digit')

// ── 2. response parsing ── [17]
const paired = parsePairResponse(200, { token: 'tok-abc', api_base_port: 8005, ws_port: 8010 })
assert(paired.kind === 'paired', '200+token → paired')
assert(paired.kind === 'paired' && paired.token === 'tok-abc', 'paired: token extracted')
assert(paired.kind === 'paired' && paired.apiBasePort === 8005 && paired.wsPort === 8010, 'paired: ports extracted')

const openDaemon = parsePairResponse(200, { token: '', api_base_port: 8005, ws_port: 8010 })
assert(openDaemon.kind === 'paired' && openDaemon.token === '', '200 with empty token = deliberately-open daemon, still paired')

const noToken = parsePairResponse(200, { hello: 'world' })
assert(noToken.kind === 'error', '200 WITHOUT a token field → error (not a silent empty-token pair)')

const wrong = parsePairResponse(401, { error: 'invalid_code', attempts_remaining: 3 })
assert(wrong.kind === 'invalid-code', '401 invalid_code → invalid-code')
assert(wrong.kind === 'invalid-code' && wrong.attemptsRemaining === 3, 'invalid-code: attempts extracted')
assert(wrong.kind === 'invalid-code' && wrong.label.includes('3 attempts remaining'), 'invalid-code: label says how many tries are left')

const lastTry = parsePairResponse(401, { error: 'invalid_code', attempts_remaining: 1 })
assert(lastTry.kind === 'invalid-code' && lastTry.label.includes('1 attempt remaining'), 'invalid-code: singular grammar on the last attempt')

const burned = parsePairResponse(401, { error: 'invalid_code', attempts_remaining: 0 })
assert(burned.kind === 'invalid-code' && burned.label.includes('locked'), 'invalid-code with 0 remaining: label says pairing is now locked')

const locked = parsePairResponse(403, { error: 'pairing_locked' })
assert(locked.kind === 'locked' && locked.reason === 'locked', '403 pairing_locked → locked')
const expired = parsePairResponse(403, { error: 'pairing_expired' })
assert(expired.kind === 'locked' && expired.reason === 'expired', '403 pairing_expired → expired')
const used = parsePairResponse(403, { error: 'pairing_used' })
assert(used.kind === 'locked' && used.reason === 'used', '403 pairing_used → used')
assert(
  [locked, expired, used].every((o) => o.kind === 'locked' && o.label.includes('restart')),
  'locked family: every label points at the restart remedy'
)
// The command a current daemon install has is `oara` (Prometheus renamed its CLI; `prometheus` stays
// as an alias). Telling a new user to type a name their install may only know as an alias is a wrong
// instruction, so the remedy names `oara daemon`.
assert(
  [locked, expired, used].every((o) => o.kind === 'locked' && o.label.includes('`oara daemon`')),
  'locked family: the restart remedy names `oara daemon`'
)
// And the setup screens never instruct `prometheus daemon` / `prometheus setup`, except the one
// "formerly …, which still works" note on the Welcome step. Read the sources (npm runs smokes from the
// repo root); an unreadable file counts as a failure, not a pass.
{
  const files = ['src/renderer/src/components/SetupWizard.tsx', 'src/renderer/src/components/FirstRunSetup.tsx', 'src/shared/pairing.ts']
  const stray: string[] = []
  let read = 0
  for (const f of files) {
    let text = ''
    try {
      text = readFileSync(f, 'utf8')
      read++
    } catch {
      stray.push(`${f}: unreadable`)
      continue
    }
    for (const m of text.matchAll(/prometheus (daemon|setup)/g)) {
      const before = text.slice(Math.max(0, (m.index ?? 0) - 40), m.index)
      if (!/formerly/.test(before)) stray.push(`${f}: "${m[0]}"`)
    }
  }
  assert(read === files.length && stray.length === 0, `setup copy names \`oara\`, not \`prometheus\` (${read}/${files.length} files read)${stray.length ? ' — ' + stray.join('; ') : ''}`)
}

const notSetup = parsePairResponse(404, null)
assert(notSetup.kind === 'error' && notSetup.label.includes('setup mode'), '404 (real daemon, no pairing route) → honest "is it in setup mode" error')
assert(parsePairResponse(500, null).kind === 'error', 'HTTP 500 → error')
const unreachable = parsePairResponse(0, null)
assert(unreachable.kind === 'error' && unreachable.label === 'Could not reach the gateway', 'status 0 → the daemon-api unreachable label')

// ── 3. gateway URL construction ── [9]
assert(hostFromAddress('my-mini') === 'my-mini', 'host: bare hostname passes through')
assert(hostFromAddress('http://my-mini:8005/x') === 'my-mini', 'host: scheme, port, and path stripped')
assert(hostFromAddress('  my-mini:9000  ') === 'my-mini', 'host: whitespace + explicit port stripped')

const urls = pairedGatewayUrls('my-mini:9999', { apiBasePort: 18205, wsPort: 18210 })
assert(urls.apiBase === 'http://my-mini:18205', 'urls: daemon-reported REST port wins over the typed one')
assert(urls.wsUrl === 'ws://my-mini:18210', 'urls: daemon-reported WS port used')

const defUrls = pairedGatewayUrls('my-mini', { apiBasePort: null, wsPort: null })
assert(defUrls.apiBase === 'http://my-mini:8005', 'urls: missing REST port → fixed 8005 default')
assert(defUrls.wsUrl === 'ws://my-mini:8010', 'urls: missing WS port → fixed 8010 default')

const junkUrls = pairedGatewayUrls('my-mini', { apiBasePort: 0, wsPort: -1 })
assert(junkUrls.apiBase === 'http://my-mini:8005', 'urls: nonsense REST port → default')
assert(junkUrls.wsUrl === 'ws://my-mini:8010', 'urls: nonsense WS port → default')

// ── 4. post-pair polling ── [7]
assert(PAIR_POLL_INTERVAL_MS === 3000, 'contract: ~3s poll cadence')
assert(pairPollState({ setupMode: true, apiStatusOk: false }) === 'waiting', 'poll: still in setup mode → waiting')
assert(pairPollState({ setupMode: null, apiStatusOk: false }) === 'waiting', 'poll: unreachable (restart gap) → waiting, never bail')
assert(pairPollState({ setupMode: false, apiStatusOk: false }) === 'waiting', 'poll: setup gone but /api/status not 200 yet → STILL waiting (no false proceed)')
assert(pairPollState({ setupMode: false, apiStatusOk: true }) === 'ready', 'poll: /api/status 200 → ready')
assert(pairPollState({ setupMode: null, apiStatusOk: true }) === 'ready', 'poll: /api/status 200 alone is sufficient')
assert(pairPollState({ setupMode: true, apiStatusOk: true }) === 'ready', 'poll: 200 wins even with a weird lingering setup answer')

// ── 5. setup-status probing (Phase 2 — the contract grew a real `configured`) ── [6]
const fresh = parseSetupStatusResponse(200, { setup_mode: true, configured: false, pairing: 'available' })
assert(fresh !== null && fresh.setupMode && !fresh.configured, 'status: fresh setup daemon parsed')
const resumed = parseSetupStatusResponse(200, { setup_mode: true, configured: true, pairing: 'locked' })
assert(resumed !== null && resumed.configured, 'status: configured:true surfaces (wizard resume signal)')
assert(resumed !== null && resumed.pairing === 'locked', 'status: pairing window state extracted')
assert(parseSetupStatusResponse(200, { hello: 'world' }) === null, 'status: body without setup_mode → null (not a setup daemon)')
assert(parseSetupStatusResponse(403, { error: 'setup_mode' }) === null, 'status: non-200 → null')
assert(parseSetupStatusResponse(200, null) === null, 'status: empty body → null, no throw')

// ── verdict ──
if (checks !== FIXED) {
  console.error(`[pairing-smoke] FAIL — ran ${checks}/${FIXED} checks (a section was skipped)`)
  process.exit(1)
}
if (failures > 0) {
  console.error(`[pairing-smoke] FAIL — ${failures}/${checks} checks failed`)
  process.exit(1)
}
console.log(`[pairing-smoke] OK — ${checks}/${FIXED} checks passed`)
