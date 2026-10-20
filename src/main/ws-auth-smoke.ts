// Headless smoke for the Phase-B WS first-frame-auth CLIENT logic
// (ELECTRON_RUN_AS_NODE electron out/main/ws-auth-smoke.js). Spins up a tiny in-process `ws`
// server that mimics the daemon's Phase-A contract — first frame must be {type:"auth",token:GOOD}
// or the socket is closed 4401 — and proves:
//   - probeWsAuth resolves ok / unauthorized / unreachable correctly
//   - GatewaySocket authenticates and reaches 'connected' with a good token
//   - GatewaySocket reports onAuthFailure + 'failed' and does NOT reconnect on a 4401

import { WebSocketServer, type WebSocket as WsServerSocket } from 'ws'
import { WS_CLOSE_UNAUTHORIZED } from '@shared/daemon-api'
import { probeWsAuth } from './connection/ws-probe'
import { GatewaySocket } from './connection/ws'

const GOOD = 'good-token'
const BAD = 'bad-token'

let failures = 0
function check(name: string, cond: boolean): void {
  if (cond) console.log(`  ✓ ${name}`)
  else {
    console.error(`  ✗ ${name}`)
    failures++
  }
}

/** A daemon-shaped WS server: enforces first-frame auth exactly like ws_server.py. */
function startServer(): Promise<{ url: string; close: () => void }> {
  return new Promise((resolve) => {
    const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 }, () => {
      const addr = wss.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      resolve({ url: `ws://127.0.0.1:${port}`, close: () => wss.close() })
    })
    wss.on('connection', (ws: WsServerSocket) => {
      let authed = false
      const timer = setTimeout(() => {
        if (!authed) ws.close(WS_CLOSE_UNAUTHORIZED, 'auth timeout')
      }, 1_000)
      ws.once('message', (raw) => {
        let ok = false
        try {
          const m = JSON.parse(raw.toString()) as { type?: string; token?: string }
          ok = m.type === 'auth' && m.token === GOOD
        } catch {
          ok = false
        }
        if (ok) {
          authed = true
          clearTimeout(timer)
          ws.send(JSON.stringify({ type: 'connected', payload: { version: 'smoke' } }))
        } else {
          clearTimeout(timer)
          ws.close(WS_CLOSE_UNAUTHORIZED, 'unauthorized')
        }
      })
    })
  })
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function main(): Promise<void> {
  const server = await startServer()

  console.log('probeWsAuth (Settings Test button — WS half):')
  check('good token → ok', (await probeWsAuth(server.url, GOOD)).state === 'ok')
  check('bad token → unauthorized (4401)', (await probeWsAuth(server.url, BAD)).state === 'unauthorized')
  check('no token (server requires it) → unauthorized', (await probeWsAuth(server.url, null)).state === 'unauthorized')
  check('dead gateway → unreachable', (await probeWsAuth('ws://127.0.0.1:1', GOOD, 1_500)).state === 'unreachable')

  console.log('GatewaySocket good token → connected:')
  {
    const states: string[] = []
    const sock = new GatewaySocket(
      server.url,
      {
        onState: (s) => states.push(s),
        onFrame: () => undefined,
        onGatewayEvent: () => undefined,
        onAuthFailure: () => states.push('AUTHFAIL')
      },
      GOOD
    )
    sock.start()
    await sleep(600)
    sock.stop()
    check('reached connected', states.includes('connected'))
    check('no auth failure on a good token', !states.includes('AUTHFAIL'))
  }

  console.log('GatewaySocket bad token → 4401, no reconnect:')
  {
    const states: string[] = []
    let authFails = 0
    const sock = new GatewaySocket(
      server.url,
      {
        onState: (s) => states.push(s),
        onFrame: () => undefined,
        onGatewayEvent: () => undefined,
        onAuthFailure: () => {
          authFails++
        }
      },
      BAD
    )
    sock.start()
    await sleep(900)
    const connectingCount = states.filter((s) => s === 'connecting').length
    sock.stop()
    check('onAuthFailure fired exactly once', authFails === 1)
    check('ended in failed state', states[states.length - 1] === 'failed')
    check('did NOT reconnect (single connect attempt, no retry storm)', connectingCount === 1)
    check('never reached connected with a bad token', !states.includes('connected'))
  }

  server.close()
  console.log(failures === 0 ? '\n[ws-auth-smoke] PASS' : `\n[ws-auth-smoke] FAIL (${failures})`)
  process.exit(failures === 0 ? 0 : 1)
}

void main()
