/**
 * activity-frames-smoke — the daemon's liveness + error frames survive the wire
 * mapping intact.
 *
 * These two frame types are what the chat UI now depends on to show real
 * activity and real failures. If the mapping silently drops a field, the UI
 * degrades back to exactly the failure mode this work exists to kill: a turn
 * that is alive (or dead for a knowable reason) looking like blank silence.
 *
 * Drives a REAL WebSocket server + GatewaySocket, so it exercises the actual
 * parse path rather than a hand-built object.
 *
 * Run: npm run smoke:activity-frames
 */
import { WebSocketServer } from 'ws'
import type { ChatStreamFrame } from '@shared/ipc'
import { GatewaySocket } from './connection/ws'

let failures = 0
function check(cond: boolean, label: string): void {
  if (cond) console.log(`  ok   ${label}`)
  else {
    console.error(`  FAIL ${label}`)
    failures += 1
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function main(): Promise<void> {
  const wss = new WebSocketServer({ port: 0 })
  await new Promise<void>((r) => wss.once('listening', () => r()))
  const port = (wss.address() as { port: number }).port

  wss.on('connection', (sock) => {
    sock.send(JSON.stringify({ type: 'connected', timestamp: Date.now() / 1000, payload: {} }))
    // Exactly what the daemon emits (prometheus/web/ws_server.py).
    sock.send(
      JSON.stringify({
        type: 'agent_progress',
        timestamp: Date.now() / 1000,
        payload: {
          session_id: 's1',
          message_id: 'asst-1',
          phase: 'tool',
          tool_name: 'bash',
          round: 2,
          chars: 1234,
          tool_calls: 3,
          elapsed_s: 47.0
        }
      })
    )
    sock.send(
      JSON.stringify({
        type: 'error',
        timestamp: Date.now() / 1000,
        payload: {
          session_id: 's1',
          message: 'Your credit balance is too low to access the Anthropic API.',
          kind: 'billing',
          provider: 'anthropic',
          status: 400,
          hint: 'anthropic rejected the request for billing reasons. Add credits at console.anthropic.com.'
        }
      })
    )
  })

  const frames: ChatStreamFrame[] = []
  const socket = new GatewaySocket(`ws://127.0.0.1:${port}`, {
    onState: () => undefined,
    onFrame: (f) => frames.push(f),
    onGatewayEvent: () => undefined,
    onAuthFailure: () => undefined
  })

  console.log('\n=== activity + error frame mapping ===')
  socket.start()
  await sleep(600)

  const progress = frames.find((f) => f.kind === 'progress')
  check(!!progress, 'agent_progress reached the chat stream')
  if (progress && progress.kind === 'progress') {
    check(progress.sessionId === 's1', 'progress is session-scoped')
    check(progress.phase === 'tool', 'phase preserved')
    check(progress.toolName === 'bash', 'tool name preserved (drives "· bash")')
    check(progress.round === 2, 'round preserved')
    check(progress.chars === 1234, 'chars preserved')
    check(progress.elapsedS === 47, 'elapsed preserved')
  }

  const err = frames.find((f) => f.kind === 'error')
  check(!!err, 'error frame reached the chat stream (renders INLINE, not just Activity)')
  if (err && err.kind === 'error') {
    check(err.sessionId === 's1', 'error is session-scoped (attributable to a chat)')
    check(err.errKind === 'billing', 'kind preserved — the UI can branch on cause')
    check(err.provider === 'anthropic', 'provider preserved')
    check(/credit balance/.test(err.message), "provider's own words preserved")
    check(!!err.hint && /console\.anthropic\.com/.test(err.hint), 'actionable hint preserved')
  }

  socket.stop()
  wss.close()
  console.log(`\n${failures === 0 ? 'PASS' : `FAIL (${failures})`}\n`)
  process.exit(failures === 0 ? 0 : 1)
}

void main()
