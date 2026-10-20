/**
 * socket-log-smoke — Beacon records its own socket lifecycle, durably and with
 * timestamps.
 *
 * WHAT THIS EXISTS TO PREVENT. On 2026-08-16 an approval produced six findings
 * that all reduce to one question: was the socket terminated, or did it stay
 * connected and never receive the frames? Neither end could answer. The daemon's
 * broadcast() swallowed dead-client writes with a bare `except` and no log; on
 * this side there were two console lines, one terminate path with NO log at all,
 * and nothing durable anywhere. The only Beacon-side artifact was a redirected
 * dev log carrying seven ECONNREFUSED entries and ZERO timestamps — unable, in
 * principle, to answer a question about a fifteen-minute window.
 *
 * WHAT IS PROVEN HOW, stated plainly because the two halves are not equal:
 *
 *   - REAL, end-to-end: a real WebSocketServer, a real GatewaySocket, a real
 *     SQLite file. Connecting, connected, error and reconnecting rows are
 *     observed by executing them, and read back out of the database.
 *
 *   - STRUCTURAL: the ping-failure terminate cannot be driven from a test. It
 *     fires only when ws.ping() throws on a socket the library still reports
 *     OPEN — a genuinely half-open TCP connection, which is not producible on
 *     demand. So it is pinned by construction instead: `destroy()` is the ONLY
 *     site that calls terminate(), and it logs before it does. Removing that log,
 *     or adding a bare terminate() elsewhere, turns this red. That is the
 *     mutation target, and it is exactly the path that was silent.
 *
 * Run: npm run smoke:socket-log
 */
import { readFileSync } from 'node:fs'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocketServer } from 'ws'
import { GatewaySocket } from './connection/ws'
import { openCache } from './cache/db'
import { CacheRepo } from './cache/repo'
import { SOCKET_LOG_MAX_ROWS, describeSocketEvent, type SocketEvent } from '@shared/socket-log'

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
  const dir = mkdtempSync(join(tmpdir(), 'beacon-socketlog-'))
  const repo = new CacheRepo(openCache(join(dir, 'beacon.db')))

  // ── 1. The table round-trips, WITH its timestamps ─────────────────────────
  console.log('\n=== 1. durable round-trip ===')
  const t0 = Date.now()
  repo.recordSocketEvent({ at: t0, kind: 'connecting', detail: 'ws://x' })
  repo.recordSocketEvent({ at: t0 + 10, kind: 'connected' })
  repo.recordSocketEvent({ at: t0 + 20, kind: 'terminated-ping-failed', detail: 'ping threw' })
  repo.recordSocketEvent({ at: t0 + 30, kind: 'reconnecting', attempt: 3 })

  const all = repo.getSocketEvents()
  check(all.length === 4, `four rows persisted (got ${all.length})`)
  check(all[0].kind === 'reconnecting' && all[0].attempt === 3, 'newest first, attempt preserved')
  check(
    all.every((e) => typeof e.at === 'number' && e.at > 0),
    'EVERY row carries an epoch-ms timestamp — a row that cannot be placed in time is not evidence'
  )
  check(
    repo.getSocketEvents().find((e) => e.kind === 'terminated-ping-failed')?.detail === 'ping threw',
    'the reason survives verbatim, not summarised'
  )

  // ── 2. The window question the console could not answer ───────────────────
  console.log('\n=== 2. "what happened between X and Y" ===')
  const win = repo.getSocketEventsBetween(t0 + 5, t0 + 25)
  check(win.length === 2, `window returns only what falls inside it (got ${win.length})`)
  check(win[0].kind === 'connected' && win[1].kind === 'terminated-ping-failed', 'oldest-first inside the window')
  check(repo.getSocketEventsBetween(t0 + 1000, t0 + 2000).length === 0, 'an empty window is empty, not everything')

  // ── 3. Bounded: it cannot become the thing it diagnoses ───────────────────
  console.log('\n=== 3. rolling window prunes ===')
  for (let i = 0; i < SOCKET_LOG_MAX_ROWS + 120; i++) {
    repo.recordSocketEvent({ at: t0 + 1000 + i, kind: 'reconnecting', attempt: i })
  }
  const n = repo.countSocketEvents()
  check(n === SOCKET_LOG_MAX_ROWS, `table is capped at ${SOCKET_LOG_MAX_ROWS} (got ${n})`)
  const newest = repo.getSocketEvents(1)[0]
  check(
    newest.attempt === SOCKET_LOG_MAX_ROWS + 119,
    'pruning drops the OLDEST — the newest event always survives, which is the one you came for'
  )
  check(
    repo.getSocketEvents().every((e) => e.kind === 'reconnecting'),
    'the four original rows aged out, as a rolling window must'
  )

  // ── 4. REAL socket, real server: lifecycle rows written by execution ──────
  console.log('\n=== 4. real socket → real rows ===')
  const wss = new WebSocketServer({ port: 0 })
  await new Promise<void>((r) => wss.once('listening', () => r()))
  const port = (wss.address() as { port: number }).port

  wss.on('connection', (sock) => {
    sock.send(JSON.stringify({ type: 'connected', timestamp: Date.now() / 1000, payload: {} }))
  })

  const live: SocketEvent[] = []
  const socket = new GatewaySocket(
    `ws://127.0.0.1:${port}`,
    {
      onState: () => undefined,
      onFrame: () => undefined,
      onGatewayEvent: () => undefined,
      onAuthFailure: () => undefined
    },
    null,
    (e) => live.push(e)
  )
  socket.start()
  for (let i = 0; i < 60 && !live.some((e) => e.kind === 'connected'); i++) await sleep(50)

  check(live.some((e) => e.kind === 'connecting'), "'connecting' recorded on dial")
  check(live.some((e) => e.kind === 'connected'), "'connected' recorded on the daemon's hello")
  check(
    live.every((e) => Number.isFinite(e.at) && e.at >= t0),
    'live events are timestamped too'
  )

  // Drop the server: a real close → a real reconnect, recorded with its attempt.
  wss.close()
  for (const c of wss.clients) c.terminate()
  for (let i = 0; i < 80 && !live.some((e) => e.kind === 'reconnecting'); i++) await sleep(50)
  const recon = live.find((e) => e.kind === 'reconnecting')
  check(!!recon, "'reconnecting' recorded when the link actually drops")
  check(typeof recon?.attempt === 'number' && recon.attempt >= 1, 'the attempt count is carried, not just the fact')
  socket.stop()

  console.log('  sample:')
  for (const e of live.slice(0, 4)) console.log(`    ${describeSocketEvent(e)}`)

  // ── 5. STRUCTURAL: no terminate can happen unrecorded ─────────────────────
  //
  // THE MUTATION TARGET. The ping-failure path was completely silent and cannot
  // be executed from a test, so it is pinned by shape: exactly one terminate()
  // call site, inside destroy(), which logs first.
  console.log('\n=== 5. no silent terminate (structural) ===')
  // Reads the SOURCE, not the bundle: the point is the shape of the code a human
  // will edit. This runs from out/main/, so ../../ is the repo root. If the file
  // moves, this fails loudly here rather than quietly asserting nothing.
  const wsSrcPath = new URL('../../src/main/connection/ws.ts', import.meta.url)
  let src: string
  try {
    src = readFileSync(wsSrcPath, 'utf8')
  } catch {
    check(false, `could not read ws.ts source at ${wsSrcPath.pathname} — this section asserts NOTHING until that is fixed`)
    src = ''
  }
  const terminateCalls = src.match(/\.terminate\(\)/g) ?? []
  check(
    terminateCalls.length === 1,
    `exactly ONE terminate() call site (got ${terminateCalls.length}) — a second one is a path that can destroy the socket without a record`
  )
  const destroyBody = src.slice(src.indexOf('private destroy('), src.indexOf('start(): void'))
  check(/this\.log\(/.test(destroyBody), 'destroy() logs BEFORE it terminates — remove this line and the silent path returns')
  // The >= 0 guard is load-bearing. Without it this passed while destroy() had
  // NO log at all: indexOf returned -1, and -1 < (any positive) is true, so the
  // assertion reported ordering it had never observed. Caught by mutation, and
  // it is the same defect the whole table exists to prevent — a check that
  // cannot fail looks exactly like a check that passed.
  const logAt = destroyBody.indexOf('this.log(')
  const termAt = destroyBody.indexOf('.terminate()')
  check(
    logAt >= 0 && termAt >= 0 && logAt < termAt,
    'the log is written first: after terminate() the socket is gone and a write into it raises nothing'
  )
  check(
    /terminated-ping-failed/.test(src),
    'the ping-failure path names itself distinctly — collapsing it into terminated-stale would lose the distinction this table exists to capture'
  )

  rmSync(dir, { recursive: true, force: true })
  console.log(`\n${failures === 0 ? 'PASS' : `FAIL (${failures})`}\n`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('[smoke] FAILED:', err)
  process.exit(1)
})
