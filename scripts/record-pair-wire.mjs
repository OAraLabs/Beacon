#!/usr/bin/env node
// record-pair-wire — what a REAL Prometheus answers the computer that asks to join it, into src/main/fixtures/pairing_wire_698.json,
// so smoke:request-join holds Beacon's requester side to the daemon's own answers and not to a second reading of the contract
// (docs/PAIRING-APPROVAL-API.md on Prometheus, from #697/#698).
//
//   export BEACON_REAL_DAEMON_SRC=<prometheus clone>/src BEACON_REAL_DAEMON_PY=<a python with its dependencies>
//   node scripts/record-pair-wire.mjs            (about 6 min: one approval waits out the daemon's 300 s delivery window)
//
// The daemons are scripts/lib/serve_real_daemon.py on 127.0.0.1 ephemeral ports, all over ONE scratch home (one instance key, so
// one fingerprint, as one computer would have), in turn: setup mode, no API token, pairing switched off, the daemon's own pairing
// limits, the probes' generous limits, and a 60 s TTL. The configured daemons run no WebSocket bridge and only STATE ws_port 8010
// (the port an approval names, as a default daemon's does): nothing listens on it, so a daemon running on this Mac is untouched.
// Separate sources for the limits come from X-Forwarded-For, which the helper's uvicorn honours from loopback (the real daemon may
// not; the source only matters to the limits, not to what a requester is told).
//
// The requester of R1 uses the contract vectors' key (pairing_seal_v1.json), so production code can unseal the recorded answer;
// expected_unseal is what Python's `cryptography` (an implementation independent of Beacon's) gets from that answer. Every exchange
// is checked against what it is meant to show before anything is written: a scenario that did not happen is a failure, never a
// recording. The scratch home, tokens and devices are deleted at the end.
import { execFileSync } from 'node:child_process'
import { generateKeyPairSync } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { realDaemonConfigured, startRealDaemon } from './lib/real-daemon.mjs'

if (!realDaemonConfigured()) {
  console.log('[record] SKIPPED: set BEACON_REAL_DAEMON_SRC and BEACON_REAL_DAEMON_PY')
  process.exit(3)
}
const OUT = fileURLToPath(new URL('../src/main/fixtures/pairing_wire_698.json', import.meta.url))
const V = JSON.parse(readFileSync(fileURLToPath(new URL('../src/main/fixtures/pairing_seal_v1.json', import.meta.url)), 'utf8'))
const NAME = JSON.parse(V.plaintext).name // the contract's example device name, so the recorded answer unseals to the vectors' name
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const GAP = 1100 // the daemon serves one poll per request per second

/** One HTTP exchange, over node:http (fetch may not set Host). Returns what is recorded. */
function call(port, method, path, { body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body))
    const req = httpRequest({ host: '127.0.0.1', port, method, path, headers: { ...(data ? { 'content-type': 'application/json', 'content-length': data.length } : {}), ...headers } }, (res) => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', (c) => (text += c))
      res.on('end', () => {
        let json = null
        try { json = text ? JSON.parse(text) : null } catch { json = text }
        resolve({ request: { method, path, body: body ?? null }, response: { status: res.statusCode, retry_after: res.headers['retry-after'] ?? null, body: json } })
      })
    })
    req.on('error', reject)
    req.end(data ?? undefined)
  })
}
const key = () => generateKeyPairSync('x25519').publicKey.export({ format: 'jwk' }).x
const exchanges = new Map()
const problems = []
/** Record one exchange under `name`, and check it shows what it is meant to (`expect(response)` is true). */
function keep(name, ex, expect, why) {
  if (exchanges.has(name)) throw new Error(`recorded twice: ${name}`)
  exchanges.set(name, { name, ...ex })
  if (!expect(ex.response)) problems.push(`${name}: expected ${why}, got ${ex.response.status} ${JSON.stringify(ex.response.body).slice(0, 200)}`)
  return ex
}
const is = (status, test = () => true) => (r) => r.status === status && test(r.body ?? {})
const create = (port, device_name, { platform = 'macos', publicKey = key(), xff } = {}) =>
  call(port, 'POST', '/api/pair/requests', { body: { device_name, platform, public_key: publicKey }, headers: xff ? { 'x-forwarded-for': xff } : {} })
const poll = (port, id, secret, headers = {}) => call(port, 'GET', `/api/pair/requests/${id}`, { headers: { 'x-pairing-secret': secret, ...headers } })
const finish = (port, id, secret) => call(port, 'DELETE', `/api/pair/requests/${id}`, { headers: { 'x-pairing-secret': secret } })
const created = (ex) => ex.response.body

const common = { name: 'Wire Test Prometheus', ws: false, wsPort: 8010 }
let home = null
const daemons = []
const start = async (o) => {
  const d = await startRealDaemon({ ...common, ...o, ...(home ? { home } : {}) })
  home ??= d.home
  daemons.push(d)
  return d
}
let module = null
try {
  // ── setup mode, no API token, pairing switched off: hello and a request, refused ───────────────────────────────────────────
  const setup = await start({ setupMode: true, name: 'Setup Mode Test Mac' })
  module = setup.module
  keep('setup_hello', await call(setup.port, 'GET', '/api/hello'), is(200, (b) => b.pair === 'code'), 'pair=code')
  keep('setup_create', await create(setup.port, 'x', { platform: 'ios' }), is(403, (b) => b.error === 'pairing_unavailable'), '403 pairing_unavailable')
  keep('setup_poll', await poll(setup.port, 'a'.repeat(32), 'x'), is(403, (b) => b.error === 'setup_mode'), '403 setup_mode')
  setup.stop()
  const noauth = await start({ auth: false })
  keep('noauth_hello', await call(noauth.port, 'GET', '/api/hello'), is(200, (b) => b.pair === 'none'), 'pair=none')
  keep('noauth_create', await create(noauth.port, 'x', { platform: 'ios' }), is(403, (b) => b.error === 'pairing_unavailable'), '403 pairing_unavailable')
  noauth.stop()
  const off = await start({ requests: false })
  keep('disabled_hello', await call(off.port, 'GET', '/api/hello'), is(200, (b) => b.pair === 'token'), 'pair=token')
  keep('disabled_create', await create(off.port, 'x', { platform: 'ios' }), is(403, (b) => b.error === 'pairing_unavailable'), '403 pairing_unavailable')
  off.stop()

  // ── the daemon's own limits (3 pending, 1 per source, 10 per source per hour; 5 wrong secrets per source) ─────────────────
  const lim = await start({ daemonLimits: true })
  const left = [] // requests to cancel before the next daemon, so they hold no slot there
  for (let i = 1; i <= 10; i++) {
    const c = await create(lim.port, `hourly ${i}`, { xff: '10.0.0.9' })
    if (c.response.status !== 201) problems.push(`hourly ${i}: expected 201, got ${c.response.status}`)
    else await finish(lim.port, created(c).request_id, created(c).poll_secret)
  }
  keep('limits_hourly_11th_refused', await create(lim.port, 'hourly 11', { xff: '10.0.0.9' }), is(429, (b) => b.reason === 'hourly'), '429 hourly')
  const first = await create(lim.port, 'B first')
  if (first.response.status === 201) left.push(created(first))
  keep('limits_second_same_source_per_source_pending', await create(lim.port, 'B second'), is(429, (b) => b.reason === 'per_source_pending'), '429 per_source_pending')
  for (const xff of ['10.0.0.2', '10.0.0.3']) {
    const c = await create(lim.port, `B ${xff}`, { xff })
    if (c.response.status === 201) left.push(created(c))
    else problems.push(`B ${xff}: expected 201, got ${c.response.status}`)
  }
  keep('limits_fourth_pending_full', await create(lim.port, 'B fourth', { xff: '10.0.0.4' }), is(429, (b) => b.reason === 'pending_full'), '429 pending_full')
  // Five wrong secrets from one source, then: a sixth wrong one is locked out, and the right one is still served.
  const target = left[0]
  for (let i = 1; i <= 5; i++) {
    const w = await poll(lim.port, target.request_id, 'wrong-' + i)
    if (w.response.status !== 404) problems.push(`wrong secret ${i}: expected 404, got ${w.response.status}`)
    await sleep(GAP)
  }
  keep('limits_sixth_poll_wrong_secret_locked_out', await poll(lim.port, target.request_id, 'wrong-6'), is(429, (b) => b.reason === 'bad_secret' && b.retry_after_seconds > 0), '429 bad_secret')
  await sleep(GAP)
  keep('limits_poll_correct_secret_after_lockout', await poll(lim.port, target.request_id, target.poll_secret), is(200, (b) => b.status === 'pending'), '200 pending (the right secret is never refused)')
  for (const c of left) await finish(lim.port, c.request_id, c.poll_secret)
  lim.stop()

  // ── a configured daemon: the main path, the ends, the name rules ────────────────────────────────────────────────────────────
  const d = await start({})
  keep('hello_configured', await call(d.port, 'GET', '/api/hello'), is(200, (b) => b.pair === 'approve' && /^[0-9a-f]{16}$/.test(b.fp)), 'pair=approve')
  keep('hello_post_not_public', await call(d.port, 'POST', '/api/hello'), is(401), '401')
  const r1 = created(keep('create_valid_vector_key', await create(d.port, NAME, { publicKey: V.requester_public_b64url }), is(201, (b) => b.request_id && b.poll_secret && b.match_code), '201'))
  keep('poll_pending', await poll(d.port, r1.request_id, r1.poll_secret), is(200, (b) => b.status === 'pending'), 'pending')
  keep('poll_immediately_again_too_fast', await poll(d.port, r1.request_id, r1.poll_secret), is(429, (b) => b.reason === 'poll_too_fast'), '429 poll_too_fast')
  await sleep(GAP)
  keep('poll_wrong_secret', await poll(d.port, r1.request_id, 'not-the-secret'), is(404, (b) => b.error === 'unknown_request'), '404 unknown_request')
  const ap = await d.owner('POST', `/api/pair/requests/${r1.request_id}/approve`, {})
  if (ap.status !== 200) problems.push(`approve R1: ${ap.status}`)
  await sleep(GAP)
  const approved = keep('poll_R1_approved_vector_key', await poll(d.port, r1.request_id, r1.poll_secret), is(200, (b) => b.status === 'approved' && b.sealed?.ciphertext), 'approved, sealed')
  // R1's answer, unsealed by Python's cryptography with the vectors' private key: what the smoke holds Beacon's unseal to.
  const unsealPy = `
import base64, json, sys
from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey, X25519PublicKey
from cryptography.hazmat.primitives.ciphers.aead import ChaCha20Poly1305
from cryptography.hazmat.primitives.hashes import SHA256
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
a = json.loads(sys.stdin.read())
b = lambda s: base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))
shared = X25519PrivateKey.from_private_bytes(bytes.fromhex(a["priv"])).exchange(X25519PublicKey.from_public_bytes(b(a["sealed"]["ephemeral_public_key"])))
key = HKDF(algorithm=SHA256(), length=32, salt=a["id"].encode(), info=b"prometheus-pair-v1/seal").derive(shared)
print(ChaCha20Poly1305(key).decrypt(b(a["sealed"]["nonce"]), b(a["sealed"]["ciphertext"]), a["id"].encode()).decode())`
  const plain = JSON.parse(execFileSync(process.env.BEACON_REAL_DAEMON_PY, ['-I', '-c', unsealPy], {
    input: JSON.stringify({ priv: V.requester_private_hex, id: r1.request_id, sealed: approved.response.body.sealed }), encoding: 'utf8'
  }))
  if (plain.name !== NAME || plain.device_id !== approved.response.body.device_id) problems.push(`R1 unseals to ${JSON.stringify(plain.name)} / ${plain.device_id}, not ${JSON.stringify(NAME)} / the approved device`)
  const expected_unseal = { request_id: r1.request_id, plaintext: { token: plain.token, device_id: plain.device_id, name: plain.name } }

  const rd = created(await create(d.port, 'Desk to deny'))
  await d.owner('POST', `/api/pair/requests/${rd.request_id}/deny`, {})
  keep('poll_Rd_denied', await poll(d.port, rd.request_id, rd.poll_secret), is(200, (b) => b.status === 'denied'), 'denied')
  const ra = created(await create(d.port, 'Second Mac'))
  await d.owner('POST', `/api/pair/requests/${ra.request_id}/approve`, {})
  const got = await poll(d.port, ra.request_id, ra.poll_secret)
  if (got.response.body?.status !== 'approved') problems.push(`Ra: expected approved, got ${JSON.stringify(got.response.body)}`)
  await finish(d.port, ra.request_id, ra.poll_secret)
  await finish(d.port, ra.request_id, ra.poll_secret)
  await sleep(GAP)
  keep('ra_poll_after_second_delete', await poll(d.port, ra.request_id, ra.poll_secret), is(200, (b) => b.status === 'delivered'), 'delivered')
  keep('create_missing_device_name', await call(d.port, 'POST', '/api/pair/requests', { body: { platform: 'macos', public_key: key() } }), is(400, (b) => (b.fields ?? []).includes('device_name')), '400 device_name')
  keep('create_missing_public_key', await call(d.port, 'POST', '/api/pair/requests', { body: { device_name: NAME, platform: 'macos' } }), is(400, (b) => (b.fields ?? []).includes('public_key')), '400 public_key')
  const re = created(await create(d.port, 'Kitchen iMac'))
  await d.owner('POST', `/api/pair/requests/${re.request_id}/approve`, {})
  keep('poll_Re_approved_host_lan_ip', await poll(d.port, re.request_id, re.poll_secret, { host: '192.168.1.20:8005' }), is(200, (b) => b.status === 'approved' && b.endpoints?.rest === 'http://192.168.1.20:8005'), 'approved, endpoints on the Host it was asked at')

  // The daemon's name rules: each case is recorded with what the daemon decided; the smoke compares Beacon's rule to it.
  const smile = '\u{1F600}'
  const names = [
    ['create_name_with_newline', 'Al\nex', 400], ['create_name_with_tab', 'Mac\tbook', 400], ['create_name_with_rtl_override', 'evil‮gnp.exe', 400],
    ['create_name_65_ascii', 'x'.repeat(65), 400], ['create_name_64cp_with_emoji', smile + 'a'.repeat(63), 201], ['create_name_65cp_with_emoji', smile + 'a'.repeat(64), 400],
    ['create_name_64_emoji', smile.repeat(64), 201], ['create_name_32_emoji', smile.repeat(32), 201], ['create_name_zwj_emoji_family', '\u{1F468}‍\u{1F469}‍\u{1F467}', 400],
    ['create_name_variation_selector', 'Alex ❤️', 201], ['create_name_trailing_newline', 'Padded Name\n', 201], ['create_name_nbsp_inside', 'Al ex', 201],
    ['create_name_curly_apostrophe_accents', 'Alex’s Mac éè ü 日本', 201]
  ]
  // The status column is what #698 decided; a daemon that decides otherwise now is recorded as it is, and said so here.
  for (const [n, value, was] of names) {
    const ex = keep(n, await create(d.port, value), (r) => r.status === 201 || r.status === 400, '201 or 400')
    if (ex.response.status !== was) console.log(`  note: ${n} is now ${ex.response.status} (was ${was})`)
  }
  const cancel = created(exchanges.get('create_name_64cp_with_emoji'))
  if (cancel?.request_id) {
    await finish(d.port, cancel.request_id, cancel.poll_secret)
    keep('poll_after_cancel', await poll(d.port, cancel.request_id, cancel.poll_secret), is(200, (b) => b.status === 'canceled'), 'canceled')
  } else problems.push('poll_after_cancel: the 64-code-point name was not accepted, so there is nothing to cancel')
  d.stop()

  // ── the slow ends: a request nobody answered (the shortest TTL, 60 s), and an approval nobody collected, which the daemon
  //    revokes when its delivery window (300 s, not configurable) closes ─────────────────────────────────────────────────────
  const t = await start({ ttl: 60 })
  const b = created(await create(t.port, 'Approved, never collected'))
  const bApproved = await t.owner('POST', `/api/pair/requests/${b.request_id}/approve`, {})
  const approvedAt = Date.now()
  if (bApproved.status !== 200) problems.push(`approve B: ${bApproved.status}`)
  const a = created(await create(t.port, 'Nobody answered'))
  console.log('  waiting out the 60 s TTL…')
  await sleep(62_000)
  keep('slow_poll_A_after_ttl', await poll(t.port, a.request_id, a.poll_secret), is(200, (x) => x.status === 'expired'), 'expired')
  console.log('  waiting out the 300 s delivery window…')
  await sleep(Math.max(0, approvedAt + 302_000 - Date.now()))
  keep('slow_poll_B_after_revoke', await poll(t.port, b.request_id, b.poll_secret), is(200, (x) => x.status === 'expired'), 'expired (uncollected, revoked)')
  // Revocation is a tombstone (device_store.py): the device stays listed, with revoked_at set.
  const listed = await t.owner('GET', '/api/devices')
  const row = Array.isArray(listed.body) ? listed.body.find((x) => x.id === bApproved.body?.device_id) : undefined
  if (listed.status !== 200 || !row || !row.revoked_at) problems.push(`B's device after the window: list ${listed.status}, row ${JSON.stringify(row)}`)
  t.stop()

  if (problems.length) {
    console.error(`✗ record-pair-wire — ${problems.length} exchange(s) did not show what they are meant to; nothing written:\n  ${problems.join('\n  ')}`)
    process.exitCode = 1
  } else {
    const ORDER = ['hello_configured', 'setup_hello', 'noauth_hello', 'disabled_hello', 'create_valid_vector_key', 'poll_pending', 'poll_immediately_again_too_fast',
      'poll_wrong_secret', 'poll_R1_approved_vector_key', 'poll_Rd_denied', 'poll_after_cancel', 'ra_poll_after_second_delete', 'slow_poll_A_after_ttl',
      'slow_poll_B_after_revoke', 'limits_second_same_source_per_source_pending', 'limits_fourth_pending_full', 'limits_hourly_11th_refused',
      'limits_sixth_poll_wrong_secret_locked_out', 'limits_poll_correct_secret_after_lockout', 'disabled_create', 'noauth_create', 'setup_create', 'setup_poll',
      'create_missing_device_name', 'create_missing_public_key', 'hello_post_not_public', 'poll_Re_approved_host_lan_ip', ...names.map(([n]) => n)]
    if (ORDER.length !== exchanges.size || ORDER.some((n) => !exchanges.has(n))) throw new Error(`recorded ${exchanges.size}, ordered ${ORDER.length}`)
    const head = execFileSync('git', ['-C', process.env.BEACON_REAL_DAEMON_SRC, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim()
    const about = `Real exchanges recorded ${new Date().toISOString().slice(0, 10)} by scripts/record-pair-wire.mjs against the real Prometheus app (${head}) served by uvicorn on ephemeral 127.0.0.1 ports over one temporary home: setup mode, no API token, pairing off, the daemon's own limits, the probes' limits, and a 60 s TTL. Tokens in it belong to those throwaway daemons and are dead. expected_unseal is what Python's cryptography got by unsealing R1's answer with the private key in pairing_seal_v1.json.`
    writeFileSync(OUT, JSON.stringify({ about, expected_unseal, exchanges: ORDER.map((n) => exchanges.get(n)) }, null, 1) + '\n')
    console.log(`✓ record-pair-wire — ${exchanges.size} exchanges from ${module}, each showing what it is meant to → ${OUT}`)
  }
} finally {
  for (const d of daemons) d.stop()
  await sleep(500) // a stopping helper may still write its home (scripts/lib/serve_real_daemon.py exits on stdin EOF)
  if (home) try { rmSync(home, { recursive: true, force: true }) } catch (e) { console.error(`  could not remove the scratch home ${home}: ${e.message}`) }
}
