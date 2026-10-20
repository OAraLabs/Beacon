/**
 * Headless smoke for the per-session profile picker (roadmap item 6, Beacon half).
 *
 * The distinction this defends: "this chat is pinned to coder" and "everything is coder today"
 * name the same profile and are different facts. The daemon models it as `source`; a picker that
 * flattened it could not offer "reset to automatic", because you cannot reset something you
 * cannot tell apart from a default.
 *
 * Run: npm run smoke:session-profile
 */
import {
  AUTOMATIC,
  UNKNOWN_PROFILE,
  parseSessionProfile,
  profileChoices,
  profileLabel,
  profileSelectBody,
  profileTooltip,
  selectedChoice
} from '@shared/session-profile'

let failures = 0
function assert(cond: boolean, what: string): void {
  console.log(`[smoke] ${cond ? 'PASS' : 'FAIL'}  ${what}`)
  if (!cond) failures++
}

// ── FIXTURE ──────────────────────────────────────────────────────────────────────────────────
// Captured from the deployed daemon (Prometheus d6675da, 2026-08-30) by binding a throwaway
// session and clearing it again. What the live read confirmed rather than what I assumed:
//   the payload is flat (session_id/profile/effective/source/dangling), `profile` is null when
//   inherited, `effective` is populated in BOTH cases, and the daemon reports six profiles —
//   assistant, coder, full, minimal, research, symbiote.
const INHERITED = { session_id: 's1', profile: null, effective: 'full', source: 'global', dangling: false }
const PINNED = { session_id: 's1', profile: 'coder', effective: 'coder', source: 'session', dangling: false }
const DANGLING = { session_id: 's1', profile: 'deleted', effective: 'full', source: 'global', dangling: true }
const NAMES = ['assistant', 'coder', 'full', 'minimal', 'research', 'symbiote']

console.log('[smoke] === 1. pinned and inherited never read alike ===')
const inh = parseSessionProfile(INHERITED)
const pin = parseSessionProfile(PINNED)
assert(inh.source === 'global' && pin.source === 'session', 'source survives the parse')
assert(profileLabel(inh) === 'full · auto', `inherited says it is automatic (${profileLabel(inh)})`)
assert(profileLabel(pin) === 'coder', `pinned shows the name plainly (${profileLabel(pin)})`)
// The case that makes `source` worth having at all:
const pinnedToDefault = parseSessionProfile({ ...INHERITED, profile: 'full', source: 'session' })
assert(profileLabel(pinnedToDefault) === 'full', 'pinning to the CURRENT default still reads as pinned')
assert(profileLabel(pinnedToDefault) !== profileLabel(inh), 'and never renders like inheriting it')
assert(selectedChoice(pinnedToDefault) === 'full', 'the menu marks the pinned name, not Automatic')
assert(selectedChoice(inh) === AUTOMATIC, 'while an inherited session marks Automatic')

console.log('[smoke] === 2. the dangling pin is visible ===')
const dang = parseSessionProfile(DANGLING)
assert(dang.dangling === true, 'the flag survives')
assert(profileLabel(dang).includes('missing'), `the label says so (${profileLabel(dang)})`)
assert(profileLabel(dang).includes('deleted'), 'and names the profile that vanished')
assert(profileTooltip(dang).includes('full'), 'the tooltip says what it runs under INSTEAD')
assert(selectedChoice(dang) === AUTOMATIC, 'a dangling pin is not marked as a live selection')

console.log('[smoke] === 3. the write body ===')
assert(profileSelectBody('coder').profile === 'coder', 'choosing a profile sends its name')
assert(profileSelectBody(AUTOMATIC).profile === '', 'Automatic sends BLANK — the daemon clears on blank')
assert(profileSelectBody('full').profile === 'full', 'choosing the default name PINS it, never clears')
// The opposite of modelSelectAction, deliberately: clearing on "picked the default" would silently
// re-point a pinned conversation the next time the daemon default moved.
assert(profileSelectBody('full').profile !== '', 'picking the default is not a covert reset')

console.log('[smoke] === 4. the menu ===')
const choices = profileChoices(NAMES, 'full')
assert(choices.length === NAMES.length + 1, `every profile plus Automatic (${choices.length})`)
assert(choices[0].id === AUTOMATIC, 'Automatic is first')
assert((choices[0].hint || '').includes('full'), `and names what it follows (${choices[0].hint})`)
assert(choices.slice(1).map((c) => c.id).join() === NAMES.join(), "the daemon's own order is preserved")
assert(profileChoices([], null)[0].hint === 'follows the daemon', 'with no global known it still reads sensibly')
assert(!NAMES.includes(AUTOMATIC), 'the sentinel can never collide with a real profile name')

console.log('[smoke] === 5. degenerate payloads ===')
assert(parseSessionProfile(null).effective === null, 'null → unknown, and the control renders read-only')
assert(profileLabel(UNKNOWN_PROFILE) === 'profile', 'with no store the label is neutral, not a fake name')
assert(profileTooltip(UNKNOWN_PROFILE).includes('unavailable'), 'and the tooltip says why')
// An incoherent row (claims session, names nothing) must not render as a pin.
const incoherent = parseSessionProfile({ session_id: 's', profile: null, effective: 'full', source: 'session' })
assert(incoherent.source === 'global', 'source:session with no name is treated as inherited, not trusted')
assert(parseSessionProfile({ profile: '', effective: 'full', source: 'global' }).profile === null, 'an empty name parses to null')

console.log('')
console.log('[smoke] ===================== RESULT =====================')
console.log(`[smoke] outcome: ${failures === 0 ? 'PASS ✓' : `FAIL ✗ (${failures})`} (pinned vs inherited, dangling, write body, menu)`)
console.log('[smoke] ===================================================')
process.exit(failures === 0 ? 0 : 1)
