#!/usr/bin/env node
// onboarding-discovery-probe — can Beacon find a Prometheus without ever connecting to it, IN THE REAL
// APP, over its real IPC, with real Bonjour?
//
// Path B of the v0.4.0 onboarding shows "We found Alex's Mac mini". Anyone on the same Wi-Fi can
// advertise that name, so discovery must be display-only: it may ask a computer who it is (GET
// /api/hello, no credential), and nothing else. This probe holds the engine to that, from the page's
// own `window.beacon.discovery`:
//   * what it finds: this Mac (a loopback probe), the home network (Bonjour), the private network
//     (tailnet peers), merged by fingerprint into one row each;
//   * what it refuses: a hostile hello (extra fields, oversized, not JSON, hanging, wrong status),
//     a typed address that is not an address;
//   * what it never does: send an Authorization header, a cookie, anything but GET /api/hello, or save a
//     connection;
//   * what it reports honestly: Local Network permission denied, the lookup tool missing.
//
// RUN (macOS; not part of verify — it launches the built app):
//   npm run build && npm run probe:onboarding-discovery
//
// SAFE BY CONSTRUCTION:
//   * the "Prometheus" is a stub on an EPHEMERAL port of 127.0.0.1 (BEACON_DISCOVERY_PORT, honoured only
//     by a non-release build), never 8005/8010, so another session's daemon is untouched and this probe
//     never touches it;
//   * Bonjour runs on dns-sd's LOCAL-ONLY interface (-lo) for both the advertiser and Beacon's browse:
//     nothing is sent on the network, no Local Network prompt appears;
//   * BEACON_DISCOVERY_SOURCES is set in EVERY launch, so the real Tailscale CLI is consulted only in the
//     scenario that puts a fake `tailscale` first on PATH (and the probe checks the fake ran);
//   * a fresh empty profile and --use-mock-keychain per launch (app-driver.mjs).
import { existsSync, mkdtempSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchApp, sleep, sql } from './app-driver.mjs'
import { startChecks, waitFor } from './lib/probe-kit.mjs'
import { FP_A, FP_B, advertise, dnssdChildren, helloGets, helloStub, makeFakes, noCreds, stopAdvertisers, stopStub } from './lib/discovery-fixtures.mjs'

const check = startChecks('onboarding-discovery', 40)
for (const k of Object.keys(process.env)) if (k.startsWith('BEACON_GATEWAY')) delete process.env[k]

const WINDOW_MS = 2500
const ORIG_PATH = process.env.PATH
const root = mkdtempSync(join(tmpdir(), 'beacon-discovery-probe-'))
const freshProfile = () => mkdtempSync(join(root, 'profile-'))

// Fixtures: the stub endpoint, the fakes and the advertisers are shared with the path B probe.
const fakes = makeFakes(root)
const bin = fakes.bin
const MARKER = fakes.MARKER

// ── app helpers ─────────────────────────────────────────────────────────────────────────────────
async function launch(env) {
  for (const k of Object.keys(process.env)) if (k.startsWith('BEACON_DISCOVERY')) delete process.env[k]
  process.env.PATH = ORIG_PATH
  Object.assign(process.env, env)
  const profile = freshProfile()
  const app = await launchApp({ profile, readySelector: '.wiz-card, [data-screen], nav[aria-label="Views"]' })
  return { app, profile }
}
/** Start a search from the page, wait for `done` (or `ms`), stop it, and return every update it saw. */
const search = (app, opts, ms = 12000) =>
  app.page.evaluate(`new Promise(async (resolve) => {
    const seen = []
    let off
    try {
      off = window.beacon.discovery.onUpdate((u) => seen.push(u))
      await window.beacon.discovery.start(${JSON.stringify(opts)})
    } catch (e) { return resolve({ error: String(e), seen }) }
    const t0 = Date.now()
    const tick = async () => {
      const last = seen[seen.length - 1]
      if ((last && last.done) || Date.now() - t0 > ${ms}) { await window.beacon.discovery.stop().catch(() => undefined); off(); return resolve({ seen }) }
      setTimeout(tick, 100)
    }
    tick()
  })`)
const last = (r) => r?.seen?.[r.seen.length - 1] ?? null
const rows = (r) => last(r)?.computers ?? []

const stub = await helloStub()
const env = (extra) => ({ BEACON_DISCOVERY_PORT: String(stub.port), BEACON_DISCOVERY_WINDOW_MS: String(WINDOW_MS), ...extra })
let app
try {
  // ── G1: this Mac, over loopback ──────────────────────────────────────────────────────────────
  console.log('\n[probe] === G1: this Mac (loopback hello) ===')
  const g1 = await launch(env({ BEACON_DISCOVERY_SOURCES: 'loopback' }))
  app = g1.app
  check((await app.page.evaluate(`typeof window.beacon.discovery?.start`)) === 'function', 'G1 the bridge offers discovery.start')
  let r = await search(app, { quiet: true })
  check(!r.error && rows(r).length === 1, 'G1 a quiet search finds the one Prometheus on this Mac', r.error ?? `${rows(r).length} rows`)
  const c = rows(r)[0]
  check(c?.name === 'Probe Mac mini' && c?.agent === 'Atlas' && c?.fp === FP_A && c?.version === '0.9.6' && c?.pair === 'approve', 'G1 …with the name, assistant, fingerprint, version and pairing style it served', JSON.stringify(c))
  check(c?.where === 'this-mac' && c?.endpoints?.[0]?.host === '127.0.0.1' && c?.endpoints?.[0]?.port === stub.port, 'G1 …labelled "this Mac", reachable at 127.0.0.1 on the port it answered on', JSON.stringify(c?.endpoints))
  check(last(r)?.done === true && last(r)?.lan === 'off', 'G1 the search says it is done, and that it never touched the network scan (a quiet search)', JSON.stringify({ done: last(r)?.done, lan: last(r)?.lan }))
  check(helloGets(stub).length >= 1 && noCreds(stub), 'G1 it asked with GET /api/hello and sent no Authorization, cookie or key header', `${helloGets(stub).length} requests`)
  check(helloGets(stub).length >= 1 && stub.requests.length === helloGets(stub).length, 'G1 …and asked for nothing else at all', `${stub.requests.length} requests, ${helloGets(stub).length} hello`)

  // ── G1b: a hostile hello ─────────────────────────────────────────────────────────────────────
  console.log('\n[probe] === G1b: a hostile or broken hello ===')
  stub.mode = 'hostile'
  r = await search(app, { quiet: true })
  const h = rows(r)[0]
  check(rows(r).length === 1 && h?.name === 'Evil' && h?.agent === '' && h?.fp === '' && h?.pair === 'unknown' && h?.version === '', 'G1b extra, oversized, malformed and mistyped fields are dropped, not passed on', JSON.stringify(h))
  check(rows(r).length === 1 && !JSON.stringify(last(r)).includes('s3cret') && !('token' in (h ?? {})) && !('extra' in (h ?? {})), 'G1b a field it never asked for ("token") does not reach the page')
  check(rows(r).length === 1 && h?.id === `127.0.0.1:${stub.port}`, 'G1b with no fingerprint the row is identified by where it answered', h?.id)
  for (const mode of ['huge', 'text', 'error']) {
    stub.mode = mode
    const before = helloGets(stub).length
    r = await search(app, { quiet: true })
    check(helloGets(stub).length > before && rows(r).length === 0, `G1b a "${mode}" answer produces no row`, `${helloGets(stub).length - before} requests, ${rows(r).length} rows`)
  }
  stub.mode = 'hang'
  const t0 = Date.now()
  const before = helloGets(stub).length
  r = await search(app, { quiet: true })
  check(helloGets(stub).length > before && rows(r).length === 0 && last(r)?.done === true && Date.now() - t0 < 6000, 'G1b a computer that never answers is given up on in a few seconds, and the search still finishes', `${Date.now() - t0} ms`)
  stub.mode = 'ok'

  // ── G1c: a typed address ─────────────────────────────────────────────────────────────────────
  console.log('\n[probe] === G1c: connect by address (Advanced) ===')
  const probeAddr = (req) => app.page.evaluate(`window.beacon.discovery.probeAddress(${JSON.stringify(req)}).catch((e) => ({ ok: false, reason: 'threw: ' + e }))`)
  let pa = await probeAddr({ host: '127.0.0.1', port: stub.port })
  check(pa.ok === true && pa.computer?.endpoints?.[0]?.port === stub.port && pa.computer?.name === 'Probe Mac mini', 'G1c a typed address that answers becomes a row, on the port that was typed (never silently 8005)', JSON.stringify(pa))
  const dead = await new Promise((res) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)) }) })
  pa = await probeAddr({ host: '127.0.0.1', port: dead })
  check(pa.ok === false && pa.reason === 'unreachable', 'G1c nothing listening there is "unreachable"', JSON.stringify(pa))
  stub.mode = 'text'
  pa = await probeAddr({ host: '127.0.0.1', port: stub.port })
  check(pa.ok === false && pa.reason === 'not-prometheus', 'G1c something that answers but is not a Prometheus says so', JSON.stringify(pa))
  stub.mode = 'ok'
  const bad = []
  for (const req of [{ host: 'a b', port: 8005 }, { host: 'http://x/y', port: 8005 }, { host: '', port: 8005 }, { host: '127.0.0.1', port: 70000 }, { host: '127.0.0.1', port: '8005' }, { host: '127.0.0.1;rm', port: 8005 }])
    bad.push((await probeAddr(req)).reason)
  check(bad.every((x) => x === 'invalid'), 'G1c a space, a scheme, a path, an empty host, an out-of-range or non-numeric port and a shell fragment are all "invalid", asked of nobody', JSON.stringify(bad))
  const stubBefore = stub.requests.length
  await probeAddr({ host: '127.0.0.1', port: stub.port })
  check(stub.requests.length === stubBefore + 1 && noCreds(stub), 'G1c a typed address costs exactly one credential-free request', `${stub.requests.length - stubBefore}`)

  // ── G1d: finding is not connecting ───────────────────────────────────────────────────────────
  console.log('\n[probe] === G1d: finding it never connects ===')
  const st = await app.page.evaluate(`window.beacon.setup.status()`)
  await app.quit()
  check(c?.fp === FP_A && st?.needsSetup === true, 'G1d after finding it, and everything else,, this Mac is still not connected to anything', JSON.stringify(st))
  check(c?.fp === FP_A && sql(g1.profile, 'SELECT count(*) FROM gateway_profiles') === '0' && !existsSync(join(g1.profile, 'api-credential.bin')), 'G1d …no address saved, no credential stored')

  // ── G2: Bonjour, real, on the local-only interface ───────────────────────────────────────────
  console.log('\n[probe] === G2: the home network (Bonjour) ===')
  advertise(['-R', 'Probe Mac', '_prometheus._tcp', 'local', String(stub.port), 'v=0.9.6', 'name=Probe Mac mini', 'agent=Atlas', `fp=${FP_A}`, 'pair=approve'])
  // Discovery confirms every record with hello before showing it (docs/MULTI-COMPUTER-v0.4.md §4): each advertised computer has a
  // live hello behind it, and one whose computer is gone does not.
  const deadSrv = createServer()
  await new Promise((r) => deadSrv.listen(0, '127.0.0.1', r))
  const deadPort = deadSrv.address().port
  await new Promise((r) => deadSrv.close(r))
  const officeStub = await helloStub()
  officeStub.hello = { v: '0.9.6', name: 'Probe Office', agent: 'Zed', fp: FP_B, pair: 'code' }
  advertise(['-P', 'Probe Office', '_prometheus._tcp', 'local', String(officeStub.port), 'probe-office.local', '127.0.0.1', 'v=0.9.6', 'name=Probe Office', 'agent=Zed', `fp=${FP_B}`, 'pair=code'])
  advertise(['-R', 'Probe Gone', '_prometheus._tcp', 'local', String(deadPort), 'v=0.9.6', 'name=Probe Gone', 'agent=Nova', 'fp=0000000000000009', 'pair=approve'])
  await sleep(1500)
  const reqsBefore = stub.requests.length
  const g2 = await launch(env({ BEACON_DISCOVERY_SOURCES: 'bonjour', BEACON_DISCOVERY_BONJOUR_FLAGS: '-lo' }))
  app = g2.app
  const noArg = await search(app, undefined)
  check(last(noArg)?.done === true && last(noArg)?.lan === 'off' && rows(noArg).length === 0 && (await dnssdChildren()) === 0, 'G2 start() with no argument is the QUIET search: the network scan is not run, and no lookup process is started', JSON.stringify({ lan: last(noArg)?.lan, rows: rows(noArg).length }))
  r = await search(app, { quiet: false })
  const byName = (n) => rows(r).find((x) => x.name === n)
  check(rows(r).length === 2 && !!byName('Probe Mac mini') && !!byName('Probe Office'), 'G2 a full search finds both advertised computers by name', JSON.stringify(rows(r).map((x) => x.name)))
  check(byName('Probe Office')?.where === 'home-network' && byName('Probe Office')?.agent === 'Zed' && byName('Probe Office')?.fp === FP_B && byName('Probe Office')?.pair === 'code', 'G2 a computer at another address is "on your home network", with its assistant, fingerprint and pairing style from its record', JSON.stringify(byName('Probe Office')))
  check(byName('Probe Office')?.endpoints?.[0]?.host === 'probe-office.local' && byName('Probe Office')?.endpoints?.[0]?.port === officeStub.port, 'G2 …and the address it asked to be reached at', JSON.stringify(byName('Probe Office')?.endpoints))
  check(byName('Probe Mac mini')?.where === 'this-mac', 'G2 a Bonjour entry that points at this very Mac is "this Mac"', byName('Probe Mac mini')?.where)
  check(last(r)?.lan === 'ok' && last(r)?.done === true, 'G2 the network scan reports it worked', JSON.stringify({ lan: last(r)?.lan, done: last(r)?.done }))
  check(rows(r).length === 2 && !byName('Probe Gone'), 'G2 a record whose computer is gone is not shown: every row was confirmed with hello first', JSON.stringify(rows(r).map((x) => x.name)))
  check(helloGets(stub).length - reqsBefore === 1 && helloGets(officeStub).length === 1 && stub.requests.length - reqsBefore === 1 && officeStub.requests.length === 1 && noCreds(stub) && noCreds(officeStub), 'G2 reading Bonjour asked each computer one thing, once: GET /api/hello, with no credential', `${stub.requests.length - reqsBefore} and ${officeStub.requests.length} requests`)
  // stop() really stops: start, see a child, stop, see none
  await app.page.evaluate(`window.beacon.discovery.start({ quiet: false })`)
  const running = await waitFor(dnssdChildren, (n) => n >= 1, 4000)
  await app.page.evaluate(`window.beacon.discovery.stop()`)
  const gone = await waitFor(dnssdChildren, (n) => n === 0, 4000)
  check(running >= 1 && gone === 0, 'G2 a running search owns a lookup process, and stop() ends it', `${running} then ${gone}`)
  await app.quit()

  // ── G2b: the same computer seen two ways is one row ──────────────────────────────────────────
  console.log('\n[probe] === G2b: merged by fingerprint ===')
  const g2b = await launch(env({ BEACON_DISCOVERY_SOURCES: 'loopback,bonjour', BEACON_DISCOVERY_BONJOUR_FLAGS: '-lo' }))
  app = g2b.app
  r = await search(app, { quiet: false })
  const mac = rows(r).filter((x) => x.fp === FP_A)
  check(rows(r).length === 2 && mac.length === 1, 'G2b answering on loopback AND advertising on Bonjour is ONE row, not two', `${rows(r).length} rows, ${mac.length} with that fingerprint`)
  check(mac[0]?.where === 'this-mac' && mac[0]?.endpoints?.length >= 2 && mac[0].endpoints.some((e) => e.host === '127.0.0.1') && mac[0].endpoints.some((e) => e.host === 'localhost'), 'G2b …"this Mac", keeping both ways to reach it', JSON.stringify(mac[0]?.endpoints))
  await app.quit()
  await stopStub(officeStub)

  // ── G3: the private network (tailnet) ────────────────────────────────────────────────────────
  console.log('\n[probe] === G3: tailnet peers ===')
  const before3 = helloGets(stub).length
  const g3 = await launch(env({ BEACON_DISCOVERY_SOURCES: 'tailnet', PATH: `${bin}:${process.env.PATH}` }))
  app = g3.app
  r = await search(app, { quiet: false })
  check(existsSync(MARKER), 'G3 the fake tailscale was the one that ran (so the real one, and the real tailnet, were not consulted)')
  check(rows(r).length === 1 && rows(r)[0]?.where === 'private-network' && rows(r)[0]?.fp === FP_A, 'G3 an online desktop peer that answers is "on your private network"', JSON.stringify(rows(r).map((x) => [x.name, x.where])))
  check(helloGets(stub).length - before3 === 1 && noCreds(stub), 'G3 offline peers and phones are not asked; the one online desktop is asked once, with no credential', `${helloGets(stub).length - before3} requests`)
  const quietRun = await search(app, { quiet: true })
  check(rows(r).length === 1 && rows(quietRun).length === 0 && last(quietRun)?.done === true, 'G3 a quiet search never reads the tailnet (the full one just did)', `${rows(quietRun).length} rows`)
  await app.quit()

  // ── G4: Local Network permission denied; G5: the lookup tool missing ─────────────────────────
  console.log('\n[probe] === G4/G5: honest reports ===')
  const g4 = await launch(env({ BEACON_DISCOVERY_SOURCES: 'loopback,bonjour', BEACON_DISCOVERY_DNSSD: join(bin, 'dns-sd-denied') }))
  app = g4.app
  r = await search(app, { quiet: false })
  check(last(r)?.lan === 'denied', 'G4 a refusal from macOS ("PolicyDenied", -65570) is reported as "denied"', last(r)?.lan)
  check(rows(r).some((x) => x.where === 'this-mac') && last(r)?.done === true, 'G4 …while the other sources still answer and the search still finishes')
  await app.quit()
  const g5 = await launch(env({ BEACON_DISCOVERY_SOURCES: 'loopback,bonjour', BEACON_DISCOVERY_DNSSD: join(root, 'no-such-tool') }))
  app = g5.app
  r = await search(app, { quiet: false })
  check(last(r)?.lan === 'unavailable', 'G5 a lookup tool that cannot be run is "unavailable", never mistaken for a permission refusal', last(r)?.lan)
  check(rows(r).some((x) => x.where === 'this-mac'), 'G5 …and this Mac is still found')
  await app.quit()
} catch (e) {
  check(false, 'probe ran to completion', e?.stack ?? String(e))
} finally {
  await app?.quit().catch(() => undefined)
  await stopStub(stub)
  stopAdvertisers()
  console.log('\n[probe] profiles left in tmp for inspection (fresh, probe-only).')
}
