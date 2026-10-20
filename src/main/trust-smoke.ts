// Headless Slice-1 smoke (ELECTRON_RUN_AS_NODE electron out/main/trust-smoke.js).
// Proves the connection trust layer: the no-save test-token resolution, the capability-flagged WS
// auth frame, the indicator view mapping, the normalized `HTTP <status>:` REST error contract, and
// — against a stubbed fetch — that ConnectionManager folds REST outcomes into the restAuth signal
// (401 → 'unauthorized', non-401 HTTP → 'ok', network drop → unchanged) and re-emits status.

import type { ConnectionStatus } from '@shared/ipc'
import { connIndicatorView, httpStatusFromError, isAuthError, resolveTestToken, wsAuthFrame, WS_CLOSE_UNAUTHORIZED } from '@shared/daemon-api'
import { ConnectionManager } from './connection'

let failures = 0
function check(name: string, cond: boolean): void {
  if (cond) console.log(`  ✓ ${name}`)
  else {
    console.error(`  ✗ ${name}`)
    failures++
  }
}

console.log('resolveTestToken (no-save Test button):')
check('typed token wins', resolveTestToken('saved', { token: ' typed ' }) === 'typed')
check('blank + useSavedToken → saved', resolveTestToken('saved', { token: '' }) === 'saved')
check('useSavedToken=false → null (Clear-token preview)', resolveTestToken('saved', { useSavedToken: false }) === null)
check('typed beats useSavedToken=false', resolveTestToken('saved', { token: 'x', useSavedToken: false }) === 'x')
check('no saved + blank → null', resolveTestToken(null, {}) === null)

console.log('wsAuthFrame (first-frame auth — top-level token per Phase A):')
{
  const f = wsAuthFrame('tok-1')
  check('shape {type:auth, token} (token TOP-LEVEL, not under payload)', f.type === 'auth' && f.token === 'tok-1')
  check('WS_CLOSE_UNAUTHORIZED is 4401', WS_CLOSE_UNAUTHORIZED === 4401)
}

console.log('connIndicatorView (NavRail-foot indicator):')
check('connected → Online', connIndicatorView({ state: 'connected' }).short === 'Online')
check('reconnecting carries attempt', connIndicatorView({ state: 'reconnecting', attempt: 3 }).short === 'Retry 3')
check('failed → Offline', connIndicatorView({ state: 'failed' }).short === 'Offline')
check('restAuth unauthorized → authBad', connIndicatorView({ state: 'connected', restAuth: 'unauthorized' }).authBad)
check('restAuth ok → not authBad', !connIndicatorView({ state: 'connected', restAuth: 'ok' }).authBad)
check('wsAuth unauthorized → authBad (WS 4401 lights the same UX)', connIndicatorView({ state: 'connected', wsAuth: 'unauthorized' }).authBad)
check('wsAuth ok + restAuth ok → not authBad', !connIndicatorView({ state: 'connected', restAuth: 'ok', wsAuth: 'ok' }).authBad)

console.log('normalized REST error contract (HTTP <status>: METHOD path):')
check('sessions-list format classifies', httpStatusFromError(new Error('HTTP 401: GET /api/sessions')) === 401)
check('chat-send format classifies', isAuthError(new Error('HTTP 401: POST /api/chat/send — unauthorized')))
check('non-401 not auth error', !isAuthError(new Error('HTTP 500: DELETE /api/sessions/x — boom')))

async function restAuthTracking(): Promise<void> {
  console.log('ConnectionManager.restAuth tracking (stubbed fetch):')
  const realFetch = globalThis.fetch
  const cm = new ConnectionManager({ name: 'smoke', apiBase: 'http://127.0.0.1:9', wsUrl: 'ws://127.0.0.1:9' }, 'tok')
  const events: ConnectionStatus[] = []
  cm.on('status', (s: ConnectionStatus) => events.push(s))

  try {
    // 401 → 'unauthorized' + a status emission
    globalThis.fetch = (async () => new Response('{"error":"unauthorized"}', { status: 401 })) as typeof fetch
    await cm.listSessions().catch(() => undefined)
    check('401 flips restAuth to unauthorized', cm.getStatus().restAuth === 'unauthorized')
    check('transition emitted a status event', events.some((e) => e.restAuth === 'unauthorized'))

    // network drop → unchanged (still unauthorized; we learned nothing about the token)
    globalThis.fetch = (async () => {
      throw new Error('ECONNREFUSED')
    }) as typeof fetch
    await cm.listSessions().catch(() => undefined)
    check('network error leaves restAuth unchanged', cm.getStatus().restAuth === 'unauthorized')

    // success → 'ok'
    globalThis.fetch = (async () => new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch
    await cm.listSessions()
    check('2xx flips restAuth to ok', cm.getStatus().restAuth === 'ok')

    // non-401 HTTP error still proves the bearer is accepted → 'ok'
    globalThis.fetch = (async () => new Response('boom', { status: 500 })) as typeof fetch
    await cm.listSessions().catch(() => undefined)
    check('non-401 HTTP keeps restAuth ok', cm.getStatus().restAuth === 'ok')

    // no duplicate emissions for the same value
    const okEvents = events.filter((e) => e.restAuth === 'ok').length
    check('no duplicate transition events', okEvents === 1)

    // manual reconnect is callable without a started socket (indicator's Reconnect button)
    cm.reconnect()
    cm.stop()
    check('reconnect()/stop() do not throw', true)
  } finally {
    globalThis.fetch = realFetch
  }
}

void restAuthTracking().then(() => {
  if (failures > 0) {
    console.error(`\n[trust-smoke] FAILED — ${failures} check(s)`)
    process.exit(1)
  }
  console.log('\n[trust-smoke] PASS')
  process.exit(0)
})
