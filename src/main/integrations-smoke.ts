// Integrations smoke — headless (ELECTRON_RUN_AS_NODE) checks for the generic
// control-surface layer (contract v0.1). Pure data-layer: no daemon, no DOM.
// Structure per nav-smoke: assert() counter, refuse-to-vacuously-pass guard,
// programmatic enumeration, fixed-count fail-loud total, RESULT banner.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  IntegrationEntry,
  SUPPORTED_CONTRACT_VERSION,
  VIEW_TYPES,
  asBrowser,
  asControls,
  asEvents,
  asVitals,
  classifyHealth,
  isAllowedIntegrationPath,
  isAuthFailure,
  isSupportedViewType,
  parseManifest,
  sanitizeIntegrations
} from '../shared/integrations'
import { NAV_VIEWS, NAV_TREE, flattenNavTree } from '../shared/views'

let checks = 0
let failures = 0
function assert(cond: boolean, label: string): void {
  checks++
  if (cond) console.log(`[integrations-smoke] PASS ${label}`)
  else {
    failures++
    console.error(`[integrations-smoke] FAIL ${label}`)
  }
}

function main(): void {
  // Refuse to vacuously pass if the shared module lost its exports.
  if (!sanitizeIntegrations || !parseManifest || !isAllowedIntegrationPath || !VIEW_TYPES.length) {
    console.error('[integrations-smoke] shared/integrations exports missing — refusing to vacuously pass')
    process.exit(1)
  }

  // ── A. sanitize: garbage-safety + round-trip (6 checks) ────────────────
  assert(sanitizeIntegrations(null).length === 0, 'A1 sanitize(null) -> []')
  assert(sanitizeIntegrations([{ id: 'x y', baseUrl: 'http://h' }]).length === 0, 'A2 illegal id dropped')
  assert(sanitizeIntegrations([{ id: 'a', baseUrl: 'ftp://h' }]).length === 0, 'A3 non-http scheme dropped')
  const clean = sanitizeIntegrations([
    { id: 'jv', name: 'J', baseUrl: 'http://127.0.0.1:8015/', authRef: 'none' },
    { id: 'jv', name: 'dup', baseUrl: 'http://127.0.0.1:9' }
  ])
  assert(clean.length === 1 && clean[0].baseUrl === 'http://127.0.0.1:8015', 'A4 dedupe + trailing-slash strip')
  assert(clean[0].enabled === true, 'A5 enabled defaults true')
  const rt: IntegrationEntry[] = sanitizeIntegrations(JSON.parse(JSON.stringify(clean)))
  assert(rt.length === 1 && rt[0].id === 'jv', 'A6 JSON round-trip stable')

  // ── B. path guard (4 checks) ───────────────────────────────────────────
  assert(isAllowedIntegrationPath('/integration/vitals'), 'B1 allows /integration/vitals')
  assert(!isAllowedIntegrationPath('integration/vitals'), 'B2 rejects relative')
  assert(!isAllowedIntegrationPath('/a/../b'), 'B3 rejects traversal')
  assert(!isAllowedIntegrationPath('/x?u=http://evil'), 'B4 rejects smuggled scheme')

  // ── C. manifest parsing — all four view types enumerated (4 + 4 checks) ─
  const fixtureViews = [
    { type: 'vitals', title: 'V', endpoint: '/integration/vitals' },
    { type: 'browser', title: 'B', endpoint: '/integration/browse/x', searchable: true },
    { type: 'controls', title: 'C', endpoint: '/integration/controls' },
    { type: 'events', title: 'E', poll_endpoint: '/integration/events' }
  ]
  const good = parseManifest({
    contract_version: SUPPORTED_CONTRACT_VERSION,
    integration: { id: 'jv', name: 'J' },
    health_endpoint: '/health',
    views: fixtureViews
  })
  assert(good.problem === null && good.manifest !== null, 'C1 good manifest parses')
  assert(good.manifest!.views.length === 4, 'C2 all four view types kept')
  for (const t of VIEW_TYPES) {
    assert(isSupportedViewType(t), `C3 view type supported: ${t}`)
  }
  const badVer = parseManifest({ contract_version: 2, integration: { id: 'x', name: 'x' }, views: [] })
  assert(badVer.problem?.kind === 'version', 'C4 version mismatch is a LOUD problem')
  const badPath = parseManifest({
    contract_version: 1, integration: { id: 'x', name: 'x' },
    views: [{ type: 'vitals', title: 'V', endpoint: 'http://evil/x' }]
  })
  assert(badPath.problem?.kind === 'shape', 'C5 manifest-declared absolute URL rejected')

  // ── D. payload coercions never throw on garbage (4 checks) ─────────────
  assert(asVitals(undefined).sections.length === 0, 'D1 asVitals(garbage) safe')
  assert(asBrowser({ rows: 'x' }).rows.length === 0, 'D2 asBrowser(garbage) safe')
  assert(asControls({ controls: [{ id: 'k', endpoint: 'http://evil', method: 'POST', label: 'x', confirm: true }] }).controls.length === 0,
    'D3 asControls drops illegal endpoints')
  assert(String(asEvents(null).cursor) === '0', 'D4 asEvents(garbage) safe')

  // ── E. health classification (3 checks) ────────────────────────────────
  assert(classifyHealth({ status: 'ok', degraded: [] }).state === 'ok', 'E1 ok')
  assert(classifyHealth({ status: 'degraded', degraded: [{ component: 't', reason: 'r' }] }).state === 'degraded', 'E2 degraded')
  assert(classifyHealth({ nope: 1 }).state === 'error', 'E3 unrecognized -> error')
  assert(isAuthFailure('HTTP 401: GET /integration/browse/memories — denied'), 'E4 401 classified as auth failure')
  assert(!isAuthFailure('HTTP 500: GET /x — boom'), 'E5 non-401 not auth failure')

  // ── F. nav wiring (2 checks) ────────────────────────────────────────────
  assert(NAV_VIEWS.some((v) => v.id === 'integrations'), 'F1 integrations registered in NAV_VIEWS')
  assert(flattenNavTree(NAV_TREE).includes('integrations'), 'F2 reachable through the nav tree')
  // F3 REMOVED: it pinned NAV_VIEWS.length === 15 while nav-smoke.ts pins the
  // same number authoritatively (17, and it also proves tree coverage). Two
  // files pinning one count is how one goes stale, and this one had — it missed
  // Wiki (#82) and Devices (#88) and left this smoke RED on main. The registry's
  // size is nav-smoke's contract; what THIS file cares about is that
  // integrations is registered and reachable, which F1 and F2 already assert.

  // ── G. genericity guard: zero integration-specific identifiers (1 check) ─
  const shared = readFileSync(join(__dirname, '../../src/shared/integrations.ts'), 'utf8')
  assert(!/jarvis|oara/i.test(shared), 'G1 shared/integrations.ts is integration-agnostic')

  const EXPECTED = 6 + 4 + (2 + VIEW_TYPES.length + 2) + 4 + 5 + 2 + 1 + 9 // F: 3->2 (count pin moved to nav-smoke); +9: manifest capabilities (B6)
  // NB: the argument evaluates BEFORE assert() increments — compare to EXPECTED, not EXPECTED+1.
  // ── manifest capabilities (B6 Config surfacing) ───────────────────────────
  // Optional and additive: an integration that predates the field must keep its
  // views, because Beacon disables an integration it cannot parse and voice would
  // go dark on any middleware not updated in lockstep.
  {
    const withCaps = parseManifest({
      contract_version: 1,
      integration: { id: 'oara', name: 'OAra Voice' },
      health_endpoint: '/health',
      views: [],
      capabilities: [
        { id: 'dictation', title: 'Dictation', detail: 'Transcription only.' },
        { id: 'voice_turn', title: 'Voice turns' }
      ]
    })
    assert(withCaps.manifest?.capabilities.length === 2, 'declared capabilities are parsed')
    assert(withCaps.manifest?.capabilities[0].detail === 'Transcription only.', 'detail survives')
    assert(withCaps.manifest?.capabilities[1].detail === undefined, 'a capability without detail is still valid')

    const noCaps = parseManifest({
      contract_version: 1,
      integration: { id: 'old', name: 'Older middleware' },
      health_endpoint: '/health',
      views: [{ type: 'vitals', title: 'Vitals', endpoint: '/integration/vitals' }]
    })
    assert(noCaps.problem === null, 'a manifest with NO capabilities is not a problem')
    assert(noCaps.manifest?.capabilities.length === 0, 'it simply declares none')
    assert(noCaps.manifest?.views.length === 1, 'and it keeps its views — the field is decorative, never fatal')

    const junk = parseManifest({
      contract_version: 1,
      integration: { id: 'x', name: 'x' },
      health_endpoint: '/health',
      views: [{ type: 'vitals', title: 'V', endpoint: '/integration/vitals' }],
      capabilities: [{ id: 'ok', title: 'Fine' }, { id: 'ok', title: 'Duplicate' }, { title: 'No id' }, 'nope', null]
    })
    assert(junk.problem === null, 'malformed capabilities do NOT fail the manifest')
    assert(junk.manifest?.capabilities.length === 1, 'the bad ones are dropped, the good one kept')
    assert(junk.manifest?.views.length === 1, 'and the views survive a garbage capabilities list')
  }

  assert(checks === EXPECTED, `count guard (${checks} checks before this one)`)
  console.log(`[integrations-smoke] RESULT ${failures === 0 ? 'PASS' : 'FAIL'} — ${checks} checks, ${failures} failures`)
  process.exit(failures === 0 ? 0 : 1)
}

try {
  main()
} catch (err) {
  console.error('[integrations-smoke] CRASH', err)
  process.exit(1)
}
