#!/usr/bin/env node
// record-tls-instance — what a REAL Prometheus (#721, pairing PR 5) presents in a TLS handshake, into
// src/main/fixtures/tls_instance_721.json, so smoke:tls-pin holds Beacon's pin to Prometheus's own certificate and its own
// encodings, not to an openssl certificate made to look like one.
//
//   export BEACON_SIGNED_PYTHON=<a python3.12 with Prometheus's dependencies, e.g. the notarized app's signed one>
//   export BEACON_PROMETHEUS_SRC=<prometheus clone at main, with #721>/src
//   node scripts/record-tls-instance.mjs
//
// Prometheus's own code makes the instance key and the certificate over it (instance_key, instance_cert) in a scratch home, and
// serves its own server SSL context (web/tls.server_ssl_context: TLS 1.2+, AEAD only) on 127.0.0.1 and an ephemeral port: a real
// #721 listener only runs on a home-network bind, which this never makes. Recorded: the certificate (PUBLIC: the private key
// stays in the scratch home and is deleted), the daemon's own pin (instance_spki_sha256, what GET /api/network's
// tls.spki_sha256 reports), its fp (hello's), its instance_public_key (base64url, what POST /api/pair/requests answers), and
// the protocol and cipher Node's TLS client negotiated with that context.
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import tls from 'node:tls'
import { fileURLToPath } from 'node:url'

const PY = process.env.BEACON_SIGNED_PYTHON
const SRC = process.env.BEACON_PROMETHEUS_SRC
if (!PY || !SRC) {
  console.log('[record] SKIPPED: set BEACON_SIGNED_PYTHON and BEACON_PROMETHEUS_SRC')
  process.exit(3)
}
const OUT = fileURLToPath(new URL('../src/main/fixtures/tls_instance_721.json', import.meta.url))
const home = mkdtempSync(join(tmpdir(), 'beacon-record-tls-'))
mkdirSync(join(home, 'tmp'))
// The certificate names this machine's host (instance_cert._names: socket.gethostname()); a fixed one keeps the recording's host
// name out of the repository. The certificate is still made by Prometheus's own code, over its own key.
const PYCODE = String.raw`
import base64, json, socket, ssl, sys, threading
socket.gethostname = lambda: "Recorder-Mac"
from http.server import BaseHTTPRequestHandler, HTTPServer
from prometheus.config.instance_key import ensure_instance_key, instance_public_key_der, instance_fingerprint
from prometheus.config.instance_cert import ensure_instance_certificate, instance_spki_sha256, cert_path, key_path
from prometheus.web.tls import LanTlsPlan, server_ssl_context
ensure_instance_key()
ensure_instance_certificate()
plan = LanTlsPlan(host="127.0.0.1", api_port=0, ws_port=0, certfile=cert_path(), keyfile=key_path())
ctx = server_ssl_context(plan)
fp = instance_fingerprint()
class H(BaseHTTPRequestHandler):
    def do_GET(self):
        body = json.dumps({"v": "record", "name": "TLS record", "agent": "Prometheus", "fp": fp, "pair": "approve", "tls": True}).encode()
        self.send_response(200); self.send_header("content-type", "application/json"); self.send_header("content-length", str(len(body))); self.end_headers(); self.wfile.write(body)
    def log_message(self, *a): pass
srv = HTTPServer(("127.0.0.1", 0), H)
srv.socket = ctx.wrap_socket(srv.socket, server_side=True)
print(json.dumps({"port": srv.server_address[1], "pin": instance_spki_sha256(), "fp": fp,
    "instance_public_key": base64.urlsafe_b64encode(instance_public_key_der()).decode().rstrip("="),
    "cert_pem": open(cert_path()).read()}), flush=True)
threading.Thread(target=srv.serve_forever, daemon=True).start()
sys.stdin.read()
`
const py = spawn(PY, ['-B', '-c', PYCODE], { env: { HOME: home, PATH: '/usr/bin:/bin', TMPDIR: join(home, 'tmp'), LANG: 'en_US.UTF-8', PYTHONPATH: SRC }, stdio: ['pipe', 'pipe', 'pipe'] })
let out = ''
let err = ''
py.stderr.on('data', (d) => (err = (err + d).slice(-3000)))
try {
  const info = await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('no answer from the Prometheus TLS server: ' + err)), 30000)
    py.stdout.on('data', (d) => {
      out += d
      const nl = out.indexOf('\n')
      if (nl >= 0) {
        clearTimeout(t)
        resolve(JSON.parse(out.slice(0, nl)))
      }
    })
    py.on('exit', (c) => reject(new Error(`the server exited (${c}): ${err}`)))
  })
  // A handshake with Prometheus's own server context: what Node's client negotiates, and the certificate it is shown.
  const seen = await new Promise((resolve, reject) => {
    const s = tls.connect({ host: '127.0.0.1', port: info.port, rejectUnauthorized: false, ALPNProtocols: ['http/1.1'] }, () => {
      const cert = s.getPeerX509Certificate()
      resolve({ protocol: s.getProtocol(), cipher: s.getCipher()?.standardName, presented_pem: cert?.toString() ?? null, self_signed: cert ? cert.checkIssued(cert) : null, san: cert?.subjectAltName ?? null })
      s.end()
    })
    s.on('error', reject)
  })
  const rec = {
    recorded: new Date().toISOString().slice(0, 10),
    daemon: 'Prometheus main 76134d6 (#721 TLS under #700): instance_key + instance_cert in a scratch home, web/tls.server_ssl_context on 127.0.0.1',
    pin: info.pin,
    fp: info.fp,
    instance_public_key: info.instance_public_key,
    cert_pem: info.cert_pem,
    handshake: { protocol: seen.protocol, cipher: seen.cipher, self_signed: seen.self_signed, san: seen.san, presented_is_cert_pem: seen.presented_pem?.trim() === info.cert_pem.trim() }
  }
  if (/PRIVATE KEY/.test(JSON.stringify(rec))) throw new Error('a private key would be recorded: refusing')
  const host = (await import('node:os')).hostname().split('.')[0]
  if (host && JSON.stringify(rec).includes(host)) throw new Error("this machine's host name would be recorded: refusing")
  writeFileSync(OUT, JSON.stringify(rec, null, 2) + '\n')
  console.log(JSON.stringify({ ...rec, cert_pem: `${rec.cert_pem.length} chars` }, null, 1))
} finally {
  py.kill('SIGTERM')
  rmSync(home, { recursive: true, force: true })
}
