/**
 * Headless smoke for dictation (B6, Beacon half). Pure model only.
 *
 * The interesting failures here are not "does it transcribe" — the middleware does that
 * (oara-voice#3). They are the two ways a transcript can go wrong AFTER it arrives: landing in
 * the wrong conversation, and being silently dropped. Both look identical to a broken mic from
 * the chair, so both are pinned here.
 *
 * Run: npm run smoke:dictation
 */
import {
  appendDictation,
  noSpeechNotice,
  dictateUnavailableReason,
  dictationLanded,
  parseDictationOutcome,
  DICTATION_MOVED_NOTICE,
  type BridgeTranscribeResponse
} from '@shared/dictation'

let failures = 0
function assert(cond: boolean, what: string): void {
  console.log(`[smoke] ${cond ? 'PASS' : 'FAIL'}  ${what}`)
  if (!cond) failures++
}

console.log('[smoke] dictation (B6) ===========================================')

// ── the join rule ─────────────────────────────────────────────────────────
assert(appendDictation('', 'hello there') === 'hello there', 'an empty draft becomes the transcript')
assert(appendDictation('write ', 'the readme') === 'write the readme', 'a trailing space is not doubled')
assert(appendDictation('write', 'the readme') === 'write the readme', 'a separator is added when missing')
assert(appendDictation('line one\n', 'line two') === 'line one\nline two', 'a trailing newline is left alone')
assert(appendDictation('  ', 'first words') === 'first words', 'a whitespace-only draft is treated as empty')
assert(appendDictation('keep me', '   ') === 'keep me', 'an empty transcript never truncates the draft')

// The transcript is the user's words. "Improving" it would make a WRONG
// transcript harder to notice, which is the opposite of the goal.
assert(
  appendDictation('', 'hello  world. um') === 'hello  world. um',
  'the transcript is inserted verbatim — no capitalising, no punctuation repair'
)

// ── outcome mapping: every status reaches ONE visible state ───────────────
const ok = (r: BridgeTranscribeResponse): ReturnType<typeof parseDictationOutcome> =>
  parseDictationOutcome(r)
assert(ok({ status: 'ok', text: 'some words' }).kind === 'text', 'ok + text -> text')
assert(ok({ status: 'no_speech', text: '' }).kind === 'no_speech', 'no_speech -> no_speech')
// The energy gate (oara-voice#6) returns no_speech, but an ok with empty text
// must not become an empty insertion that looks like a working mic.
assert(ok({ status: 'ok', text: '   ' }).kind === 'no_speech', 'ok with blank text -> no_speech, not an empty insert')
assert(ok({ status: 'error' }).kind === 'error', 'anything else -> error')
assert(
  ok({ status: 'weird' }).kind === 'error' && /weird/.test((ok({ status: 'weird' }) as { notice: string }).notice),
  'an unknown status is NAMED in the notice, not swallowed'
)
const textOut = ok({ status: 'ok', text: '  padded  ' })
assert(textOut.kind === 'text' && textOut.text === 'padded', 'the transcript is trimmed of transport padding')

// ── a transcript belongs to the conversation it started in ────────────────
assert(dictationLanded('beacon:a', 'beacon:a'), 'same session -> lands')
assert(!dictationLanded('beacon:a', 'beacon:b'), 'switched session -> does NOT land')
assert(dictationLanded(null, null), 'Home -> Home lands (Home has its own draft)')
assert(!dictationLanded(null, 'beacon:a'), 'Home -> a session does NOT land')
assert(!dictationLanded('beacon:a', null), 'a session -> Home does NOT land')
assert(DICTATION_MOVED_NOTICE.length > 0, 'and the refusal has a notice — a dropped transcript is never silent')

// ── one microphone, two features ──────────────────────────────────────────
assert(dictateUnavailableReason('idle', false) === null, 'idle + not sending -> dictation allowed')
assert(dictateUnavailableReason('recording', false) !== null, 'a voice turn holds the mic -> refused')
assert(dictateUnavailableReason('processing', false) !== null, 'a turn in flight -> refused')
assert(dictateUnavailableReason('idle', true) !== null, 'mid-send -> refused')


// ── why nothing was heard (oara-voice#8) ──────────────────────────────────
// One sentence for three problems is one too few: two of them the reader can
// fix in seconds, but only if the notice says which.
const N = (level?: number, floor?: number): string =>
  noSpeechNotice({ status: 'no_speech', text: '', level_rms: level, silence_floor_rms: floor })

assert(/not muted|blocked/i.test(N(0, 32)), 'level 0 -> a muted or blocked mic, named')
assert(/too quiet/i.test(N(20, 32)), 'below the floor -> too quiet, named')
assert(/20/.test(N(20, 32)) && /32/.test(N(20, 32)), 'and it shows the measured level AND the floor')
assert(!/too quiet/i.test(N(900, 32)), 'above the floor -> NOT blamed on the mic')
assert(/catch that/.test(N(900, 32)), 'above the floor -> the generic notice')

// An older middleware reports NO level. That is not a level of zero, and
// diagnosing a muted mic on that evidence would be a guess.
assert(N(undefined, undefined) === "Didn't catch that — nothing was added", 'no level reported -> generic notice, no invented diagnosis')
assert(N(0, undefined) === "Didn't catch that — nothing was added", 'a level without a floor cannot be judged')
assert(N(undefined, 32) === "Didn't catch that — nothing was added", 'a floor without a level cannot either')

// Three cases, three notices — not three spellings of one.
assert(new Set([N(0, 32), N(20, 32), N(900, 32)]).size === 3, 'the three cases produce three DIFFERENT notices')

console.log('[smoke] =========================================================')
console.log(`[smoke] outcome: ${failures === 0 ? 'PASS ✓' : `FAIL (${failures})`}`)
process.exit(failures === 0 ? 0 : 1)
