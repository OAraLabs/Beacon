/**
 * Headless smoke for beacon:// deep links — the pure parse + policy layer.
 * The OS delivery paths (open-url, second-instance argv, protocol registration) are hands-on
 * against the packaged app; what this pins is the ROUTE TABLE, above all that the one dangerous
 * route — pair, which carries a host and a credential — is refused BY DESIGN, with a reason.
 *
 * Run: npm run smoke:deeplink
 */
import { firstDeepLinkInArgv, parseDeepLink } from '@shared/deeplink'

let failures = 0
function assert(cond: boolean, what: string): void {
  console.log(`[smoke] ${cond ? 'PASS' : 'FAIL'}  ${what}`)
  if (!cond) failures++
}

console.log('[smoke] === 1. the open route ===')
const ok = parseDeepLink('beacon://open?session=beacon:117082a6-a2e0-422a-8ca9-510e58d3a5d4')
assert(ok !== null && ok.kind === 'open' && ok.sessionId === 'beacon:117082a6-a2e0-422a-8ca9-510e58d3a5d4', 'a real session id round-trips (colon + hyphens intact)')
const enc = parseDeepLink('beacon://open?session=desktop%3Aabc-123')
assert(enc !== null && enc.kind === 'open' && enc.sessionId === 'desktop:abc-123', 'url-encoded session decodes')
assert(parseDeepLink('BEACON://OPEN?session=x')?.kind === 'open', 'scheme and route match case-insensitively')

console.log('[smoke] === 2. refusals are actions with reasons, never silence ===')
const pair = parseDeepLink('beacon://pair?host=evil.example&token=stolen')
assert(pair !== null && pair.kind === 'refused', 'an inbound PAIR link is refused — the desktop mints these, it never accepts one')
assert(pair !== null && pair.kind === 'refused' && /phone/i.test(pair.reason), 'the pair refusal says who pair links are FOR')
const unknown = parseDeepLink('beacon://exec?cmd=rm')
assert(unknown !== null && unknown.kind === 'refused' && unknown.reason.includes('exec'), 'an unknown route is refused and NAMED')
assert(parseDeepLink('beacon://open')?.kind === 'refused', 'open without a session is refused, not guessed')
assert(parseDeepLink('beacon://open?session=')?.kind === 'refused', 'an empty session id is refused')
assert(parseDeepLink(`beacon://open?session=${'a'.repeat(200)}`)?.kind === 'refused', 'an absurdly long id is refused')
assert(parseDeepLink('beacon://open?session=a%09b')?.kind === 'refused', 'control characters in the id are refused')

console.log('[smoke] === 3. non-links are ignored, not refused ===')
assert(parseDeepLink('https://example.com') === null, 'a foreign scheme is not ours to judge')
assert(parseDeepLink('--remote-debugging-port=9222') === null, 'an ordinary argv flag is ignored')
assert(parseDeepLink('') === null && parseDeepLink('beacon') === null, 'empty / prefix-only strings are ignored')

console.log('[smoke] === 4. argv scanning ===')
assert(firstDeepLinkInArgv(['/usr/bin/beacon', '--flag', 'beacon://open?session=x']) === 'beacon://open?session=x', 'finds the link among ordinary args')
assert(firstDeepLinkInArgv(['/usr/bin/beacon', '--flag']) === null, 'no link → null, not a guess')
assert(firstDeepLinkInArgv(['BEACON://a', 'beacon://b']) === 'BEACON://a', 'first match wins, case-insensitive')

console.log('')
console.log('[smoke] ===================== RESULT =====================')
console.log(`[smoke] outcome: ${failures === 0 ? 'PASS ✓' : `FAIL ✗ (${failures})`} (routes, refusals, argv)`)
console.log('[smoke] ===================================================')
process.exit(failures === 0 ? 0 : 1)
