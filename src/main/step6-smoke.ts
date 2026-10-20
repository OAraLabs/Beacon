/**
 * Step-6 smoke (headless / ELECTRON_RUN_AS_NODE). Verifies the LOGIC layer CC can prove without
 * a display: tray-status derivation, shouldNotify() decision table, unread math, and the
 * sessions:list cache↔daemon reconcile. The visual tray/notification/sidebar is a hands-on display run.
 *
 *   npm run build && npm run smoke:step6
 *
 * Live-daemon smoke (excluded from CI). Against a bearer-gated daemon, pass
 * the token or the connection is refused (that's the point):
 *   set -a; . ~/.config/prometheus/env; set +a
 *   BEACON_GATEWAY_TOKEN="$PROMETHEUS_API_TOKEN" npm run smoke:step6
 */
import { existsSync, unlinkSync } from 'node:fs'
import { openCache } from './cache/db'
import { CacheRepo } from './cache/repo'
import { CacheService } from './cache/service'
import { ConnectionManager } from './connection'
import { resolveGateway } from './connection/config'
import {
  INITIAL_PRESENCE,
  applyPresenceEvent,
  deriveTrayStatus,
  gatewayOf,
  isUnread,
  shouldNotify,
  type PresenceEvent,
  type TrayStatus
} from './presence'

const DB_PATH = '/tmp/beacon-s6-smoke.db'
let failures = 0
function assert(cond: boolean, label: string): void {
  console.log(`[smoke] ${cond ? 'PASS' : 'FAIL'}  ${label}`)
  if (!cond) failures++
}
const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
function cleanDb(): void {
  for (const f of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) if (existsSync(f)) unlinkSync(f)
}
async function waitFor(p: () => boolean, ms = 10_000, step = 100): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (p()) return true
    await delay(step)
  }
  return p()
}
function derive(events: PresenceEvent[]): TrayStatus {
  let s = INITIAL_PRESENCE
  for (const e of events) s = applyPresenceEvent(s, e)
  return deriveTrayStatus(s)
}

async function main(): Promise<void> {
  // ── tray status derivation (scripted event sequences) ──────────────────────
  console.log('[smoke] === tray status derivation ===')
  assert(deriveTrayStatus(INITIAL_PRESENCE) === 'idle', 'initial → idle')
  assert(derive([{ type: 'conn', state: 'connecting' }]) === 'connecting', 'connecting')
  assert(derive([{ type: 'conn', state: 'connected' }]) === 'connected', 'connected')
  assert(derive([{ type: 'conn', state: 'connected' }, { type: 'delta' }]) === 'thinking', 'connected + delta → thinking')
  assert(
    derive([{ type: 'conn', state: 'connected' }, { type: 'delta' }, { type: 'tool_start' }]) === 'tool-running',
    'tool_start → tool-running (over thinking)'
  )
  assert(
    derive([{ type: 'conn', state: 'connected' }, { type: 'tool_start' }, { type: 'tool_end' }]) === 'connected',
    'tool_end balances → connected'
  )
  assert(
    derive([{ type: 'conn', state: 'connected' }, { type: 'delta' }, { type: 'done' }]) === 'connected',
    'done clears streaming → connected'
  )
  assert(derive([{ type: 'conn', state: 'failed' }]) === 'error', 'failed → error')
  assert(
    derive([{ type: 'conn', state: 'connected' }, { type: 'error' }, { type: 'conn', state: 'connected' }]) === 'connected',
    'reconnect clears error'
  )

  // ── shouldNotify() decision table ──────────────────────────────────────────
  console.log('\n[smoke] === shouldNotify table ===')
  assert(shouldNotify({ kind: 'chat_done', sessionId: 's1', windowFocused: false, activeSessionId: 's1' }) === true, 'unfocused + done → true')
  assert(shouldNotify({ kind: 'chat_done', sessionId: 's2', windowFocused: true, activeSessionId: 's1' }) === true, 'focused but non-active session → true')
  assert(shouldNotify({ kind: 'chat_done', sessionId: 's1', windowFocused: true, activeSessionId: 's1' }) === false, 'focused + active → false')
  assert(shouldNotify({ kind: 'user_echo', sessionId: 's1', windowFocused: false, activeSessionId: 's2' }) === false, 'user echo → false (never)')
  assert(shouldNotify({ kind: 'error', sessionId: '', windowFocused: true, activeSessionId: 's1' }) === true, 'error transition → true')

  // ── unread math ─────────────────────────────────────────────────────────────
  console.log('\n[smoke] === unread math ===')
  assert(isUnread(10, 5) === true, 'watermark > last_viewed → unread')
  assert(isUnread(5, 5) === false, 'watermark == last_viewed → read')
  assert(isUnread(5, 10) === false, 'after view (last_viewed past) → cleared')
  assert(gatewayOf('telegram:123') === 'telegram' && gatewayOf('desktop:smoke') === 'desktop', 'gatewayOf derives the id prefix')

  // ── sessions:list reconcile (cache ↔ daemon) ─────────────────────────────────
  console.log('\n[smoke] === sessions:list reconcile ===')
  cleanDb()
  const db = openCache(DB_PATH)
  const repo = new CacheRepo(db)
  // Authenticated happy path (DT1): the live daemon is bearer-gated, so a
  // tokenless run silently degraded to a "graceful 0 sessions" pass that
  // proved nothing about real auth. Thread BEACON_GATEWAY_TOKEN (same env the
  // live smokes use) and assert the connection is auth-accepted.
  //   set -a; . ~/.config/prometheus/env; set +a   # exports PROMETHEUS_API_TOKEN
  //   BEACON_GATEWAY_TOKEN="$PROMETHEUS_API_TOKEN" npm run smoke:step6
  const token = process.env.BEACON_GATEWAY_TOKEN ?? null
  const conn = new ConnectionManager(resolveGateway(), token)
  const cache = new CacheService(repo, conn)
  conn.start()
  await waitFor(() => cache.isConnected())
  assert(cache.isConnected(), 'connected to daemon')
  if (token) {
    // The reconcile rides the WS, so restAuth may stay 'unknown'; the proof of
    // auth is structural: a gated daemon closes 4401 on a bad/missing token,
    // so 'connected' WITH a token set means the first-frame auth was accepted.
    const s = conn.getStatus()
    assert(s.state === 'connected' && s.wsAuth !== 'unauthorized', `authenticated WS (state=${s.state}, wsAuth=${s.wsAuth ?? 'unknown'} — not rejected)`)
  } else {
    console.log('[smoke] no BEACON_GATEWAY_TOKEN — running tokenless (against a gated daemon this proves the 401 path, not real auth)')
  }

  const list = await cache.listSessions()
  assert(Array.isArray(list), `sessions:list returns an array (got ${typeof list})`)
  // A fresh daemon (e.g. just restarted → in-memory sessions cleared) lists 0 sessions. That is a
  // valid state, NOT a crash: skip the per-session shape checks instead of indexing list[0].
  if (list.length === 0) {
    console.log('[smoke] 0 sessions (fresh daemon) — skipping per-session shape checks (graceful, not a failure)')
  } else {
    const sample = list[0]
    assert(typeof sample.gateway === 'string' && sample.gateway === gatewayOf(sample.id), `gateway derived from id (${sample.id} → ${sample.gateway})`)
    assert(typeof sample.watermark === 'number', 'each session carries a numeric watermark (cache cursor)')
    assert(typeof sample.lastActive === 'number' && (sample.lastActive ?? 0) > 0, 'lastActive is a real epoch (created_at)')
  }
  const persisted = repo.getSessions()
  assert(persisted.length === list.length, `cache persists the reconciled list (${persisted.length})`)

  console.log('\n[smoke] ===================== RESULT =====================')
  console.log(`[smoke] sessions listed : ${list.length}  (gateways: ${[...new Set(list.map((s) => s.gateway))].join(', ')})`)
  console.log(`[smoke] outcome         : ${failures === 0 ? 'PASS ✓ (tray derivation, shouldNotify, unread, sessions reconcile)' : `FAIL ✗ (${failures})`}`)
  console.log('[smoke] ===================================================')

  conn.stop()
  db.close()
  cleanDb()
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('[smoke] FAILED:', err)
  process.exit(1)
})
