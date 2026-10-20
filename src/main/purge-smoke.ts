/**
 * Session PURGE model (Prometheus#354). The load-bearing distinction: forget TOMBSTONES (hides,
 * history kept, session resurfaces on new activity) and purge DESTROYS. A client that blurred the
 * two would silently upgrade "tidy my sidebar" into "delete the record".
 *
 * Run: npm run smoke:purge
 */
import {
  isPurgeConfirmed,
  parsePurgeResult,
  purgeBody,
  purgePath,
  purgeSummary,
  purgedTotal,
  PURGE_TYPED_CONFIRM
} from '@shared/purge'

let failures = 0
function assert(cond: boolean, what: string): void {
  console.log(`[smoke] ${cond ? 'PASS' : 'FAIL'}  ${what}`)
  if (!cond) failures++
}

console.log('[smoke] === 1. the route + the daemon-side confirm ===')
assert(purgePath('beacon:a b/c') === '/api/sessions/beacon%3Aa%20b%2Fc/purge', 'the id is encoded — a colon or slash cannot escape the path')
assert(purgePath('x').endsWith('/purge') && !purgePath('x').startsWith('/api/sessions/x?'), 'POST …/purge, deliberately NOT folded into DELETE')
assert(purgeBody('beacon:abc').confirm === 'beacon:abc', 'the body echoes the session id back — the daemon refuses without it')

console.log('[smoke] === 2. the human-scale guard (separate from the daemon\'s) ===')
assert(isPurgeConfirmed('PURGE') && isPurgeConfirmed(' purge ') , 'typing PURGE arms it, case- and space-insensitively')
assert(!isPurgeConfirmed('') && !isPurgeConfirmed('purg') && !isPurgeConfirmed('yes'), 'anything else leaves it disarmed')
assert(PURGE_TYPED_CONFIRM === 'PURGE', 'the word says what it does')

console.log('[smoke] === 3. ok alone is NOT evidence (the #348/#349 shape) ===')
const bare = parsePurgeResult({ ok: true })
assert(!bare.ok && !!bare.error, 'ok with no `purged` block is treated as UNPROVEN, not success — the pre-#354 route returned ok unconditionally')
assert(parsePurgeResult(null).ok === false, 'nothing back is a failure, never a silent pass')
assert(parsePurgeResult({ error: 'unknown session' }).error === 'unknown session', 'a daemon error carries its reason')

console.log('[smoke] === 4. a real result parses, counts, and states the branch caveat ===')
const real = parsePurgeResult({ ok: true, purged: { lcm_messages: 2, lcm_summaries: 1, session_titles: 1, session_pins: 0 }, branches: ['beacon:branch'], reversible: false })
assert(real.ok && purgedTotal(real) === 4, `counts total across tables (got ${purgedTotal(real)})`)
assert(real.reversible === false, 'reversible is always false — a UI can never imply otherwise')
assert(real.branches.length === 1, 'branches are carried, not dropped')
const line = purgeSummary(real)
assert(line.includes('2 messages') && line.includes('1 summaries'), `the sentence names what went (got: ${line})`)
assert(!line.includes('session pins'), 'zero-count tables are not listed as if something happened')
assert(/branch keeps its own copy/.test(line), 'and it SAYS a branch survived — otherwise that is discovered later and read as a failed purge')
assert(purgeSummary(parsePurgeResult({ ok: true, purged: { lcm_messages: 3 }, branches: [] })).includes('cannot be undone'), 'with no branches it still states irreversibility')
assert(purgeSummary(parsePurgeResult({ ok: true, purged: {} })).length > 0, 'an empty purge still produces a sentence, never a blank status')

console.log('')
console.log('[smoke] ===================== RESULT =====================')
console.log(`[smoke] outcome: ${failures === 0 ? 'PASS ✓' : `FAIL ✗ (${failures})`} (route, confirms, unproven-ok, counts, branch caveat)`)
console.log('[smoke] ===================================================')
process.exit(failures === 0 ? 0 : 1)
