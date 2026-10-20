/**
 * Headless smoke for notification preferences (@shared/notification-prefs).
 *
 * Proves the MODEL — parse/serialize round-trips, hostile input degrades to defaults per-field, the
 * mute gate short-circuits, and every kind is independently gateable. Then proves main WIRES it: that
 * the gate sits at all four notification call sites (the defect a pure model cannot catch — a correct
 * model wired to nothing is the same as no feature). The wiring half reads main's source, exactly like
 * badge-smoke does: a regex over the text is weaker than executing it, but it is what a headless run
 * can prove, and it fails the moment a call site drops its gate.
 *
 *   npm run build && npm run smoke:notification-prefs
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  DEFAULT_NOTIFY_PREFS,
  NOTIFY_PREF_KINDS,
  notifyAllowed,
  parseNotifyPrefs,
  serializeNotifyPrefs,
  type NotifyPrefs
} from '@shared/notification-prefs'

let failures = 0
function assert(cond: boolean, what: string, detail = ''): void {
  console.log(`[smoke] ${cond ? 'PASS' : 'FAIL'}  ${what}${detail && !cond ? `\n        ${detail}` : ''}`)
  if (!cond) failures++
}

console.log('[smoke] === defaults ARE today\'s behavior ===')
assert(DEFAULT_NOTIFY_PREFS.muted === false, 'nothing is muted by default')
for (const k of NOTIFY_PREF_KINDS) {
  assert(DEFAULT_NOTIFY_PREFS[k] === true, `every kind (${k}) is ON by default — the feature cannot silently mute an existing user`)
}
assert(parseNotifyPrefs(null).approval === true, 'no stored row → approvals still notify')
assert(parseNotifyPrefs(undefined).task === true, 'undefined → defaults')
assert(parseNotifyPrefs('').reply === true, 'empty string → defaults (an empty settings value is "unset", not "muted")')

console.log('\n[smoke] === hostile stored rows cannot mute you by accident ===')
assert(parseNotifyPrefs('not json').approval === true, 'malformed JSON → defaults, does not throw')
assert(parseNotifyPrefs('"a string"').error === true, 'a JSON non-object → defaults')
assert(parseNotifyPrefs('null').task === true, 'JSON null → defaults')
assert(parseNotifyPrefs('[]').reply === true, 'a JSON array → defaults')
assert(parseNotifyPrefs('{}').approval === true, 'an empty object → every field defaults ON')
assert(parseNotifyPrefs('{"approval": "yes"}').approval === true, 'a wrong-typed field falls back per-field, not to false')
assert(parseNotifyPrefs('{"approval": false, "task": true}').approval === false, 'an explicit false IS honored — the fallback is for junk, not for the user saying no')
assert(parseNotifyPrefs('{"approval": false}').reply === true, 'a partial row (older build) defaults only the missing field')
assert(parseNotifyPrefs('{"muted": true}').muted === true && parseNotifyPrefs('{"muted": true}').approval === true, 'muted:true parses; approval stays true as a FIELD — the gate, not the parser, is what silences it')

console.log('\n[smoke] === round-trip is stable ===')
const sample: NotifyPrefs = { muted: false, approval: true, reply: false, task: false, error: true }
assert(parseNotifyPrefs(serializeNotifyPrefs(sample)).reply === false, 'serialize → parse preserves a false')
assert(
  serializeNotifyPrefs(parseNotifyPrefs(serializeNotifyPrefs(sample))) === serializeNotifyPrefs(sample),
  'serialize(parse(serialize(x))) === serialize(x) — idempotent, so re-saving an unchanged row is a no-op diff'
)
assert(serializeNotifyPrefs({ ...sample, muted: undefined as unknown as boolean }).includes('"muted":false'), 'a non-boolean field serializes as false, never undefined-as-missing')

console.log('\n[smoke] === the gate: mute outranks everything ===')
const on: NotifyPrefs = { ...DEFAULT_NOTIFY_PREFS }
for (const k of NOTIFY_PREF_KINDS) assert(notifyAllowed(on, k) === true, `defaults allow ${k}`)
const muted: NotifyPrefs = { ...on, muted: true, approval: true }
assert(notifyAllowed(muted, 'approval') === false, 'muted silences APPROVALS too — do-not-disturb means what it says; the UI warns, the model does not carve a surprise exception')
for (const k of NOTIFY_PREF_KINDS) assert(notifyAllowed(muted, k) === false, `muted silences ${k}`)
const noTask: NotifyPrefs = { ...on, task: false }
assert(notifyAllowed(noTask, 'task') === false, 'a per-kind off switch works')
assert(notifyAllowed(noTask, 'approval') === true, '...and touching one kind leaves the others alone — muting tasks must NOT mute approvals, that is the whole point')
const noApproval: NotifyPrefs = { ...on, approval: false }
assert(notifyAllowed(noApproval, 'approval') === false && notifyAllowed(noApproval, 'reply') === true, 'quieting the load-bearing kind is allowed (it is the user\'s machine) and is per-kind too')

console.log('\n[smoke] === main wires the model at every notification site ===')
{
  const mainSrc = readFileSync(join(process.cwd(), 'src/main/index.ts'), 'utf8')
  assert(mainSrc.includes(`notifyAllowed(notifyPrefs, 'task')`), 'the task-completion notify is gated')
  assert(mainSrc.includes(`notifyAllowed(notifyPrefs, 'reply')`), 'the chat-reply notify is gated')
  assert(mainSrc.includes(`notifyAllowed(notifyPrefs, 'error')`), 'the disconnection notify is gated')
  assert(mainSrc.includes(`notifyAllowed(notifyPrefs, 'approval')`), 'the approval notify is gated')
  // The approval gate must sit AFTER the dedupe add — muting an approval has to behave like being
  // focused (account for the id, skip the alert), or a later unmute re-fires stale approvals.
  const approvalFn = mainSrc.slice(mainSrc.indexOf('function notifyApproval'))
  const dedupeIdx = approvalFn.indexOf('notifiedApprovalIds.add(requestId)')
  const gateIdx = approvalFn.indexOf("notifyAllowed(notifyPrefs, 'approval')")
  assert(dedupeIdx > -1 && gateIdx > dedupeIdx, 'the approval gate runs AFTER the dedupe add — muting cannot strand ids out of the dedupe set')
  assert(mainSrc.includes('loadNotifyPrefs()'), 'main loads prefs at startup — the gate must use a settled value before the renderer ever round-trips')
  assert(mainSrc.includes('NOTIFY_PREFS_KEY'), 'main persists under the model\'s own key constant (the identifier, not a hand-typed literal that could drift)')
  // The link-blocked security notice is NOT one of the four user kinds. It must stay ungated:
  // muting a blocked-navigation report would hide a security event. Assert the call exists and that
  // no notifyAllowed gate sits on the line before it.
  const linkLines = mainSrc.split('\n')
  const linkIdx = linkLines.findIndex((l) => l.includes("notify('Link not opened'"))
  assert(linkIdx > -1, 'the link-blocked notice still calls notify')
  assert(linkIdx > -1 && !linkLines[linkIdx - 1].includes('notifyAllowed'), 'and it is UNGATED — the security notice is not a user-quietable kind')
}

console.log(`\n[smoke] outcome: ${failures === 0 ? 'PASS ✓' : `FAIL ✗ (${failures})`}`)
process.exit(failures === 0 ? 0 : 1)
