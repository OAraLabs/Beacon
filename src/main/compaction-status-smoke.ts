/**
 * compaction-status-smoke — the inline "Tidying up the conversation…" status (#283).
 *
 * A compaction pass on a long cloud session is several summarizer calls (Prometheus #773), tens of
 * seconds to minutes before the model call. Without this the chat shows "Pondering…" the whole time
 * and the pause reads as a stall.
 *
 * Three layers, each driven for real:
 *   1. the wire: a REAL WebSocket server sends the daemon's session-scoped `context_compaction`
 *      frame and GatewaySocket maps it, so the parse path is the shipped one;
 *   2. the rules (@shared/compaction-status): start → progress → done hides, start → failed leaves
 *      the plain note, another session's frames never land, the bar comes from chunks_done/total;
 *   3. the render: the real CompactionLine and ActivityLine through react-dom/server, so the line
 *      and the bar asserted are the markup that ships, not a model of it.
 *
 * Run: npm run build && npm run smoke:compaction-status
 */
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { WebSocketServer } from 'ws'
import type { ChatStreamFrame } from '@shared/ipc'
import {
  COMPACTION_DONE_ANNOUNCE,
  COMPACTION_FAILED_TEXT,
  COMPACTION_IDLE,
  COMPACTION_RUNNING_TEXT,
  COMPACTION_START_ANNOUNCE,
  compactionFraction,
  endsCompaction,
  nextCompaction,
  type CompactionInput,
  type CompactionState
} from '@shared/compaction-status'
import { CompactionLine } from '../renderer/src/components/CompactionLine'
import { ActivityLine } from '../renderer/src/components/ActivityLine'
import { GatewaySocket } from './connection/ws'

const MIN_CHECKS = 64
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
// The verdict rides on 'exit', so an early return or a throw cannot skip the count guard.
process.on('exit', () => {
  if (checks < MIN_CHECKS) {
    console.error(`\n[smoke] FAIL only ${checks} checks ran, expected at least ${MIN_CHECKS}`)
    process.exitCode = 1
  } else if (failures > 0) {
    console.error(`\n[smoke] FAIL ${failures} of ${checks}`)
    process.exitCode = 1
  } else console.log(`\n[smoke] PASS ${checks} checks`)
})

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const S = 'sess-on-screen'
const OTHER = 'sess-elsewhere'

const render = (state: CompactionState, tick = 0): string => renderToStaticMarkup(createElement(CompactionLine, { state, tick }))
const has = (html: string, s: string): boolean => html.includes(s)
/** The visible strip only: the polite live region is stripped so a check on the LINE cannot be
 *  satisfied by the announcement, and vice versa. */
const visible = (html: string): string => html.replace(/<div[^>]*class="sr-only compaction-live"[^>]*>[\s\S]*?<\/div>/, '')
const announced = (html: string): string => /<div[^>]*class="sr-only compaction-live"[^>]*>([\s\S]*?)<\/div>/.exec(html)?.[1] ?? ''

/** A compaction frame as ChatShell receives it (the ChatStreamFrame variant, built literally). */
function cf(stage: string, extra: Partial<CompactionInput> & { tokensBefore?: number; tokensAfter?: number; reason?: string } = {}): CompactionInput {
  return { kind: 'compaction', sessionId: S, stage, ...extra }
}
function run(frames: CompactionInput[], from: CompactionState = COMPACTION_IDLE): CompactionState {
  return frames.reduce((st, f) => nextCompaction(st, f, S), from)
}

async function wire(): Promise<void> {
  console.log('\n=== 1. wire: context_compaction reaches the chat stream ===')
  const wss = new WebSocketServer({ port: 0 })
  await new Promise<void>((r) => wss.once('listening', () => r()))
  const port = (wss.address() as { port: number }).port
  const ts = (): number => Date.now() / 1000
  wss.on('connection', (sock) => {
    sock.send(JSON.stringify({ type: 'connected', timestamp: ts(), payload: {} }))
    // The frame #283 specifies, in the daemon's usual {type, timestamp, payload} envelope.
    sock.send(JSON.stringify({ type: 'context_compaction', timestamp: ts(), payload: {
      session_id: S, message_id: 'asst-9', stage: 'start', tokens_before: 241427, threshold: 200000, chunks_done: 0, chunks_total: 7
    } }))
    sock.send(JSON.stringify({ type: 'context_compaction', timestamp: ts(), payload: {
      session_id: S, message_id: 'asst-9', stage: 'progress', tokens_before: 241427, threshold: 200000, progress: 0.4, chunks_done: 3, chunks_total: 7
    } }))
    sock.send(JSON.stringify({ type: 'context_compaction', timestamp: ts(), payload: {
      session_id: S, message_id: 'asst-9', stage: 'done', tokens_before: 241427, tokens_after: 112000, threshold: 200000, duration_ms: 5400
    } }))
    sock.send(JSON.stringify({ type: 'context_compaction', timestamp: ts(), payload: {
      session_id: S, stage: 'failed', reason: 'summarizer timed out', duration_ms: 9000
    } }))
    // A stage this Beacon does not know is dropped, never guessed at.
    sock.send(JSON.stringify({ type: 'context_compaction', timestamp: ts(), payload: { session_id: S, stage: 'reticulating' } }))
    // The old telemetry broadcast is NOT the chat frame: it stays out of the chat stream.
    sock.send(JSON.stringify({ type: 'sentinel_signal', timestamp: ts(), payload: { kind: 'context_compaction', session_id: S } }))
  })

  const frames: ChatStreamFrame[] = []
  const socket = new GatewaySocket(`ws://127.0.0.1:${port}`, {
    onState: () => undefined,
    onFrame: (f) => frames.push(f),
    onGatewayEvent: () => undefined,
    onAuthFailure: () => undefined
  })
  socket.start()
  for (let i = 0; i < 40 && frames.length < 4; i++) await sleep(50)
  socket.stop()
  wss.close()

  const got = frames.filter((f) => f.kind === 'compaction')
  check(got.length === 4, 'the four known-stage frames reach the chat stream, the unknown stage and the sentinel do not', frames.map((f) => f.kind))
  const [start, progress, done, failed] = got as Array<Extract<ChatStreamFrame, { kind: 'compaction' }>>
  check(start?.sessionId === S, 'session_id rides through (the scoping key)', start)
  check(start?.stage === 'start', 'stage: start')
  check(start?.chunksDone === 0 && start?.chunksTotal === 7, 'chunks_done / chunks_total ride through on start', start)
  check(start?.tokensBefore === 241427 && start?.threshold === 200000, 'tokens_before and threshold ride through', start)
  check(progress?.stage === 'progress' && progress?.progress === 0.4, 'progress fraction rides through', progress)
  check(progress?.chunksDone === 3 && progress?.chunksTotal === 7, 'chunk counts ride through on progress', progress)
  check(done?.stage === 'done' && done?.tokensAfter === 112000, 'done carries tokens_after', done)
  check(failed?.stage === 'failed' && failed?.reason === 'summarizer timed out', 'failed carries its reason', failed)
  check(done?.chunksDone === undefined && done?.progress === undefined, 'absent fields stay absent, never defaulted to 0', done)
}

function rules(): void {
  console.log('\n=== 2a. the bar: chunks_done / chunks_total first, then progress, else indeterminate ===')
  check(compactionFraction({ chunksDone: 3, chunksTotal: 6 }) === 0.5, '3 of 6 chunks → 0.5')
  check(compactionFraction({ chunksDone: 3, chunksTotal: 6, progress: 0.1 }) === 0.5, 'the chunk counts win over progress when both are there')
  check(compactionFraction({ chunksDone: 0, chunksTotal: 7 }) === 0, '0 of 7 is a determinate empty bar, not unknown')
  check(compactionFraction({ progress: 0.25 }) === 0.25, 'progress alone is used when the counts are missing')
  check(compactionFraction({}) === null, 'nothing known → null (indeterminate)')
  check(compactionFraction({ chunksDone: 1, chunksTotal: 0 }) === null, 'a zero total is unknown, not a division')
  check(compactionFraction({ chunksDone: 8, chunksTotal: 7 }) === null, 'more done than total is nonsense → unknown, not clamped to full')
  check(compactionFraction({ chunksDone: -1, chunksTotal: 7 }) === null, 'a negative count is unknown')
  check(compactionFraction({ progress: 1.4 }) === null, 'a progress over 1 is unknown, not clamped')
  check(compactionFraction({ progress: Number.NaN }) === null, 'NaN progress is unknown')
  check(compactionFraction({ chunksDone: 8, chunksTotal: 7, progress: 0.6 }) === 0.6, 'bad counts fall through to a good progress')

  console.log('\n=== 2b. start → progress → done ===')
  const started = run([cf('start', { chunksDone: 0, chunksTotal: 5 })])
  check(started.show === 'running', 'start shows the line', started)
  check(started.fraction === 0, 'start with 0 of 5 → empty determinate bar', started)
  check(started.announce === COMPACTION_START_ANNOUNCE && COMPACTION_START_ANNOUNCE.length > 0, 'start is announced politely', started)
  const mid = nextCompaction(started, cf('progress', { chunksDone: 2, chunksTotal: 5 }), S)
  check(mid.show === 'running' && mid.fraction === 0.4, 'progress advances the bar to 2/5', mid)
  check(mid.announce === started.announce, 'progress does not re-announce (no chatter per chunk)', mid)
  const finished = nextCompaction(mid, cf('done', { tokensBefore: 241000, tokensAfter: 112000 }), S)
  check(finished.show === 'none', 'done hides the line', finished)
  check(finished.announce === COMPACTION_DONE_ANNOUNCE && COMPACTION_DONE_ANNOUNCE.length > 0, 'done is announced', finished)
  const unknownBar = run([cf('start'), cf('progress')])
  check(unknownBar.show === 'running' && unknownBar.fraction === null, 'no fraction on the wire → indeterminate bar', unknownBar)
  const lateJoin = run([cf('progress', { chunksDone: 4, chunksTotal: 5 })])
  check(lateJoin.show === 'running' && lateJoin.fraction === 0.8, 'opening the chat mid-pass (progress, no start) still shows it', lateJoin)
  check(lateJoin.announce === COMPACTION_START_ANNOUNCE, 'and announces it, since the start was missed', lateJoin)

  console.log('\n=== 2c. start → failed ===')
  const failed = run([cf('start'), cf('failed', { reason: 'boom' })])
  check(failed.show === 'failed', 'failed leaves the plain note', failed)
  check(failed.announce === COMPACTION_FAILED_TEXT && COMPACTION_FAILED_TEXT.length > 0, 'failed is announced in the same words', failed)
  const thenReply = run([{ kind: 'progress', sessionId: S }, { kind: 'delta', sessionId: S }, { kind: 'done', sessionId: S }], failed)
  check(thenReply.show === 'failed', 'the note survives the reply that follows (it is about this turn)', thenReply)
  const nextSend = nextCompaction(thenReply, { kind: 'message', sessionId: S, role: 'user' }, S)
  check(nextSend.show === 'none', 'the next message from the operator clears it', nextSend)
  const assistantMsg = nextCompaction(thenReply, { kind: 'message', sessionId: S, role: 'assistant' }, S)
  check(assistantMsg.show === 'failed', 'an assistant message does not clear it', assistantMsg)
  const retried = nextCompaction(failed, cf('start'), S)
  check(retried.show === 'running', 'a new pass replaces the note with the line', retried)

  console.log('\n=== 2d. noop, and a pass whose end frame never comes ===')
  const noop = run([cf('start'), cf('noop')])
  check(noop.show === 'none', 'noop hides the line', noop)
  check(noop.announce !== COMPACTION_DONE_ANNOUNCE, 'noop does not claim it tidied anything', noop)
  for (const kind of ['delta', 'tool_start', 'done', 'error']) {
    const st = run([cf('start', { chunksDone: 1, chunksTotal: 3 }), { kind, sessionId: S }])
    check(st.show === 'none', `a running line clears on '${kind}' (the model call has started, or the turn is over)`, st)
  }
  const pulse = run([cf('start'), { kind: 'progress', sessionId: S }])
  check(pulse.show === 'running', 'the agent_progress pulse during the pass does NOT clear it', pulse)
  const doneCold = run([cf('done')])
  check(doneCold.show === 'none' && doneCold.announce === '', 'a done with no pass seen announces nothing', doneCold)
  const failedTurnEnd = run([cf('start'), cf('failed'), { kind: 'error', sessionId: S }])
  check(failedTurnEnd.show === 'failed', 'the failed note survives a turn error too', failedTurnEnd)

  console.log('\n=== 2e. scoping: only the session the frame names ===')
  const foreign = run([{ ...cf('start', { chunksDone: 1, chunksTotal: 2 }), sessionId: OTHER }])
  check(foreign === COMPACTION_IDLE || (foreign.show === 'none' && foreign.announce === ''), "another session's start does not render here", foreign)
  const unscoped = run([{ ...cf('start'), sessionId: '' }])
  check(unscoped.show === 'none', 'a frame with an empty session_id does not render (deliversToSession would let it through)', unscoped)
  const noSid = run([{ kind: 'compaction', stage: 'start' }])
  check(noSid.show === 'none', 'a frame with no session_id at all does not render', noSid)
  const foreignFail = nextCompaction(started, { ...cf('failed'), sessionId: OTHER }, S)
  check(foreignFail === started, "another session's failure leaves this one's line alone", foreignFail)
  const foreignChat = nextCompaction(started, { kind: 'delta', sessionId: OTHER }, S)
  check(foreignChat === started, "another session's reply does not clear this one's line", foreignChat)
  const foreignSend = nextCompaction(failed, { kind: 'message', sessionId: OTHER, role: 'user' }, S)
  check(foreignSend === failed, "another session's send does not clear this one's note", foreignSend)
  const weird = nextCompaction(started, cf('reticulating'), S)
  check(weird === started, 'an unknown stage changes nothing', weird)

  console.log('\n=== 2g. a pass ended by Stop hides; only a real failure leaves the note ===')
  const stopped = run([cf('start', { chunksDone: 1, chunksTotal: 4 }), cf('failed', { reason: 'cancelled' })])
  check(stopped.show === 'none', 'failed with reason "cancelled" (the turn was stopped) hides the line, no note', stopped)
  check(stopped.announce !== COMPACTION_FAILED_TEXT, 'and does not announce "Couldn\'t tidy up"', stopped)
  const realFail = run([cf('start'), cf('failed', { reason: 'summarizer returned empty/failed' })])
  check(realFail.show === 'failed', 'a real failure still leaves the note', realFail)
  const noReason = run([cf('start'), cf('failed')])
  check(noReason.show === 'failed', 'a failure with no reason is a failure, not a stop', noReason)
  const lookAlike = run([cf('start'), cf('failed', { reason: 'cancelled by the summarizer provider' })])
  check(lookAlike.show === 'failed', 'only the exact "cancelled" reason counts as a stop', lookAlike)
  const stoppedAfterNote = nextCompaction(realFail, cf('failed', { reason: 'cancelled' }), S)
  check(stoppedAfterNote.show === 'none', 'a stop clears an earlier note too: the turn ended, not the tidy-up', stoppedAfterNote)

  console.log('\n=== 2f. the end of a pass makes a "compacting" pulse stale (found by the live check) ===')
  for (const stage of ['done', 'failed', 'noop']) check(endsCompaction(cf(stage), S), `${stage} ends this chat's pass`)
  for (const stage of ['start', 'progress', 'reticulating']) check(!endsCompaction(cf(stage), S), `${stage} does not end it`)
  check(!endsCompaction({ ...cf('done'), sessionId: OTHER }, S), "another session's done does not end this chat's pass")
  check(!endsCompaction({ ...cf('done'), sessionId: '' }, S), 'a done with no session id does not end it')
  check(!endsCompaction({ kind: 'done', sessionId: S, stage: 'done' }, S), "the turn's own chat done is not a compaction end")
}

function renders(): void {
  console.log('\n=== 3a. render: start → progress → done ===')
  const started = run([cf('start', { chunksDone: 0, chunksTotal: 5 })])
  const h0 = render(started)
  check(has(visible(h0), COMPACTION_RUNNING_TEXT) && COMPACTION_RUNNING_TEXT.startsWith('Tidying up the conversation'), 'start: the line reads "Tidying up the conversation…"', h0)
  check(has(h0, 'role="progressbar"'), 'start: a progress bar is drawn', h0)
  check(has(h0, 'aria-valuenow="0"') && has(h0, 'width:0%'), 'start: the bar is empty at 0 of 5', h0)
  check(announced(h0) === COMPACTION_START_ANNOUNCE, 'start: the live region carries the start announcement', announced(h0))

  const mid = nextCompaction(started, cf('progress', { chunksDone: 2, chunksTotal: 5 }), S)
  const h1 = render(mid)
  check(has(visible(h1), COMPACTION_RUNNING_TEXT), 'progress: still the same line', h1)
  check(has(h1, 'aria-valuenow="40"') && has(h1, 'width:40%'), 'progress: the bar is at 40% for 2 of 5', h1)

  const h2 = render(nextCompaction(mid, cf('done'), S))
  check(!has(visible(h2), COMPACTION_RUNNING_TEXT), 'done: the line is gone', h2)
  check(!has(h2, 'role="progressbar"'), 'done: the bar is gone', h2)
  check(!has(visible(h2), COMPACTION_FAILED_TEXT), 'done: no failure note', h2)
  check(announced(h2) === COMPACTION_DONE_ANNOUNCE, 'done: the live region says it finished', announced(h2))

  const hx = render(run([cf('start'), cf('progress')]))
  check(has(hx, 'role="progressbar"') && !has(hx, 'aria-valuenow'), 'unknown progress: a bar with no value (indeterminate)', hx)
  check(has(hx, 'compaction-bar-indeterminate'), 'unknown progress: drawn as indeterminate, not as an empty bar', hx)
  check(!/animation/.test(hx), 'no animation is written into the markup (movement means liveness)', hx)

  const spun = render(started, 3)
  check(has(spun, 'rotate(270deg)'), 'the spinner turns with the pulse tick, a quarter turn each', spun)

  console.log('\n=== 3b. render: start → failed ===')
  const failed = run([cf('start'), cf('failed', { reason: 'summarizer timed out' })])
  const hf = render(failed)
  check(has(visible(hf), COMPACTION_FAILED_TEXT), 'failed: the plain note is shown', hf)
  check(/^Couldn.t tidy up/.test(COMPACTION_FAILED_TEXT), 'failed: the note says it could not tidy up, in plain words', COMPACTION_FAILED_TEXT)
  check(!has(hf, 'summarizer timed out'), "failed: the daemon's internal reason is not shown to the operator", hf)
  check(!has(visible(hf), COMPACTION_RUNNING_TEXT), 'failed: the running line is gone', hf)
  check(!has(hf, 'role="progressbar"'), 'failed: no bar', hf)
  const hs = render(run([cf('start', { chunksDone: 1, chunksTotal: 4 }), cf('failed', { reason: 'cancelled' })]))
  check(!has(visible(hs), COMPACTION_FAILED_TEXT) && !has(visible(hs), COMPACTION_RUNNING_TEXT) && !has(hs, 'role="progressbar"'), 'stopped: nothing visible, no note, no bar', hs)

  console.log('\n=== 3c. render: idle, and the ActivityLine fallback word ===')
  const hi = render(COMPACTION_IDLE)
  check(visible(hi).trim() === '' && has(hi, 'aria-live="polite"'), 'idle: nothing visible, but the live region stays mounted so the next announcement is heard', hi)

  const al = renderToStaticMarkup(createElement(ActivityLine, { activity: { phase: 'compacting', at: Date.now(), tick: 0 } }))
  check(has(al, 'Tidying up'), 'ActivityLine: the pulse phase "compacting" reads "Tidying up", not a generic word', al)
  const al2 = renderToStaticMarkup(createElement(ActivityLine, { activity: { phase: 'compacting', at: Date.now(), tick: 7 } }))
  check(has(al2, 'Tidying up'), 'ActivityLine: every tick of "compacting" reads "Tidying up"', al2)
  const al3 = renderToStaticMarkup(createElement(ActivityLine, { activity: { phase: 'thinking', at: Date.now(), tick: 0 } }))
  check(!has(al3, 'Tidying up'), 'ActivityLine: an ordinary thinking pulse does not say "Tidying up"', al3)
}

async function main(): Promise<void> {
  await wire()
  rules()
  renders()
}

main().catch((err) => {
  console.error(`\n[smoke] threw: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`)
  process.exitCode = 1
})
