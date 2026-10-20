/**
 * Request-to-join smoke (headless / ELECTRON_RUN_AS_NODE) — v0.4.0 onboarding, O3: the requesting device's half of
 * joining a Prometheus that already has an owner (docs/PAIRING-APPROVAL-API.md on Prometheus #697/#698).
 *
 * The cryptography is checked against the contract's OWN test vectors (src/main/fixtures/pairing_seal_v1.json, copied
 * byte for byte from Prometheus #698 at e99053f, where they were produced by a separate implementation written from the
 * recipe): the match code, the X25519 shared secret, the HKDF key and the ChaCha20-Poly1305 unsealing, to the byte.
 */
import { chacha20poly1305 } from '@noble/ciphers/chacha.js'
import { createPrivateKey, createPublicKey, randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { readFileSync } from 'node:fs'
import { approveHereCommand, checkJoinRequest, cleanDeviceName, clockText, joinActions, JOIN_FAILURE_KINDS, parseCreated, parsePoll, platformFor, portsFromEndpoints, waitingOffersOtherWay, waitPhrase } from '@shared/join'
import { COPY } from '@shared/onboarding-strings'
import { helloFrom } from '@shared/discovery'
import { requestSmall } from './pairing/http'
import { JoinSession, type JoinDeps, type JoinTarget, type SavedConnection } from './pairing/session'
import { decodeB64url, matchCode, newRequesterKeys, privateKeyFromRaw, sealKey, sharedSecret, unseal, type Sealed } from './pairing/seal'

let failures = 0
let checks = 0
function assert(cond: boolean, label: string, detail?: string): void {
  checks++
  console.log(`[request-join-smoke] ${cond ? 'PASS' : 'FAIL'}  ${label}${!cond && detail ? `  — ${detail}` : ''}`)
  if (!cond) failures++
}
const EXPECTED = 81

interface Vectors {
  request_id: string
  requester_private_hex: string
  requester_public_hex: string
  requester_public_b64url: string
  instance_public_key_der_hex: string
  match_code: string
  ephemeral_private_hex: string
  ephemeral_public_hex: string
  nonce_hex: string
  shared_secret_hex: string
  derived_key_hex: string
  plaintext: string
  sealed: Sealed
}
const V = JSON.parse(readFileSync('src/main/fixtures/pairing_seal_v1.json', 'utf8')) as Vectors
const hex = (s: string): Buffer => Buffer.from(s, 'hex')
const tryRun = <T>(f: () => T): T | 'threw' => {
  try {
    return f()
  } catch {
    return 'threw'
  }
}

// ── the match code, the shared secret, the key, the unsealing: each to the byte ─────────────────────
assert(tryRun(() => matchCode(hex(V.requester_public_hex), hex(V.instance_public_key_der_hex), V.request_id)) === V.match_code, `vectors: the match code is ${V.match_code}`)
// The line is pasted into a shell by a person: it is built only from an id and a code that are exactly what the contract allows,
// so nothing the computer sent can add a word to it.
const hostileIds = ['9e0a425697cf9c55ba563610836138f0; rm -rf ~', '$(curl evil)', '9E0A425697CF9C55BA563610836138F0', '9e0a4256', '9e0a425697cf9c55ba563610836138f0\n', '']
const hostileCodes = ['1438; id', '143', '14380', '$(id)', '']
assert(
  approveHereCommand('9e0a425697cf9c55ba563610836138f0', '1438') === 'oara pair approve 9e0a4256 --code 1438' &&
    hostileIds.every((id) => approveHereCommand(id, '1438') === null) && hostileCodes.every((c) => approveHereCommand('9e0a425697cf9c55ba563610836138f0', c) === null),
  'say yes here: oara pair approve <8 of the id> --code <4 digits>, and no line at all from an id or a code the contract does not allow (a person pastes it into a shell)',
  JSON.stringify([approveHereCommand('9e0a425697cf9c55ba563610836138f0', '1438'), ...hostileIds.map((id) => approveHereCommand(id, '1438'))])
)
const priv = tryRun(() => privateKeyFromRaw(hex(V.requester_private_hex)))
const shared = priv === 'threw' ? 'threw' : tryRun(() => sharedSecret(priv, hex(V.ephemeral_public_hex)))
assert(shared !== 'threw' && shared.toString('hex') === V.shared_secret_hex, 'vectors: the X25519 shared secret is the vector\'s, byte for byte')
const key = shared === 'threw' ? 'threw' : tryRun(() => sealKey(shared, V.request_id))
assert(key !== 'threw' && key.toString('hex') === V.derived_key_hex, 'vectors: the HKDF-SHA256 key (salt = the request id, info = prometheus-pair-v1/seal) is the vector\'s, byte for byte')
const plain = JSON.parse(V.plaintext) as { token: string; device_id: string; name: string }
const opened = priv === 'threw' ? 'threw' : tryRun(() => unseal(V.sealed, priv, V.request_id))
assert(opened !== 'threw' && opened !== null && opened.token === plain.token && opened.deviceId === plain.device_id && opened.name === plain.name, 'vectors: unsealing the vector\'s sealed blob gives its token, device id and name')

// ── nothing else unseals ──────────────────────────────────────────────────────────────────────────
const flip = (s: string): string => {
  const b = Buffer.from(s, 'base64url')
  b[b.length - 1] ^= 1
  return b.toString('base64url')
}
const otherId = V.request_id.replace(/.$/, V.request_id.endsWith('0') ? '1' : '0')
const bad = (sealed: unknown, requestId = V.request_id, k = priv): unknown => (k === 'threw' ? 'threw' : tryRun(() => unseal(sealed, k, requestId)))
assert(bad(V.sealed, otherId) === null, 'unseal: another request id is refused (it is both the HKDF salt and the AEAD associated data)')
assert(bad({ ...V.sealed, ciphertext: flip(V.sealed.ciphertext) }) === null, 'unseal: a flipped bit in the ciphertext is refused')
assert(bad({ ...V.sealed, nonce: flip(V.sealed.nonce) }) === null && bad({ ...V.sealed, ephemeral_public_key: flip(V.sealed.ephemeral_public_key) }) === null, 'unseal: a changed nonce or sender key is refused')
const mine = newRequesterKeys()
assert(bad(V.sealed, V.request_id, mine.privateKey) === null, 'unseal: someone else\'s private key is refused')
assert(bad({ ...V.sealed, alg: 'aes-256-gcm' }) === null && bad({ ...V.sealed, nonce: Buffer.alloc(8).toString('base64url') }) === null && bad({ ...V.sealed, ciphertext: '' }) === null && bad(null) === null && bad('sealed') === null, 'unseal: an unknown algorithm, a short nonce, an empty ciphertext, or no object at all is refused, never guessed at')

const weak = priv === 'threw' ? 'threw' : tryRun(() => sharedSecret(priv, Buffer.alloc(32)))
assert(weak === 'threw', 'unseal: a key agreement with a weak (all-zero) public key is refused rather than used (anyone could compute that secret)')
// ── a daemon-side encoder written HERE from the recipe, held to the vector ─────────────────────────
function sealTo(recipientPublicRaw: Buffer, ephemeralPrivateRaw: Buffer, nonce: Buffer, plaintext: string, requestId: string): Sealed {
  const ePriv = privateKeyFromRaw(ephemeralPrivateRaw)
  const raw = createPublicKey(createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b656e04220420', 'hex'), ephemeralPrivateRaw]), format: 'der', type: 'pkcs8' })).export({ format: 'der', type: 'spki' }).subarray(-32)
  const k = sealKey(sharedSecret(ePriv, recipientPublicRaw), requestId)
  const body = Buffer.from(chacha20poly1305(k, nonce, Buffer.from(requestId, 'ascii')).encrypt(Buffer.from(plaintext, 'utf8')))
  return { alg: 'x25519-hkdf-sha256-chacha20poly1305', ephemeral_public_key: raw.toString('base64url'), nonce: nonce.toString('base64url'), ciphertext: body.toString('base64url') }
}
const resealed = tryRun(() => sealTo(hex(V.requester_public_hex), hex(V.ephemeral_private_hex), hex(V.nonce_hex), V.plaintext, V.request_id))
assert(resealed !== 'threw' && JSON.stringify(resealed) === JSON.stringify(V.sealed), 'vectors: this smoke\'s own encoder, run on the vector\'s inputs, reproduces the sealed blob byte for byte (so its round trips below mean something)')
const round = tryRun(() => sealTo(mine.publicRaw, Buffer.alloc(32, 7), Buffer.alloc(12, 9), '{"token":"t-1","device_id":"d-1","name":"Test"}', V.request_id))
const back = round === 'threw' ? 'threw' : tryRun(() => unseal(round, mine.privateKey, V.request_id))
assert(back !== 'threw' && back !== null && back.token === 't-1' && back.deviceId === 'd-1' && back.name === 'Test', 'round trip: sealed to a fresh key of ours, unsealed with it')

// ── our own key pair ──────────────────────────────────────────────────────────────────────────────
const k2 = tryRun(() => newRequesterKeys())
assert(k2 !== 'threw' && k2.publicRaw.length === 32 && /^[A-Za-z0-9_-]{43}$/.test(k2.publicB64) && Buffer.from(k2.publicB64, 'base64url').equals(k2.publicRaw) && !k2.publicRaw.equals(mine.publicRaw), 'keys: 32 raw bytes, 43 characters of unpadded base64url, and never the same twice')
const pubFromPriv = priv === 'threw' ? 'threw' : tryRun(() => createPublicKey(priv).export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex'))
assert(pubFromPriv === V.requester_public_hex, 'keys: the vector\'s private key is the vector\'s public key (the helper that loads it is right)')

// ── the device's name: the daemon's rules, counted the daemon's way ────────────────────────────────
const BEL = String.fromCodePoint(0x07)
const ZWJ = String.fromCodePoint(0x200d)
const LINE_SEP = String.fromCodePoint(0x2028)
const NBSP = String.fromCodePoint(0xa0)
const EMOJI = String.fromCodePoint(0x1f600)
const E_ACUTE = String.fromCodePoint(0xe9)
const nm = (v: unknown): string | null | 'threw' => tryRun(() => cleanDeviceName(v))
assert(nm("  Sam's MacBook Air  ") === "Sam's MacBook Air" && nm('Kitchen Mac') === 'Kitchen Mac', 'name: trimmed, otherwise as typed')
assert(nm('') === null && nm('   ') === null && nm('a' + String.fromCharCode(10) + 'b') === null && nm('a' + BEL + 'b') === null && nm('a' + ZWJ + 'b') === null && nm('a' + LINE_SEP + 'b') === null && nm(42) === null && nm(null) === null, 'name: empty, a newline, a control or invisible format character, a line separator, or not text at all is refused, never cleaned up (what the owner sees is what was sent)')
assert(nm('a'.repeat(64)) === 'a'.repeat(64) && nm('a'.repeat(65)) === null && nm(EMOJI.repeat(64)) === EMOJI.repeat(64) && nm(EMOJI.repeat(65)) === null && nm('caf' + E_ACUTE + NBSP + 'Mac') !== null, 'name: 64 characters counted as characters, not as UTF-16 units (64 emoji pass, 65 do not); a no-break space is a space')
assert(platformFor('darwin') === 'macos' && platformFor('win32') === 'windows' && platformFor('linux') === 'linux' && platformFor('freebsd') === 'other', 'platform: the names the daemon knows')

// ── what a daemon answers to "may I join?" ─────────────────────────────────────────────────────────
const RID = 'c3f1a9e07b2d4a6831ff09aa5e2b7c44'
const SECRET = 'A'.repeat(43)
const created = { request_id: RID, poll_secret: SECRET, match_code: '4821', instance_public_key: 'MFkw', expires_at: 1760000300, ttl_seconds: 300, poll_interval_seconds: 2, notified: false }
const c1 = tryRun(() => parseCreated(201, created))
assert(c1 !== 'threw' && c1.ok && c1.created.requestId === RID && c1.created.pollSecret === SECRET && c1.created.matchCode === '4821' && c1.created.ttlSeconds === 300 && c1.created.pollIntervalSeconds === 2 && c1.created.expiresAt === 1760000300 && c1.created.notified === false, 'created: a 201 is read field by field')
const kindOf = (r: ReturnType<typeof parseCreated> | ReturnType<typeof parsePoll> | 'threw'): string => (r === 'threw' ? 'threw' : 'ok' in r ? (r.ok ? 'ok' : r.failure.kind) : r.kind === 'failed' ? r.failure.kind : r.kind)
const badCreated = [
  { ...created, request_id: RID.toUpperCase() },
  { ...created, request_id: RID.slice(1) },
  { ...created, poll_secret: 'A'.repeat(42) },
  { ...created, match_code: '482' },
  { ...created, match_code: 4821 },
  { ...created, ttl_seconds: 59 },
  { ...created, ttl_seconds: 901 },
  { ...created, expires_at: -1 },
  { ...created, poll_interval_seconds: 0 },
  { ...created, notified: 'yes' },
  { ...created, instance_public_key: 'not base64url!' },
  [created],
  null,
  'created'
]
assert(badCreated.every((b) => kindOf(tryRun(() => parseCreated(201, b))) === 'unreadable'), 'created: a 201 that is not exactly what the contract describes (a malformed id, secret, code, lifetime or key; an array; text) is "unreadable", never half-used')
const f = (status: number, body: unknown, retry?: string | null): string => kindOf(tryRun(() => parseCreated(status, body, retry)))
assert(f(403, { error: 'pairing_unavailable' }) === 'unavailable' && f(403, { error: 'pairing_closed' }) === 'closed' && f(403, { error: 'something_else' }) === 'refused' && f(403, null) === 'refused', 'refused: pairing switched off or in setup mode is "unavailable", an owner-only window is "closed", any other 403 is a plain refusal')
assert(f(401, { error: 'unauthorized — set Authorization: Bearer <token>' }) === 'too-old' && f(404, { detail: 'Not Found' }) === 'too-old' && f(405, null) === 'too-old', 'refused: a Prometheus that has no such route (the bearer gate\'s 401, a 404 or a 405 on the request route) is "too old"')
assert(f(429, { error: 'rate_limited', reason: 'per_source_pending', retry_after_seconds: 41 }) === 'busy-here' && f(429, { error: 'rate_limited', reason: 'pending_full', retry_after_seconds: 9 }) === 'busy-full' && f(429, { error: 'rate_limited', reason: 'hourly', retry_after_seconds: 600 }) === 'too-many' && f(429, { error: 'rate_limited', reason: 'poll_too_fast' }) === 'slow-down' && f(429, {}) === 'slow-down', 'refused: each rate limit says which (a request from this Mac already waiting, the owner\'s list full, too many this hour), and an unknown one is "slow down"')
const wait = (status: number, body: unknown, retry?: string | null): number | undefined => {
  const r = tryRun(() => parseCreated(status, body, retry))
  return r === 'threw' || r.ok ? undefined : r.failure.retryAfterSeconds
}
assert(wait(429, { reason: 'hourly', retry_after_seconds: 41 }) === 41 && wait(429, { reason: 'hourly' }, '17') === 17 && wait(429, { retry_after_seconds: 0 }) === undefined && wait(429, { retry_after_seconds: 999999 }) === 3600 && wait(429, {}, 'soon') === undefined, 'refused: how long to wait is the body\'s number, else the Retry-After header, kept between 1 second and an hour, and absent when it is neither')
assert(f(503, { error: 'identity_unavailable' }) === 'identity' && f(400, { error: 'invalid_request', fields: ['device_name'] }) === 'refused' && f(413, { error: 'too_large' }) === 'refused' && f(500, null) === 'refused' && f(0, null) === 'lost', 'refused: no identity yet, a 400, a 413 or a 500 are refusals the person can only retry, and no answer at all is "lost"')

// ── what a daemon answers to a poll ───────────────────────────────────────────────────────────────
const sealedLike = { alg: 'x25519-hkdf-sha256-chacha20poly1305', ephemeral_public_key: 'a', nonce: 'b', ciphertext: 'c' }
const approvedBody = { status: 'approved', device_id: '9b2e5c7a41d84f0aa13c6e8d2b07f5e9', sealed: sealedLike, endpoints: { rest: 'http://192.168.1.20:8005', ws: 'ws://192.168.1.20:8010' }, tls: null, approved_at: 1760000042 }
const p0 = tryRun(() => parsePoll(200, { status: 'pending', expires_at: 1760000300 }))
const p1 = tryRun(() => parsePoll(200, approvedBody))
assert(p0 !== 'threw' && p0.kind === 'pending' && p0.expiresAt === 1760000300 && p1 !== 'threw' && p1.kind === 'approved' && p1.approved.deviceId === approvedBody.device_id && p1.approved.approvedAt === 1760000042 && JSON.stringify(p1.approved.sealed) === JSON.stringify(sealedLike), 'poll: pending, and approved with the sealed answer passed on untouched for the unsealing to judge')
assert((['denied', 'expired', 'canceled', 'delivered'] as const).every((k) => kindOf(tryRun(() => parsePoll(200, { status: k }))) === k), 'poll: denied, expired, canceled and delivered are each themselves')
const pf = (status: number, body: unknown, retry?: string | null): string => kindOf(tryRun(() => parsePoll(status, body, retry)))
assert(pf(200, { status: 'rejected' }) === 'unreadable' && pf(200, {}) === 'unreadable' && pf(200, null) === 'unreadable' && pf(200, { status: 'pending' }) === 'unreadable' && pf(200, { ...approvedBody, device_id: '' }) === 'unreadable' && pf(200, { ...approvedBody, sealed: null }) === 'unreadable' && pf(200, { ...approvedBody, approved_at: 'now' }) === 'unreadable', 'poll: a status it does not know, no status, a pending with no end time, an approval with no device or sealed answer or time: "unreadable"')
assert(pf(404, { error: 'unknown_request' }) === 'gone' && pf(429, { error: 'rate_limited', reason: 'poll_too_fast', retry_after_seconds: 1 }) === 'slow-down' && pf(401, null) === 'refused' && pf(500, null) === 'refused' && pf(0, null) === 'lost', 'poll: an unknown request is "gone" (it was forgotten), a poll that came too fast is "slow down", anything else is a refusal or no answer')

// ── where to connect after approval ───────────────────────────────────────────────────────────────
const ports = (e: unknown, fb = 8005): string => {
  const r = tryRun(() => portsFromEndpoints(e, fb))
  return r === 'threw' ? 'threw' : r.ok ? `${r.apiPort}/${r.wsPort}${r.guessed ? '?' : ''}` : r.kind
}
assert(ports({ rest: 'http://192.168.1.20:8123', ws: 'ws://192.168.1.20:8456' }) === '8123/8456' && ports({ rest: 'http://[fe80::1]:8005', ws: 'ws://[fe80::1]:8010' }) === '8005/8010' && ports({ rest: 'http://alex-mac.local', ws: 'ws://alex-mac.local:8010' }) === '80/8010', 'endpoints: the ports out of the two addresses, a bracketed IPv6 address too, a missing port meaning 80')
assert(ports({ rest: 'https://192.168.1.20:8006', ws: 'wss://192.168.1.20:8011' }) === 'needs-newer-beacon' && ports({ rest: 'http://h:1', ws: 'wss://h:2' }) === 'needs-newer-beacon', 'endpoints: an address that speaks TLS is not used (this Beacon cannot pin a certificate yet), whatever the other one says')
assert(ports({ rest: null, ws: null }, 8123) === '8123/8010?' && ports({ rest: 'http://h:8123', ws: null }) === '8123/8010?' && ports(undefined, 8123) === '8123/8010?', 'endpoints: with none given, the port it was reached on and the usual WebSocket port, marked as a guess')
assert(ports({ rest: 'javascript:alert(1)', ws: 'ws://h:8010' }) === 'unreadable' && ports({ rest: 'http://h:99999', ws: 'ws://h:8010' }) === 'unreadable' && ports({ rest: 'ftp://h:21', ws: 'ws://h:8010' }) === 'unreadable' && ports({ rest: 'http://h:8005', ws: 'http://h:8010' }) === 'unreadable', 'endpoints: another scheme, a port that is not one, or the wrong kind of address is "unreadable"')

// ── held to the REAL daemon's recorded answers ────────────────────────────────────────────────────
// src/main/fixtures/pairing_wire_698.json: exchanges recorded over real HTTP against the real Prometheus #698 app (e99053f), so the
// parsers are checked against what a daemon actually said, not against this smoke's reading of the contract.
interface WireExchange {
  name: string
  request: { method: string; path: string; body: { device_name?: string; public_key?: string } | null }
  response: { status: number; retry_after: string | null; body: unknown }
}
const W = JSON.parse(readFileSync('src/main/fixtures/pairing_wire_698.json', 'utf8')) as { expected_unseal: { request_id: string; plaintext: { token: string; device_id: string; name: string } }; exchanges: WireExchange[] }
const wire = (name: string): WireExchange => {
  const w = W.exchanges.find((e) => e.name === name)
  if (!w) throw new Error(`no recorded exchange named ${name}`)
  return w
}
const helloOf = (name: string): { pair: string; tls: boolean; fp: string; name: string } | null => helloFrom(wire(name).response.body)
assert(helloOf('hello_configured')?.pair === 'approve' && helloOf('setup_hello')?.pair === 'code' && helloOf('noauth_hello')?.pair === 'none' && helloOf('disabled_hello')?.pair === 'token' && helloOf('hello_configured')?.tls === false && /^[0-9a-f]{16}$/.test(helloOf('hello_configured')?.fp ?? ''), 'real wire: the four hellos a daemon gives (approval, setup mode, no password, approval switched off) read as approve, code, none and token, with its fingerprint and no TLS')
const real = wire('create_valid_vector_key').response
const createdReal = parseCreated(real.status, real.body)
const realDer = createdReal.ok ? decodeB64url(createdReal.created.instancePublicKey) : null
assert(createdReal.ok && createdReal.created.ttlSeconds === 300 && createdReal.created.pollIntervalSeconds === 2 && realDer !== null && matchCode(hex(V.requester_public_hex), realDer, createdReal.created.requestId) === createdReal.created.matchCode, 'real wire: a real 201 is read, and the code THIS code computes from the vector key, the daemon\'s own key and the request id is the code the daemon sent')
const pollKinds = ['poll_pending', 'poll_immediately_again_too_fast', 'poll_wrong_secret', 'limits_sixth_poll_wrong_secret_locked_out', 'limits_poll_correct_secret_after_lockout'].map((n) => {
  const r = wire(n).response
  const p = parsePoll(r.status, r.body, r.retry_after)
  return p.kind === 'failed' ? `${p.failure.kind}${p.failure.retryAfterSeconds !== undefined ? ':' + p.failure.retryAfterSeconds : ''}` : p.kind
})
const lockedFor = Number(wire('limits_sixth_poll_wrong_secret_locked_out').response.retry_after)
assert(pollKinds[0] === 'pending' && pollKinds[1].startsWith('slow-down') && pollKinds[2] === 'gone' && Number.isInteger(lockedFor) && lockedFor >= 1 && lockedFor <= 60 && pollKinds[3] === `slow-down:${lockedFor}` && pollKinds[4] === 'pending', 'real wire: pending; a poll under a second after the last is "slow down"; a wrong secret is "gone"; after five wrong secrets a sixth is "slow down" for the seconds the daemon gave; and the right secret is still served (the daemon never refuses it)', pollKinds.join())
const apr = wire('poll_R1_approved_vector_key').response
const approvedReal = parsePoll(apr.status, apr.body)
const vecPriv = privateKeyFromRaw(hex(V.requester_private_hex))
const openedReal = approvedReal.kind === 'approved' ? unseal(approvedReal.approved.sealed, vecPriv, W.expected_unseal.request_id) : null
assert(approvedReal.kind === 'approved' && openedReal !== null && openedReal.token === W.expected_unseal.plaintext.token && openedReal.deviceId === W.expected_unseal.plaintext.device_id && openedReal.name === W.expected_unseal.plaintext.name && openedReal.deviceId === approvedReal.approved.deviceId, 'real wire: the sealed answer the REAL daemon produced is unsealed by this code to exactly what an independent implementation got, and its device is the device the daemon named')
const ports2 = approvedReal.kind === 'approved' ? portsFromEndpoints(approvedReal.approved.endpoints, 1) : null
assert(ports2 !== null && ports2.ok && !ports2.guessed && ports2.apiPort > 1024 && ports2.wsPort === 8010, 'real wire: the endpoints a real daemon names give ports, with no guessing')
const ended = (n: string): string => {
  const r = wire(n).response
  const p = parsePoll(r.status, r.body)
  return p.kind
}
assert(ended('poll_Rd_denied') === 'denied' && ended('poll_after_cancel') === 'canceled' && ended('ra_poll_after_second_delete') === 'delivered' && ended('slow_poll_A_after_ttl') === 'expired' && ended('slow_poll_B_after_revoke') === 'expired', 'real wire: denied, canceled, delivered, an expired request and an approval nobody collected (which reads "expired") each read as themselves')
const createKind = (n: string): string => {
  const r = wire(n).response
  const c = parseCreated(r.status, r.body, r.retry_after)
  return c.ok ? 'ok' : `${c.failure.kind}${c.failure.retryAfterSeconds !== undefined ? ':' + c.failure.retryAfterSeconds : ''}`
}
const failKinds = ['limits_second_same_source_per_source_pending', 'limits_fourth_pending_full', 'limits_hourly_11th_refused', 'disabled_create', 'noauth_create', 'setup_create', 'hello_post_not_public', 'create_missing_device_name'].map(createKind)
assert(failKinds.join() === 'busy-here:300,busy-full:' + (failKinds[1].split(':')[1] ?? '') + ',too-many:' + (failKinds[2].split(':')[1] ?? '') + ',unavailable,unavailable,unavailable,too-old,refused' && /^busy-full:[1-9]/.test(failKinds[1]) && /^too-many:[1-9]/.test(failKinds[2]), 'real wire: the three rate limits say which and for how long, a switched-off, password-less or still-being-set-up daemon is "unavailable", the gate\'s 401 is "too old", a bad body is a refusal', failKinds.join())
const setupPoll = wire('setup_poll').response
assert(((): string => { const p = parsePoll(setupPoll.status, setupPoll.body); return p.kind === 'failed' ? p.failure.kind : p.kind })() === 'refused', 'real wire: a poll to a daemon in setup mode (a 403) is a refusal')
const nameCases = W.exchanges.filter((e) => e.name.startsWith('create_name_'))
const disagree = nameCases.filter((e) => (cleanDeviceName(e.request.body?.device_name) !== null) !== (e.response.status === 201)).map((e) => e.name)
assert(disagree.length === 0, 'real wire: for every device name recorded, this code accepts it exactly when the real daemon did', disagree.join())
assert(nameCases.length >= 12 && nameCases.some((e) => e.response.status === 201) && nameCases.some((e) => e.response.status === 400), `real wire: that comparison covers both outcomes (${nameCases.length} names, accepted and refused), so it cannot pass by comparing nothing`)

// ── what the page may ask main to do ──────────────────────────────────────────────────────────────
const goodReq = { host: '192.168.1.20', apiPort: 8005, name: "Alex's Mac mini", fp: '0123456789abcdef', tls: false }
const cj = (o: unknown): string => JSON.stringify(tryRun(() => checkJoinRequest(o)))
assert(cj(goodReq) === JSON.stringify(goodReq) && cj({ ...goodReq, fp: '', host: 'alex-mac.local', apiPort: 1 }) !== 'null' && cj({ ...goodReq, extra: 'x', token: 'y' }) === JSON.stringify(goodReq), 'ipc: a real host, port, name, fingerprint (or none) and boolean pass, and anything else on the object is dropped')
assert(['a b', '', '127.0.0.1/evil', 'host:8005', 42, null].every((h) => cj({ ...goodReq, host: h }) === 'null') && [0, 70000, 1.5, '8005', null, -1].every((p) => cj({ ...goodReq, apiPort: p }) === 'null') && ['', 'x'.repeat(129), 5, null].every((n) => cj({ ...goodReq, name: n }) === 'null') && ['0123456789ABCDEF', '0123456789abcde', '0123456789abcdeff', 'zzzzzzzzzzzzzzzz', 5].every((f) => cj({ ...goodReq, fp: f }) === 'null') && ['false', 0, 1, null].every((t) => cj({ ...goodReq, tls: t }) === 'null') && cj(null) === 'null' && cj([goodReq]) === 'null' && cj('x') === 'null', 'ipc: a host that is not a host, a port that is not one, a bad name, a bad fingerprint, a TLS flag that is not a boolean, or no object at all is refused')

// ── whether anyone who can approve has been told (the pending poll's `notified`, Prometheus #699 9f16284) ──
const pn = (body: unknown): string => {
  const p = tryRun(() => parsePoll(200, body))
  return p === 'threw' ? 'threw' : p.kind === 'pending' ? `pending:${String(p.notified)}` : p.kind
}
assert(pn({ status: 'pending', expires_at: 1760000300, notified: true }) === 'pending:true' && pn({ status: 'pending', expires_at: 1760000300, notified: false }) === 'pending:false' && pn({ status: 'pending', expires_at: 1760000300 }) === 'pending:undefined' && pn({ status: 'pending', expires_at: 1760000300, notified: 'yes' }) === 'pending:undefined' && pn({ status: 'pending', expires_at: 1760000300, notified: 1 }) === 'pending:undefined', 'poll: a pending answer\'s `notified` is read when it is a boolean, and is simply not known (an older daemon) when absent or anything else: it is a hint, never a reason to refuse the answer')
const NT = JSON.parse(readFileSync('src/main/fixtures/pairing_poll_notified_699.json', 'utf8')) as { steps: Array<{ step: string; status: number; body: { status?: string; notified?: boolean } }> }
const realPolls = NT.steps.filter((s) => s.body.status === 'pending')
assert(realPolls.length >= 5 && realPolls.every((s) => pn(s.body) === `pending:${String(s.body.notified)}`) && realPolls.some((s) => s.body.notified === true) && realPolls.some((s) => s.body.notified === false), 'real wire: every pending poll recorded from a real #699 daemon (nobody connected, an owner connected later, told at creation, and both after that owner left) is read with the `notified` the daemon gave', String(realPolls.length))
assert(waitingOffersOtherWay(false) === true && waitingOffersOtherWay(true) === false, 'screens: while waiting, "Connect another way" is offered exactly when no one who can approve has been told')

// ── how long to wait, in words ────────────────────────────────────────────────────────────────────
const wp = (n: number | undefined): string => {
  const w = waitPhrase(n)
  return `${w.key}:${w.n}`
}
assert(wp(undefined) === 'soon:0' && wp(0) === 'soon:0' && wp(Number.NaN) === 'soon:0' && wp(1) === 'seconds:1' && wp(40.2) === 'seconds:41' && wp(44) === 'seconds:44' && wp(45) === 'minute:1' && wp(89) === 'minute:1' && wp(90) === 'minutes:2' && wp(300) === 'minutes:5' && wp(3600) === 'minutes:60', 'wait: "try again in …" is seconds under 45, "about a minute" to 90, then minutes; nothing known is "a little while"')

// ── nobody to approve: where to go (owner decision, 2026-10-08: no 6-digit code route; the owner's Mac is the way in) ──
const nobody = [COPY.main.b4.ifNothing, COPY.main.b4.nobodyThere, COPY.main.joinFailed.expired.body, COPY.main.joinFailed.unavailable.body, COPY.main.bNojoin.body]
assert(nobody.every((t) => /open Beacon on the computer running Prometheus/i.test(t)) && /computer running Prometheus/i.test(COPY.main.joinFailed.closed.body) && /open Beacon/i.test(COPY.main.joinFailed.closed.body), 'copy: every place where no one may be able to approve (waiting, nobody connected, out of time, switched off, not offered) tells the person to open Beacon on the computer running Prometheus, never a dead end')

// ── every way it can fail has words and a way forward ──────────────────────────────────────────────
const allEnds = [...JOIN_FAILURE_KINDS, 'denied', 'expired', 'canceled'] as const
const copyFor = COPY.main.joinFailed as unknown as Record<string, { title?: string; body?: string }>
assert(allEnds.every((k) => typeof copyFor[k]?.title === 'string' && copyFor[k].title !== '' && typeof copyFor[k].body === 'string' && copyFor[k].body !== ''), 'screens: every way a request can end or fail has a title and words')
assert(allEnds.every((k) => joinActions(k).length > 0 || k === 'needs-newer-beacon') && joinActions('unavailable').join() === 'other-way' && joinActions('too-old').join() === 'other-way' && joinActions('denied').join() === 'ask-again' && joinActions('lost').join() === 'try-again' && joinActions('mismatch').join() === 'try-again', 'screens: every one offers a way forward besides Back (the one that cannot be helped by trying again says to update Beacon), and a computer that does not take new devices points to the older setup')

// ── the countdown ─────────────────────────────────────────────────────────────────────────────────
const ck = (n: number): string => tryRun(() => clockText(n)) as string
assert(ck(272) === '4:32' && ck(300) === '5:00' && ck(59) === '0:59' && ck(0) === '0:00' && ck(-5) === '0:00' && ck(Number.NaN) === '0:00' && ck(600) === '10:00' && ck(61.9) === '1:01', 'countdown: minutes and seconds, whole seconds, never negative')

function finish(): void {
  if (checks !== EXPECTED) {
    console.log(`[request-join-smoke] INCOMPLETE — ${checks} checks ran, expected ${EXPECTED}`)
    process.exit(1)
  }
  console.log(failures === 0 ? `[request-join-smoke] OK — ${checks} checks passed` : `[request-join-smoke] FAIL — ${failures}/${checks} checks failed`)
  process.exit(failures === 0 ? 0 : 1)
}

// ── a daemon that follows the contract, and writes down everything it is sent ─────────────────────
interface Seen {
  method: string
  url: string
  headers: IncomingMessage['headers']
  body: string
}
interface Mode {
  /** `notified` in the 201, and in the pending poll (undefined = the poll says nothing about it, like an older daemon). */
  createNotified?: boolean
  pollNotified?: boolean
  wrongCode?: boolean
  create?: { status: number; body: unknown; headers?: Record<string, string> }
  sealTo?: 'attacker'
  plainDeviceId?: string
  endpoints?: unknown
  redirectTo?: string
  huge?: boolean
}
interface Fake {
  port: number
  seen: Seen[]
  mode: Mode
  id: string
  secret: string
  devicePublic: () => Buffer | null
  approve: () => void
  end: (status: 'denied' | 'expired' | 'canceled') => void
  status: () => string
  close: () => Promise<void>
}
const DEVICE_ID = '9b2e5c7a41d84f0aa13c6e8d2b07f5e9'
const FAKE_WS_PORT = 18010
const INSTANCE_DER = Buffer.from(V.instance_public_key_der_hex, 'hex')
const attacker = newRequesterKeys()

async function listen(handler: (req: IncomingMessage, res: ServerResponse, body: string) => void): Promise<{ server: Server; port: number }> {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => handler(req, res, Buffer.concat(chunks).toString('utf8')))
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const addr = server.address()
  return { server, port: typeof addr === 'object' && addr ? addr.port : 0 }
}

async function fakeDaemon(): Promise<Fake> {
  const id = randomBytes(16).toString('hex')
  const secret = randomBytes(32).toString('base64url')
  const seen: Seen[] = []
  const mode: Mode = {}
  let status: 'none' | 'pending' | 'approved' | 'delivered' | 'denied' | 'expired' | 'canceled' = 'none'
  let devicePublic: Buffer | null = null
  let name = ''
  let sealed: Sealed | null = null
  const json = (res: ServerResponse, code: number, body: unknown, headers: Record<string, string> = {}): void => {
    res.writeHead(code, { 'content-type': 'application/json', ...headers })
    res.end(JSON.stringify(body))
  }
  const { server, port } = await listen((req, res, body) => {
    seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body })
    if (req.headers.origin) return json(res, 400, { error: 'browser_not_allowed' })
    const url = req.url ?? ''
    if (req.method === 'POST' && url === '/api/pair/requests') {
      if (mode.redirectTo) {
        res.writeHead(302, { location: mode.redirectTo })
        return res.end()
      }
      if (mode.create) return json(res, mode.create.status, mode.create.body, mode.create.headers)
      const b = JSON.parse(body) as { device_name: string; platform: string; public_key: string }
      devicePublic = Buffer.from(b.public_key, 'base64url')
      name = b.device_name
      status = 'pending'
      const code = mode.wrongCode ? '0000' : matchCode(devicePublic, INSTANCE_DER, id)
      // `huge`: an otherwise PERFECT answer with a lot of extra text, so only the size cap can refuse it (one with missing fields would be refused anyway).
      return json(res, 201, { request_id: id, poll_secret: secret, match_code: code, instance_public_key: INSTANCE_DER.toString('base64url'), expires_at: 1760000300, ttl_seconds: 300, poll_interval_seconds: 2, notified: mode.createNotified ?? false, ...(mode.huge ? { padding: 'x'.repeat(40_000) } : {}) })
    }
    const m = /^\/api\/pair\/requests\/([0-9a-f]{32})$/.exec(url)
    if (m && (req.method === 'GET' || req.method === 'DELETE')) {
      if (m[1] !== id || req.headers['x-pairing-secret'] !== secret) return json(res, 404, { error: 'unknown_request' })
      if (req.method === 'DELETE') {
        if (status === 'approved') status = 'delivered'
        else if (status === 'pending') status = 'canceled'
        res.writeHead(204)
        return res.end()
      }
      if (status === 'pending') return json(res, 200, { status: 'pending', expires_at: 1760000300, ...(mode.pollNotified === undefined ? {} : { notified: mode.pollNotified }) })
      if (status === 'approved' && sealed) return json(res, 200, { status: 'approved', device_id: DEVICE_ID, sealed, endpoints: mode.endpoints ?? { rest: `http://127.0.0.1:${port}`, ws: `ws://127.0.0.1:${FAKE_WS_PORT}` }, tls: null, approved_at: 1760000042 })
      return json(res, 200, { status })
    }
    json(res, 404, { detail: 'Not Found' })
  })
  return {
    port,
    seen,
    mode,
    id,
    secret,
    devicePublic: () => devicePublic,
    approve: () => {
      const plain = JSON.stringify({ token: 'tok-' + randomBytes(24).toString('base64url'), device_id: mode.plainDeviceId ?? DEVICE_ID, name })
      sealed = sealTo(mode.sealTo === 'attacker' ? attacker.publicRaw : (devicePublic as Buffer), randomBytes(32), randomBytes(12), plain, id)
      status = 'approved'
    },
    end: (st) => {
      status = st
    },
    status: () => status,
    close: () => new Promise<void>((r) => server.close(() => r()))
  }
}

let clock = 1_000_000
const target = (d: { port: number }, over: Partial<JoinTarget> = {}): JoinTarget => ({ host: '127.0.0.1', apiPort: d.port, name: "Alex's Mac mini", fp: '0123456789abcdef', tls: false, ...over })
function newSession(over: Partial<JoinDeps> = {}): { s: JoinSession; saved: SavedConnection[]; log: string[] } {
  const saved: SavedConnection[] = []
  const log: string[] = []
  const deps: JoinDeps = {
    request: async (r) => {
      log.push(r.method)
      return requestSmall(r)
    },
    now: () => clock,
    save: (c) => {
      log.push('save')
      saved.push(c)
    },
    activate: () => {
      log.push('activate')
    },
    ...over
  }
  return { s: new JoinSession(deps), saved, log }
}
const poll = async (s: JoinSession): Promise<string> => {
  clock += 1100
  const o = await s.poll()
  return o.state === 'failed' ? `failed:${o.failure.kind}` : o.state
}
const begin = async (a: { s: JoinSession }, d: Fake, over: Partial<JoinTarget> = {}): Promise<string> => {
  const r = await a.s.begin(target(d, over), "Sam's MacBook", 'macos')
  return r.ok ? 'ok' : r.failure.kind
}

async function sessions(): Promise<void> {
  // ── the whole way through ───────────────────────────────────────────────────────────────────────
  const d1 = await fakeDaemon()
  const a1 = newSession()
  const r1 = await a1.s.begin(target(d1), "Sam's MacBook", 'macos')
  const sentBody = JSON.parse(d1.seen[0]?.body ?? '{}') as Record<string, unknown>
  assert(JSON.stringify(Object.keys(sentBody).sort()) === '["device_name","platform","public_key"]' && sentBody.device_name === "Sam's MacBook" && sentBody.platform === 'macos' && typeof sentBody.public_key === 'string' && /^[A-Za-z0-9_-]{43}$/.test(sentBody.public_key) && d1.seen[0].headers['content-type'] === 'application/json', 'session: asking sends the name, the platform and the PUBLIC key, as JSON, and nothing else')
  const expectCode = matchCode(d1.devicePublic() as Buffer, INSTANCE_DER, d1.id)
  assert(r1.ok && r1.matchCode === expectCode && r1.ttlSeconds === 300 && r1.pollIntervalSeconds === 2 && r1.notified === false && r1.deviceName === "Sam's MacBook" && a1.s.active(), 'session: the code shown is the one this Mac computed itself from its key, the computer\'s key and the request id, and the lifetime is the computer\'s')
  // Same Mac, no other Beacon to say yes (the onboarding shoot, 2026-10-16): the line to say yes here, from the request's own id
  // and the code this Mac worked out.
  assert(
    r1.ok && (r1 as unknown as { approveCommand?: string | null }).approveCommand === `oara pair approve ${d1.id.slice(0, 8)} --code ${expectCode}`,
    'session: it also carries the one line that says yes on the computer itself: oara pair approve <the first 8 of the request id> --code <this code>',
    JSON.stringify(r1)
  )
  assert((await poll(a1.s)) === 'waiting' && a1.log.join() === 'POST,GET', 'session: while nobody has answered it keeps waiting')
  d1.approve()
  const o1 = await poll(a1.s)
  assert(o1 === 'connected' && a1.saved.length === 1 && a1.saved[0].gateway.apiBase === `http://127.0.0.1:${d1.port}` && a1.saved[0].gateway.wsUrl === `ws://127.0.0.1:${FAKE_WS_PORT}` && /^tok-/.test(a1.saved[0].token) && a1.saved[0].computerName === "Alex's Mac mini" && a1.saved[0].fp === '0123456789abcdef', 'session: approval unseals the token and keeps the connection at the ports the computer named')
  assert(a1.log.join() === 'POST,GET,GET,save,DELETE,activate' && d1.status() === 'delivered', 'session: the order is ask, wait, receive, KEEP the token, only then tell the computer it arrived, only then connect (so a token that could not be kept is never acknowledged)')
  assert(d1.seen.every((q) => !('authorization' in q.headers) && !('cookie' in q.headers) && !('origin' in q.headers)) && d1.seen.filter((q) => q.url.includes(d1.secret)).length === 0 && d1.seen.filter((q) => q.method !== 'POST').every((q) => q.headers['x-pairing-secret'] === d1.secret) && !a1.s.active(), 'session: nothing it sent carried a credential, a cookie or an Origin; the poll secret travelled only in its header, never in an address; and the attempt is over')
  await d1.close()

  // ── it will not be talked into trusting the wrong thing ──────────────────────────────────────
  const d2 = await fakeDaemon()
  d2.mode.wrongCode = true
  const a2 = newSession()
  assert((await begin(a2, d2)) === 'mismatch' && a2.log.join() === 'POST,DELETE' && !a2.s.active() && d2.status() === 'canceled', 'session: a code that is not the one this Mac computed (something may be in between) stops at once, withdraws the request, and shows nothing')
  await d2.close()
  const d3 = await fakeDaemon()
  d3.mode.sealTo = 'attacker'
  const a3 = newSession()
  await begin(a3, d3)
  d3.approve()
  assert((await poll(a3.s)) === 'failed:unopened' && a3.saved.length === 0 && !a3.log.includes('DELETE') && !a3.log.includes('activate') && !a3.s.active(), 'session: a token sealed to someone else\'s key is not opened, kept, acknowledged or used')
  await d3.close()
  const d4 = await fakeDaemon()
  d4.mode.plainDeviceId = 'f'.repeat(32)
  const a4 = newSession()
  await begin(a4, d4)
  d4.approve()
  assert((await poll(a4.s)) === 'failed:unopened' && a4.saved.length === 0 && !a4.log.includes('DELETE'), 'session: an answer whose sealed device is not the device the computer said it approved is refused')
  await d4.close()
  const d5 = await fakeDaemon()
  d5.mode.endpoints = { rest: 'https://127.0.0.1:1', ws: 'wss://127.0.0.1:2' }
  const a5 = newSession()
  await begin(a5, d5)
  d5.approve()
  assert((await poll(a5.s)) === 'failed:needs-newer-beacon' && a5.saved.length === 0 && !a5.log.includes('DELETE'), 'session: addresses that speak TLS are not connected to (this Beacon cannot check their certificate yet), and nothing is kept')
  await d5.close()
  const d6 = await fakeDaemon()
  const a6 = newSession()
  assert((await begin(a6, d6, { tls: true })) === 'needs-newer-beacon' && a6.log.length === 0, 'session: a computer that says it speaks TLS is not asked anything')
  await d6.close()

  // ── it cannot keep the connection ────────────────────────────────────────────────────────────
  const d7 = await fakeDaemon()
  const a7 = newSession({ save: () => { throw new Error('keychain says no') } })
  await begin(a7, d7)
  d7.approve()
  assert((await poll(a7.s)) === 'failed:not-saved' && !a7.log.includes('DELETE') && !a7.log.includes('activate') && !a7.s.active(), 'session: when the token cannot be kept it is NOT acknowledged and nothing is connected (the computer then revokes the device itself)')
  await d7.close()

  // ── the other ways it ends ───────────────────────────────────────────────────────────────────
  for (const end of ['denied', 'expired', 'canceled'] as const) {
    const d = await fakeDaemon()
    const a = newSession()
    await begin(a, d)
    d.end(end)
    const o = await poll(a.s)
    assert(o === end && a.saved.length === 0 && !a.s.active(), `session: "${end}" ends the attempt with nothing kept`)
    await d.close()
  }
  const d8 = await fakeDaemon()
  const a8 = newSession()
  await begin(a8, d8)
  await a8.s.cancel()
  assert(a8.log.join() === 'POST,DELETE' && d8.status() === 'canceled' && !a8.s.active() && (await poll(a8.s)) === 'failed:gone' && a8.log.length === 2, 'session: going Back withdraws the request, and a poll after that asks nothing')
  await d8.close()
  const d9 = await fakeDaemon()
  const a9 = newSession()
  await begin(a9, d9)
  const first = d9.id
  const d9b = d9
  await begin(a9, d9b)
  assert(a9.log.join() === 'POST,DELETE,POST' && d9.seen[1].method === 'DELETE' && d9.seen[1].url.endsWith(first), 'session: asking again first withdraws the request that was waiting')
  await d9.close()

  // ── the wire misbehaving ─────────────────────────────────────────────────────────────────────
  const d10 = await fakeDaemon()
  d10.mode.create = { status: 429, body: { error: 'rate_limited', reason: 'per_source_pending', retry_after_seconds: 41 }, headers: { 'retry-after': '41' } }
  const a10 = newSession()
  const r10 = await a10.s.begin(target(d10), "Sam's MacBook", 'macos')
  assert(!r10.ok && r10.failure.kind === 'busy-here' && r10.failure.retryAfterSeconds === 41 && !a10.s.active(), 'session: a computer that already has a request from this Mac waiting says so, and how long')
  await d10.close()
  const d11 = await fakeDaemon()
  d11.mode.huge = true
  assert((await begin(newSession(), d11)) === 'unreadable', 'session: an answer larger than any real one is unreadable even when everything in it is right (only the size limit can refuse it)')
  await d11.close()
  const evil = await listen((_q, res) => res.end('{}'))
  const d12 = await fakeDaemon()
  d12.mode.redirectTo = `http://127.0.0.1:${evil.port}/stolen`
  let evilHits = 0
  evil.server.on('request', () => evilHits++)
  assert((await begin(newSession(), d12)) === 'lost' && evilHits === 0, 'session: a redirect is not followed (the place it points at is never contacted)')
  await d12.close()
  await new Promise<void>((r) => evil.server.close(() => r()))
  const dead = await fakeDaemon()
  const deadPort = dead.port
  await dead.close()
  assert((await begin(newSession(), { port: deadPort } as Fake)) === 'lost', 'session: nobody there is "lost"')

  // ── "has anyone been told?", over the wait: it can only become true, whatever a poll later says ────
  const dn = await fakeDaemon()
  const an = newSession()
  const wn = async (): Promise<string> => {
    clock += 1100
    const o = await an.s.poll()
    return o.state === 'waiting' ? `waiting:${String(o.notified)}` : o.state
  }
  const beginN = await an.s.begin(target(dn), "Sam's MacBook", 'macos')
  const seq: string[] = [beginN.ok ? `begin:${String(beginN.notified)}` : 'begin-failed', await wn()] // an older daemon: the poll says nothing
  dn.mode.pollNotified = false
  seq.push(await wn())
  dn.mode.pollNotified = true
  seq.push(await wn())
  dn.mode.pollNotified = false // the owner who connected later has left again (the real daemon does this)
  seq.push(await wn())
  dn.mode.pollNotified = undefined
  seq.push(await wn())
  assert(seq.join() === 'begin:false,waiting:false,waiting:false,waiting:true,waiting:true,waiting:true', 'session: every wait reports whether anyone has been told: it starts from the daemon\'s word at creation, becomes true when a poll says so, and then STAYS true (the real daemon reports false again once a late-connecting owner leaves; they were still told)', seq.join())
  await an.s.cancel()
  await dn.close()
  const dt = await fakeDaemon()
  dt.mode.createNotified = true
  const at = newSession()
  await at.s.begin(target(dt), "Sam's MacBook", 'macos')
  dt.mode.pollNotified = false
  clock += 1100
  const ot = await at.s.poll()
  assert(ot.state === 'waiting' && ot.notified === true, 'session: told at creation stays told even if the first poll says otherwise')
  await at.s.cancel()
  await dt.close()

  // ── calls that arrive together are run one after another, in the order they arrived ─────────────
  const d15 = await fakeDaemon()
  const a15 = newSession()
  // What a screen that starts, is torn down and starts again does: begin, cancel, begin, all at once.
  const together = await Promise.all([a15.s.begin(target(d15), 'First', 'macos'), a15.s.cancel(), a15.s.begin(target(d15), 'Second', 'macos')])
  assert(a15.log.join() === 'POST,DELETE,POST' && together[0].ok && (together[2] as { ok: boolean }).ok && a15.s.active() && d15.seen.filter((q) => q.method === 'POST').length === 2, 'session: a begin, a cancel and a begin that arrive together run in that order (ask, withdraw, ask), so the computer never sees two open requests from this Mac')
  await a15.s.cancel()
  await d15.close()

  // ── polling manners ──────────────────────────────────────────────────────────────────────────
  const d13 = await fakeDaemon()
  const a13 = newSession()
  await begin(a13, d13)
  await poll(a13.s)
  const before = a13.log.length
  const quick = await a13.s.poll()
  assert(quick.state === 'waiting' && a13.log.length === before, 'session: asking again within a second asks nothing')
  const d14 = await fakeDaemon()
  const a14 = newSession()
  await begin(a14, d14)
  await d14.close()
  const lostRun = [await poll(a14.s), await poll(a14.s), await poll(a14.s)]
  assert(lostRun.join() === 'waiting,waiting,failed:lost', 'session: one or two missed answers are just waiting; the third in a row is "lost"')
  await d13.close()
}

sessions().then(finish, (e) => {
  console.log(`[request-join-smoke] CRASH ${e instanceof Error ? e.stack : String(e)}`)
  process.exit(1)
})
