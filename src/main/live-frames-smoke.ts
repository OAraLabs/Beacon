/**
 * live-frames-smoke — the four checks, against frames captured OFF THE WIRE.
 *
 * WHY A CAPTURED FIXTURE AND NOT A HAND-WRITTEN ONE. The hand-written test for
 * the mid-turn case asserted a sequence that never occurs: it put the progress
 * pulse last and omitted the command reply. The real order is
 * progress -> cmd-asst chat_message -> command_done, which means the reply always
 * re-arms an instant before its own terminator. The first implementation scoped
 * on that id, the unit test passed, and the design was wrong. This fixture is
 * what caught it.
 *
 * Frames replay through a real WebSocketServer + GatewaySocket, so the actual
 * parse path runs — not a hand-built ChatStreamFrame.
 *
 * Run: npm run smoke:live-frames
 */
import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocketServer } from 'ws'
import type { ChatStreamFrame } from '@shared/ipc'
import type { ConnectionManager } from './connection'
import { GatewaySocket } from './connection/ws'
import { openCache } from './cache/db'
import { CacheRepo } from './cache/repo'
import { CacheService } from './cache/service'
import { deliversToSession, nextTurnInFlight, watchdogAction } from '@shared/reply-watchdog'

let failures = 0
function check(c: boolean, l: string): void {
  if (c) console.log(`  ok   ${l}`)
  else { console.error(`  FAIL ${l}`); failures += 1 }
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const cap = JSON.parse(readFileSync(process.argv[2] ?? new URL('./live-frames.json', import.meta.url).pathname, 'utf8'))

async function replay(scn: { session_id: string; frames: Array<{ type: string; payload: unknown }> }): Promise<ChatStreamFrame[]> {
  const wss = new WebSocketServer({ port: 0 })
  await new Promise<void>((r) => wss.once('listening', () => r()))
  const port = (wss.address() as { port: number }).port
  wss.on('connection', (sock) => {
    for (const f of scn.frames) {
      if (f.type === '_LOCAL_sent') continue
      sock.send(JSON.stringify({ type: f.type, timestamp: Date.now() / 1000, payload: f.payload }))
    }
  })
  const out: ChatStreamFrame[] = []
  const socket = new GatewaySocket(`ws://127.0.0.1:${port}`, {
    onState: () => undefined, onFrame: (f) => out.push(f),
    onGatewayEvent: () => undefined, onAuthFailure: () => undefined
  })
  socket.start()
  await sleep(1200)
  socket.stop?.()
  wss.close()
  return out
}

/** ChatShell's glue, exactly as the component applies it. */
interface W { armed: boolean; turnInFlight: boolean }
function step(w: W, f: ChatStreamFrame, sessionId: string): W {
  if (!deliversToSession(f, sessionId)) return w
  const a = watchdogAction(f, w.turnInFlight)
  const turnInFlight = nextTurnInFlight(f, w.turnInFlight)
  if (a === 'stand-down') return { armed: false, turnInFlight }
  if (a === 'rearm') return { armed: true, turnInFlight }
  return { armed: w.armed, turnInFlight }
}

async function main(): Promise<void> {
  console.log('\n=== CHECK 2: toFrame maps a LIVE command_done ===')
  const a = await replay(cap.help)
  const cd = a.find((f) => f.kind === 'command_done')
  check(!!cd, 'command_done survived the real GatewaySocket parse path')
  if (cd && cd.kind === 'command_done') {
    check(cd.sessionId === cap.help.session_id, `sessionId mapped (${cd.sessionId})`)
    // Shape, not a literal id. Pinning the captured id made a re-capture look like a
    // regression: the field mapped perfectly and the assertion still went red.
    check(/^cmd-asst-\d+$/.test(cd.messageId), `messageId mapped (${cd.messageId})`)
    check(cd.commandName === 'help', `commandName mapped (${cd.commandName})`)
    check(cd.transient === true, 'transient mapped')
  }
  // THE DAEMON'S DISAMBIGUATION, ASSERTED FROM THIS SIDE. `command` was a bool on the
  // assistant chat_message and a string here — same key, consecutive frames, different
  // types. It was renamed with NO compatibility alias, because carrying both would have
  // preserved the ambiguity. If an alias ever reappears, this goes red.
  const rawCd = (cap.help.frames as Array<{ type: string; payload: Record<string, unknown> }>)
    .find((f) => f.type === 'command_done')
  const rawMsg = (cap.help.frames as Array<{ type: string; payload: Record<string, unknown> }>)
    .find((f) => f.type === 'chat_message' && f.payload.role === 'assistant')
  check(!!rawCd && !('command' in rawCd.payload), 'command_done carries NO `command` key on the wire')
  check(!!rawCd && typeof rawCd?.payload.command_name === 'string', '`command_name` is the string, and it is a string')
  check(!!rawMsg && typeof rawMsg?.payload.command === 'boolean', 'the adjacent assistant frame still carries `command` as a BOOL — the collision this rename removed')
  const asst = a.find((f) => f.kind === 'message' && f.role === 'assistant')
  check(!!asst && asst.kind === 'message' && String(asst.messageId) === String(cd && cd.kind === 'command_done' ? cd.messageId : ''),
    'the assistant reply and its terminator carry the SAME id after mapping')

  console.log('\n=== CHECK 3: the stall no longer follows /help ===')
  let w: W = { armed: true, turnInFlight: false } // the send armed it
  for (const f of a) w = step(w, f, cap.help.session_id)
  check(!w.armed, 'after the live /help exchange the watchdog is DOWN — no stall line can fire')

  console.log('\n=== CHECK 4: /steer mid-turn leaves the running turn alone ===')
  const b = await replay(cap.steer)
  const turnDone = b.find((f) => f.kind === 'done')
  const bcd = b.find((f) => f.kind === 'command_done')
  check(!!bcd && !!turnDone, 'both a command_done and the turn own chat_done were captured')
  if (bcd && bcd.kind === 'command_done' && turnDone && turnDone.kind === 'done') {
    check(bcd.messageId !== turnDone.messageId, `distinct ids: ${bcd.messageId} vs ${turnDone.messageId}`)
  }
  let t: W = { armed: true, turnInFlight: false }
  let armedAtCommandDone: boolean | null = null
  let progressAfter = 0
  let seenCd = false
  for (const f of b) {
    t = step(t, f, cap.steer.session_id)
    if (f.kind === 'command_done') { seenCd = true; armedAtCommandDone = t.armed }
    else if (seenCd && f.kind === 'progress') progressAfter += 1
  }
  check(armedAtCommandDone === true, 'MID-TURN: watchdog still ARMED immediately after the live command_done')
  check(progressAfter > 0, `the turn kept pulsing after it (${progressAfter} progress frames) — it was genuinely live`)
  check(!t.armed, 'and the turn stood its own watchdog down on its own chat_done')

  // ── CHECK 5 ────────────────────────────────────────────────────────────────
  // A slash command is answered TRANSIENTLY: the daemon persists neither side, and its user echo
  // carries client_msg_id=null with a string `cmd-user-<ms>` id (see the captured payloads above),
  // so relinkByClientMsgId cannot match the optimistic row the composer wrote. Before this check
  // existed, that row stayed in the cache with row_id NULL forever — and getMessages sorts null
  // rows LAST, so every reload re-rendered the command at the bottom of the thread as though it
  // were the newest message in the conversation. Observed in the wild 2026-08-25: a `/reset` from
  // two days earlier, sitting under a fresh turn, reading as if the app had reset itself.
  //
  // Driven through the REAL glue — the frames come off the same replayed socket as the checks
  // above, and go into a real CacheService over a real sqlite cache.
  console.log('\n=== CHECK 5: a slash command leaves NO stranded row in the cache ===')
  const dir = mkdtempSync(join(tmpdir(), 'beacon-cmdrow-'))
  const repo = new CacheRepo(openCache(join(dir, 'beacon.db')))
  const bus = new EventEmitter()
  const stubConn = {
    on: (evt: string, h: (...args: unknown[]) => void) => bus.on(evt, h),
    getStatus: () => ({ state: 'connected', gateway: 'smoke' })
  }
  new CacheService(repo, stubConn as unknown as ConnectionManager).attach()

  const sid = cap.help.session_id
  const cmdRow = repo.addOptimisticMessage(sid, 'user', '/help', randomUUID())
  const withArgs = repo.addOptimisticMessage(sid, 'user', '/help pins', randomUUID())
  const ordinary = repo.addOptimisticMessage(sid, 'user', 'an ordinary message still in flight', randomUUID())
  const pathLike = repo.addOptimisticMessage(sid, 'user', '/helpers/readme.md is the file', randomUUID())
  const queued = repo.addOptimisticMessage(sid, 'user', '/help queued while offline', randomUUID())
  repo.attachOutbox(sid, '/help queued while offline', randomUUID(), randomUUID(), queued)

  for (const f of a) bus.emit('stream', f)
  const left = new Set(repo.getMessages(sid).map((r) => r.id))

  check(!left.has(cmdRow), 'the bare /help row is gone once the daemon reports command_done')
  check(!left.has(withArgs), 'and so is the same command WITH arguments')
  check(left.has(ordinary), 'an ordinary in-flight message is untouched')
  // `/helpers/...` starts with the command's letters. Deleting on a prefix STRING match rather
  // than on the command token would eat it, and it is a real message.
  check(left.has(pathLike), 'a message merely starting "/helpers…" is NOT mistaken for /help')
  check(left.has(queued), 'an outbox-backed row survives — it is owed a retry, not a phantom')
  rmSync(dir, { recursive: true, force: true })

  console.log(`\n${failures === 0 ? 'PASS' : `FAIL (${failures})`}\n`)
  process.exit(failures === 0 ? 0 : 1)
}
void main()
