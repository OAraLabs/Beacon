/**
 * stop-interrupt-smoke — the chat_done{interrupted} mapping (P9.1, Prometheus#125).
 *
 * WHY THIS EXISTS. The daemon broadcasts chat_done{interrupted:true} when a turn is stopped — from
 * this client's Stop button or any other window. ws.ts's toFrame must carry that flag onto the
 * normalized 'done' frame so ChatShell can render an interrupted turn distinctly. A type that
 * declares the flag but a mapper that drops it is the exact #122/#123 failure class: the contract
 * looks honored and the value silently never arrives.
 *
 * WHY A SYNTHETIC REPLAY, NOT the captured live-frames.json. That fixture's rule is "NEVER
 * hand-edit — re-capture", and its value is preserving real wire ORDER for the watchdog re-arm
 * subtlety. This flag has no ordering subtlety: it is one boolean on one terminal frame. So the
 * frames are constructed inline and replayed through the SAME real GatewaySocket parse path the
 * live fixture uses — the actual code under test runs, not a hand-built ChatStreamFrame.
 *
 * Run: npm run smoke:stop-interrupt
 */
import { WebSocketServer } from 'ws'
import type { ChatStreamFrame } from '@shared/ipc'
import { GatewaySocket } from './connection/ws'

let failures = 0
function check(c: boolean, l: string): void {
  if (c) console.log(`  ok   ${l}`)
  else { console.error(`  FAIL ${l}`); failures += 1 }
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function replay(frames: Array<{ type: string; payload: unknown }>): Promise<ChatStreamFrame[]> {
  const wss = new WebSocketServer({ port: 0 })
  await new Promise<void>((r) => wss.once('listening', () => r()))
  const port = (wss.address() as { port: number }).port
  wss.on('connection', (sock) => {
    for (const f of frames) {
      sock.send(JSON.stringify({ type: f.type, timestamp: Date.now() / 1000, payload: f.payload }))
    }
  })
  const out: ChatStreamFrame[] = []
  const socket = new GatewaySocket(`ws://127.0.0.1:${port}`, {
    onState: () => undefined,
    onFrame: (f) => out.push(f),
    onGatewayEvent: () => undefined,
    onAuthFailure: () => undefined
  })
  socket.start()
  await sleep(800)
  socket.stop?.()
  wss.close()
  return out
}

async function main(): Promise<void> {
  const sid = 'beacon:sess'

  console.log('\n=== an INTERRUPTED chat_done carries interrupted:true onto the frame ===')
  const stopped = await replay([
    { type: 'chat_delta', payload: { session_id: sid, message_id: 'm1', content: 'partial answer' } },
    // The daemon's interrupt-path payload (ws_server.py:1331): session_id, message_id,
    // interrupted:true, and row_id when the partial turn persisted.
    { type: 'chat_done', payload: { session_id: sid, message_id: 'm1', interrupted: true, row_id: 42 } }
  ])
  const done = stopped.find((f) => f.kind === 'done')
  check(!!done, 'the interrupted chat_done mapped to a done frame')
  if (done && done.kind === 'done') {
    check(done.interrupted === true, 'done.interrupted === true (the mapper carried the flag)')
    check(done.messageId === 'm1', 'and it kept the message id the row keys on')
  }

  console.log('\n=== a NORMAL chat_done does NOT gain an interrupted key ===')
  // Byte-identical to the pre-#125 shape for the common case: an ordinary finish must not start
  // rendering as "stopped". This is the refusal-direction assertion — a mapper that set
  // interrupted:true unconditionally would pass the check above and fail here.
  const normal = await replay([
    { type: 'chat_delta', payload: { session_id: sid, message_id: 'm2', content: 'full answer' } },
    { type: 'chat_done', payload: { session_id: sid, message_id: 'm2', row_id: 43 } }
  ])
  const ndone = normal.find((f) => f.kind === 'done')
  check(!!ndone, 'the normal chat_done mapped to a done frame')
  if (ndone && ndone.kind === 'done') {
    check(ndone.interrupted === undefined, 'done.interrupted is UNDEFINED on a normal finish (not false, not true)')
  }

  console.log('\n=== an OLDER daemon that omits interrupted is unaffected ===')
  // A pre-interrupt daemon sends chat_done with no interrupted key at all. The mapping must not
  // invent one — absence stays absence, so old daemons render exactly as before.
  const legacy = await replay([{ type: 'chat_done', payload: { session_id: sid, message_id: 'm3' } }])
  const ldone = legacy.find((f) => f.kind === 'done')
  check(!!ldone && ldone.kind === 'done' && ldone.interrupted === undefined, 'a legacy chat_done maps with no interrupted key')

  console.log('\n===================== RESULT =====================')
  if (failures > 0) {
    console.error(`stop-interrupt smoke: FAIL ✗ (${failures})`)
    process.exit(1)
  }
  console.log('stop-interrupt smoke: PASS ✓ (interrupted carried; normal + legacy untouched)')
}

void main()
