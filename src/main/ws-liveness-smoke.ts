/**
 * ws-liveness-smoke — the half-open socket is detected and recovered from.
 *
 * Regression cover for the 2026-07-29 incident: the daemon was restarted, the
 * Mac slept, and Beacon's socket died WITHOUT a `close` event. No reconnect was
 * ever attempted and the header sat on "Connected" for ~53 hours while chat
 * replies (produced fine by the daemon) never reached the UI.
 *
 * Drives a REAL WebSocket server and a REAL GatewaySocket. To simulate a
 * half-open connection we destroy the underlying TCP socket on the SERVER side
 * without sending a close frame — the client is then holding a dead socket that
 * emits no events, exactly as after a laptop sleep.
 *
 * Run: npm run smoke:ws-liveness
 */
import { WebSocketServer } from 'ws'
import type { ConnectionState } from '@shared/ipc'
import { GatewaySocket } from './connection/ws'

let failures = 0
function check(cond: boolean, label: string): void {
  if (cond) {
    console.log(`  ok   ${label}`)
  } else {
    console.error(`  FAIL ${label}`)
    failures += 1
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function main(): Promise<void> {
  const wss = new WebSocketServer({ port: 0 })
  await new Promise<void>((r) => wss.once('listening', () => r()))
  const port = (wss.address() as { port: number }).port

  let connections = 0
  const serverSockets: import('ws').WebSocket[] = []
  wss.on('connection', (sock) => {
    connections += 1
    serverSockets.push(sock)
    // The daemon's app-level hello — GatewaySocket reports 'connected' on this.
    sock.send(JSON.stringify({ type: 'connected', timestamp: Date.now() / 1000, payload: {} }))
  })

  const states: ConnectionState[] = []
  const socket = new GatewaySocket(`ws://127.0.0.1:${port}`, {
    onState: (s) => {
      states.push(s)
    },
    onFrame: () => undefined,
    onGatewayEvent: () => undefined,
    onAuthFailure: () => undefined
  })

  console.log('\n=== ws liveness: half-open detection + recovery ===')
  socket.start()
  await sleep(300)
  check(connections === 1, 'client connected to the server')
  check(states.includes('connected'), "state reached 'connected'")

  // Simulate sleep/network death: destroy the TCP socket underneath WITHOUT a
  // close handshake. The client gets no 'close' and no 'error'.
  console.log('  … killing the underlying TCP socket (no close frame)')
  const raw = (serverSockets[0] as unknown as { _socket: { destroy(): void } })._socket
  raw.destroy()

  const beforeCount = connections
  // Without a liveness probe this would hang forever. With it: ping fails or
  // the staleness window trips, terminate() fires, backoff redials.
  // PING_INTERVAL is 20s and STALE_AFTER 45s, so allow room for the probe.
  console.log('  … waiting for the watchdog (this takes ~20-50s by design)')
  const deadline = Date.now() + 75_000
  while (connections === beforeCount && Date.now() < deadline) await sleep(500)

  check(connections > beforeCount, 'socket was re-established after the silent death')
  check(
    states.includes('reconnecting') || states.lastIndexOf('connecting') > states.indexOf('connected'),
    "status reported a non-connected state (the header stops claiming 'Connected')"
  )
  const finalState = states[states.length - 1]
  check(finalState === 'connected', `recovered to 'connected' (final state: ${finalState})`)

  socket.stop()
  wss.close()

  console.log(`\n${failures === 0 ? 'PASS' : `FAIL (${failures})`}\n`)
  process.exit(failures === 0 ? 0 : 1)
}

void main()
