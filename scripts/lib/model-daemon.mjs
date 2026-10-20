// A REAL configured Prometheus for the main-model recorder and probe (Prometheus #737: GET/PUT /api/model, POST
// /api/model/check-key), and the world around it, so that nothing leaves this Mac:
//
//   * a stand-in provider and OpenRouter on one loopback server. Prometheus's key check is pointed at it by a sitecustomize in
//     a scratch folder (key_check's three addresses are module constants; the O9 probe does the same), and Beacon's OpenRouter
//     sign-in by BEACON_OPENROUTER_BASE. Which keys it accepts, and whether an OpenRouter account has credit, is set per call;
//   * every daemon under an mDNS sandbox (sandbox-exec refusing *:5353), proved by a send that must be refused first;
//   * a listen tripwire: each daemon's listening sockets read every 150 ms, one on anything but 127.0.0.1 kills its process
//     group and is reported. It proves itself with a planted [::1] listener before any daemon starts;
//   * scratch homes, loopback, ephemeral ports (never 8005/8006/8010/8011).
//
// The daemon is set up the way an install is: setup mode, pair, configure (Anthropic), complete, then started again from its
// own file. The setup credential stays the operator's (the master token).
//
//   BEACON_SIGNED_PYTHON   a python with Prometheus's dependencies (its project venv)
//   BEACON_PROMETHEUS_SRC  <prometheus tree with #737>/src
import { spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
export async function until(fn, ms, every = 200) {
  const end = Date.now() + ms
  for (;;) {
    const v = await fn()
    if (v || Date.now() > end) return v
    await sleep(every)
  }
}
const freePort = () => new Promise((res) => { const s = createNetServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)) }) })

export function modelDaemonConfigured() {
  return !!(process.env.BEACON_SIGNED_PYTHON && process.env.BEACON_PROMETHEUS_SRC)
}

/** Keys the stand-in accepts look like these; anything else is refused (401). */
export const GOOD = {
  anthropic: 'sk-ant-api03-probe' + 'a'.repeat(40),
  openai: 'sk-proj-probe' + 'b'.repeat(40),
  openrouter: 'sk-or-v1-probe' + 'c'.repeat(40)
}

/** The world: guards proved, the stand-in up. Returns { stub, STUB, configured(), stopAll(), tripped }. Exits 2 if a guard fails. */
export async function startWorld() {
  const PY = process.env.BEACON_SIGNED_PYTHON
  const SRC = process.env.BEACON_PROMETHEUS_SRC
  if (!readFileSync(join(SRC, 'prometheus/web/model_routes.py'), 'utf8').includes('@app.put("/api/model")')) {
    console.log('[world] REFUSED: BEACON_PROMETHEUS_SRC has no PUT /api/model (Prometheus #737)')
    process.exit(2)
  }
  const root = mkdtempSync(join(tmpdir(), 'beacon-main-model-'))
  const SANDBOX = join(root, 'mdns.sb')
  writeFileSync(SANDBOX, '(version 1)\n(allow default)\n(deny network-outbound (remote ip "*:5353"))\n')
  const selfTest = spawnSync('/usr/bin/sandbox-exec', ['-f', SANDBOX, PY, '-B', '-c', 'import socket\ns = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)\ntry:\n    s.sendto(b"x", ("224.0.0.251", 5353)); print("sent")\nexcept OSError:\n    print("refused")'], { encoding: 'utf8' })
  if (selfTest.stdout.trim() !== 'refused') {
    console.log(`[world] REFUSED: the mDNS sandbox did not refuse a send (${selfTest.stdout.trim() || selfTest.stderr.trim()})`)
    process.exit(2)
  }

  // ── the tripwire ──────────────────────────────────────────────────────────────────────────────────────────────────────
  const procs = []
  const tripped = []
  const listening = (pid) => (spawnSync('/usr/sbin/lsof', ['-nP', '-a', '-iTCP', '-sTCP:LISTEN', '-g', String(pid), '-Fn'], { encoding: 'utf8' }).stdout ?? '').split('\n').filter((l) => l.startsWith('n')).map((l) => l.slice(1))
  const tripwire = setInterval(() => {
    for (const p of procs) {
      if (p.exitCode !== null || p.signalCode !== null) continue
      const wide = listening(p.pid).filter((n) => !n.startsWith('127.0.0.1:'))
      if (wide.length > 0) {
        try { process.kill(-p.pid, 'SIGKILL') } catch { /* gone */ }
        tripped.push(wide.join(' '))
        console.log(`[world] TRIPWIRE: a daemon listened on ${wide.join(', ')}; killed`)
      }
    }
  }, 150)
  {
    const planted = spawn(PY, ['-B', '-c', 'import socket, time\ns = socket.socket(socket.AF_INET6, socket.SOCK_STREAM)\ns.bind(("::1", 0)); s.listen(1); time.sleep(30)'], { stdio: 'ignore', detached: true })
    procs.push(planted)
    const end = Date.now() + 5000
    while (planted.exitCode === null && planted.signalCode === null && Date.now() < end) await sleep(100)
    const caught = planted.signalCode === 'SIGKILL' && tripped.length === 1 && tripped[0].startsWith('[::1]:')
    procs.splice(procs.indexOf(planted), 1)
    tripped.length = 0
    if (!caught) {
      try { process.kill(-planted.pid, 'SIGKILL') } catch { /* gone */ }
      clearInterval(tripwire)
      console.log('[world] REFUSED: the tripwire did not catch a planted listener on [::1]')
      process.exit(2)
    }
  }
  console.log('[world] guards: mDNS sandbox and tripwire each proved before use')

  // ── the stand-in provider + OpenRouter ────────────────────────────────────────────────────────────────────────────────
  const stub = { requests: [], issued: [], credit: true, accept: new Set(Object.values(GOOD)) }
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      const auth = String(req.headers.authorization ?? req.headers['x-api-key'] ?? '')
      stub.requests.push({ method: req.method, path: req.url, auth, body })
      const bare = auth.replace(/^Bearer /, '')
      const json = (code, o) => (res.writeHead(code, { 'content-type': 'application/json' }), res.end(JSON.stringify(o)))
      // OpenRouter's PKCE exchange: a fresh key per code, accepted from then on.
      if (req.method === 'POST' && req.url === '/api/v1/auth/keys') {
        const key = 'sk-or-v1-probe' + randomBytes(24).toString('hex')
        stub.issued.push({ key, body: JSON.parse(body || '{}') })
        stub.accept.add(key)
        return json(200, { key })
      }
      if (req.method === 'GET' && req.url === '/api/v1/key') return stub.accept.has(bare) ? json(200, { data: { label: 'probe' } }) : json(401, { error: 'no' })
      if (req.method === 'POST' && req.url === '/api/v1/chat/completions') return stub.credit ? json(200, { choices: [{ message: { content: 'hi' } }] }) : json(402, { error: { message: 'Insufficient credits' } })
      if (req.method === 'GET' && req.url === '/v1/models') return stub.accept.has(bare) ? json(200, { data: [] }) : json(401, { error: { type: 'authentication_error' } })
      json(404, {})
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const STUB = `http://127.0.0.1:${server.address().port}`
  const site = join(root, 'site')
  mkdirSync(site)
  writeFileSync(join(site, 'sitecustomize.py'), `import os\nbase = os.environ.get('BEACON_PROBE_PROVIDER_BASE')\nif base:\n    import prometheus.providers.key_check as kc\n    kc._OPENROUTER = base + '/api/v1'\n    kc._ANTHROPIC = base + '/v1'\n    kc._OPENAI = base + '/v1'\n`)

  async function stop(p) {
    if (p.exitCode !== null || p.signalCode !== null) return
    try { process.kill(-p.pid, 'SIGTERM') } catch { /* gone */ }
    if (!(await until(() => p.exitCode !== null || p.signalCode !== null, 15000))) try { process.kill(-p.pid, 'SIGKILL') } catch { /* gone */ }
  }

  /** A configured Prometheus (Anthropic, its key GOOD.anthropic), started from its own file. */
  async function configured() {
    const api = await freePort()
    const ws = await freePort()
    if ([api, ws].some((p) => [8005, 8006, 8010, 8011].includes(p))) throw new Error('refusing the real ports')
    const home = join(root, `home-${api}`)
    mkdirSync(join(home, 'tmp'), { recursive: true })
    const base = { HOME: home, PATH: '/usr/bin:/bin', TMPDIR: join(home, 'tmp'), LANG: 'en_US.UTF-8', PYTHONPATH: `${site}:${SRC}`, PROMETHEUS_INSTALL_KIND: 'app', BEACON_PROBE_PROVIDER_BASE: STUB }
    const start = (env) => {
      const p = spawn('/usr/bin/sandbox-exec', ['-f', SANDBOX, PY, '-B', '-m', 'prometheus', 'daemon'], { env: { ...base, ...env }, stdio: 'ignore', detached: true })
      procs.push(p)
      return p
    }
    const call = async (method, path, body, token) => {
      try {
        const res = await fetch(`http://127.0.0.1:${api}${path}`, { method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(body !== undefined ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}), signal: AbortSignal.timeout(20000) })
        const text = await res.text()
        let json = null
        try { json = JSON.parse(text) } catch { /* not JSON */ }
        return { status: res.status, json }
      } catch {
        return { status: 0, json: null }
      }
    }
    let p = start({ PROMETHEUS_WEB_BIND: '127.0.0.1', PROMETHEUS_WEB_API_PORT: String(api), PROMETHEUS_WEB_WS_PORT: String(ws) })
    if (!(await until(async () => (await call('GET', '/api/setup/status')).status === 200, 60000))) throw new Error('setup mode did not answer')
    const secret = join(home, 'Library/Application Support/Prometheus/pairing/pair.secret')
    await until(() => existsSync(secret), 5000)
    const master = (await call('POST', '/api/setup/pair', { code: readFileSync(secret, 'utf8').trim() })).json?.token
    if (!master) throw new Error('no master token')
    const conf = await call('POST', '/api/setup/configure', { provider: 'anthropic', model: 'claude-sonnet-5', api_key: GOOD.anthropic }, master)
    if (conf.status !== 200) throw new Error(`configure: ${conf.status} ${JSON.stringify(conf.json)}`)
    await call('POST', '/api/setup/complete', {}, master)
    if (!(await until(async () => (await call('GET', '/api/status', undefined, master)).status === 200, 60000))) throw new Error('did not come up configured')
    await stop(p)
    p = start({}) // as an installed daemon starts: the file decides the address (127.0.0.1 for a new install)
    if (!(await until(async () => (await call('GET', '/api/status', undefined, master)).status === 200, 60000))) throw new Error('did not restart from its config')
    const device = (await call('POST', '/api/devices', { name: 'Probe phone', platform: 'ios' }, master)).json?.token
    return { p: () => p, api, ws, home, call, master, device, listening: () => listening(p.pid) }
  }

  /** A stand-in llama.cpp server on loopback (the probe can stop it and start it again on the same port): what a local model's
   *  box answers to Prometheus's setup and its reachability check. */
  const llama = { port: 0, server: null }
  const llamaHandler = (req, res) => {
    const j = (code, body) => (res.writeHead(code, { 'content-type': 'application/json' }), res.end(JSON.stringify(body)))
    if (req.url === '/props') return j(200, { default_generation_settings: { n_ctx: 32768 }, modalities: { vision: false }, model_path: 'stand-in.gguf' })
    if (req.url === '/v1/models' || req.url === '/models') return j(200, { object: 'list', data: [{ id: 'stand-in', object: 'model' }] })
    if (req.url === '/health') return j(200, { status: 'ok' })
    return j(404, {})
  }
  llama.start = () => new Promise((r) => { llama.server = createServer(llamaHandler); llama.server.listen(llama.port, '127.0.0.1', () => { llama.port = llama.server.address().port; r(llama.port) }) })
  llama.stop = () => new Promise((r) => { if (!llama.server) return r(); llama.server.closeAllConnections?.(); llama.server.close(() => r()); llama.server = null })

  /** A Prometheus whose main model is a LOCAL server (llama.cpp, the stand-in above), set up the way a pip install's fast path does
   *  (`setup --noninteractive --probe-url`, the firstlight harness's recipe), its web ports moved off the defaults, started from its own
   *  file. Returns the same shape as configured(), with `master` the web API token `token show` prints. */
  async function localConfigured() {
    if (!llama.server) await llama.start()
    const api = await freePort()
    const ws = await freePort()
    if ([api, ws].some((p) => [8005, 8006, 8010, 8011].includes(p))) throw new Error('refusing the real ports')
    const home = join(root, `home-local-${api}`)
    mkdirSync(join(home, 'tmp'), { recursive: true })
    const base = { HOME: home, PATH: '/usr/bin:/bin', TMPDIR: join(home, 'tmp'), LANG: 'en_US.UTF-8', PYTHONPATH: `${site}:${SRC}`, PYTHONUNBUFFERED: '1', TERM: 'dumb' }
    const cli = (args) => spawnSync('/usr/bin/sandbox-exec', ['-f', SANDBOX, PY, '-B', '-m', 'prometheus', ...args], { env: base, encoding: 'utf8', timeout: 180_000 })
    // Asynchronously: the stand-in server lives in THIS process, and a spawnSync would block the event loop it answers on.
    const setup = await new Promise((resolve) => {
      const c = spawn('/usr/bin/sandbox-exec', ['-f', SANDBOX, PY, '-B', '-m', 'prometheus', 'setup', '--noninteractive', '--timeout', '3', '--probe-url', `http://127.0.0.1:${llama.port}`], { env: base, stdio: ['ignore', 'pipe', 'pipe'] })
      let out = ''
      c.stdout.on('data', (b) => (out += b))
      c.stderr.on('data', (b) => (out += b))
      c.on('exit', (status) => resolve({ status, stdout: out, stderr: '' }))
    })
    const cfgPath = join(home, '.prometheus/prometheus.yaml')
    if (setup.status !== 0 || !existsSync(cfgPath)) throw new Error(`local setup failed (${setup.status}): ${(setup.stdout ?? '') + (setup.stderr ?? '')}`.slice(0, 1500))
    let cfg = readFileSync(cfgPath, 'utf8')
    if (!cfg.includes(`127.0.0.1:${llama.port}`)) throw new Error('local setup did not point at the stand-in server')
    for (const [old, now] of [['api_port: 8005', `api_port: ${api}`], ['ws_port: 8010', `ws_port: ${ws}`]]) {
      if (cfg.split(old).length !== 2) throw new Error(`expected one "${old}" in the config`)
      cfg = cfg.replace(old, now)
    }
    writeFileSync(cfgPath, cfg)
    const call = async (method, path, body, token) => {
      try {
        const res = await fetch(`http://127.0.0.1:${api}${path}`, { method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(20000) })
        const text = await res.text()
        let json = null
        try { json = JSON.parse(text) } catch { /* not JSON */ }
        return { status: res.status, json }
      } catch {
        return { status: 0, json: null }
      }
    }
    const p = spawn('/usr/bin/sandbox-exec', ['-f', SANDBOX, PY, '-B', '-m', 'prometheus', 'daemon'], { env: { ...base, PROMETHEUS_WEB_BIND: '127.0.0.1' }, stdio: 'ignore', detached: true })
    procs.push(p)
    if (!(await until(async () => (await call('GET', '/api/hello')).status === 200, 90000))) throw new Error('the local daemon did not answer')
    const bootedAt = Date.now()
    const master = (cli(['token', 'show']).stdout ?? '').split('\n')[0].trim()
    if (!/^[A-Za-z0-9_-]{20,}$/.test(master)) throw new Error('no token from `token show`')
    return { p: () => p, api, ws, home, call, master, bootedAt, listening: () => listening(p.pid) }
  }

  async function stopAll() {
    await llama.stop()
    for (const p of procs) await stop(p)
    clearInterval(tripwire)
    server.close()
    const alive = procs.filter((p) => p.exitCode === null && p.signalCode === null).length
    rmSync(root, { recursive: true, force: true })
    return { alive, tripped: tripped.slice() }
  }
  return { stub, STUB, configured, localConfigured, llama, stopAll, tripped }
}
