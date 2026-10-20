/**
 * approval-disclosure-smoke — the grant options stay behind a deliberate act.
 *
 * THE RULE THIS PINS: closed on mount, and closed again on a NEW request even
 * after one was opened. Opening is the consent act; it must not carry over.
 *
 * WHY IT IS TESTED RATHER THAN TRUSTED: Beacon shipped a persisted-collapse
 * mechanism the day before this (sessions:groups:v1 — settings KV, versioned
 * key, garbage-safe parse). "Make the disclosure remember, like the sidebar
 * does" is a natural and well-intentioned change, and it would silently put the
 * grant options back under an accidental click for anyone who ever opened one.
 *
 * The rule is encoded in the TYPE — the state is WHICH REQUEST is open, not
 * WHETHER something is — so a persistent variant cannot be written without
 * changing that shape. These assertions and the source check below are what
 * turn red when someone tries.
 *
 * Run: npm run smoke:approval-disclosure
 */
import { readFileSync } from 'node:fs'
import { disclosureLabel, isDisclosureOpen, toggleDisclosure } from '@shared/approval-disclosure'

let failures = 0
let checks = 0
function check(cond: boolean, label: string): void {
  checks += 1
  if (cond) console.log(`  ok   ${label}`)
  else {
    console.error(`  FAIL ${label}`)
    failures += 1
  }
}

/** COUNT GUARD — this file is all top-level checks against a source string; a rename that
 *  makes a `slice` return '' would quietly stop measuring rather than fail. */
const MIN_CHECKS = 22

console.log('\n=== closed on mount ===')
check(isDisclosureOpen(null, 'req-a') === false, 'nothing open → this request is closed')
check(
  toggleDisclosure(null, 'req-a') === 'req-a',
  'toggling from closed opens THIS request (state is the id, not a flag)'
)

console.log('\n=== THE RULE: a NEW request is closed even after one was opened ===')
const opened = toggleDisclosure(null, 'req-a')
check(isDisclosureOpen(opened, 'req-a') === true, 'the request you opened is open')
check(
  isDisclosureOpen(opened, 'req-b') === false,
  'a DIFFERENT request is CLOSED — opening does not carry over, which is the whole rule'
)
check(
  isDisclosureOpen(toggleDisclosure(opened, 'req-a'), 'req-a') === false,
  'toggling the open one closes it'
)
check(
  isDisclosureOpen(toggleDisclosure(opened, 'req-b'), 'req-a') === false,
  'opening req-b closes req-a — one disclosure open at a time, never a set that accumulates'
)

console.log('\n=== the state cannot express "remembered" ===')
// A boolean would make "open" a property of the CARD rather than of one request,
// and that is exactly the persistable shape. Assert we do not have one.
check(
  typeof toggleDisclosure(null, 'req-a') !== 'boolean',
  'toggle returns a request id, not a boolean — there is no flag to persist'
)
check(toggleDisclosure(null, 'req-a') !== toggleDisclosure(null, 'req-b'), 'the state distinguishes requests')

console.log('\n=== summary label keeps the capability discoverable ===')
check(disclosureLabel(4) === 'Remember this decision (4 options)', 'states what is behind it, and how much')
check(disclosureLabel(1).endsWith('(1 option)'), 'singular reads correctly')

console.log('\n=== NOT PERSISTED (structural) ===')
// The mutation target. Wiring the disclosure to the settings KV — the mechanism
// sitting right next door — is the change this must catch.
const card = readFileSync(new URL('../../src/renderer/src/components/ExecApprovalCard.tsx', import.meta.url), 'utf8')
const main = readFileSync(new URL('../../src/renderer/src/components/MainView.tsx', import.meta.url), 'utf8')
const disclosureDecl = main.slice(main.indexOf('disclosedFor'), main.indexOf('daemonLastSeen'))

check(!/settings\.(get|set)/.test(card), 'the card never touches the settings store')
check(
  !/settings\.(get|set)/.test(disclosureDecl),
  'the disclosure state is not read from or written to the settings KV — it must not survive a request, let alone a restart'
)
check(
  /useState<DisclosureState>\(null\)/.test(main),
  'the disclosure initialises CLOSED (null) — an initialiser that reads persisted state would fail here'
)
check(
  /disclosureOpen=\{isDisclosureOpen\(disclosedFor, a\.requestId\)\}/.test(main),
  'openness is computed per request id at render — not held as a flag on the card'
)

console.log('\n=== empty extents → no disclosure at all ===')
check(
  /scopes\.length > 0 \? \(/.test(card),
  'the whole block is gated on there being options — an empty expander would imply a grant is on offer'
)

console.log('\n=== …but the empty case SAYS SO — `{}` is a ruling, not a gap ===')
// Ruled 2026-09-19. `{}` is now PERMANENT for whole classes of request: a third-party MCP
// tool carries no path and no command, and a payload-bearing desktop action (typing, menu
// invocation) is not rememberable AT ALL — remembering "type this" would mint "type ANY
// text into this app, forever" from a prompt that showed one string.
//
// Rendering nothing left those indistinguishable from a daemon too old to offer a grant,
// and the two call for opposite responses: one is the system working as ruled, the other
// is a reason to go and look. The mutation this catches is the original `: null`.
//
// ⚠ The first draft of this check was a regex for `) : null}` and it was a DUD: the card has
// several such closers (the arguments block, the error block, the inner disclosure), so the
// pattern matched — or failed to — for reasons unrelated to this branch, and it stayed green
// when the `: null` was actually restored. Both checks below were run against that restored
// `: null` and both go red. Position, not pattern.
const scopesIdx = card.indexOf('scopes.length > 0 ? (')
const noteIdx = card.indexOf('style={noGrantNote}')
check(
  scopesIdx !== -1 && noteIdx > scopesIdx,
  'the empty-extents ternary has a REAL else — the note renders where `: null` used to'
)
check(
  /no lasting grant is on offer/.test(card),
  'the card STATES that no lasting grant is on offer, in the slot the disclosure would have taken'
)
// The sentence must report the FIELD, not diagnose the request. Beacon naming the cause
// would be it classifying the payload — the same second-definition defect the verb comment
// in this card already forbids. The daemon puts its own reason in `description`.
//
// ⚠ ANCHOR THE SLICE TO THE SENTENCE, not to the style object next to it. The first draft
// sliced from `const noGrantNote` (the CSSProperties declaration) and a cause planted in the
// rendered text sat outside the window entirely — the check passed with the defect present.
const noteText = card.slice(noteIdx, noteIdx === -1 ? 0 : card.indexOf('</div>', noteIdx))
check(noteText.length > 20, `the note's rendered text was located (${noteText.length} chars) — a slice that found nothing would pass the next check vacuously`)
check(
  !/(payload|mcp__|type_text|keystroke|because)/i.test(noteText),
  'the note does not name a CAUSE — Beacon reads the field, the daemon owns the why'
)

console.log('\n=== arguments render ABOVE the answer options ===')
// The daemon pins this same order in its own prompt (test_approval_shows_arguments.py:
// "a prompt that offers the answers before the thing being decided invites the reflex
// answer"). It holds harder here: `A` approves with one key, no pointer travel at all.
const argsIdx = card.indexOf('<div style={argsInset}>')
const approveIdx = card.indexOf('approval-btn-approve')
check(argsIdx !== -1, 'the arguments block exists — for type_text the arguments ARE the decision')
check(
  argsIdx !== -1 && approveIdx !== -1 && argsIdx < approveIdx,
  'the arguments are rendered BEFORE the Approve/Deny buttons, not below them'
)
// Truncating again would produce a cut with no statement of how much was cut — the daemon's
// own ellipsis says "(+391 more chars)"; Beacon's would say nothing.
check(
  !/\.slice\(0,|substring\(|\.{3}'/.test(card.slice(argsIdx === -1 ? 0 : argsIdx, approveIdx === -1 ? undefined : approveIdx)),
  'the card does not re-truncate an already-truncated value (a second cut would be a silent one)'
)

if (checks < MIN_CHECKS) {
  console.error(`  FAIL only ${checks} checks ran, expected at least ${MIN_CHECKS} — a section stopped running`)
  failures += 1
}
console.log(`\n${failures === 0 ? `PASS (${checks} checks)` : `FAIL (${failures})`}\n`)
process.exit(failures === 0 ? 0 : 1)
