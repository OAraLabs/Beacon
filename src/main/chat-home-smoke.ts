/**
 * Chat home / landing smoke (headless / ELECTRON_RUN_AS_NODE) — Sprint A.
 *
 * Proves the pure Chat-home logic the renderer rides on, where it would actually break:
 *   1. LAUNCH-RESTORE — resolveLaunchTarget reopens the persisted last session IFF it still exists,
 *      else Home (first-run / no-session / stale id). This is the "don't regress returning-to-work"
 *      guarantee (note: no restore existed before this sprint — this ADDS it).
 *   2. HOME STATE — isHome distinguishes "no conversation open" (null) from "a session is open".
 *   3. SUBMIT-FROM-HOME — beginFromHome mints a session (the newChat path) THEN focuses + stages the
 *      first message into it, trim-guarding empty input and bailing cleanly if the mint fails.
 *
 * The deps passed to beginFromHome are RECORDING SEAMS (real call capture), not mocks of the unit
 * under test — so this exercises the actual orchestration. DOM/React wiring (the ChatHome composer,
 * ChatShell's initial send) is the macOS eyes-on walk.
 *
 * FAIL-LOUD: every check increments `checks`; at the end `checks === FIXED` or the run FAILS (a
 * skipped section can't false-pass). A thrown error exits non-zero.
 */
import { resolveLaunchTarget, isHome, beginFromHome, HOME, LAST_SESSION_KEY } from '@shared/chat-home'

let failures = 0
let checks = 0
function assert(cond: boolean, label: string): void {
  checks++
  console.log(`[chat-home-smoke] ${cond ? 'PASS' : 'FAIL'}  ${label}`)
  if (!cond) failures++
}

if (
  typeof resolveLaunchTarget !== 'function' ||
  typeof isHome !== 'function' ||
  typeof beginFromHome !== 'function' ||
  typeof LAST_SESSION_KEY !== 'string'
) {
  console.error('[chat-home-smoke] FAIL — required @shared/chat-home exports missing. Refusing to vacuously pass.')
  process.exit(1)
}

const FIXED = 22

async function main(): Promise<void> {
  // ── 1. launch-restore resolution ── [6]
  assert(resolveLaunchTarget('s2', ['s1', 's2', 's3']) === 's2', 'restore: persisted id present in list → reopened (not [0])')
  assert(resolveLaunchTarget(null, ['s1']) === HOME, 'restore: no persisted id (null) → Home')
  assert(resolveLaunchTarget(undefined, ['s1']) === HOME, 'restore: undefined → Home')
  assert(resolveLaunchTarget('', ['s1']) === HOME, 'restore: empty persisted id → Home')
  assert(resolveLaunchTarget('gone', ['s1', 's2']) === HOME, 'restore: stale id no longer in list → Home (no broken restore)')
  assert(resolveLaunchTarget('s1', []) === HOME, 'restore: empty session list → Home (first run)')

  // ── 2. home state ── [2]
  assert(isHome(HOME) === true, 'isHome(null) → true (no conversation open)')
  assert(isHome('desktop:abc') === false, 'isHome(sessionId) → false (a session is open)')

  // ── 3a. submit-from-home: empty / whitespace text is a no-op (no session minted) ── [4]
  let created = 0
  let opened = 0
  let stagedCount = 0
  const noopDeps = {
    createSession: async () => {
      created++
      return 'should-not-happen'
    },
    open: (_id: string) => {
      opened++
    },
    stageInitial: (_id: string, _t: string) => {
      stagedCount++
    }
  }
  assert((await beginFromHome('', noopDeps)) === null, 'submit: empty text → null (stays on Home)')
  assert((await beginFromHome('   \n  ', noopDeps)) === null, 'submit: whitespace-only text → null')
  assert(created === 0, 'submit: empty/whitespace never mints a session')
  assert(opened === 0 && stagedCount === 0, 'submit: empty/whitespace never focuses or stages')

  // ── 3b. submit-from-home: mint failure bails cleanly ── [4]
  const order: string[] = []
  let openId: string | null = null
  const failDeps = {
    createSession: async () => {
      order.push('create')
      return null
    },
    open: (id: string) => {
      order.push('open')
      openId = id
    },
    stageInitial: (id: string, _t: string) => order.push(`stage:${id}`)
  }
  const failResult = await beginFromHome('hello', failDeps)
  assert(failResult === null, 'submit: createSession → null ⇒ beginFromHome returns null')
  assert(order.filter((o) => o === 'create').length === 1, 'submit: createSession attempted exactly once on mint failure')
  assert(!order.includes('open'), 'submit: mint failure does NOT focus a session')
  assert(!order.some((o) => o.startsWith('stage')), 'submit: mint failure does NOT stage a message')

  // ── 3c. submit-from-home: success mints → focuses → stages, in order, with trimmed text ── [6]
  const seq: string[] = []
  let focusedId: string | null = null
  let stagedId: string | null = null
  let stagedText: string | null = null
  const okDeps = {
    createSession: async () => {
      seq.push('create')
      return 'desktop:new-123'
    },
    open: (id: string) => {
      seq.push('open')
      focusedId = id
    },
    stageInitial: (id: string, text: string) => {
      seq.push('stage')
      stagedId = id
      stagedText = text
    }
  }
  const okResult = await beginFromHome('  first message  ', okDeps)
  assert(okResult === 'desktop:new-123', 'submit: returns the minted session id')
  assert(focusedId === 'desktop:new-123', 'submit: focuses (opens) the minted session')
  assert(stagedId === 'desktop:new-123', 'submit: stages the first message INTO the minted session')
  assert(stagedText === 'first message', 'submit: first message is trimmed before staging')
  assert(seq.join(',') === 'create,open,stage', 'submit: order is mint → focus → stage (newChat THEN send-into-it)')
  assert(openId === null, 'submit: success path is independent of the earlier failure path (no cross-talk)')

  // ── fail-loud count guard ──
  if (checks !== FIXED) {
    console.error(`[chat-home-smoke] FAIL — ran ${checks} checks but expected ${FIXED} (a section was skipped or a check added without bumping FIXED).`)
    failures++
  }

  console.log('\n[chat-home-smoke] ===================== RESULT =====================')
  console.log(`[chat-home-smoke] checks=${checks} expected=${FIXED} failures=${failures}`)
  console.log(
    `[chat-home-smoke] outcome: ${
      failures === 0
        ? 'PASS ✓ (launch restores last session or Home; submit-from-Home mints then sends into the new session)'
        : `FAIL ✗ (${failures})`
    }`
  )
  console.log('[chat-home-smoke] ===================================================')
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('[chat-home-smoke] FAILED (threw before completing — loud, not a silent skip):', err)
  process.exit(1)
})
