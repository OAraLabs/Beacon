/**
 * First-message smoke (headless / ELECTRON_RUN_AS_NODE) — v0.4.0 onboarding, O4.
 *
 * "Say hello to your assistant" is where someone finds out the whole thing works, so the ways it can go are held
 * to account without a window: compose, send, wait, the three things that go wrong (no answer in time, the computer
 * gone, the computer refusing), the first reply, and what a reply may contain when it is shown.
 *
 *   * the reducer: every phase and the events that move it, including a late answer finishing a slow one;
 *   * reading a reply: the first assistant message with something in it, cleaned and capped;
 *   * telling "gone" from "refused": a status in the error means the computer answered and said no;
 *   * the dev override of the timeout: ignored by a release build.
 *
 * Every guard was shown to fail on a planted fault (the mutation sweep recorded in the PR).
 * What it cannot prove: the screen, the real send and the real polling. `npm run probe:onboarding-hello`
 * drives the built app against a stub daemon.
 */
import {
  DEFAULT_HELLO_TIMEOUT_MS,
  MAX_REPLY_CHARS,
  displayReply,
  failureKind,
  firstReply,
  helloReduce,
  helloTimeoutMs,
  initialHello,
  type HelloEvent,
  type HelloState
} from '@shared/hello'
import { COPY } from '@shared/onboarding-strings'

let failures = 0
let checks = 0
function assert(cond: boolean, label: string, detail?: string): void {
  checks++
  console.log(`[hello-smoke] ${cond ? 'PASS' : 'FAIL'}  ${label}${!cond && detail ? `  — ${detail}` : ''}`)
  if (!cond) failures++
}
const EXPECTED = 28

const run = (s: HelloState, ...events: HelloEvent[]): HelloState => events.reduce(helloReduce, s)
const T = 120_000

// ── the suggestions ─────────────────────────────────────────────────────────────────────────────
const chips = COPY.main.f1.chips
assert(chips.length === 3 && chips[0] === 'What can you help me with?', 'copy: three suggestions, the first is "What can you help me with?"')
const start = initialHello(chips[0])
assert(start.phase === 'compose' && start.text === chips[0] && start.session === null, 'compose: it starts with the first suggestion in the field, no conversation yet')

// ── compose and send ────────────────────────────────────────────────────────────────────────────
assert(run(start, { type: 'edit', text: 'Hi there' }).text === 'Hi there', 'compose: the field can be edited')
assert(run(start, { type: 'edit', text: '   ' }, { type: 'send' }).phase === 'compose' && run(start, { type: 'edit', text: '' }, { type: 'send' }).phase === 'compose', 'compose: an empty or blank message cannot be sent')
const sending = run(start, { type: 'send' })
assert(sending.phase === 'sending' && run(sending, { type: 'edit', text: 'changed' }).text === chips[0], 'send: Send moves on, and the field can no longer be edited (what was sent is what was written)')
assert(run(sending, { type: 'send' }) === sending && run(start, { type: 'tick', now: 1e12, timeoutMs: T }) === start, 'send: Send twice, or a clock tick before anything was sent, changes nothing')

// ── waiting ─────────────────────────────────────────────────────────────────────────────────────
const waiting = run(sending, { type: 'sent', session: 's1', at: 1000 })
assert(waiting.phase === 'waiting' && waiting.session === 's1' && waiting.waitingSince === 1000, 'wait: a sent message is waited for, in a named conversation')
assert(run(waiting, { type: 'tick', now: 1000 + T - 1, timeoutMs: T }).phase === 'waiting' && run(waiting, { type: 'tick', now: 1000 + T, timeoutMs: T }).phase === 'slow', 'wait: "no answer yet" comes at exactly the timeout, not before')
const done = run(waiting, { type: 'reply', text: 'Hello!' })
assert(done.phase === 'done' && done.reply === 'Hello!', 'reply: the first reply finishes it')
const slow = run(waiting, { type: 'tick', now: 1000 + T, timeoutMs: T })
assert(run(slow, { type: 'reply', text: 'Late, but here' }).phase === 'done', 'slow: a late answer still finishes it (the model was only slow)')
const kept = run(slow, { type: 'keepWaiting', at: 5000 })
assert(kept.phase === 'waiting' && kept.waitingSince === 5000 && kept.session === 's1', 'slow: Keep waiting waits again, the clock restarted, in the same conversation')
assert(run(kept, { type: 'tick', now: 5000 + T - 1, timeoutMs: T }).phase === 'waiting', 'slow: …and the restarted clock is honoured')
assert(run(sending, { type: 'session', id: 's9' }).session === 's9' && run(run(sending, { type: 'session', id: 's9' }), { type: 'failed', kind: 'refused' }, { type: 'retry' }).session === 's9' && run(start, { type: 'session', id: 's9' }) === start, 'send: a conversation made before the send failed is kept, so Try again reuses it instead of making another')
const retried = run(slow, { type: 'retry' })
assert(retried.phase === 'sending' && retried.session === 's1' && retried.text === chips[0], 'slow: Try again sends the message again, in the SAME conversation')

// ── going wrong ─────────────────────────────────────────────────────────────────────────────────
assert(run(sending, { type: 'failed', kind: 'lost' }).phase === 'lost' && run(sending, { type: 'failed', kind: 'refused' }).phase === 'refused', 'wrong: a failed send is "lost" or "refused", whichever it was')
assert(run(waiting, { type: 'failed', kind: 'lost' }).phase === 'lost' && run(slow, { type: 'failed', kind: 'lost' }).phase === 'lost', 'wrong: losing touch while waiting, or while slow, is "lost"')
assert(run(start, { type: 'failed', kind: 'lost' }) === start && run(done, { type: 'failed', kind: 'lost' }) === done, 'wrong: a failure before anything was sent, or after the reply, changes nothing')
const lost = run(waiting, { type: 'failed', kind: 'lost' })
assert(run(lost, { type: 'retry' }).phase === 'sending' && run(lost, { type: 'retry' }).session === 's1' && run(run(sending, { type: 'failed', kind: 'refused' }), { type: 'retry' }).phase === 'sending', 'wrong: Reconnect or Try again goes round again, reusing the conversation if there is one')
assert(run(done, { type: 'retry' }) === done && run(waiting, { type: 'retry' }) === waiting && run(start, { type: 'keepWaiting', at: 1 }) === start, 'wrong: retry and keep-waiting only apply where they are offered')

// ── reading a reply ─────────────────────────────────────────────────────────────────────────────
assert(firstReply({ messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: '  Hello there  ' }] }) === 'Hello there', 'reply: the first assistant message, trimmed')
assert(firstReply({ messages: [{ role: 'user', content: 'hi' }] }) === null && firstReply({ messages: [{ role: 'assistant', content: '   ' }, { role: 'assistant', content: 'Second' }] }) === 'Second', 'reply: no assistant message yet is null; an empty one is skipped for the next with something in it')
assert(firstReply(null) === null && firstReply({}) === null && firstReply({ messages: 'x' }) === null && firstReply({ messages: [null, 5, { role: 'assistant', content: 7 }] }) === null, 'reply: anything that is not a message list is null, never a throw')
const bidi = String.fromCharCode(0x202e)
const zw = String.fromCharCode(0x200b)
assert(displayReply(`Hel${bidi}lo${zw}\u0007 world\nline two`) === 'Hello world\nline two', 'reply: control, zero-width and bidirectional-override characters are removed; newlines stay')
const long = displayReply('a'.repeat(MAX_REPLY_CHARS + 500))
assert(long.length === MAX_REPLY_CHARS + 1 && long.endsWith('…') && displayReply('a'.repeat(MAX_REPLY_CHARS)).length === MAX_REPLY_CHARS, 'reply: a reply is cut at the cap with an ellipsis; one at the cap is shown whole')

// ── gone or refused ─────────────────────────────────────────────────────────────────────────────
assert(failureKind(new Error('HTTP 500: POST /api/chat/send — {"error":"boom"}')) === 'refused' && failureKind(new Error('HTTP 404: POST /api/chat/send')) === 'refused', 'kind: an error with a status is "refused": the computer answered, and said no')
assert(failureKind(new Error('fetch failed')) === 'lost' && failureKind(new Error('connect ECONNREFUSED 127.0.0.1:8005')) === 'lost' && failureKind('timeout') === 'lost' && failureKind(undefined) === 'lost', 'kind: anything else (refused connection, timeout, no route) is "lost touch"')

// ── the dev override ────────────────────────────────────────────────────────────────────────────
assert(helloTimeoutMs({ BEACON_HELLO_TIMEOUT_MS: '2500' }, true) === 2500 && helloTimeoutMs({}, true) === DEFAULT_HELLO_TIMEOUT_MS && DEFAULT_HELLO_TIMEOUT_MS === 120_000, 'timeout: two minutes by default, and a dev or probe build may shorten it')
assert(helloTimeoutMs({ BEACON_HELLO_TIMEOUT_MS: '2500' }, false) === DEFAULT_HELLO_TIMEOUT_MS && helloTimeoutMs({ BEACON_HELLO_TIMEOUT_MS: '5' }, true) === DEFAULT_HELLO_TIMEOUT_MS && helloTimeoutMs({ BEACON_HELLO_TIMEOUT_MS: 'abc' }, true) === DEFAULT_HELLO_TIMEOUT_MS, 'timeout: a release build ignores the override, and junk or absurd values fall back to the default')

if (checks !== EXPECTED) {
  console.error(`[hello-smoke] FAIL — ran ${checks} checks, expected exactly ${EXPECTED} (a section was skipped, or one was added without updating EXPECTED)`)
  process.exit(1)
}
if (failures > 0) {
  console.error(`[hello-smoke] FAIL — ${failures}/${checks} checks failed`)
  process.exit(1)
}
console.log(`[hello-smoke] OK — ${checks} checks passed`)
