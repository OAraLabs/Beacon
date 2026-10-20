/**
 * Step-2 connection smoke. Drives the REAL main-process connection layer against the LOCAL
 * Prometheus daemon: subscribe to `:8010`, POST a clearly-marked message to `:8005`, and
 * confirm the streamed reply arrives end-to-end. Headless-friendly — logs everything.
 *
 *   npm run build && npm run smoke:step2
 *   (runs out/main/step2-smoke.js under ELECTRON_RUN_AS_NODE, i.e. Electron's Node runtime)
 */
import { ConnectionManager } from './connection'
import { envToken, resolveGateway } from './connection/config'
import type { ChatStreamFrame, ConnectionStatus } from '@shared/ipc'

// `smoke:` is the daemon's reserved machine namespace (Prometheus memory/session_kind.py). This
// read `desktop:smoke`, which is indistinguishable from a real desktop chat — so every run left a
// session that retention could only treat as a CONVERSATION and hold for 90 days.
const SESSION = 'smoke:step2'
const BODY = 'desktop step-2 smoke — reply OK'
const CONNECT_TIMEOUT_MS = 8_000
// Default 90s; override via env when the model backend is slow (remote ollama turns can take
// minutes with a full LCM context): BEACON_SMOKE_REPLY_TIMEOUT_MS=360000 npm run smoke:step2
const REPLY_TIMEOUT_MS = Number(process.env.BEACON_SMOKE_REPLY_TIMEOUT_MS ?? 90_000)

async function main(): Promise<void> {
  // Bearer from env (the daemon enabled auth 2026-06-06): source ~/.config/prometheus/env first.
  const cm = new ConnectionManager(resolveGateway(), envToken())
  const transitions: string[] = []
  let assembled = ''
  let settled = false
  let resolveReply!: () => void
  const replyDone = new Promise<void>((r) => (resolveReply = r))
  const settle = (): void => {
    if (settled) return
    settled = true
    resolveReply()
  }

  cm.on('status', (s: ConnectionStatus) => {
    transitions.push(s.state)
    console.log(`[smoke] status → ${s.state}${s.attempt ? ` (attempt ${s.attempt})` : ''} @ ${s.gateway}`)
  })

  cm.on('stream', (f: ChatStreamFrame) => {
    // The :8010 stream is global; attribute frames to our session (frames without a
    // session_id are kept — see Step 0.C).
    if ('sessionId' in f && f.sessionId && f.sessionId !== SESSION) return
    switch (f.kind) {
      case 'delta':
        assembled += f.content
        process.stdout.write(`[smoke] Δ ${JSON.stringify(f.content)}\n`)
        break
      case 'message':
        console.log(`[smoke] full message (${f.role}): ${JSON.stringify(f.content.slice(0, 200))}`)
        if (f.role !== 'user') {
          assembled = f.content
          settle()
        }
        break
      case 'done':
        console.log(`[smoke] chat_done (message_id=${f.messageId})`)
        settle()
        break
      case 'tool_start':
        console.log(`[smoke] tool_start: ${f.toolName}`)
        break
      case 'tool_end':
        console.log(`[smoke] tool_end: ${f.callId} ${f.success === false ? 'FAIL' : 'ok'}`)
        break
    }
  })

  cm.start()
  await waitUntil(() => transitions.includes('connected'), CONNECT_TIMEOUT_MS, 'WS connect')
  console.log(`[smoke] connected — POST /api/chat/send  session=${SESSION}  body=${JSON.stringify(BODY)}`)

  const res = await cm.send({ sessionId: SESSION, message: BODY })
  console.log(`[smoke] send accepted: runId=${res.runId} status=${res.status}`)

  const timedOut = await Promise.race([
    replyDone.then(() => false),
    delay(REPLY_TIMEOUT_MS).then(() => true)
  ])

  console.log('\n[smoke] ===================== RESULT =====================')
  console.log(`[smoke] status transitions : ${transitions.join(' → ')}`)
  console.log(`[smoke] reply (${assembled.length} chars)  : ${assembled || '(none received)'}`)
  console.log(`[smoke] outcome            : ${assembled ? 'PASS ✓' : timedOut ? 'TIMEOUT ✗' : 'NO REPLY ✗'}`)
  console.log('[smoke] ===================================================')

  cm.stop()
  process.exit(assembled ? 0 : 3)
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

async function waitUntil(pred: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label} (${timeoutMs}ms)`)
    await delay(100)
  }
}

main().catch((err) => {
  console.error('[smoke] FAILED:', err)
  process.exit(1)
})
