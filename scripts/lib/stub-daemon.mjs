// A stub Prometheus for probes that need a CONNECTED app, on EPHEMERAL loopback ports (never 8005/8010, so
// another session's daemon is untouched and a probe never talks to it).
//
// It answers what the first message needs and nothing more: the hello (discovery), sessions, chat/send, a
// session's messages, and a WebSocket that stays open. No authentication: a daemon with no token set accepts
// everyone, and a probe that stores no credential has nothing to leak.
//
// `mode` decides what a sent message gets:
//   reply  an assistant message after `replyDelayMs`;
//   never  none, until release() pushes one (a slow model);
//   error  HTTP 500 on chat/send.
//   flaky  set pollFailures = n and the next n asks for a session's messages fail with HTTP 500.
// stop() frees both ports (the computer went away); start() listens again on the SAME ports.
import { createServer } from 'node:http'
import { WebSocketServer } from 'ws'

export async function stubDaemon({ name = 'Probe Mac mini', agent = 'Atlas', fp = '0123456789abcdef' } = {}) {
  const d = { mode: 'reply', replyDelayMs: 300, pollFailures: 0, profile: 'hello', apiPort: 0, wsPort: 0, requests: [], sessions: new Map(), sends: [], created: [], http: null, ws: null, timers: [] }
  const json = (res, code, body) => (res.writeHead(code, { 'content-type': 'application/json' }), res.end(JSON.stringify(body)))
  const reply = (sid, message) => {
    const s = d.sessions.get(sid)
    if (s) s.messages.push({ role: 'assistant', content: `Hello! I'm ${agent}. You said: ${message}` })
  }
  const handle = (req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      const url = new URL(req.url, `http://127.0.0.1:${d.apiPort}`)
      d.requests.push({ method: req.method, path: url.pathname, headers: { ...req.headers }, body })
      const input = (() => { try { return JSON.parse(body || '{}') } catch { return {} } })()
      // What a Prometheus on this Mac answers WITHOUT a credential, by `profile` (settled with the installer session):
      //   hello       GET /api/hello (the discovery hello, P5);
      //   setup       a daemon in setup mode: GET /api/setup/status, with a `version` field;
      //   configured  a running daemon: every /api/ route is 401 {"error":"unauthorized ..."};
      //   none        nothing answers (404).
      if (url.pathname === '/api/hello' && req.method === 'GET') return d.profile === 'hello' ? json(res, 200, { v: '0.9.6', name, agent, fp, pair: 'approve' }) : json(res, 404, {})
      if (url.pathname === '/api/setup/status' && req.method === 'GET') {
        if (d.profile === 'setup') return json(res, 200, { setup_mode: true, configured: false, pairing: 'available', version: '0.9.6' })
        if (d.profile === 'configured') return json(res, 401, { error: 'unauthorized — set Authorization: Bearer <token>' })
        return json(res, 404, {})
      }
      if (url.pathname === '/api/status' && d.profile === 'configured' && !('authorization' in req.headers)) return json(res, 401, { error: 'unauthorized — set Authorization: Bearer <token>' })
      if (url.pathname === '/api/status') return json(res, 200, { status: 'ok', model: 'stub-model' })
      if (url.pathname === '/api/sessions' && req.method === 'GET')
        return json(res, 200, { sessions: [...d.sessions.entries()].map(([id, s]) => ({ session_id: id, id, gateway: s.gateway, title: s.messages[0]?.content ?? '', updated_at: Date.now() / 1000 })) })
      if (url.pathname === '/api/sessions' && req.method === 'POST') {
        const id = `s${d.sessions.size + 1}`
        d.sessions.set(id, { gateway: input.gateway, messages: [] })
        d.created.push({ id, gateway: input.gateway })
        return json(res, 200, { session_id: id })
      }
      if (url.pathname === '/api/chat/send' && req.method === 'POST') {
        const s = d.sessions.get(input.session_id)
        if (!s) return json(res, 404, { error: 'no such session' })
        if (d.mode === 'error') return json(res, 500, { error: 'boom' })
        s.messages.push({ role: 'user', content: input.message })
        d.sends.push({ session: input.session_id, message: input.message })
        if (d.mode === 'reply') d.timers.push(setTimeout(() => reply(input.session_id, input.message), d.replyDelayMs))
        return json(res, 200, { run_id: `r${d.sends.length}`, status: 'queued' })
      }
      const m = /^\/api\/sessions\/([^/]+)\/messages$/.exec(url.pathname)
      if (m && req.method === 'GET') {
        // A flaky network: the next `pollFailures` asks for the messages fail.
        if (d.pollFailures > 0) return (d.pollFailures--, json(res, 500, { error: 'flaky' }))
        return json(res, 200, { messages: d.sessions.get(m[1])?.messages ?? [] })
      }
      return json(res, 404, { error: 'not_found' })
    })
  }
  d.start = async () => {
    d.http = createServer(handle)
    await new Promise((r) => d.http.listen(d.apiPort, '127.0.0.1', r))
    d.apiPort = d.http.address().port
    d.ws = new WebSocketServer({ host: '127.0.0.1', port: d.wsPort })
    await new Promise((r) => d.ws.once('listening', r))
    d.wsPort = d.ws.address().port
    d.ws.on('connection', (sock) => sock.send(JSON.stringify({ type: 'connected' })))
  }
  d.stop = async () => {
    for (const t of d.timers.splice(0)) clearTimeout(t)
    if (d.ws) {
      for (const c of d.ws.clients) c.terminate()
      await new Promise((r) => d.ws.close(r))
      d.ws = null
    }
    if (d.http) {
      d.http.closeAllConnections?.()
      await new Promise((r) => d.http.close(r))
      d.http = null
    }
  }
  /** Push the assistant's answer to everything sent so far (the slow model finally answers). */
  d.release = () => d.sends.forEach((s) => reply(s.session, s.message))
  d.count = (path, method = 'GET') => d.requests.filter((q) => q.path === path && q.method === method).length
  await d.start()
  return d
}
