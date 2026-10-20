/**
 * Step-4 smoke: cache on the durable rowid contract. Headless / main-process
 * (ELECTRON_RUN_AS_NODE), against the live daemon.
 *
 *   npm run build && npm run smoke:step4
 *
 * Proves: (1) optimistic re-key by client_msg_id — local-<uuid> → <rowid>, exactly one row,
 * no content matching; (2) reconcile by the rowid cursor (?since), converging to 0; (3) tool
 * frames correlated by call_id; (4) content-dedup is DEAD — identical content twice yields
 * TWO distinct rows (the case the old content-dedup corrupted).
 */
import { existsSync, unlinkSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import type { ChatStreamFrame } from '@shared/ipc'
import { openCache } from './cache/db'
import { CacheRepo } from './cache/repo'
import { CacheService } from './cache/service'
import { ConnectionManager } from './connection'
import { envToken, resolveGateway } from './connection/config'

const DB_PATH = '/tmp/beacon-s4-smoke.db'
const NONCE = `${process.pid}.${Date.now()}`
const SESSION = `smoke:s4-${NONCE}` // reserved machine namespace — see step2-smoke

let failures = 0
function assert(cond: boolean, label: string): void {
  console.log(`[smoke] ${cond ? 'PASS' : 'FAIL'}  ${label}`)
  if (!cond) failures++
}
const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
function cleanDb(): void {
  for (const f of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) if (existsSync(f)) unlinkSync(f)
}
// Reply-dependent waits default to 35s; scale via env when the model backend is slow:
//   BEACON_SMOKE_REPLY_TIMEOUT_MS=360000 npm run smoke:step4
const REPLY_WAIT_MS = Number(process.env.BEACON_SMOKE_REPLY_TIMEOUT_MS ?? 35_000)

async function waitFor(pred: () => boolean, ms = REPLY_WAIT_MS, step = 500): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (pred()) return true
    await delay(step)
  }
  return pred()
}

async function main(): Promise<void> {
  cleanDb()
  const db = openCache(DB_PATH)
  const repo = new CacheRepo(db)
  // Bearer from env (the daemon enabled auth 2026-06-06): source ~/.config/prometheus/env first.
  const connection = new ConnectionManager(resolveGateway(), envToken())
  const cache = new CacheService(repo, connection)
  cache.attach()

  const toolStarts = new Map<string, string>()
  const toolEnds = new Map<string, boolean | undefined>()
  connection.on('stream', (f: ChatStreamFrame) => {
    if (f.kind === 'tool_start') toolStarts.set(f.callId, f.toolName)
    if (f.kind === 'tool_end') toolEnds.set(f.callId, f.success)
  })

  connection.start()
  await waitFor(() => cache.isConnected(), 10_000, 100)
  assert(cache.isConnected(), 'connected to daemon')

  // ── SWEEP THE PREVIOUS RUNS' LITTER ───────────────────────────────────────
  // Teardown at the END of a run cannot be relied on, and it took three tries to understand why:
  // this smoke's probe provokes a REAL agent turn, and that agent keeps working long after the
  // socket closes. Measured tails on live runs: 18s/20 messages, 90s/40, and once 372s/128. There
  // is no endpoint to stop a turn (DELETE is "forget", not cancel), so any end-of-run wait is a
  // race the smoke can lose — and silently, because a delete that lands mid-turn is undone by the
  // next write.
  //
  // So cleanup is made SELF-HEALING instead of perfect: each run purges the leftovers of earlier
  // runs, whose agents finished minutes ago and cannot resurrect them. Litter can never accumulate
  // past one run's worth, which is the property that actually matters.
  try {
    const prior = (await connection.getDaemon('/api/sessions')) as unknown
    const stale = (Array.isArray(prior) ? (prior as Array<Record<string, unknown>>) : []).filter((r) => {
      const id = String(r.session_id ?? r.id ?? '')
      // Older than 10 minutes: comfortably past the longest tail measured, and never this run.
      // BOTH prefixes: renaming the session without renaming its sweeper would orphan every
      // `desktop:s4-` session already on the daemon while the new ones went unswept.
      const mine = id.startsWith('smoke:s4-') || id.startsWith('desktop:s4-')
      return mine && id !== SESSION && Number(r.last_active ?? 0) * 1000 < Date.now() - 600_000
    })
    for (const row of stale) {
      const id = String(row.session_id ?? row.id ?? '')
      await connection.writeDaemon(`/api/sessions/${encodeURIComponent(id)}/purge`, { confirm: id }, 'POST')
    }
    if (stale.length) console.log(`[smoke] swept ${stale.length} leftover s4 session(s) from earlier runs`)
  } catch (err) {
    console.warn('[smoke] sweep of earlier runs failed (not fatal):', err instanceof Error ? err.message : err)
  }

  // ── 1. optimistic re-key by client_msg_id (local → rowid, no dup) ──────────
  console.log('\n[smoke] === 1. optimistic re-key by client_msg_id ===')
  const cmid = randomUUID()
  const BODY = `s4 re-key probe ${NONCE}`
  const p = cache.send({ sessionId: SESSION, message: BODY, clientMsgId: cmid }) // no await: capture optimistic state synchronously
  const optimistic = repo.getMessages(SESSION).filter((m) => m.content === BODY)
  assert(
    optimistic.length === 1 && optimistic[0].id.startsWith('local-') && optimistic[0].row_id === null && optimistic[0].client_msg_id === cmid,
    `optimistic row rendered: local-* row_id=null client_msg_id set (id=${optimistic[0]?.id})`
  )
  await p
  await waitFor(() => {
    const r = repo.getMessages(SESSION).find((m) => m.content === BODY)
    return !!r && r.row_id !== null
  })
  const final = repo.getMessages(SESSION).filter((m) => m.content === BODY)
  assert(final.length === 1, `exactly ONE row after echo — no dup (got ${final.length})`)
  assert(
    !!final[0] && final[0].row_id !== null && final[0].id === String(final[0].row_id),
    `transitioned local-* → rowid (id=${final[0]?.id}, row_id=${final[0]?.row_id})`
  )
  const ob = repo.outboxStatus()
  assert(ob.pending + ob.sent + ob.failed + ob.confirmed === 0, 'online send created no outbox row')

  // ── 4. identical content twice → TWO distinct rows (content-dedup DEAD) ────
  console.log('\n[smoke] === 4. identical content twice → two distinct rows ===')
  await sendAndConfirm(cache, repo, 'yes')
  await sendAndConfirm(cache, repo, 'yes')
  const yes = repo.getMessages(SESSION).filter((m) => m.role === 'user' && m.content === 'yes')
  const yesIds = yes.filter((m) => m.row_id !== null).map((m) => m.row_id)
  assert(repo.countByContent(SESSION, 'user', 'yes') === 2, `TWO 'yes' rows retained (got ${repo.countByContent(SESSION, 'user', 'yes')})`)
  assert(yesIds.length === 2 && new Set(yesIds).size === 2, `both 'yes' have DISTINCT rowids (${JSON.stringify(yesIds)})`)

  // ── 2. reconcile by rowid cursor ──────────────────────────────────────────
  console.log('\n[smoke] === 2. reconcile by rowid cursor ===')
  const wmBefore = repo.getSessionWatermark(SESSION)
  const stats1 = await cache.reconcile(SESSION)
  assert(stats1.fromWatermark === wmBefore, `reconcile cursor = stored watermark (?since=${stats1.fromWatermark}, not full GET)`)
  const stats2 = await cache.reconcile(SESSION)
  assert(stats2.pulled === 0, `consecutive reconcile is caught up: pulled 0 (got ${stats2.pulled})`)
  assert(repo.getSessionWatermark(SESSION) >= wmBefore, `watermark monotonic (${wmBefore} → ${repo.getSessionWatermark(SESSION)})`)

  // ── 3. tool call_id correlation ───────────────────────────────────────────
  console.log('\n[smoke] === 3. tool call_id correlation ===')
  await cache.send({ sessionId: SESSION, message: `Use your sessions_list tool, then reply DONE. ${NONCE}`, clientMsgId: randomUUID() })
  await waitFor(() => [...toolStarts.keys()].some((c) => toolEnds.has(c)), Math.max(60_000, REPLY_WAIT_MS), 1_000)
  const paired = [...toolStarts.keys()].filter((c) => toolEnds.has(c) && c)
  // Two different outcomes hide behind "0 pairs", and only one is a defect:
  //   no tool frames at all  -> the MODEL declined to use a tool. Nothing was proved or disproved;
  //                             failing here makes this smoke's colour depend on model mood.
  //   frames but no pairs    -> start and end did NOT share a call_id. That is the bug this checks.
  if (toolStarts.size === 0) {
    console.log('[smoke] INCONCLUSIVE  the model called no tool this run — call_id correlation untested (not a failure)')
  } else {
    assert(paired.length >= 1, `tool start↔end share a call_id (${paired.length} pair(s) from ${toolStarts.size} start(s); e.g. ${paired[0]} = ${toolStarts.get(paired[0])})`)
  }

  // ── 5. fresh-cache reconcile vs daemon-watermark poisoning (live-walk 2026-06-10) ──
  // The sidebar's sessions-list upsert pushes the DAEMON's high-water mark into the watermark
  // column BEFORE any message is cached. The reconcile cursor must be the max CACHED rowid, not
  // that column — else a never-cached session renders empty forever.
  console.log('\n[smoke] === 5. fresh-cache reconcile vs poisoned watermark ===')
  repo.upsertSessionMeta('desktop:smoke', 'desktop', 'desktop:smoke', Date.now(), 0, 999_999)
  const poisoned = await cache.reconcile('desktop:smoke')
  assert(poisoned.pulled > 0, `poisoned watermark still pulls history (pulled ${poisoned.pulled})`)
  assert(repo.getMessages('desktop:smoke').length > 0, 'messages cached despite a high pre-set watermark')

  // ── 6. content-derived auto-titles ("name the session by what's inside") ──
  console.log('\n[smoke] === 6. auto-title from first user message ===')
  const sums = await cache.listSessions()
  const mine = sums.find((s) => s.id === SESSION)
  // A title is EITHER a snippet of the first message or a model-written summary, depending on
  // whether generation finished before this listSessions call — it is a race, not a contract.
  // Five runs of this exact probe produced "s4 re-key probe 33450.17881…" (snippet) twice and
  // "S4 Re-key Probe" / "Probe Acknowledgment Without Action" (generated) as well. The original
  // assertion pinned the snippet spelling and so passed or failed on timing.
  // What IS guaranteed either way: the session gets a real title instead of showing its raw id.
  const title = (mine?.title ?? '').trim()
  assert(!!mine && title.length > 0, `session is auto-titled (got "${mine?.title}")`)
  assert(title !== SESSION, `the title is not just the session id (got "${title}")`)
  // The three PURE snippetTitle assertions that used to sit here moved to smoke:panels (beacon #87):
  // this smoke is in NEEDS_DAEMON, so CI skips it without a daemon and those pure checks never ran.
  // panels-smoke is daemon-free and always runs. What stays here is the end-to-end claim that needs
  // a real daemon — that a freshly-created session gets auto-titled at all.

  // ── report ────────────────────────────────────────────────────────────────
  console.log('\n[smoke] ========================= RESULT =========================')
  console.log(`[smoke] session rows in cache : ${repo.getMessages(SESSION).length}  (keyed by rowid; ordinal is display-only)`)
  console.log(`[smoke] outbox status         : ${JSON.stringify(repo.outboxStatus())}`)
  console.log(`[smoke] session watermark     : ${repo.getSessionWatermark(SESSION)} (max rowid)`)
  console.log(`[smoke] outcome               : ${failures === 0 ? 'PASS ✓ (rowid re-key, no content-dedup, two-row proof)' : `FAIL ✗ (${failures})`}`)
  console.log('[smoke] ===========================================================')

  // ── TEAR DOWN THE DAEMON SESSION ──────────────────────────────────────────
  // This smoke mints a REAL session on a REAL daemon (`desktop:s4-<nonce>`), one per run, and
  // never cleaned up — 23 had accumulated in the live Sessions view. The local temp db was always
  // removed; the daemon-side litter was invisible from here because the sidebar folds `desktop:`
  // rows into a collapsed pseudo-bucket.
  //
  // ORDER MATTERS, and the first version of this got it wrong: DELETE writes a tombstone with a
  // `deleted_at` watermark, and a session RESURFACES when its activity is newer than that. Deleting
  // while the socket was still open let trailing frames bump `last_active` ~7s PAST the tombstone,
  // so the session came straight back while the teardown logged success. Stop the socket first,
  // then delete. (stop() closes only the WS; REST stays usable.)
  //
  // And VERIFY by re-reading: the response body is not evidence — `DELETE` answers `{"ok": true}`
  // whether or not a tombstone was written (Prometheus#353), and a resurfaced session answers ok
  // too. The listing is the only thing that can tell those apart.
  connection.stop()

  // Closing the socket does NOT stop the daemon: it keeps working this session server-side and
  // keeps bumping `last_active` (measured: 11s and 18 messages past created_at on one run). A
  // one-shot delete therefore always races — it wins the re-read and loses to the next write,
  // which is exactly how the first two versions of this "passed" while leaving litter behind.
  // So: wait for the session to go QUIET, then delete, then confirm it STAYS gone.
  const listSessions = async (): Promise<Array<Record<string, unknown>>> => {
    const listed = (await connection.getDaemon('/api/sessions')) as unknown
    return Array.isArray(listed) ? (listed as Array<Record<string, unknown>>) : []
  }
  const findSelf = (rows: Array<Record<string, unknown>>): Record<string, unknown> | undefined =>
    rows.find((r) => String(r.session_id ?? r.id ?? '') === SESSION)
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

  // Quiet means quiet: the daemon writes in BURSTS, so `last_active` unchanged across two reads a
  // second apart is just a gap between writes — that false read is what let the previous version
  // delete mid-stream and report success. Measured tail on a real run: 37s and 24 messages after
  // the socket closed. Require the value to hold still for several consecutive reads.
  const quiesce = async (): Promise<void> => {
    let prev = Number.NaN
    let stable = 0
    for (let i = 0; i < 45; i++) {
      const row = findSelf(await listSessions())
      const active = row ? Number(row.last_active ?? 0) : -1
      if (active === prev) {
        if (++stable >= 5) return
      } else {
        stable = 0
        prev = active
      }
      await sleep(1000)
    }
  }

  try {
    let gone = false
    for (let attempt = 1; attempt <= 3 && !gone; attempt++) {
      await quiesce() // never delete while it is still being written to — the tombstone would lose
      await connection.writeDaemon(`/api/sessions/${encodeURIComponent(SESSION)}/purge`, { confirm: SESSION }, 'POST')
      await sleep(3000)
      gone = !findSelf(await listSessions())
      if (!gone) console.warn(`[smoke] teardown: ${SESSION} resurfaced after delete ${attempt}/3 — re-quiescing`)
    }
    if (gone) console.log(`[smoke] teardown: ${SESSION} is gone and STAYED gone (quiesced, deleted, re-read)`)
    else console.warn(`[smoke] teardown: ${SESSION} is still being written by its agent — left for the next run's sweep`)
  } catch (err) {
    console.warn(`[smoke] teardown FAILED for ${SESSION} — it will linger:`, err instanceof Error ? err.message : err)
  }

  db.close()
  cleanDb()
  process.exit(failures === 0 ? 0 : 1)
}

async function sendAndConfirm(cache: CacheService, repo: CacheRepo, content: string): Promise<void> {
  const cmid = randomUUID()
  await cache.send({ sessionId: SESSION, message: content, clientMsgId: cmid })
  await waitFor(() =>
    repo.getMessages(SESSION).some((m) => m.role === 'user' && m.content === content && m.client_msg_id === cmid && m.row_id !== null)
  )
}

main().catch((err) => {
  console.error('[smoke] FAILED:', err)
  process.exit(1)
})
