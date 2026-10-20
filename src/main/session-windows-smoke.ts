/**
 * session-windows-smoke — the pure rules behind popping a conversation out into its own window
 * (@shared/session-windows), the notification rule that knows about it (presence.shouldNotify), and
 * the draft-memory drop that keeps a returning session's draft current (@shared/drafts).
 *
 * The window manager itself (src/main/session-windows.ts) needs Electron windows; the app probe
 * (scripts/session-window-app-probe.mjs) drives that against the built app.
 *
 * Run: npm run build && npm run smoke:session-windows
 */
import {
  isPlausibleSessionId,
  parseOpenSessionWindows,
  parseSessionWindowRoute,
  sessionWindowRoute,
  sessionWindowStateName,
  switchTarget,
  SESSION_ID_MAX
} from '@shared/session-windows'
import { shouldNotify } from './presence'
import { draftStoreValue, dropDraftMemory, forgetDraft, recallDraft, rememberDraft } from '@shared/drafts'

const MIN_CHECKS = 30
let checks = 0
let failures = 0
function check(cond: boolean, label: string, detail?: unknown): void {
  checks += 1
  if (cond) console.log(`  ok   ${label}`)
  else {
    console.error(`  FAIL ${label}${detail !== undefined ? `  (${JSON.stringify(detail)})` : ''}`)
    failures += 1
  }
}
process.on('exit', () => {
  if (checks < MIN_CHECKS) {
    console.error(`\n[smoke] FAIL only ${checks} checks ran, expected at least ${MIN_CHECKS}`)
    process.exitCode = 1
  } else if (failures > 0) {
    console.error(`\n[smoke] FAIL ${failures} of ${checks}`)
    process.exitCode = 1
  } else console.log(`\n[smoke] PASS ${checks} checks`)
})

console.log('\n=== route ===')
{
  for (const id of ['beacon:6f1c-2', 'telegram:123', 'probe123', 'beacon:a/b#c?d e', 'beacon:ünïcödé·✓', 'x'.repeat(SESSION_ID_MAX)]) {
    const r = sessionWindowRoute(id)
    check(parseSessionWindowRoute(`#${r}`) === id && parseSessionWindowRoute(r) === id, `round-trips ${JSON.stringify(id.slice(0, 24))}${id.length > 24 ? '…' : ''}`, r)
    check(!/[#?\s]/.test(r), `the route has no raw #, ? or whitespace (${id.slice(0, 16)})`, r)
  }
  check(parseSessionWindowRoute('') === null && parseSessionWindowRoute('#') === null, 'the main window (no hash) is not a session window')
  check(parseSessionWindowRoute('#terminal') === null && parseSessionWindowRoute('#browser') === null && parseSessionWindowRoute('#capture') === null, 'the other pop-outs are not session windows')
  check(parseSessionWindowRoute('#session=') === null, 'an empty id is refused')
  check(parseSessionWindowRoute('#session=%E0%A4%A') === null, 'malformed percent-encoding is refused, not thrown')
  check(parseSessionWindowRoute('#session=' + encodeURIComponent('a\u0000b')) === null && parseSessionWindowRoute('#session=' + encodeURIComponent('a\nb')) === null, 'control characters are refused (an id becomes a title and a file name)')
  check(parseSessionWindowRoute('#session=' + 'x'.repeat(SESSION_ID_MAX + 1)) === null, `longer than ${SESSION_ID_MAX} is refused`)
  check(parseSessionWindowRoute(null) === null && parseSessionWindowRoute(undefined) === null, 'null / undefined → null')
  check(!isPlausibleSessionId(42) && !isPlausibleSessionId('') && isPlausibleSessionId('beacon:x'), 'isPlausibleSessionId: strings with content only')
}

console.log('\n=== state file names ===')
{
  const a = sessionWindowStateName('beacon:a/b')
  const b = sessionWindowStateName('beacon_a_b')
  check(a !== b, 'ids that read the same once sanitised still get different files (hash suffix)', { a, b })
  for (const id of ['beacon:a/b', '../../etc/passwd', 'telegram:123', 'x'.repeat(SESSION_ID_MAX), 'ü/ö\\\\:*?"<>|']) {
    const n = sessionWindowStateName(id)
    check(/^[A-Za-z0-9._-]+\.json$/.test(n) && !n.includes('..') === !id.includes('..') && n.length <= 48 + 1 + 8 + 5, `a safe, bounded file name for ${JSON.stringify(id.slice(0, 20))}`, n)
    check(!n.includes('/') && !n.includes('\\\\'), `no path separators for ${JSON.stringify(id.slice(0, 20))}`, n)
  }
  check(sessionWindowStateName('beacon:x') === sessionWindowStateName('beacon:x'), 'the same id always maps to the same file (bounds come back)')
}

console.log('\n=== where "show me this session" goes ===')
{
  check(switchTarget('beacon:a', new Set(['beacon:a'])) === 'popout', 'a popped-out session → its own window')
  check(switchTarget('beacon:b', new Set(['beacon:a'])) === 'main', 'any other session → the main window')
  check(switchTarget('beacon:a', ['beacon:a']) === 'popout' && switchTarget('beacon:z', []) === 'main', 'accepts the list form too')
}

console.log('\n=== the open list, for relaunch ===')
{
  check(JSON.stringify(parseOpenSessionWindows('["beacon:a","telegram:1"]')) === '["beacon:a","telegram:1"]', 'reads the saved list in order')
  check(parseOpenSessionWindows('{bad').length === 0 && parseOpenSessionWindows('{"a":1}').length === 0 && parseOpenSessionWindows(null).length === 0, 'garbage → nothing to restore, no throw')
  check(JSON.stringify(parseOpenSessionWindows('["beacon:a",7,"","beacon:a","x\\u0000y"]')) === '["beacon:a"]', 'drops non-strings, empties, duplicates and control characters')
}

console.log('\n=== notifications ===')
{
  const base = { kind: 'chat_done' as const, sessionId: 'beacon:a', windowFocused: false, activeSessionId: 'beacon:b' }
  check(shouldNotify(base) === true, 'main unfocused, no pop-out focused → notify (unchanged)')
  check(shouldNotify({ ...base, focusedPopout: 'beacon:a' }) === false, "the reply's own window has focus → do not notify (you are reading it)")
  check(shouldNotify({ ...base, focusedPopout: 'beacon:c' }) === true, "another session's window has focus → notify")
  check(shouldNotify({ ...base, windowFocused: true, activeSessionId: 'beacon:a' }) === false, 'main focused on the same session → no notify (unchanged)')
  check(shouldNotify({ ...base, windowFocused: true, activeSessionId: 'beacon:a', focusedPopout: null }) === false, 'focusedPopout null is the old behaviour')
  check(shouldNotify({ kind: 'error', sessionId: '', windowFocused: true, activeSessionId: null, focusedPopout: 'beacon:a' }) === true, 'errors always notify, pop-out or not')
  check(shouldNotify({ kind: 'user_echo', sessionId: 'beacon:a', windowFocused: false, activeSessionId: null }) === false, 'your own message never notifies')
}

console.log('\n=== draft memory when a session leaves this window ===')
{
  rememberDraft('beacon:pop', 'typed before it left')
  check(recallDraft('beacon:pop') === 'typed before it left', 'precondition: this window holds a memory copy')
  dropDraftMemory('beacon:pop')
  check(recallDraft('beacon:pop') === undefined, 'dropped: the next mount asks the durable store instead of showing the stale copy')
  check(draftStoreValue('beacon:pop', 'typed in the other window') === 'typed in the other window', 'NOT tombstoned: writes for it still persist (unlike forget)')
  forgetDraft('beacon:gone')
  check(draftStoreValue('beacon:gone', 'x') === null, 'contrast: forget DOES tombstone, which is why the pop-out does not use it')
}
