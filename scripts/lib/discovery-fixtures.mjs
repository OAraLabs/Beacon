// Fixtures for the discovery probes (scripts/onboarding-discovery-probe.mjs, onboarding-path-b-probe.mjs):
// a stub hello endpoint on an EPHEMERAL loopback port (never 8005), fakes of `tailscale` and `dns-sd`, and
// real Bonjour advertisers on dns-sd's LOCAL-ONLY interface, so nothing leaves the machine and no Local
// Network prompt appears.
import { execFileSync, spawn } from 'node:child_process'
import { X509Certificate, createHash } from 'node:crypto'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { createServer as createTlsServer } from 'node:https'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const FP_A = '0123456789abcdef'
export const FP_B = 'fedcba9876543210'

// ── a stub hello endpoint on an ephemeral loopback port ─────────────────────────────────────────
/** A self-signed P-256 certificate (openssl), and its fp: the first 16 hex of its SPKI's SHA-256, what a TLS Prometheus's hello says. */
export function tlsIdentity() {
  const d = mkdtempSync(join(tmpdir(), 'discovery-fixture-tls-'))
  execFileSync('openssl', ['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', join(d, 'k')], { stdio: 'ignore' })
  execFileSync('openssl', ['req', '-new', '-x509', '-key', join(d, 'k'), '-out', join(d, 'c'), '-days', '2', '-subj', '/CN=prometheus-probe.local'], { stdio: 'ignore' })
  const key = readFileSync(join(d, 'k'), 'utf8')
  const cert = readFileSync(join(d, 'c'), 'utf8')
  rmSync(d, { recursive: true, force: true })
  const fp = createHash('sha256').update(new X509Certificate(cert).publicKey.export({ type: 'spki', format: 'der' })).digest('hex').slice(0, 16)
  return { key, cert, fp }
}

/** { tls: true }: the stub speaks TLS only, as a home-network Prometheus does (#721), and its hello's fp is its own key's. */
export function helloStub({ tls = false } = {}) {
  const id = tls ? tlsIdentity() : null
  const s = { requests: [], mode: 'ok', delayMs: 0, port: 0, server: null, fp: id?.fp ?? FP_A, hello: { v: '0.9.6', name: 'Probe Mac mini', agent: 'Atlas', fp: id?.fp ?? FP_A, pair: 'approve', ...(tls ? { tls: true } : {}) } }
  const json = (res, code, body) => (res.writeHead(code, { 'content-type': 'application/json' }), res.end(JSON.stringify(body)))
  const handler = (req, res) => {
    s.requests.push({ method: req.method, url: req.url, headers: { ...req.headers } })
    if (req.method !== 'GET' || req.url !== '/api/hello') return json(res, 404, {})
    switch (s.mode) {
      case 'ok':
        return s.delayMs ? void setTimeout(() => json(res, 200, s.hello), s.delayMs) : json(res, 200, s.hello)
      case 'hostile':
        return json(res, 200, { name: 'Evil', agent: 'x'.repeat(500), fp: 'NOTHEX', token: 's3cret-token-value', pair: 'root', v: 5, extra: { a: 1 } })
      case 'huge':
        res.writeHead(200, { 'content-type': 'application/json' })
        return res.end(`{"name":"${'a'.repeat(1_000_000)}"}`)
      case 'text':
        res.writeHead(200, { 'content-type': 'text/plain' })
        return res.end('hello world')
      case 'error':
        return json(res, 500, { error: 'boom' })
      case 'hang':
        return undefined // never answers
    }
  }
  s.server = id ? createTlsServer({ key: id.key, cert: id.cert }, handler) : createServer(handler)
  return new Promise((r) => s.server.listen(0, '127.0.0.1', () => ((s.port = s.server.address().port), r(s))))
}
export const stopStub = (s) => new Promise((r) => (s.server.closeAllConnections?.(), s.server.close(r)))
export const noCreds = (s) => helloGets(s).every((q) => !('authorization' in q.headers) && !('cookie' in q.headers) && !('x-api-key' in q.headers))
export const helloGets = (s) => s.requests.filter((q) => q.method === 'GET' && q.url === '/api/hello')

// ── fakes that live in a temp dir ───────────────────────────────────────────────────────────────
/** A `tailscale` that lists one online desktop peer (at 127.0.0.1), one offline one and a phone, touching
 *  MARKER when it runs (so a probe can prove the real CLI was not the one consulted); and a `dns-sd` that
 *  fails the way macOS refuses Local Network access. */
export function makeFakes(root) {
  const bin = join(root, 'bin')
  mkdirSync(bin, { recursive: true })
  const MARKER = join(root, 'fake-tailscale-ran')
  writeFileSync(
    join(bin, 'tailscale'),
    `#!/bin/sh\ntouch "${MARKER}"\ncat <<'JSON'\n{"BackendState":"Running","Peer":{"a":{"HostName":"probe-peer","DNSName":"probe-peer.example.internal.","OS":"linux","Online":true,"TailscaleIPs":["127.0.0.1"]},"b":{"HostName":"probe-off","DNSName":"probe-off.example.internal.","OS":"linux","Online":false,"TailscaleIPs":["127.0.0.1"]},"c":{"HostName":"probe-phone","DNSName":"probe-phone.example.internal.","OS":"iOS","Online":true,"TailscaleIPs":["127.0.0.1"]}}}\nJSON\n`
  )
  writeFileSync(join(bin, 'dns-sd-denied'), `#!/bin/sh\necho "DNSService call failed -65570" >&2\nexit 1\n`)
  for (const f of ['tailscale', 'dns-sd-denied']) chmodSync(join(bin, f), 0o755)
  return { bin, MARKER, deniedDnsSd: join(bin, 'dns-sd-denied') }
}

// ── real Bonjour advertisers, on the local-only interface ───────────────────────────────────────
export const advertisers = []
export function advertise(args) {
  const p = spawn('/usr/bin/dns-sd', ['-lo', '-t', '120', ...args], { stdio: 'ignore' })
  advertisers.push(p)
  return p
}
process.on('exit', () => advertisers.forEach((p) => p.kill('SIGTERM')))
export const stopAdvertisers = () => advertisers.splice(0).forEach((p) => p.kill('SIGTERM'))
export const dnssdChildren = () =>
  new Promise((res) => {
    const p = spawn('/bin/ps', ['-axo', 'pid=,command='], { stdio: ['ignore', 'pipe', 'ignore'] })
    let out = ''
    p.stdout.on('data', (d) => (out += d))
    p.on('exit', () => res(out.split('\n').filter((l) => /dns-sd .*-Z _prometheus\._tcp/.test(l)).length))
  })

