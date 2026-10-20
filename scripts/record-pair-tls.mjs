#!/usr/bin/env node
// record-pair-tls — what a REAL Prometheus answers a computer that asks to join it OVER TLS (the home-network listener, #721),
// into src/main/fixtures/pair_tls.json, so smoke:join-tls holds Beacon's TLS join to the daemon's own approve answer and not to
// a second reading of the contract (docs/MULTI-COMPUTER-v0.4.md §3.2, the contract's §7.3).
//
//   export BEACON_REAL_DAEMON_SRC=<prometheus clone>/src BEACON_REAL_DAEMON_PY=<a python with its dependencies>
//   node scripts/record-pair-tls.mjs
//
// scripts/lib/serve_real_daemon.py --tls serves the real app twice, the way web/launcher.py does in home-network mode: plain HTTP
// and the bridge, and the same app and bridge over TLS with the instance certificate, `app.state.lan_tls` set. Every listener is
// on 127.0.0.1 (the helper asserts it before it says ready, and this checks it again with lsof): a real daemon only runs TLS on a
// home-network bind, which this never makes. The requester's key is the contract vectors' (pairing_seal_v1.json), so production
// code can unseal the recorded answer. The throwaway daemon's home, token and device are deleted at the end.
//
// Recorded, each with the listener it went to and, for TLS, whether the certificate presented carried the daemon's own pin:
// hello over TLS; the request (201) over TLS; the owner's approval (plain loopback, the global token); the approved poll over
// TLS; the same poll over plain HTTP, for contrast; and the acknowledgement over TLS.
import { execFileSync } from 'node:child_process'
import { createHash, X509Certificate } from 'node:crypto'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import https from 'node:https'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { realDaemonConfigured, startRealDaemon } from './lib/real-daemon.mjs'

if (!realDaemonConfigured()) {
  console.log('[record] SKIPPED: set BEACON_REAL_DAEMON_SRC and BEACON_REAL_DAEMON_PY')
  process.exit(3)
}
const OUT = fileURLToPath(new URL('../src/main/fixtures/pair_tls.json', import.meta.url))
const VECTORS = JSON.parse(readFileSync(fileURLToPath(new URL('../src/main/fixtures/pairing_seal_v1.json', import.meta.url)), 'utf8'))
const SRC = process.env.BEACON_REAL_DAEMON_SRC
let source = 'unknown'
try {
  source = execFileSync('git', ['-C', dirname(SRC), 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
} catch {
  /* not a clone */
}

const spkiSha256 = (cert) => createHash('sha256').update(cert.publicKey.export({ type: 'spki', format: 'der' })).digest('hex')

const d = await startRealDaemon({ name: 'TLS Record Prometheus', tls: true })
if (!d.tlsPort || !d.pin) throw new Error('the helper did not start the TLS listeners (an older serve_real_daemon.py, or a Prometheus without #721)')

/** One request over TLS to the daemon's TLS listener. The answer is kept only if the certificate presented has the daemon's pin. */
const overTls = (method, path, { headers = {}, body } = {}) =>
  new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body)
    const req = https.request(
      { host: '127.0.0.1', port: d.tlsPort, method, path, rejectUnauthorized: false, agent: false, headers: { accept: 'application/json', ...(payload ? { 'content-type': 'application/json' } : {}), ...headers } },
      (res) => {
        const cert = new X509Certificate(res.socket.getPeerCertificate(false).raw)
        const pinned = spkiSha256(cert) === d.pin
        let text = ''
        res.setEncoding('utf8')
        res.on('data', (c) => (text += c))
        res.on('end', () => resolve({ status: res.statusCode, retry_after: res.headers['retry-after'] ?? null, body: text ? JSON.parse(text) : null, pinned, protocol: res.socket.getProtocol() }))
      }
    )
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
const overPlain = async (method, path, headers = {}) => {
  const res = await fetch(`http://127.0.0.1:${d.port}${path}`, { method, headers: { accept: 'application/json', ...headers } })
  const text = await res.text()
  return { status: res.status, retry_after: res.headers.get('retry-after'), body: text ? JSON.parse(text) : null }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const exchanges = []
const keep = (name, listener, request, response) => {
  exchanges.push({ name, listener, request, response })
  return response
}
try {
  // Every listener the daemon has is on 127.0.0.1: the helper asserted it for the sockets it made; lsof checks the whole process.
  const pid = execFileSync('lsof', ['-nP', '-t', `-iTCP:${d.tlsPort}`, '-sTCP:LISTEN'], { encoding: 'utf8' }).trim().split('\n')[0]
  const listening = execFileSync('lsof', ['-nP', '-a', '-p', pid, '-iTCP', '-sTCP:LISTEN', '-Fn'], { encoding: 'utf8' })
    .split('\n')
    .filter((l) => l.startsWith('n'))
    .map((l) => l.slice(1))
  if (listening.length < 4 || !listening.every((a) => a.startsWith('127.0.0.1:'))) throw new Error('a listener off 127.0.0.1: ' + listening.join(' '))
  console.log('[record] listening only on 127.0.0.1:', listening.join(' '))

  const hello = keep('hello_tls', 'tls', { method: 'GET', path: '/api/hello', body: null }, await overTls('GET', '/api/hello'))
  // The contract's example device name, so the sealed answer and the fixture's own fields name the same device.
  const reqBody = { device_name: JSON.parse(VECTORS.plaintext).name, platform: 'macos', public_key: VECTORS.requester_public_b64url }
  const created = keep('create_tls', 'tls', { method: 'POST', path: '/api/pair/requests', body: reqBody }, await overTls('POST', '/api/pair/requests', { body: reqBody }))
  if (created.status !== 201) throw new Error('the request was refused: ' + JSON.stringify(created))
  const id = created.body.request_id
  const secret = { 'x-pairing-secret': created.body.poll_secret }
  const approved = await d.owner('POST', `/api/pair/requests/${id}/approve`, {})
  keep('owner_approve', 'plain', { method: 'POST', path: `/api/pair/requests/${id}/approve`, body: {} }, { status: approved.status, retry_after: null, body: approved.body })
  const waitMs = (created.body.poll_interval_seconds ?? 2) * 1000 + 300
  await sleep(waitMs)
  const pollTls = keep('poll_approved_tls', 'tls', { method: 'GET', path: `/api/pair/requests/${id}`, body: null }, await overTls('GET', `/api/pair/requests/${id}`, { headers: secret }))
  await sleep(waitMs)
  const pollPlain = keep('poll_approved_plain', 'plain', { method: 'GET', path: `/api/pair/requests/${id}`, body: null }, await overPlain('GET', `/api/pair/requests/${id}`, secret))
  await sleep(waitMs)
  const ack = keep('acknowledge_tls', 'tls', { method: 'DELETE', path: `/api/pair/requests/${id}`, body: null }, await overTls('DELETE', `/api/pair/requests/${id}`, { headers: secret }))

  const unpinned = exchanges.filter((e) => e.listener === 'tls' && e.response.pinned !== true).map((e) => e.name)
  if (unpinned.length) throw new Error('an answer over TLS came with a certificate without the daemon pin: ' + unpinned.join(', '))
  if (hello.body?.fp !== d.fp) throw new Error(`hello's fp ${hello.body?.fp} is not the daemon's ${d.fp}`)

  const fixture = {
    about:
      'Real exchanges with a real Prometheus app served the way a home-network daemon serves it (plain HTTP and its bridge, plus the same app and bridge over TLS with the instance certificate, app.state.lan_tls set), every listener on 127.0.0.1, by scripts/record-pair-tls.mjs. The requester key is pairing_seal_v1.json\'s. The daemon, its token and the device are throwaway and deleted.',
    recorded: new Date().toISOString().slice(0, 10),
    daemon: { source, module: d.module.replace(dirname(SRC), '<prometheus>') },
    ports: { plain: d.port, ws: d.wsPort, tls: d.tlsPort, tls_ws: d.tlsWsPort },
    pin: d.pin,
    fp: d.fp,
    exchanges
  }
  writeFileSync(OUT, JSON.stringify(fixture, null, 2) + '\n')
  console.log(`[record] wrote ${OUT}`)
  console.log('[record] approved over TLS, endpoints:', JSON.stringify(pollTls.body?.endpoints), 'tls:', JSON.stringify(pollTls.body?.tls))
  console.log('[record] approved over plain, endpoints:', JSON.stringify(pollPlain.body?.endpoints), 'tls:', JSON.stringify(pollPlain.body?.tls))
  console.log('[record] acknowledged:', ack.status, JSON.stringify(ack.body))
} finally {
  d.stop()
  await sleep(500)
  rmSync(d.home, { recursive: true, force: true })
  console.log('[record] scratch home deleted:', d.home)
}
