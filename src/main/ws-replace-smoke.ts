/**
 * ws-replace-smoke — replacing the socket must leave exactly ONE socket.
 *
 * Regression cover for the 2026-08-19 incident: the Mac slept, `powerMonitor`
 * fired `resume`, and `ConnectionManager.reconnect()` (stop + start) left the
 * PREVIOUS socket open with its handlers still wired into handleMessage. Two
 * live sockets, one daemon: every `chat_delta` was delivered twice and the
 * reply rendered with every token doubled ("FirstFirst,, a a quick quick").
 * The durable copy was clean — the duplication was entirely on the receive side.
 *
 * The socket log caught the shape of it: `connected` at 01:10:53.716 and
 * `reconnecting` 100ms later, because the OLD socket's late `close` ran the LIVE
 * socket's cleanup — nulling `this.ws` and scheduling a phantom redial.
 *
 * Drives a REAL WebSocket server and a REAL GatewaySocket, and counts sockets on
 * the SERVER side — the client cannot be trusted to report a socket it forgot.
 *
 * Run: npm run smoke:ws-replace
 */
import { WebSocketServer, type WebSocket as ServerSocket } from 'ws'
import type { SocketEvent } from '@shared/socket-log'
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

  const live = new Set<ServerSocket>()
  wss.on('connection', (sock) => {
    live.add(sock)
    sock.on('close', () => live.delete(sock))
    sock.send(JSON.stringify({ type: 'connected', timestamp: Date.now() / 1000, payload: {} }))
  })

  let frames = 0
  const events: SocketEvent[] = []
  const socket = new GatewaySocket(
    `ws://127.0.0.1:${port}`,
    {
      onState: () => {},
      onFrame: () => {
        frames += 1
      },
      onGatewayEvent: () => {},
      onAuthFailure: () => {}
    },
    null,
    (e) => events.push(e)
  )

  /** One delta from the daemon to every socket it is holding → how many times did we process it? */
  const deliverOne = async (): Promise<number> => {
    frames = 0
    for (const s of live) s.send(JSON.stringify({ type: 'chat_delta', payload: { session_id: 's', message_id: 'm', content: 'X' } }))
    await sleep(150)
    return frames
  }

  console.log('a fresh dial:')
  socket.start()
  await sleep(300)
  check(live.size === 1, 'one socket on the server')
  check((await deliverOne()) === 1, 'one daemon delta is processed once')

  console.log('\nstop() + start() — what powerMonitor resume does on every lid open:')
  socket.stop()
  socket.start()
  // Long enough for the old socket's close to land AND any redial it schedules (backoff 1s).
  await sleep(2_500)
  check(live.size === 1, 'STILL one socket — the replaced one was destroyed, not orphaned')
  check((await deliverOne()) === 1, 'one daemon delta is STILL processed once (this is the doubling)')
  check(
    events.some((e) => e.kind === 'retired'),
    'the retirement is on the durable log — a future orphan is auditable'
  )

  console.log('\nstart() while already connected (bringUpConnection re-entry):')
  socket.start()
  await sleep(500)
  check(live.size === 1, 'redialing over a healthy socket replaces it rather than stacking')
  check((await deliverOne()) === 1, 'one daemon delta is processed once')

  console.log('\nthe recovery path still works (retiring must not break reconnect):')
  for (const s of live) s.terminate() // server-side death, like a daemon restart
  await sleep(3_000)
  check(live.size === 1, 'redialed back to exactly one socket')
  check((await deliverOne()) === 1, 'and it delivers once')

  socket.stop()
  wss.close()
  if (failures > 0) {
    console.error(`\n[ws-replace-smoke] FAILED — ${failures} check(s)`)
    process.exit(1)
  }
  console.log('\n[ws-replace-smoke] PASS')
  process.exit(0)
}

void main()
