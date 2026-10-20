#!/usr/bin/env node
// record-pairing-frames — record the pairing frames a REAL Prometheus daemon sends over its REAL WebSocket bridge (Prometheus #699,
// docs/PAIRING-APPROVAL-API.md section 5.1), into src/main/fixtures/pairing_frames_699.json, so smoke:approve-join can hold Beacon's frame
// parser and watcher to what a daemon actually sent and not to a reading of the contract.
//
//   export BEACON_REAL_DAEMON_SRC=<prometheus clone at #699 or later>/src BEACON_REAL_DAEMON_PY=<its venv>/bin/python
//   node scripts/record-pairing-frames.mjs            (about 80 s: it waits for a real expiry)
//
// What it does, over real sockets: an owner socket (the global token) sees live pairing_pending frames; a second owner socket that connects
// LATER is backfilled with what is still waiting; a scoped device's socket is sent nothing; owner decisions come back as pairing_resolved
// (approved by beacon, denied, approved by cli, canceled by the requester, expired by the system after the request's lifetime).
import { createDecipheriv, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'
import { realDaemonConfigured, startRealDaemon } from './lib/real-daemon.mjs'

if (!realDaemonConfigured()) {
  console.log('[record] SKIPPED: set BEACON_REAL_DAEMON_SRC and BEACON_REAL_DAEMON_PY')
  process.exit(3)
}
const OUT = fileURLToPath(new URL('../src/main/fixtures/pairing_frames_699.json', import.meta.url))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const SPKI = Buffer.from('302a300506032b656e032100', 'hex')

async function socket(d, token, label) {
  const ws = new WebSocket(`ws://127.0.0.1:${d.wsPort}`)
  const frames = []
  ws.on('message', (m) => frames.push({ ...JSON.parse(String(m)), recvAtMs: Date.now() }))
  await new Promise((res, rej) => (ws.once('open', res), ws.once('error', rej)))
  ws.send(JSON.stringify({ type: 'auth', token }))
  for (let i = 0; i < 40 && !frames.some((f) => f.type === 'connected'); i++) await sleep(100)
  if (!frames.some((f) => f.type === 'connected')) throw new Error(`${label}: never connected`)
  return { ws, frames, label }
}
const pairingOnly = (s) => s.frames.filter((f) => String(f.type).startsWith('pairing'))
function device(name, platform) {
  const { publicKey, privateKey } = generateKeyPairSync('x25519')
  return { name, platform, privateKey, pub: publicKey.export({ format: 'der', type: 'spki' }).subarray(-32), id: null, secret: null, code: null }
}
async function ask(d, dev) {
  const res = await fetch(`http://127.0.0.1:${d.port}/api/pair/requests`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ device_name: dev.name, platform: dev.platform, public_key: dev.pub.toString('base64url') }) })
  const b = await res.json()
  Object.assign(dev, { id: b.request_id, secret: b.poll_secret, code: b.match_code, notified: b.notified })
  return b
}
const poll = async (d, dev) => (await fetch(`http://127.0.0.1:${d.port}/api/pair/requests/${dev.id}`, { headers: { 'x-pairing-secret': dev.secret } })).json()
const cancel = (d, dev) => fetch(`http://127.0.0.1:${d.port}/api/pair/requests/${dev.id}`, { method: 'DELETE', headers: { 'x-pairing-secret': dev.secret } })
function unseal(dev, s) {
  const shared = diffieHellman({ privateKey: dev.privateKey, publicKey: createPublicKey({ key: Buffer.concat([SPKI, Buffer.from(s.ephemeral_public_key, 'base64url')]), format: 'der', type: 'spki' }) })
  const key = Buffer.from(hkdfSync('sha256', shared, Buffer.from(dev.id, 'ascii'), 'prometheus-pair-v1/seal', 32))
  const body = Buffer.from(s.ciphertext, 'base64url')
  const dec = createDecipheriv('chacha20-poly1305', key, Buffer.from(s.nonce, 'base64url'), { authTagLength: 16 })
  dec.setAAD(Buffer.from(dev.id, 'ascii'))
  dec.setAuthTag(body.subarray(body.length - 16))
  return JSON.parse(Buffer.concat([dec.update(body.subarray(0, body.length - 16)), dec.final()]).toString('utf8'))
}

const daemons = []
try {
  const d = await startRealDaemon({ name: 'Frame Recorder' })
  daemons.push(d)
  if (!d.frames) throw new Error('this daemon has no pairing frames (Prometheus #699 or later is needed)')
  const decide = (id, verb, body, extraHeaders = {}) => fetch(`http://127.0.0.1:${d.port}/api/pair/requests/${id}/${verb}`, { method: 'POST', headers: { authorization: `Bearer ${d.token}`, 'content-type': 'application/json', ...extraHeaders }, body: JSON.stringify(body ?? {}) })

  const opA = await socket(d, d.token, 'owner A')
  const noneYet = pairingOnly(opA).length
  const r1 = device('Alpha Laptop', 'windows')
  const r2 = device('Beta Phone', 'ios')
  const r3 = device('Gamma Tablet', 'android')
  const created = []
  for (const r of [r1, r2, r3]) {
    created.push(await ask(d, r))
    await sleep(1100) // distinct created_at seconds: the order of arrival is then a fact, not a tie
  }
  await sleep(500)
  const opB = await socket(d, d.token, 'owner B, connected late') // backfill
  await sleep(800)

  // a scoped device: approve a request, unseal its token, connect a socket with it
  const scopedDev = device('Scoped Phone', 'ios')
  await ask(d, scopedDev)
  await decide(scopedDev.id, 'approve', { match_code: scopedDev.code })
  const approved = await poll(d, scopedDev)
  const scopedToken = unseal(scopedDev, approved.sealed).token
  await cancel(d, scopedDev)
  const scoped = await socket(d, scopedToken, 'scoped device')
  await sleep(800)
  const r4 = device('Delta Desktop', 'macos')
  await ask(d, r4)
  await sleep(800)

  // decisions
  await decide(r1.id, 'approve', { match_code: r1.code })
  await decide(r2.id, 'deny')
  await cancel(d, r3)
  await decide(r4.id, 'approve', { match_code: r4.code }, { 'x-pairing-via': 'cli' })
  await sleep(1200)

  // an expiry, for real: a daemon whose requests live 60 seconds
  const d2 = await startRealDaemon({ name: 'Frame Recorder (short lives)', ttl: 60 })
  daemons.push(d2)
  const opC = await socket(d2, d2.token, 'owner C (60 s requests)')
  const r5 = device('Epsilon Watch', 'other')
  await ask(d2, r5)
  console.log('[record] waiting for a real expiry (about 70 s)...')
  for (let i = 0; i < 100 && !pairingOnly(opC).some((f) => f.type === 'pairing_resolved'); i++) await sleep(1000)

  const doc = {
    about: 'Pairing frames recorded 2026-10-08 from the REAL Prometheus app (#699, feat/pairing-channels 9f16284) over its real WebSocket bridge on an ephemeral 127.0.0.1 port with a temporary home, by scripts/record-pairing-frames.mjs. Tokens belong to throwaway daemons. recvAtMs is this machine\'s clock when the frame arrived; every frame\'s own `timestamp` is the daemon\'s clock at sending.',
    requests: { r1: r1.id, r2: r2.id, r3: r3.id, r4: r4.id, r5: r5.id },
    created: created.map((c) => ({ notified: c.notified, expires_at: c.expires_at, ttl_seconds: c.ttl_seconds })),
    sockets: {
      ownerA: { framesBeforeAnyRequest: noneYet, frames: pairingOnly(opA) },
      ownerBLate: { frames: pairingOnly(opB) },
      scoped: { allTypes: scoped.frames.map((f) => f.type), pairing: pairingOnly(scoped) },
      ownerC: { frames: pairingOnly(opC), requestId: r5.id }
    }
  }
  writeFileSync(OUT, JSON.stringify(doc, null, 1))
  const n = (s) => doc.sockets[s].frames?.length ?? doc.sockets[s].pairing.length
  console.log(`[record] wrote ${OUT}: owner A ${n('ownerA')} frames, owner B (late) ${n('ownerBLate')}, scoped ${n('scoped')}, owner C ${n('ownerC')}`)
  for (const s of [opA, opB, scoped, opC]) s.ws.close()
} finally {
  for (const dm of daemons) dm?.stop()
}
