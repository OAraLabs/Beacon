/**
 * "Let other computers on my home network connect" — headless, under ELECTRON_RUN_AS_NODE. Written before the code
 * (docs/MULTI-COMPUTER-v0.4.md §2), then held to a REAL daemon's answers: src/main/fixtures/network_setting_700.json, recorded
 * by scripts/record-network-setting.mjs from Prometheus main (#700's GET/PUT /api/network) and #724 (POST /api/restart), on
 * loopback in scratch homes. Where an answer could not be recorded (home-network mode itself, which would listen on the LAN;
 * the 409s; 503 restart_unavailable), it is built from #700's and #724's source and says so.
 *
 * Pins: who sees the section (an operator; a scoped device's 403 shows nothing); what the switch and its lines say for each
 * mode and applied state; every warning and advertising reason in Beacon's words, and an unknown code in the daemon's own
 * message (never nothing); why there is no switch (can_change, by bind_source); PUT's body (never "open") and every answer;
 * the switch reading the setting back with GET (PUT's answer uses `mode` for the SAVED state, GET for the running one); and the
 * restart: hello's fp first, then the route, then Prometheus waited for until it has gone away and answers as the same computer,
 * or the route missing (a real 405), or it not coming back, or something else answering.
 */
import { NETWORK_ROUTE, PUT_FAILED, RESTART_ROUTE, putBody, readNetwork, readPut, readRestart, type NetworkRead } from '@shared/network-setting'
import { NetworkSetting } from './network-setting'
import type { HttpRequest, HttpResult } from './pairing/http'
import wire from './fixtures/network_setting_700.json'

let failures = 0
let checks = 0
function assert(cond: boolean, label: string, detail?: string): void {
  checks++
  console.log(`[network-setting-smoke] ${cond ? 'PASS' : 'FAIL'}  ${label}${!cond && detail ? `  — ${detail}` : ''}`)
  if (!cond) failures++
}
const EXPECTED = 31
process.on('exit', () => {
  if (checks !== EXPECTED) {
    console.error(`[network-setting-smoke] FAIL — ran ${checks} checks, expected exactly ${EXPECTED}`)
    process.exitCode = 1
  } else if (failures > 0) {
    console.error(`[network-setting-smoke] FAIL — ${failures}/${checks} checks failed`)
    process.exitCode = 1
  } else console.log(`[network-setting-smoke] OK — ${checks} checks passed`)
})

/** A GET /api/network answer in the recorded shape (nine keys; pending_mode only when applied is on_restart), for the states that
 *  were not recorded. */
const net = (o: Record<string, unknown> = {}): Record<string, unknown> => ({
  mode: 'this_mac',
  bind: '127.0.0.1',
  bind_source: 'config',
  tls: { enabled: false, spki_sha256: null },
  advertising: false,
  advertising_reason: { code: 'this_mac_only', message: 'not advertising: the daemon listens on this machine only' },
  applied: 'live',
  warnings: [],
  can_change: true,
  ...o
})
const view = (r: NetworkRead) => (r.kind === 'shown' ? r.view : null)
const shown = (o: Record<string, unknown>) => view(readNetwork(200, net(o)))

// ── what the section shows ────────────────────────────────────────────────────────────────────────────────────────────────
assert(NETWORK_ROUTE === '/api/network' && RESTART_ROUTE === '/api/restart', 'routes: GET/PUT /api/network (#700) and POST /api/restart (#724)', `${NETWORK_ROUTE} ${RESTART_ROUTE}`)
const N = wire.network
assert(N.get_scoped_device.status === 403 && readNetwork(N.get_scoped_device.status, N.get_scoped_device.json).kind === 'hidden', 'who: a scoped device (recorded: 403 operator_only) sees no section at all')
assert(readNetwork(N.get_no_token.status, N.get_no_token.json).kind === 'unreadable' && readNetwork(403, { error: 'forbidden' }).kind === 'unreadable' && readNetwork(500, null).kind === 'unreadable' && readNetwork(200, { mode: 'this_mac' }).kind === 'unreadable' && readNetwork(200, net({ mode: 'everywhere' })).kind === 'unreadable', 'who: any other failure, a body missing keys, or an unknown mode is "couldn\'t read this setting", not a guess')
const mac = view(readNetwork(N.get_this_mac.status, N.get_this_mac.json))
assert(!!mac && !mac.on && mac.canChange && mac.why === null && !mac.restartNeeded && mac.line === 'Only this Mac can use Prometheus.' && mac.notes.length === 0, 'this_mac (recorded): off, "Only this Mac can use Prometheus.", and the this_mac_only reason is not repeated as a note', JSON.stringify(mac))
const home = shown({ mode: 'home_network', bind: '0.0.0.0', advertising: true, advertising_reason: null, tls: { enabled: true, spki_sha256: 'ab'.repeat(32) } })
assert(!!home && home.on && home.line === 'Beacon on your other computers can find this Prometheus and ask to connect. You approve each one.' && home.notes.length === 0, 'home_network, advertising: on, and the line says other computers ask and you approve', JSON.stringify(home))
const open = shown({ mode: 'open', bind: '0.0.0.0', advertising_reason: { code: 'not_home_network', message: 'x' }, warnings: [{ code: 'listening_on_all_interfaces', message: 'x' }] })
assert(!!open && !open.on && open.line === 'Prometheus can already be reached from other computers, without the home-network protections. Turn this on to use them.' && JSON.stringify(open.notes) === JSON.stringify(['Prometheus listens on every network this Mac is on.']), 'open: off, said plainly (reachable without the protections), with its warning in Beacon\'s words', JSON.stringify(open))
const pending = view(readNetwork(N.get_pending.status, N.get_pending.json))
assert(!!pending && pending.on && pending.restartNeeded && pending.line === 'Restart Prometheus to finish.' && pending.notes.length === 0, 'a saved change waiting for a restart (recorded: running this_mac, pending_mode home_network): the switch shows the SAVED choice, "Restart Prometheus to finish.", and restart_required is not said twice', JSON.stringify(pending))
const warned = shown({ mode: 'home_network', advertising: true, advertising_reason: null, warnings: [{ code: 'plain_http_on_lan', message: 'x' }, { code: 'home_network_on_loopback', message: 'x' }] })
assert(JSON.stringify(warned?.notes) === JSON.stringify(['Messages to Prometheus travel unencrypted on your home network.', 'Prometheus is set to share, but it only listens on this Mac.']), 'warnings: each known code in Beacon\'s own words, in order', JSON.stringify(warned?.notes))
const unknown = shown({ mode: 'open', warnings: [{ code: 'home_network_unavailable', message: 'x' }, { code: 'something_new', message: 'The daemon says something new.' }] })
assert(JSON.stringify(unknown?.notes) === JSON.stringify(["Prometheus can't share safely on your network yet, so it isn't announcing itself.", 'The daemon says something new.']), 'warnings: a code Beacon does not know shows the daemon\'s message, never nothing', JSON.stringify(unknown?.notes))
const protoNames = shown({ mode: 'open', warnings: [{ code: 'constructor', message: 'Daemon says constructor.' }, { code: 'toString', message: 'Daemon says toString.' }] })
assert(JSON.stringify(protoNames?.notes) === JSON.stringify(['Daemon says constructor.', 'Daemon says toString.']), 'warnings: a code that names something every JS object has (constructor, toString) is still a code Beacon does not know', JSON.stringify(protoNames?.notes))
const reasons = ['no_usable_address', 'library_missing', 'registration_failed', 'stopped'].map((code) => shown({ mode: 'home_network', advertising: false, advertising_reason: { code, message: `daemon: ${code}` } })?.notes ?? [])
assert(
  JSON.stringify(reasons) ===
    JSON.stringify([["This Mac isn't on a home network right now, so other computers can't find it."], ["Prometheus can't announce itself on this network (it's missing a part). Other computers can still connect by address."], ["Prometheus couldn't announce itself; it will keep trying."], ['daemon: stopped']]),
  'advertising: why a home-network Prometheus is not announcing itself, in Beacon\'s words, or the daemon\'s message for any other reason',
  JSON.stringify(reasons)
)
const pinned = ['flag', 'env', 'caller'].map((source) => shown({ can_change: false, bind_source: source }))
assert(
  pinned.every((p) => !!p && !p.canChange) &&
    JSON.stringify(pinned.map((p) => p?.why)) ===
      JSON.stringify(['Prometheus was started in a way that keeps it on this Mac.', "Prometheus's address is set where it starts, so it can't be changed here.", 'Prometheus was set up to stay on the address Beacon first reached it on.']),
  'can_change false: no switch, and why, by bind_source (the Mac app\'s launcher is "flag")',
  JSON.stringify(pinned.map((p) => p?.why))
)

// ── changing it ───────────────────────────────────────────────────────────────────────────────────────────────────────────
assert(JSON.stringify(putBody(true)) === '{"mode":"home_network"}' && JSON.stringify(putBody(false)) === '{"mode":"this_mac"}', 'put: on is home_network, off is this_mac, and nothing else is ever in the body ("open" is not a choice)')
const saved = readPut(N.put_home_network.status, N.put_home_network.json)
const live = readPut(N.put_this_mac_back.status, N.put_this_mac_back.json)
assert(saved.kind === 'saved' && saved.restartNeeded && live.kind === 'saved' && !live.restartNeeded, 'put (recorded): home_network is 200 on_restart, saved and waiting for a restart; this_mac back before any restart is 200 live, nothing more')
const refused = (status: number, body: unknown): string => {
  const r = readPut(status, body)
  return r.kind === 'refused' ? r.message : `(${r.kind})`
}
assert(
  refused(409, { error: 'tls_unavailable' }) === 'Prometheus needs an update before it can share safely on your network.' &&
    refused(409, { error: 'would_lock_out' }) === 'Turn this off from the Mac running Prometheus: doing it from here would disconnect this computer.' &&
    refused(409, { error: 'no_config_file' }) === "Prometheus wasn't started from a settings file, so this can't be saved here." &&
    refused(500, { error: 'persist_failed' }) === "Prometheus couldn't save this. Nothing changed." &&
    refused(409, { error: 'bind_overridden', source: 'flag' }) === 'Prometheus was started in a way that keeps it on this Mac.',
  'put: every refusal in #700\'s source (network_routes.py), in Beacon\'s words',
  [refused(409, { error: 'tls_unavailable' }), refused(409, { error: 'would_lock_out' })].join(' | ')
)
assert(
  [refused(N.put_open.status, N.put_open.json), refused(N.put_extra_key.status, N.put_extra_key.json), refused(N.put_scoped_device.status, N.put_scoped_device.json), refused(418, null), refused(409, { error: 'brand_new' })].every((m) => m === PUT_FAILED),
  'put: anything else, including the recorded 400 invalid_request and 403 operator_only, is "Beacon couldn\'t change this setting.", never "saved"'
)
const R = wire.restart
assert(
  readRestart(R.operator.status, R.operator.json) === 'restarting' &&
    readRestart(N.restart_without_route.status, N.restart_without_route.json) === 'unavailable' &&
    readRestart(503, { error: 'restart_unavailable', detail: 'x' }) === 'unavailable' &&
    readRestart(404, null) === 'unavailable' &&
    [R.with_origin, R.scoped_device, R.no_token].every((a) => readRestart(a.status, a.json) === 'failed') &&
    readRestart(202, null) === 'failed',
  'restart answers: the recorded 202 {"restarting":true} restarts; the recorded 405 from a Prometheus without the route, #724\'s 503 restart_unavailable, and 404 are "restart it yourself"; the recorded 400/403/401 are failures',
  JSON.stringify([R.operator.status, N.restart_without_route.status])
)

// ── the main-process half, with a fake Prometheus that answers with the recorded bodies ───────────────────────────────────────
const BASE = 'http://127.0.0.1:55201'
const TOKEN = 'OWNER-TOKEN'
const FP = '3a7f18cbd818fce7'
interface Fake {
  log: string[]
  /** What GET /api/network answers now; PUT moves it the way the real daemon did. */
  state: 'this_mac' | 'pending' | 'back'
  restart: { status: number; json: unknown }
  /** After the restart is asked: polls the OLD process still answers, then polls nothing answers (null: never again). */
  oldAnswers: number
  goneFor: number | null
  helloFp: string
  token: string | null
  /** Nothing answers hello even before the restart; GET /api/network goes unanswered. */
  silentBefore: boolean
  getUnreachable: boolean | 'wrong-key'
  /** The fake clock (ms), advanced only by the setting's own sleeps. */
  t: number
}
const GET_FOR: Record<Fake['state'], { status: number; json: unknown }> = { this_mac: N.get_this_mac, pending: N.get_pending, back: N.get_after_back }
function setting(f: Fake): NetworkSetting {
  let asked = false
  let polls = 0
  const request = async (r: HttpRequest): Promise<HttpResult> => {
    const path = new URL(r.url).pathname
    const auth = (r.headers?.authorization ?? '') === `Bearer ${TOKEN}`
    f.log.push(`${r.method} ${path}${auth ? ' bearer' : ''}${r.body ? ` ${r.body}` : ''}`)
    if (path === '/api/network' && r.method === 'GET' && f.getUnreachable) return f.getUnreachable === 'wrong-key' ? 'wrong-key' : 'unreachable'
    if (path === '/api/network' && r.method === 'GET') return auth ? { ...GET_FOR[f.state], retryAfter: null } : { ...N.get_no_token, retryAfter: null }
    if (path === '/api/network' && r.method === 'PUT') {
      if (!auth) return { ...N.get_no_token, retryAfter: null }
      const mode = JSON.parse(r.body ?? '{}').mode
      if (mode === 'home_network') {
        f.state = 'pending'
        return { ...N.put_home_network, retryAfter: null }
      }
      f.state = 'back'
      return { ...N.put_this_mac_back, retryAfter: null }
    }
    if (path === '/api/restart' && r.method === 'POST') {
      if (!auth) return { ...R.no_token, retryAfter: null }
      asked = f.restart.status === 202
      return { ...f.restart, retryAfter: null }
    }
    if (path === '/api/hello') {
      const hello = (fp: string): HttpResult => ({ status: 200, json: { v: '0.9.7', name: 'Mac mini', agent: 'Prometheus', fp, pair: 'approve', tls: false }, retryAfter: null })
      if (!asked) return f.silentBefore ? 'unreachable' : hello(FP)
      polls++
      if (polls <= f.oldAnswers) return hello(FP)
      if (f.goneFor === null || polls <= f.oldAnswers + f.goneFor) return 'unreachable'
      return hello(f.helloFp)
    }
    return { status: 404, json: null, retryAfter: null }
  }
  return new NetworkSetting({ base: () => BASE, token: () => f.token, request, now: () => f.t, sleep: async (ms) => void (f.t += ms) })
}
const fake = (o: Partial<Fake> = {}): Fake => ({ log: [], state: 'this_mac', restart: R.operator, oldAnswers: 0, goneFor: 2, helloFp: FP, token: TOKEN, silentBefore: false, getUnreachable: false, t: 0, ...o })
const hellos = (f: Fake): number => f.log.filter((l) => l.startsWith('GET /api/hello')).length

async function main(): Promise<void> {
  const f0 = fake({ token: null })
  const r0 = await setting(f0).read()
  assert(r0.kind === 'hidden' && f0.log.length === 0, 'main: no credential for this Prometheus is no section, and nothing is asked', JSON.stringify(f0.log))
  const f1 = fake()
  const r1 = await setting(f1).read()
  assert(r1.kind === 'shown' && !r1.view.on && JSON.stringify(f1.log) === JSON.stringify(['GET /api/network bearer']), 'main: reading asks GET /api/network once, with the credential Beacon holds', JSON.stringify(f1.log))
  const f1b = fake({ getUnreachable: true })
  const r1b = await setting(f1b).read()
  assert(r1b.kind === 'unreadable', 'main: Prometheus not answering is "couldn\'t read this setting", not no section', JSON.stringify(r1b))
  const r1c = await setting(fake({ getUnreachable: 'wrong-key' })).read()
  assert(r1c.kind === 'unreadable' && /another key/.test(r1c.detail) && !/too big/.test(r1c.detail), 'main: a computer presenting another key than the pinned one is said as that, not as "the answer was too big" (review of PR 244, F5)', JSON.stringify(r1c))
  const f2 = fake()
  const r2 = await setting(f2).set(true)
  assert(
    JSON.stringify(f2.log) === JSON.stringify(['PUT /api/network bearer {"mode":"home_network"}', 'GET /api/network bearer']) && r2.kind === 'shown' && r2.view.on && r2.view.restartNeeded && r2.view.line === 'Restart Prometheus to finish.',
    'main: turning it on PUTs home_network, then reads the setting back with GET: the saved choice, waiting for a restart',
    JSON.stringify({ log: f2.log, r2 })
  )
  const f2b = fake({ state: 'pending' })
  const r2b = await setting(f2b).set(false)
  assert(r2b.kind === 'shown' && !r2b.view.on && !r2b.view.restartNeeded && f2b.log[0] === 'PUT /api/network bearer {"mode":"this_mac"}', 'main: turning it back off before any restart is live again (recorded), nothing to restart', JSON.stringify({ log: f2b.log, r2b }))
  const f3 = fake()
  const back = await setting(f3).restart()
  assert(
    back.kind === 'back' && back.read.kind === 'shown' && f3.log[0] === 'GET /api/hello' && f3.log[1] === 'POST /api/restart bearer' && hellos(f3) === 4 && f3.log[f3.log.length - 1] === 'GET /api/network bearer',
    'restart: hello first (no credential) for the fp, then the route, then Prometheus waited for (gone twice, then back as the same fp), and the setting read again',
    JSON.stringify(f3.log)
  )
  const f3b = fake({ oldAnswers: 2 })
  const late = await setting(f3b).restart()
  assert(late.kind === 'back' && hellos(f3b) === 6, 'restart: the old process still answering after the 202 is not "back": Beacon waits for it to go away first', JSON.stringify(f3b.log))
  const f4 = fake({ restart: N.restart_without_route })
  const none = await setting(f4).restart()
  const f4b = fake({ restart: { status: 503, json: { error: 'restart_unavailable', detail: 'x' } } })
  const none503 = await setting(f4b).restart()
  assert(none.kind === 'unavailable' && none503.kind === 'unavailable' && hellos(f4) === 1 && hellos(f4b) === 1, 'restart: a Prometheus without the route (recorded 405) or that cannot restart itself (503) is "restart it yourself", and nothing is waited for', JSON.stringify(f4.log))
  const f5 = fake({ goneFor: null })
  const gone = await setting(f5).restart()
  const f5b = fake({ goneFor: 200 }) // 50 s of 250 ms polls
  const slow = await setting(f5b).restart()
  assert(gone.kind === 'not-back' && f5.t >= 60_000 && f5.t < 61_000 && slow.kind === 'back', 'restart: Beacon waits the whole 60 s (back after 50 s is back), and not answering by then is "Prometheus didn\'t come back"', JSON.stringify({ gone, t: f5.t, slow: slow.kind }))
  const f5c = fake({ silentBefore: true })
  const silent = await setting(f5c).restart()
  assert(silent.kind === 'failed' && !f5c.log.some((l) => l.startsWith('POST')), 'restart: a Prometheus that does not answer hello now is not asked to restart (there is no fp to wait for)', JSON.stringify(f5c.log))
  const f5d = fake()
  const one = setting(f5d)
  const [x, y] = await Promise.all([one.restart(), one.restart()])
  assert(x.kind === 'back' && y.kind === 'back' && f5d.log.filter((l) => l.startsWith('POST /api/restart')).length === 1, 'restart: two [Restart now]s at once ask Prometheus once, and both get the answer', JSON.stringify(f5d.log.filter((l) => l.startsWith('POST'))))
  const f6 = fake({ helloFp: 'ffffffffffffffff' })
  const other = await setting(f6).restart()
  assert(other.kind === 'someone-else' && !f6.log.slice(1).some((l) => l.startsWith('GET /api/network')), 'restart: something answering afterwards with another fingerprint is not this Prometheus, and is not asked for the setting', JSON.stringify(f6.log))
  const f7 = fake({ restart: R.scoped_device })
  const no = await setting(f7).restart()
  assert(no.kind === 'failed' && hellos(f7) === 1, 'restart: a refusal (recorded 403 operator_only) is "Beacon couldn\'t restart Prometheus", and nothing is waited for', JSON.stringify(f7.log))
}

main()
  .catch((e) => assert(false, 'the smoke ran to the end', String((e as Error)?.stack ?? e)))
  .finally(() => setTimeout(() => process.exit(failures > 0 || checks !== EXPECTED ? 1 : 0), 20))
