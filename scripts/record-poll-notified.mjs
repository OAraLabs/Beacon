#!/usr/bin/env node
// record-poll-notified — record how a REAL Prometheus daemon (#699, 9f16284 or later) reports `notified` on the PENDING POLL, into
// src/main/fixtures/pairing_poll_notified_699.json, so smoke:request-join can hold Beacon's reading of it to the daemon's real answers.
//
//   export BEACON_REAL_DAEMON_SRC=<prometheus clone>/src BEACON_REAL_DAEMON_PY=<its venv>/bin/python
//   node scripts/record-poll-notified.mjs
//
// The contract says `notified` "only ever goes false to true" during a request's life. This records what actually happens when: nobody is
// connected; an owner connects later; that owner disconnects again; and when an owner is already connected at creation and then leaves.
import { generateKeyPairSync } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'
import { realDaemonConfigured, startRealDaemon } from './lib/real-daemon.mjs'

if (!realDaemonConfigured()) {
  console.log('[record] SKIPPED: set BEACON_REAL_DAEMON_SRC and BEACON_REAL_DAEMON_PY')
  process.exit(3)
}
const OUT = fileURLToPath(new URL('../src/main/fixtures/pairing_poll_notified_699.json', import.meta.url))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const d = await startRealDaemon({ name: 'Notified Recorder' })
const steps = []
try {
  const owner = async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${d.wsPort}`)
    const frames = []
    ws.on('message', (m) => frames.push(JSON.parse(String(m))))
    await new Promise((res, rej) => (ws.once('open', res), ws.once('error', rej)))
    ws.send(JSON.stringify({ type: 'auth', token: d.token }))
    for (let i = 0; i < 40 && !frames.some((f) => f.type === 'connected'); i++) await sleep(100)
    return ws
  }
  const ask = async (name) => {
    const { publicKey } = generateKeyPairSync('x25519')
    const res = await fetch(`http://127.0.0.1:${d.port}/api/pair/requests`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ device_name: name, platform: 'macos', public_key: publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url') }) })
    return { status: res.status, body: await res.json() }
  }
  const poll = async (req, step) => {
    await sleep(1200) // the daemon refuses polls closer than a second
    const res = await fetch(`http://127.0.0.1:${d.port}/api/pair/requests/${req.body.request_id}`, { headers: { 'x-pairing-secret': req.body.poll_secret } })
    steps.push({ step, status: res.status, body: await res.json() })
  }
  // 1. nobody connected at creation; an owner connects; the owner leaves
  const a = await ask('Late Owner')
  steps.push({ step: 'create, no owner connected', status: a.status, body: { notified: a.body.notified, expires_at: a.body.expires_at } })
  await poll(a, 'poll: still nobody')
  const ws1 = await owner()
  await poll(a, 'poll: an owner connected after the request was made')
  ws1.close()
  await sleep(600)
  await poll(a, 'poll: that owner has disconnected again')
  // 2. an owner is connected AT creation; then leaves
  const ws2 = await owner()
  const b = await ask('Told At Creation')
  steps.push({ step: 'create, an owner connected', status: b.status, body: { notified: b.body.notified, expires_at: b.body.expires_at } })
  await poll(b, 'poll: owner still connected')
  ws2.close()
  await sleep(600)
  await poll(b, 'poll: the owner who was told at creation has disconnected')
  writeFileSync(OUT, JSON.stringify({ about: 'How a real Prometheus daemon (#699, feat/pairing-channels 9f16284) reports `notified` on the pending poll, recorded 2026-10-08 by scripts/record-poll-notified.mjs against the real app on an ephemeral 127.0.0.1 port with a temporary home.', steps }, null, 1))
  for (const s of steps) console.log(`[record] ${s.step.padEnd(62)} ${s.status} notified=${s.body.notified}`)
} finally {
  d.stop()
}
