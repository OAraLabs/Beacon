// Start the REAL Prometheus app for a probe (scripts/lib/serve_real_daemon.py) and talk to it as its owner.
//
// A probe that needs this says where the Prometheus checkout is:
//   BEACON_REAL_DAEMON_SRC  <clone>/src of the branch to test (Prometheus #698 or later)
//   BEACON_REAL_DAEMON_PY   a Python that has Prometheus's dependencies (its project venv)
// Without both it answers `null`, and the probe must say it did NOT run (a skipped probe is not a passed one).
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT = fileURLToPath(new URL('./serve_real_daemon.py', import.meta.url))

const freePort = () =>
  new Promise((res, rej) => {
    const s = createServer()
    s.once('error', rej)
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address()
      s.close(() => res(port))
    })
  })

export function realDaemonConfigured() {
  return !!(process.env.BEACON_REAL_DAEMON_SRC && process.env.BEACON_REAL_DAEMON_PY)
}

/** @returns {Promise<null | {port:number, wsPort:number, token:string, fp:string, module:string, owner:Function, stop:Function}>} */
export async function startRealDaemon({ name = 'Probe Prometheus', requests = true, ttl = 300, perSource = 20, ws = true, tls = false, setupMode = false, auth = true, daemonLimits = false, wsPort: advertisedWsPort = null, home: reuseHome = null } = {}) {
  if (!realDaemonConfigured()) return null
  // reuseHome: a scratch home made by an earlier startRealDaemon, so several modes share one instance key (one fingerprint).
  const home = reuseHome ?? mkdtempSync(join(tmpdir(), 'beacon-real-daemon-'))
  const token = randomBytes(24).toString('base64url')
  // advertisedWsPort: with ws: false, the ws_port the config states (what an approval names); nothing listens on it.
  if (advertisedWsPort !== null && ws) throw new Error('startRealDaemon: wsPort is only for ws: false (nothing may listen on it)')
  const wsPort = advertisedWsPort ?? (await freePort())
  // The token is ONE argument (--token=...): one that starts with '-' (about 1 in 64 do) would otherwise be read as a flag.
  const argv = ['-X', 'utf8', SCRIPT, '--src', process.env.BEACON_REAL_DAEMON_SRC, '--home', home, `--token=${token}`, '--ws-port', String(wsPort), '--name', name, '--ttl', String(ttl), '--per-source', String(perSource)]
  if (!requests) argv.push('--no-requests')
  if (!ws) argv.push('--no-ws')
  if (setupMode) argv.push('--setup-mode')
  if (!auth) argv.push('--no-auth')
  if (daemonLimits) argv.push('--daemon-limits')
  if (tls) argv.push('--tls') // the home-network TLS listeners too, on 127.0.0.1 (serve_real_daemon.py says how)
  const child = spawn(process.env.BEACON_REAL_DAEMON_PY, argv, { stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: process.env.PATH ?? '', LANG: 'en_US.UTF-8' } })
  let err = ''
  child.stderr.on('data', (d) => (err += String(d)))
  const ready = await new Promise((res, rej) => {
    let buf = ''
    const t = setTimeout(() => rej(new Error('the real daemon did not start in 60 s:\n' + err.slice(-1500))), 60_000)
    child.stdout.on('data', (d) => {
      buf += String(d)
      const line = buf.split('\n').find((l) => l.startsWith('{'))
      if (line) {
        clearTimeout(t)
        res(JSON.parse(line))
      }
    })
    child.once('exit', (code) => rej(new Error(`the real daemon exited (${code}) before it was ready:\n` + err.slice(-1500))))
  })
  const stop = () => {
    try {
      child.stdin.end()
      child.kill('SIGTERM')
    } catch {
      /* gone */
    }
  }
  process.on('exit', stop)
  /** A request as the OWNER (the global token). Returns {status, body}. */
  const owner = async (method, path, body) => {
    const res = await fetch(`http://127.0.0.1:${ready.port}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {})
    })
    const text = await res.text()
    let json = null
    try {
      json = text ? JSON.parse(text) : null
    } catch {
      /* not JSON */
    }
    return { status: res.status, body: json }
  }
  const tlsInfo = tls ? { tlsPort: ready.tls_port, tlsWsPort: ready.tls_ws_port, pin: ready.pin } : {}
  return { port: ready.port, wsPort, token, fp: ready.fp, module: ready.module, ws: ready.ws === true, frames: ready.frames === true, home, owner, stop, ...tlsInfo }
}
