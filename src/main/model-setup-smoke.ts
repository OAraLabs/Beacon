/**
 * How the assistant thinks (O9) — headless, under ELECTRON_RUN_AS_NODE. Written before the code (docs/ONBOARDING-v0.4.0-O9.md
 * §2, §3, §5, §6, §7).
 *
 * Pins:
 *   1. the Prometheus shapes (§6), held to a REAL daemon's answers (Prometheus #732, recorded by scripts/record-model-setup-732.mjs
 *      into src/main/fixtures/model_setup_732.json): the key check's four answers, and anything else is never "ok"; the configure
 *      bodies; the shapes of pasted keys;
 *   2. the machine (§3): A2 → A3c-1 → (OpenRouter A3c-or | a pasted key A3c-2) → A5 → F1, Back on each, none from A5 or after;
 *   3. THE END OF O9 (§5), in a world of fakes answering with the recorded bodies: check, configure and complete with the master
 *      token; then a hello and pair.fp compared as plain strings (a missing one is ""), and only then `--pair` and
 *      `/api/pair/local` (the installer's order, now one function: nothing is written or sent before hello says it is ours); the owner credential replaces the master token in the keychain entry,
 *      the connection is brought up with it, and the master token is in no update the page is sent and in no saved state. A
 *      failure at any step stops before F1 and never marks the master token as an owner credential.
 */
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { CHECK_KEY_ROUTE, CREDENTIAL_KIND_KEY, configureBody, pastedKeyLooksRight, readKeyCheck, resumeAtTrade } from '@shared/model-setup'
import { initialOnboardingState, onboardingEntry, onboardingReduce, PENDING_SCREENS, type OnboardingEvent, type OnboardingState, type ScreenId } from '@shared/onboarding'
import { PAIR_SECRET_IN_HOME } from '@shared/prometheus-app'
import { COPY } from '@shared/onboarding-strings'
import { decideStartupRoute, type LaunchProbe } from '@shared/setup-wizard'
import { ModelSetup, type ModelSetupView } from './model-setup'
import type { ExecFn } from './prometheus-install'
import type { HttpRequest, HttpResult } from './pairing/http'
import type { GatewayConfig } from './connection/config'
import wire from './fixtures/model_setup_732.json'

let failures = 0
let checks = 0
function assert(cond: boolean, label: string, detail?: string): void {
  checks++
  console.log(`[model-setup-smoke] ${cond ? 'PASS' : 'FAIL'}  ${label}${!cond && detail ? `  — ${detail}` : ''}`)
  if (!cond) failures++
}
const EXPECTED = 32
process.on('exit', () => {
  if (checks !== EXPECTED) {
    console.error(`[model-setup-smoke] FAIL — ran ${checks} checks, expected exactly ${EXPECTED}`)
    process.exitCode = 1
  } else if (failures > 0) {
    console.error(`[model-setup-smoke] FAIL — ${failures}/${checks} checks failed`)
    process.exitCode = 1
  } else console.log(`[model-setup-smoke] OK — ${checks} checks passed`)
})

// ── 1. the shapes Beacon assumes (§6) ─────────────────────────────────────────────────────────────────────────────────────
const K = wire.check_key
assert(CHECK_KEY_ROUTE === '/api/setup/check-key', 'route: the key check is POST /api/setup/check-key (Prometheus #732)', CHECK_KEY_ROUTE)
assert((['ok', 'bad_key', 'no_credit', 'unreachable'] as const).every((r) => readKeyCheck(200, { result: r }).result === r), 'the key check answers ok, bad_key, no_credit or unreachable, and each is read as itself')
assert(readKeyCheck(200, { result: 'maybe' }).result !== 'ok' && readKeyCheck(500, { result: 'ok' }).result !== 'ok' && readKeyCheck(401, null).result !== 'ok' && readKeyCheck(200, null).result !== 'ok' && readKeyCheck(200, 'ok').result !== 'ok', 'another result, an error status carrying "ok", a refusal, or no body is never "ok"')
const fakes = [K.fake_openrouter, K.fake_anthropic, K.fake_openai].map((a) => readKeyCheck(a.status, a.json))
assert(
  fakes.every((f) => f.result === 'bad_key' && f.detail.includes('401')) &&
    readKeyCheck(K.not_a_key.status, K.not_a_key.json).result === 'bad_key' &&
    [K.no_token, K.not_json, K.base_url, K.unsupported, K.empty_key].every((a) => readKeyCheck(a.status, a.json).result === 'unreachable'),
  'recorded (#732): a key each company refuses (401) is bad_key, with the company\'s status kept for Copy details; one not shaped like a key is bad_key; every 400 and the 401 for no credential are never "ok"',
  JSON.stringify(fakes)
)
assert(JSON.stringify(configureBody('openrouter', 'sk-or-v1-x')) === JSON.stringify({ provider: 'openrouter', api_key: 'sk-or-v1-x' }) && JSON.stringify(configureBody('anthropic', 'sk-ant-x')) === JSON.stringify({ provider: 'anthropic', api_key: 'sk-ant-x' }) && JSON.stringify(configureBody('openai', 'sk-x')) === JSON.stringify({ provider: 'openai', api_key: 'sk-x' }), 'configure gets the provider and the key, no base_url and no model (the daemon\'s default)')
const conf = wire.configure_openrouter.json
assert(wire.configure_openrouter.status === 200 && conf.configured === true && conf.provider === 'openrouter' && conf.model === 'anthropic/claude-sonnet-5' && conf.api_key_saved === true && !wire.key_in_config_yaml && wire.key_kept_in.length === 1 && /\/\.config\/prometheus\/env$/.test(wire.key_kept_in[0]), 'recorded (#732): configure {provider: openrouter, api_key} with no model is configured on anthropic/claude-sonnet-5, a paid one; the key is kept in Prometheus\'s env file only, never its config', JSON.stringify({ conf, kept: wire.key_kept_in }))
assert(pastedKeyLooksRight('anthropic', '  sk-ant-api03-abc  ') && !pastedKeyLooksRight('anthropic', 'sk-proj-abc') && pastedKeyLooksRight('openai', 'sk-proj-abc') && !pastedKeyLooksRight('openai', 'sk-ant-api03-abc') && !pastedKeyLooksRight('openai', '') && !pastedKeyLooksRight('anthropic', 'sk-ant-'), 'keys: an Anthropic key starts sk-ant-, an OpenAI one sk- (and is not an Anthropic one); spaces around a paste are forgiven; a prefix alone is not a key')
// Two facts from Prometheus #732 the copy must carry: a good Anthropic or OpenAI key is "ok" even on an account with no credit (only
// OpenRouter is checked for credit), and a busy (rate-limited) company reads "unreachable", the same as no connection.
assert(
  /credit or a payment method/.test(COPY.main.a3c2.finePrint) && /wait a minute/.test(COPY.main.a3cOr.unreachable.body) && /wait a minute/.test(COPY.main.a3c2.unreachable.body) && /internet connection/.test(COPY.main.a3cOr.unreachable.body),
  'copy: the paste screen says the account needs credit (a good key is not proof of it), and "couldn\'t reach" says both a lost connection and a busy company',
  JSON.stringify({ fine: COPY.main.a3c2.finePrint, or: COPY.main.a3cOr.unreachable.body })
)
assert(
  resumeAtTrade({ credential: 'master', setupMode: false, thisMac: true }) &&
    !resumeAtTrade({ credential: 'owner', setupMode: false, thisMac: true }) &&
    !resumeAtTrade({ credential: 'master', setupMode: true, thisMac: true }) &&
    !resumeAtTrade({ credential: 'master', setupMode: false, thisMac: false }) &&
    !resumeAtTrade({ credential: null, setupMode: false, thisMac: true }) &&
    !resumeAtTrade({ credential: '', setupMode: false, thisMac: true }),
  'resume: Prometheus on this Mac, no longer in setup mode (configured, or not answering), whose credential is still the master token resumes at the owner trade, and only that'
)
const probeOf = (o: Partial<LaunchProbe> | null): LaunchProbe | null => (o === null ? null : { reachable: true, setupMode: false, configured: true, ...o })
const routeFor = (credential: string | null, probe: LaunchProbe | null, thisMac = true): string => decideStartupRoute({ hasConnection: true, probe, hasCredential: true, credential, thisMac }).kind
assert(
  routeFor('master', probeOf({})) === 'trade' &&
    routeFor('master', null) === 'trade' &&
    routeFor('master', probeOf({ reachable: false })) === 'trade' &&
    routeFor('master', probeOf({ setupMode: true, configured: false })) === 'resume' &&
    routeFor('owner', probeOf({})) === 'app' &&
    routeFor(null, probeOf({})) === 'app' &&
    routeFor('master', probeOf({}), false) === 'app',
  'startup: the master token kept for Prometheus on this Mac never opens the app: configured or not answering resumes at the trade, setup mode resumes at A2; an owner credential (or none recorded) opens the app',
  JSON.stringify([routeFor('master', probeOf({})), routeFor('master', null), routeFor('master', probeOf({ setupMode: true }))])
)
const tradeEntry = onboardingEntry({ visible: false, resume: true, browsing: false, resumeHere: true, resumeTrade: true })
const atTrade = initialOnboardingState('resumeTrade')
assert(
  tradeEntry === 'resumeTrade' && onboardingEntry({ visible: true, resume: true, browsing: true, resumeHere: true, resumeTrade: true }) === 'resumeTrade' && atTrade.screen === 'A5' && onboardingReduce(atTrade, { type: 'back' }).screen === 'A5' && onboardingReduce(atTrade, { type: 'setUp' } as unknown as OnboardingEvent).screen === 'F1',
  'startup: a resumed trade opens on "Finishing setup" (whatever the gate says: only the new flow can finish it), with no Back, and on to "Say hello" when it is done',
  `${tradeEntry} ${atTrade.screen}`
)

// ── 2. the machine (§3) ───────────────────────────────────────────────────────────────────────────────────────────────────
const ev = (e: Record<string, unknown>): OnboardingEvent => e as unknown as OnboardingEvent
const step = (s: OnboardingState, e: OnboardingEvent): OnboardingState => onboardingReduce(s, e) ?? s
const run = (s: OnboardingState, ...es: OnboardingEvent[]): OnboardingState => es.reduce(step, s)
const is = (s: OnboardingState, id: string): boolean => (s.screen as string) === id
const atA2 = run(initialOnboardingState('welcome'), { type: 'start' }, { type: 'choose', where: 'new' }, { type: 'continue' }, { type: 'macChecked', verdict: { kind: 'ok' } }, { type: 'confirmSetup' }, { type: 'installed', daemon: 'setup' })
const a3 = run(atA2, { type: 'continue' })
assert(is(atA2, 'A2') && !PENDING_SCREENS.includes('A2' as ScreenId) && is(a3, 'A3c-1') && is(run(a3, { type: 'back' }), 'A2') && is(run(atA2, { type: 'back' }), 'W2'), 'machine: A2 is a real screen; Continue (a cloud AI, the only choice in O9) is "Connect a cloud AI", whose Back is A2; Back from A2 is the question')
const or = run(a3, { type: 'continue' })
const pasted = run(a3, ev({ type: 'otherKey', company: 'anthropic' }))
assert(is(or, 'A3c-or') && is(run(or, { type: 'back' }), 'A3c-1') && is(pasted, 'A3c-2') && is(run(pasted, { type: 'back' }), 'A3c-1'), 'machine: Continue on the Recommended card is the OpenRouter sign-in; Other options leads to a pasted key; Back from either is the list')
const a5 = run(or, ev({ type: 'signedIn' }))
const a5k = run(pasted, ev({ type: 'keyAccepted' }))
assert(is(a5, 'A5') && is(a5k, 'A5') && run(a5, { type: 'back' }).screen === a5.screen, 'machine: a finished sign-in or an accepted key goes to "Finishing setup", which has no Back while it works')
const f1 = run(a5, ev({ type: 'setUp' }))
assert(is(f1, 'F1') && f1.history.length === 0 && run(f1, { type: 'back' }) === f1, 'machine: set up and owner, "Say hello", with nothing to go back to (the master token is gone)')
assert(run(a3, ev({ type: 'signedIn' })) === a3 && run(atA2, ev({ type: 'keyAccepted' })) === atA2 && run(or, ev({ type: 'setUp' })) === or && run(atA2, ev({ type: 'otherKey', company: 'openai' })) === atA2, 'machine: each O9 event means something on its own screen only')

// ── 3. the end of O9 (§5), in a world of fakes ────────────────────────────────────────────────────────────────────────────
const root = mkdtempSync(join(tmpdir(), 'model-setup-smoke-'))
const PORT = 55101
const MASTER = 'MASTER' + randomBytes(12).toString('hex')
const OWNER = 'OWNER' + randomBytes(12).toString('hex')
const KEY = 'sk-or-v1-' + randomBytes(12).toString('hex')
const LOCAL = JSON.parse(readFileSync('src/main/fixtures/pair_local_696.json', 'utf8')) as { hello: { json: Record<string, unknown> } }
const FP = String(LOCAL.hello.json.fp)

interface World {
  log: string[]
  views: ModelSetupView[]
  saved: { gateway: GatewayConfig; token: string }[]
  settings: Record<string, string>
  activated: number
  stored: string
  setup: ModelSetup
}
interface Opts {
  check?: string
  pairStatus?: number
  /** pair.fp after complete. Undefined: what the daemon writes at boot (its fingerprint); null: none; a string: that. */
  pairFp?: string | null
  never?: 'configured'
  /** The daemon is already configured when the world starts (complete ran before a relaunch). */
  start?: 'configured'
  /** /api/pair/local refuses this many times, then answers (pairStatus refuses always). */
  pairRefusals?: number
}
function world(o: Opts = {}): World {
  const home = mkdtempSync(join(root, 'home-'))
  const secretPath = join(home, PAIR_SECRET_IN_HOME)
  const w = { log: [] as string[], views: [] as ModelSetupView[], saved: [] as { gateway: GatewayConfig; token: string }[], settings: {} as Record<string, string>, activated: 0, stored: MASTER } as World
  let state: 'setup' | 'configured' = o.start ?? 'setup'
  let secret: string | null = null
  let refusals = o.pairRefusals ?? 0
  const writePairFp = (fp: string): void => {
    const dir = join(home, 'Library/Application Support/Prometheus/pairing')
    mkdirSync(dir, { recursive: true })
    chmodSync(dir, 0o700)
    writeFileSync(join(dir, 'pair.fp'), fp + '\n')
    chmodSync(join(dir, 'pair.fp'), 0o600)
  }
  if (o.start === 'configured') writePairFp(FP)
  const bearer = (r: HttpRequest): string => (r.headers?.authorization ?? r.headers?.Authorization ?? '').replace(/^Bearer /, '')
  const request = async (r: HttpRequest): Promise<HttpResult> => {
    const path = new URL(r.url).pathname
    w.log.push(`${r.method} ${path} ${bearer(r) === MASTER ? 'master' : bearer(r) === OWNER ? 'owner' : 'none'}${r.body ? ` ${r.body}` : ''}`)
    if (!r.url.startsWith(`http://127.0.0.1:${PORT}/`)) return 'unreachable'
    if (path === CHECK_KEY_ROUTE && r.method === 'POST') return bearer(r) === MASTER ? { status: 200, json: o.check === 'bad_key' ? K.fake_anthropic.json : { result: o.check ?? 'ok', ...(o.check ? {} : { status: 200, detail: 'the provider accepted the key' }) }, retryAfter: null } : { status: K.no_token.status, json: K.no_token.json, retryAfter: null }
    if (path === '/api/setup/configure') return bearer(r) === MASTER && state === 'setup' ? { status: 200, json: wire.configure_openrouter.json, retryAfter: null } : { status: 401, json: null, retryAfter: null }
    if (path === '/api/setup/complete') {
      if (bearer(r) !== MASTER) return { status: 401, json: null, retryAfter: null }
      if (o.never !== 'configured') {
        state = 'configured'
        // The full daemon's boot (the same process, after complete) writes pair.fp from its key (recorded: Prometheus #695).
        const fp = o.pairFp === undefined ? FP : o.pairFp
        if (fp !== null) writePairFp(fp)
      }
      return { status: 200, json: { restarting: true }, retryAfter: null }
    }
    // As recorded (#695/#732): setup mode answers with setup_mode; a configured daemon gives the bearer middleware's 401.
    if (path === '/api/setup/status') return state === 'setup' ? { status: 200, json: { setup_mode: true, configured: false, version: '0.9.6' }, retryAfter: null } : { status: 401, json: { error: 'unauthorized — set Authorization: Bearer <token>' }, retryAfter: null }
    if (path === '/api/status') return state === 'configured' && (bearer(r) === MASTER || bearer(r) === OWNER) ? { status: 200, json: {}, retryAfter: null } : { status: 401, json: { error: 'unauthorized — set Authorization: Bearer <token>' }, retryAfter: null }
    if (path === '/api/hello') return { status: 200, json: LOCAL.hello.json, retryAfter: null }
    if (path === '/api/pair/local' && r.method === 'POST') {
      const code = (JSON.parse(r.body ?? '{}') as { code?: string }).code
      if (refusals > 0) {
        refusals--
        return { status: 401, json: { error: 'invalid_code' }, retryAfter: null }
      }
      if (o.pairStatus && o.pairStatus !== 200) return { status: o.pairStatus, json: { error: 'invalid_code' }, retryAfter: null }
      if (!secret || code !== secret || state !== 'configured') return { status: 401, json: { error: 'invalid_code' }, retryAfter: null }
      secret = null
      rmSync(secretPath, { force: true })
      return { status: 200, json: { token: OWNER, revoked_previous: 0, api_base_port: 8005, ws_port: 55102 }, retryAfter: null }
    }
    return { status: 404, json: null, retryAfter: null }
  }
  const exec: ExecFn = async (_file, args) => {
    w.log.push(`exec ${args.join(' ')}`)
    if (args[0] !== '--pair') return { exit: 2, stdout: '', stderr: 'unexpected' }
    const dir = join(home, 'Library/Application Support/Prometheus/pairing')
    mkdirSync(dir, { recursive: true })
    chmodSync(dir, 0o700)
    secret = randomBytes(32).toString('base64url')
    writeFileSync(secretPath, secret + '\n')
    chmodSync(secretPath, 0o600)
    return { exit: 0, stdout: JSON.stringify({ ok: true, state: 'pair_secret_written', path: secretPath, detail: '', agent: 'x', app_version: '0.9.6' }) + '\n', stderr: '' }
  }
  w.setup = new ModelSetup({
    port: PORT,
    masterToken: () => w.stored,
    request,
    exec,
    launcher: '/Applications/Prometheus.app/Contents/MacOS/Prometheus',
    secretPath,
    now: (() => {
      let t = 0
      return () => (t += 250)
    })(),
    sleep: async () => undefined,
    save: (c) => {
      w.log.push('save')
      w.saved.push(c)
      w.stored = c.token
      w.settings[CREDENTIAL_KIND_KEY] = c.credential // what index.ts's saveLocalConnection records beside the token
    },
    activate: () => {
      w.log.push('activate')
      w.activated++
    },
    publish: (v) => w.views.push(v)
  })
  return w
}
const idx = (w: World, needle: string): number => w.log.findIndex((l) => l.startsWith(needle))

async function main(): Promise<void> {
  const w = world()
  const v = await w.setup.finish('openrouter', KEY)
  assert(v.phase === 'done', 'end: OpenRouter, checked and configured, ends done', JSON.stringify(v))
  const order = ['POST /api/setup/check-key master', 'POST /api/setup/configure master', 'POST /api/setup/complete master', 'GET /api/status master', 'GET /api/hello none', 'exec --pair', 'POST /api/pair/local none', 'save', 'activate', 'GET /api/status owner'].map((n) => idx(w, n))
  assert(order.every((i) => i >= 0) && order.every((i, k) => k === 0 || i > order[k - 1]), 'end: check → configure → complete (with the master token) → the daemon up → hello (and pair.fp) before any secret is written → --pair → /api/pair/local (with no credential) → keep → bring up → the owner credential answers', JSON.stringify(w.log.map((l) => l.slice(0, 50))))
  const configured = w.log.find((l) => l.startsWith('POST /api/setup/configure'))
  assert(!!configured && JSON.parse(configured.slice(configured.indexOf('{'))).provider === 'openrouter' && JSON.parse(configured.slice(configured.indexOf('{'))).api_key === KEY, 'end: configure carries the OpenRouter key as given')
  assert(w.saved.length === 1 && w.saved[0].token === OWNER && w.stored === OWNER && w.saved[0].gateway.apiBase === `http://127.0.0.1:${PORT}` && w.saved[0].gateway.wsUrl === 'ws://127.0.0.1:55102', 'end: the owner credential replaces the master token in the keychain entry, at the port Beacon reached and the daemon\'s WebSocket port', JSON.stringify(w.saved.map((s) => s.gateway)))
  assert(w.settings[CREDENTIAL_KIND_KEY] === 'owner' && !JSON.stringify(w.settings).includes(MASTER) && !JSON.stringify(w.views).includes(MASTER) && !JSON.stringify(w.views).includes(KEY), 'end: the connection is recorded as an owner credential; neither the master token nor the key is in any saved setting or any update the page is sent')

  for (const [label, check, kind] of [
    ['no credit', 'no_credit', 'no_credit'],
    ['a key it does not accept', 'bad_key', 'bad_key'],
    ['the company unreachable', 'unreachable', 'unreachable'],
    ['an answer that is not one of the four', 'perhaps', 'unreachable']
  ] as const) {
    const c = world({ check })
    const cv = await c.setup.finish('anthropic', 'sk-ant-api03-x')
    assert(cv.phase === 'failed' && cv.failure?.kind === kind && idx(c, 'POST /api/setup/configure') === -1 && c.saved.length === 0 && c.stored === MASTER && c.settings[CREDENTIAL_KIND_KEY] !== 'owner', `check: ${label} is its card, and nothing is configured or kept`, JSON.stringify(cv))
  }
  const never = world({ never: 'configured' })
  const nv = await never.setup.finish('openrouter', KEY)
  assert(nv.phase === 'failed' && nv.failure?.kind === 'not-started' && idx(never, 'exec --pair') === -1 && never.saved.length === 0, 'start: a daemon that never comes back as configured is "Prometheus didn\'t start", and no secret is written', JSON.stringify(nv))
  const refused = world({ pairStatus: 401 })
  const rv = await refused.setup.finish('openrouter', KEY)
  assert(rv.phase === 'failed' && rv.failure?.kind === 'trade' && refused.saved.length === 0 && refused.stored === MASTER && refused.settings[CREDENTIAL_KIND_KEY] !== 'owner' && refused.activated === 0, 'trade: /api/pair/local refusing stops before F1 ("Beacon couldn\'t finish connecting"); the master token is not marked as an owner credential', JSON.stringify(rv))
  const wrongFp = world({ pairFp: '0000000000000000' })
  const fv = await wrongFp.setup.finish('openrouter', KEY)
  assert(fv.phase === 'failed' && fv.failure?.kind === 'trade' && idx(wrongFp, 'POST /api/pair/local') === -1 && wrongFp.saved.length === 0, 'trade: a pair.fp that is not the fingerprint hello gives (a sanity check that this is our daemon): the secret is not sent', JSON.stringify(fv))
  const noFp = world({ pairFp: null })
  const gv = await noFp.setup.finish('openrouter', KEY)
  assert(gv.phase === 'failed' && gv.failure?.kind === 'trade' && idx(noFp, 'POST /api/pair/local') === -1 && noFp.stored === MASTER, 'trade: no pair.fp beside a configured daemon is "" against its fingerprint: a mismatch, and the secret is not sent', JSON.stringify(gv))
  // ── a relaunch part-way through the trade, and Try again after it failed ──
  const owed = world({ start: 'configured' })
  const ov = await owed.setup.resumeTrade()
  const oorder = ['GET /api/status master', 'GET /api/hello none', 'exec --pair', 'POST /api/pair/local none', 'save', 'activate', 'GET /api/status owner'].map((n) => idx(owed, n))
  assert(
    ov.phase === 'done' && oorder.every((i, k) => i >= 0 && (k === 0 || i > oorder[k - 1])) && ['POST /api/setup/check-key', 'POST /api/setup/configure', 'POST /api/setup/complete'].every((n) => idx(owed, n) === -1) && owed.stored === OWNER && owed.settings[CREDENTIAL_KIND_KEY] === 'owner' && owed.activated === 1,
    'resume: on a configured daemon with no key in hand, only the trade runs (no check, no configure, no complete): the owner credential replaces the master token and is recorded as one',
    JSON.stringify({ ov, log: owed.log.map((l) => l.slice(0, 40)) })
  )
  const again = world({ pairRefusals: 1 })
  const first = await again.setup.finish('openrouter', KEY)
  const configures = (): number => again.log.filter((l) => l.startsWith('POST /api/setup/c')).length
  const before = configures()
  const second = await again.setup.finish('openrouter', KEY)
  assert(
    first.phase === 'failed' && first.failure?.kind === 'trade' && second.phase === 'done' && configures() === before && again.stored === OWNER && again.settings[CREDENTIAL_KIND_KEY] === 'owner',
    'Try again after the trade failed: the daemon is configured already, so only the trade runs again (configure and complete are not sent to a configured daemon), and it ends as owner',
    JSON.stringify({ first, second, log: again.log.map((l) => l.slice(0, 40)) })
  )
  const early = world()
  const ev2 = await early.setup.resumeTrade()
  assert(
    ev2.phase === 'failed' && ev2.failure?.kind === 'not-started' && idx(early, 'GET /api/status master') === -1 && idx(early, 'exec --pair') === -1 && idx(early, 'POST /api/setup/configure') === -1 && early.saved.length === 0 && early.stored === MASTER && early.settings[CREDENTIAL_KIND_KEY] !== 'owner',
    'resume: a daemon still in setup mode has nothing to trade: it says so at once (no minute of waiting for it to come up configured), without a secret written, a configure sent or anything kept',
    JSON.stringify(ev2)
  )
}

main()
  .catch((e) => assert(false, 'the smoke ran to the end', String((e as Error)?.stack ?? e)))
  .finally(() => {
    rmSync(root, { recursive: true, force: true })
    setTimeout(() => process.exit(failures > 0 || checks !== EXPECTED ? 1 : 0), 20)
  })
