// Headless smoke for the desktop action log (computer-use v1.1, Prometheus#663)
// (ELECTRON_RUN_AS_NODE electron out/main/computer-smoke.js). No daemon, no React.
//
// THE GUARANTEE IT PINS: no computer_* frame is silently dropped. That failure has already happened
// twice to this client's sibling stream. coding_tool and coding_acceptance shipped for months
// wrapped as sentinel_signal because the daemon's promotion list was copied by hand and drifted,
// and every gate keyed on `ev.type` matched nothing (Prometheus#503). The daemon now promotes from
// the emitter's own tuple, COMPUTER_FRAME_KINDS. This smoke is the client's half of that contract:
//
//   1. The client's list of kinds is pinned to a copy of the server's tuple
//      (fixtures/computer-frame-kinds.json). A kind the daemon adds fails here until it decodes.
//   2. A whole task, replayed over a REAL socket through GatewaySocket, decodes frame by frame as
//      its own typed event (never 'unknown', never sentinel_signal) and folds to the right steps
//      and outcome.
//   3. A backfill that overlaps the live stream de-dupes by (task_id, seq).
//
// The wire fixture is WRITTEN from the daemon's payload builders, not captured (its header says
// so). Replace it with a capture once a daemon running #663 is reachable.

import { readFileSync } from 'node:fs'
import { WebSocketServer } from 'ws'
import type { ChatStreamFrame } from '@shared/ipc'
import { GatewaySocket } from './connection/ws'
import { categorize, eventRowTs, inActivityFeed, summarize, type EventRow, type GatewayEvent } from '@shared/gateway-events'
import {
  COMPUTER_EVENT_KINDS,
  COMPUTER_FRAME_KINDS,
  COMPUTER_STEP_THUMBNAIL,
  COMPUTER_STOP_ACK,
  EMPTY_COMPUTER,
  computerBackfillPath,
  computerEventsFromRows,
  computerLogRows,
  computerOutcomeLabel,
  computerStepLabel,
  computerTaskStopFrame,
  consentLabel,
  decodeComputerEvent,
  hasPendingApproval,
  latestTask,
  mergeComputerBackfill,
  missingSeqs,
  reduceComputer,
  thumbnailSrc,
  THUMBNAIL_MIMES,
  type ComputerState,
  type ComputerStep,
  type ComputerTaskLive
} from '@shared/computer'
// Imported, not read from disk: the bundler inlines them, so the smoke cannot run against a
// fixture that failed to ship or a stale copy in another tree.
import kindsPin from './fixtures/computer-frame-kinds.json'
import wire from './fixtures/computer-wire-task.json'

let failures = 0
/** Total checks run. The MIN_CHECKS guard at the end needs this: a section that stops running
 *  (a renamed anchor making a slice return '') would otherwise reduce the count silently, and a
 *  smoke that measures less than it should still prints PASS. */
let checks = 0
function check(name: string, cond: boolean): void {
  checks++
  if (cond) console.log(`  ✓ ${name}`)
  else {
    console.error(`  ✗ ${name}`)
    failures++
  }
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

interface WireFrame {
  type: string
  timestamp: number
  payload: Record<string, unknown>
}
interface Scenario {
  session_id: string
  task_id: string
  frames: WireFrame[]
}
const scenarios = wire as unknown as { task: Scenario; task_layer1_end: WireFrame[]; stopped: Scenario; log_failed: Scenario }
const SID = scenarios.task.session_id
const serverTuple: string[] = kindsPin.COMPUTER_FRAME_KINDS
const allFrames: WireFrame[] = [...scenarios.task.frames, ...scenarios.stopped.frames, ...scenarios.log_failed.frames]
/** What ws.ts hands the store for a wire frame: timestamp (s) → ts (ms). */
const asEvent = (f: WireFrame): GatewayEvent => ({ type: f.type, payload: f.payload, ts: f.timestamp * 1000 })
const fold = (state: ComputerState, frames: WireFrame[]): ComputerState =>
  frames.reduce((s, f) => reduceComputer(s, asEvent(f)), state)

/** Replay frames over a real WebSocketServer through GatewaySocket and collect what reaches the
 *  panels' store, so the actual parse path runs, not a hand-built GatewayEvent. */
async function replay(frames: WireFrame[], chat: ChatStreamFrame[] = []): Promise<GatewayEvent[]> {
  const wss = new WebSocketServer({ port: 0 })
  await new Promise<void>((r) => wss.once('listening', () => r()))
  const port = (wss.address() as { port: number }).port
  wss.on('connection', (sock) => {
    for (const f of frames) sock.send(JSON.stringify(f))
  })
  const out: GatewayEvent[] = []
  const socket = new GatewaySocket(`ws://127.0.0.1:${port}`, {
    onState: () => undefined,
    onFrame: (f) => chat.push(f),
    onGatewayEvent: (ev) => out.push(ev),
    onAuthFailure: () => undefined
  })
  socket.start()
  await sleep(800)
  socket.stop()
  wss.close()
  return out
}

async function main(): Promise<void> {
  // ── 1. The client's kinds ARE the server's tuple ─────────────────────────────────────────────
  console.log('\n[pin] the client decodes exactly the server tuple (+ the stop ack)')
  check(`client COMPUTER_FRAME_KINDS equals the server tuple, same order (${serverTuple.join(', ')})`,
    JSON.stringify([...COMPUTER_FRAME_KINDS]) === JSON.stringify(serverTuple))
  // The event set is the server tuple PLUS the two direct-only kinds (the stop ack and the
  // thumbnail). Both decode and fold here, but NEITHER is in COMPUTER_FRAME_KINDS — that is what
  // keeps them out of a backfill. This is the assertion that makes that structural, not a comment.
  const DIRECT_ONLY = [COMPUTER_STOP_ACK, COMPUTER_STEP_THUMBNAIL]
  check('client COMPUTER_EVENT_KINDS is the server tuple plus the two direct-only kinds',
    COMPUTER_EVENT_KINDS.size === serverTuple.length + DIRECT_ONLY.length &&
      serverTuple.every((k) => COMPUTER_EVENT_KINDS.has(k)) &&
      DIRECT_ONLY.every((k) => COMPUTER_EVENT_KINDS.has(k)))
  check('NEITHER direct-only kind is a SignalBus kind (never persisted, never backfilled)',
    DIRECT_ONLY.every((k) => !serverTuple.includes(k)) &&
      DIRECT_ONLY.every((k) => !(COMPUTER_FRAME_KINDS as readonly string[]).includes(k)))
  check('the stop ack is the socket reply to our own stop', COMPUTER_STOP_ACK === 'computer_task_stop_ack')
  check('the thumbnail kind is the daemon\'s computer_step_thumbnail', COMPUTER_STEP_THUMBNAIL === 'computer_step_thumbnail')
  check('the wire fixture carries a frame of every kind the client decodes, so section 2 exercises each decoder',
    [...serverTuple, ...DIRECT_ONLY].every((k) => allFrames.some((f) => f.type === k)))
  // Optional: compare the fixture with the daemon's source itself. The fixture is a copy; this is
  // how a stale copy gets caught on a machine that has the Prometheus checkout.
  const src = process.env.PROMETHEUS_LIVESTREAM
  if (src) {
    const text = readFileSync(src, 'utf8')
    const m = /COMPUTER_FRAME_KINDS\s*=\s*\(([\s\S]*?)\)/.exec(text)
    const fromSource = m ? [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]) : []
    check(`the fixture matches COMPUTER_FRAME_KINDS in ${src}`, JSON.stringify(fromSource) === JSON.stringify(serverTuple))
  } else {
    console.log('  (set PROMETHEUS_LIVESTREAM=<path to livestream.py> to also compare the fixture with the daemon source)')
  }

  // ── 2. Over a real socket, every frame decodes as ITSELF ────────────────────────────────────
  console.log('\n[wire] the whole fixture over a real socket: nothing filtered, nothing unknown')
  const received = await replay(allFrames)
  check(`every frame reached the store (${received.length}/${allFrames.length})`, received.length === allFrames.length)
  check('in wire order', received.map((e) => e.type).join(',') === allFrames.map((f) => f.type).join(','))
  check('none arrived as sentinel_signal', !received.some((e) => e.type === 'sentinel_signal'))
  const decoded = received.map((e) => decodeComputerEvent(e))
  const unknown = decoded.filter((d) => d.kind === 'unknown')
  check(`NO frame decodes as unknown (${unknown.length} did${unknown.length ? `: ${unknown.map((u) => (u.kind === 'unknown' ? `${u.type} (${u.why})` : '')).join('; ')}` : ''})`,
    unknown.length === 0)
  check('each frame decodes as its own kind', decoded.every((d, i) => d.kind === received[i].type))
  for (const kind of [...serverTuple, COMPUTER_STOP_ACK]) {
    const ev = received.find((e) => e.type === kind)
    check(`${kind}: decoded as itself`, !!ev && decodeComputerEvent(ev).kind === kind)
    // The Activity feed's generic fallbacks are what an undecoded kind falls into: 'system' and
    // the type with its underscores replaced. A decoded kind has its own words.
    check(`${kind}: has an Activity category of its own (not the 'system' fallback)`, categorize(kind) === 'agent')
    check(`${kind}: has a summary of its own (not the type echoed back)`, !!ev && summarize(ev) !== kind.replace(/_/g, ' '))
  }

  // ── 3. A whole task folds to the right steps and outcome ────────────────────────────────────
  console.log('\n[task] binding on → started → steps (approval, executed) → ended → binding off')
  {
    const t = scenarios.task
    const afterOn = fold(EMPTY_COMPUTER, t.frames.slice(0, 1))
    check('binding on: the pick is live, with what it covers and its own sentence',
      afterOn.sessions[SID]?.binding?.on === true &&
        afterOn.sessions[SID]?.binding?.app === 'gedit' &&
        afterOn.sessions[SID]?.binding?.covers.join(',') === 'click,press_key:tab,press_key:escape' &&
        (afterOn.sessions[SID]?.binding?.describes ?? '').startsWith('Prometheus may click'))
    const state = fold(EMPTY_COMPUTER, t.frames)
    const sess = state.sessions[SID]
    const task = sess?.tasks[t.task_id]
    check('one session, one task', Object.keys(state.sessions).length === 1 && Object.keys(sess?.tasks ?? {}).length === 1)
    check('binding off at the end (scope task), app kept', sess?.binding?.on === false && sess?.binding?.app === 'gedit' && sess?.binding?.scope === 'task')
    check('started: app, goal, chooser, who started it, limits',
      task?.started?.app === 'gedit' && task?.started?.goal === 'save the document' && task?.started?.chooser === 'rule' &&
        task?.started?.startedBy === 'beacon' && task?.started?.limits.maxSteps === 20 && task?.started?.limits.maxApprovals === 10)
    check('4 steps, in seq order', task?.steps.map((s) => s.seq).join(',') === '1,2,3,4')
    check('step 1 executed under the pick: CONFIRMED',
      task?.steps[0]?.status === 'executed' && task?.steps[0]?.consent === 'binding' && task?.steps[0]?.effect === 'CONFIRMED' && task?.steps[0]?.verified === true)
    check('step 2 waits on approval cafe1234, with the action described in the app\'s own text',
      task?.steps[1]?.status === 'awaiting_approval' && task?.steps[1]?.approvalRequestId === 'cafe1234' &&
        task?.steps[1]?.action?.description === "Press Return on the push button 'Save'" && task?.steps[1]?.action?.appText === true)
    check('step 3 executed after the person approved: consent prompt, UNVERIFIABLE',
      task?.steps[2]?.status === 'executed' && task?.steps[2]?.consent === 'prompt' && task?.steps[2]?.effect === 'UNVERIFIABLE' && task?.steps[2]?.verified === null)
    check('step 4 abstained: no action, the chooser\'s reason kept',
      task?.steps[3]?.status === 'abstained' && task?.steps[3]?.action === null && task?.steps[3]?.reason === 'nothing on screen serves the goal')
    check('ended: done, 2 steps, 1 approval, nothing in flight',
      task?.ended?.outcome === 'done' && task?.ended?.steps === 2 && task?.ended?.approvals === 1 && task?.ended?.inFlightAtStop === false)
    check('nothing unplaced, no stream error', state.unplaced === 0 && task?.streamError === null && sess?.streamError === null)
    check('latestTask is this task', latestTask(sess)?.taskId === t.task_id)
    check('no seq gap', task ? missingSeqs(task).length === 0 : false)
    // Folding the whole task twice is what a reconnect replay looks like: nothing may change.
    const twice = fold(state, t.frames)
    check('replaying the whole task changes nothing (same ref)', twice === state)
  }

  // The layer-1 frames that close the same task ride the chat path, not this one. The chat_done
  // carries a string handle (Prometheus 6be4020), never a rowid, and must stay out of this state.
  console.log('\n[layer 1] the task\'s closing tool_call_end + chat_done stay on the chat path')
  {
    const chat: ChatStreamFrame[] = []
    const evs = await replay(scenarios.task_layer1_end, chat)
    const state = fold(EMPTY_COMPUTER, scenarios.task.frames)
    check('neither decodes as a computer frame', evs.length === 2 && evs.every((e) => decodeComputerEvent(e).kind === 'unknown'))
    check('neither touches the computer state (same ref)', evs.reduce((st, e) => reduceComputer(st, e), state) === state)
    const done = chat.find((f) => f.kind === 'done')
    check('chat_done maps to a done frame keyed by the handle computer:<task_id>, with no rowId invented',
      done?.kind === 'done' && done.messageId === `computer:${scenarios.task.task_id}` && done.rowId === undefined && done.interrupted === undefined)
  }

  console.log('\n[stopped] Stop mid-task: the ack, the action already in flight, outcome stopped')
  {
    const s = scenarios.stopped
    const state = fold(fold(EMPTY_COMPUTER, scenarios.task.frames), s.frames)
    const task = state.sessions[SID]?.tasks[s.task_id]
    check('the ack lands on its task (it carries no session_id)', task?.stopAck === true)
    check('the in-flight click is kept and marked as after the stop',
      task?.steps.length === 1 && task?.steps[0]?.status === 'in_flight_at_stop' && task?.steps[0]?.afterStop === true)
    check('ended stopped, with in_flight_at_stop', task?.ended?.outcome === 'stopped' && task?.ended?.inFlightAtStop === true)
    check('latestTask is now the stopped task', latestTask(state.sessions[SID])?.taskId === s.task_id)
    check('the earlier task is untouched', state.sessions[SID]?.tasks[scenarios.task.task_id]?.steps.length === 4)
    // An ack for a task this client never saw has nowhere to go. It is counted, not dropped.
    const orphan = reduceComputer(state, { type: COMPUTER_STOP_ACK, payload: { task_id: 'nope', stopped: false }, ts: 1 })
    check('an ack for an unknown task is counted as unplaced', orphan.unplaced === state.unplaced + 1)
  }

  console.log('\n[log_failed] a step frame that never arrived is visible, not hidden')
  {
    const s = scenarios.log_failed
    const state = fold(EMPTY_COMPUTER, s.frames)
    const task = state.sessions[SID]?.tasks[s.task_id]
    check('the stream error names the task', task?.streamError === 'computer_step not delivered (ConnectionError)')
    check('steps 1 and 3 kept', task?.steps.map((x) => x.seq).join(',') === '1,3')
    check('the gap is reported: seq 2 is missing', task ? missingSeqs(task).join(',') === '2' : false)
    check('the task still ends on its own outcome', task?.ended?.outcome === 'refused')
    const orphan = reduceComputer(state, { type: 'computer_stream_error', payload: { session_id: null, task_id: null, detail: 'bus down' }, ts: 1 })
    check('a stream error with no session is kept at the top level', orphan.orphanStreamError === 'bus down')
  }

  // ── 4. Backfill de-dupes with the live stream ─────────────────────────────────────────────────
  console.log('\n[backfill] GET /api/events/recent rows merged with live frames, de-duped by (task_id, seq)')
  {
    const path = computerBackfillPath(SID)
    check('the backfill path asks for every server kind, this session, 500 rows',
      path.startsWith('/api/events/recent?') &&
        new URLSearchParams(path.split('?')[1]).get('types') === serverTuple.join(',') &&
        new URLSearchParams(path.split('?')[1]).get('session_id') === SID &&
        new URLSearchParams(path.split('?')[1]).get('limit') === '500')
    // The rows the daemon returns: signal_events, newest first, ISO timestamps. The ack AND the
    // thumbnail are both direct-only — a socket reply and a memory-only image — so NEITHER is ever
    // among them. Excluding only the ack here would fabricate a persisted thumbnail row the daemon
    // never writes, and then assert the client de-dupes against a backfill that cannot happen.
    const persisted = allFrames.filter((f) => f.type !== COMPUTER_STOP_ACK && f.type !== COMPUTER_STEP_THUMBNAIL)
    const rows: EventRow[] = persisted
      .map((f, i) => ({ id: i + 1, timestamp: new Date(f.timestamp * 1000).toISOString(), signal_type: f.type, payload: f.payload, source_subsystem: 'computer' }))
      .reverse()
    check('the rows decode back to events (oldest first, ms timestamps)',
      computerEventsFromRows(rows).length === persisted.length &&
        computerEventsFromRows(rows)[0]?.type === persisted[0].type &&
        computerEventsFromRows(rows)[0]?.ts === eventRowTs(rows[rows.length - 1].timestamp))
    const t = scenarios.task

    // a) Full overlap: everything live already, then the backfill lands. Nothing may change.
    const live = fold(EMPTY_COMPUTER, allFrames)
    const merged = mergeComputerBackfill(live, rows)
    check('full overlap: the backfill adds nothing (same ref)', merged === live)
    check('full overlap: still 4 steps on the task', merged.sessions[SID]?.tasks[t.task_id]?.steps.length === 4)

    // b) A reconnect mid-task: live saw only the tail (step 3 onwards + binding off).
    // Found by CONTENT, not a hardcoded index: the thumbnail frame sits mid-stream (it arrives
    // before the step it belongs to), so a positional slice here would silently grab the wrong
    // frames the moment another direct-only frame is added. This broke once already.
    const seq3idx = t.frames.findIndex((f) => f.type === 'computer_step' && f.payload.seq === 3)
    const tail = t.frames.slice(seq3idx)
    const partial = fold(EMPTY_COMPUTER, tail)
    check('reconnected mid-task: live alone has 2 steps and no start', partial.sessions[SID]?.tasks[t.task_id]?.steps.length === 2 && partial.sessions[SID]?.tasks[t.task_id]?.started === null)
    const filled = mergeComputerBackfill(partial, rows)
    const ft = filled.sessions[SID]?.tasks[t.task_id]
    check('the backfill fills the start and the missing steps, no duplicates', ft?.steps.map((x) => x.seq).join(',') === '1,2,3,4' && ft?.started?.goal === 'save the document')
    check('the older binding:on from the backfill does NOT turn a live binding:off back on', filled.sessions[SID]?.binding?.on === false)
    check('the other tasks arrive from the backfill too', Object.keys(filled.sessions[SID]?.tasks ?? {}).length === 3)

    // c) The same backfill twice is a no-op the second time.
    check('merging the same backfill again changes nothing (same ref)', mergeComputerBackfill(filled, rows) === filled)

    // d) Backfill first, live replay after (the request resolved before the socket's frames).
    const seeded = mergeComputerBackfill(EMPTY_COMPUTER, rows)
    const thenLive = fold(seeded, persisted)
    check('backfill first, then the same frames live: same steps, same ref', thenLive === seeded && thenLive.sessions[SID]?.tasks[t.task_id]?.steps.length === 4)
  }

  // ── 5. The Activity feed stays readable ────────────────────────────────────────────────────────
  console.log('\n[activity] computer_step and computer_binding stay out, like coding_round')
  check('computer_step is kept out', !inActivityFeed('computer_step'))
  check('computer_binding is kept out', !inActivityFeed('computer_binding'))
  check('computer_task_started appears', inActivityFeed('computer_task_started'))
  check('computer_task_ended appears', inActivityFeed('computer_task_ended'))
  check('computer_stream_error appears', inActivityFeed('computer_stream_error'))
  check('coding_round is still kept out', !inActivityFeed('coding_round'))
  check('chat_message still appears', inActivityFeed('chat_message'))

  // ── 6. Stop ──────────────────────────────────────────────────────────────────────────────────
  console.log('\n[stop] {type: computer_task_stop, payload: {task_id}} over the socket, ack decoded')
  check('the stop frame is exactly the daemon contract',
    JSON.stringify(computerTaskStopFrame('a1b2c3d4')) === JSON.stringify({ type: 'computer_task_stop', payload: { task_id: 'a1b2c3d4' } }))
  {
    const wss = new WebSocketServer({ port: 0 })
    await new Promise<void>((r) => wss.once('listening', () => r()))
    const port = (wss.address() as { port: number }).port
    const got: unknown[] = []
    wss.on('connection', (sock) => {
      sock.send(JSON.stringify({ type: 'connected', timestamp: Date.now() / 1000, payload: {} }))
      sock.on('message', (data) => {
        const msg = JSON.parse(String(data)) as { type?: string; payload?: { task_id?: string } }
        got.push(msg)
        // ws_server.py: the ack goes to the requesting socket only.
        if (msg.type === 'computer_task_stop') {
          sock.send(JSON.stringify({ type: 'computer_task_stop_ack', timestamp: Date.now() / 1000, payload: { task_id: msg.payload?.task_id ?? '', stopped: true } }))
        }
      })
    })
    const events: GatewayEvent[] = []
    const socket = new GatewaySocket(`ws://127.0.0.1:${port}`, {
      onState: () => undefined,
      onFrame: () => undefined,
      onGatewayEvent: (ev) => events.push(ev),
      onAuthFailure: () => undefined
    })
    socket.start()
    await sleep(400)
    check('it sends while the socket is open', socket.sendComputerTaskStop('a1b2c3d4') === true)
    await sleep(400)
    // Exactly two frames, in this order: the subscribe that follows the open (it declares the
    // capability the daemon's thumbnail gate reads), then the stop. Written as literals, not via
    // wsSubscribeFrame(), so this pins the wire contract rather than echoing the code under test.
    check('the daemon received exactly the subscribe {capabilities: [computer-thumbnails]}, then {type: computer_task_stop, payload: {task_id}}',
      JSON.stringify(got) === JSON.stringify([
        { type: 'subscribe', payload: { capabilities: ['computer-thumbnails'] } },
        { type: 'computer_task_stop', payload: { task_id: 'a1b2c3d4' } }
      ]))
    const ack = events.find((e) => e.type === COMPUTER_STOP_ACK)
    const d = ack ? decodeComputerEvent(ack) : null
    check('the ack comes back and decodes', d?.kind === 'computer_task_stop_ack' && d.taskId === 'a1b2c3d4' && d.stopped === true)
    socket.stop()
    await sleep(50)
    check('with the socket closed it reports false (the caller falls back to REST), never throws', socket.sendComputerTaskStop('a1b2c3d4') === false)
    wss.close()
  }

  // ── 7. Labels: the app's words and honest outcomes, never a blank ───────────────────────────
  console.log('\n[labels] each status and outcome has words; unknown ones fall back to the raw value')
  for (const st of ['executed', 'refused', 'abstained', 'reobserve', 'blocked', 'awaiting_approval', 'in_flight_at_stop']) {
    check(`step status ${st} has its own label`, computerStepLabel(st) !== st && computerStepLabel(st).length > 0)
  }
  check('in_flight_at_stop says it may have landed', /may have landed/.test(computerStepLabel('in_flight_at_stop')))
  check('awaiting_approval says it waits on a person', /approv/i.test(computerStepLabel('awaiting_approval')))
  check('an unknown status renders as itself, never blank', computerStepLabel('new_status') === 'new_status')
  for (const oc of ['done', 'abstained', 'stopped', 'refused', 'failed', 'limit']) {
    check(`outcome ${oc} has its own label`, computerOutcomeLabel(oc).text !== oc && computerOutcomeLabel(oc).text.length > 0)
  }
  check('done is the only ok outcome', computerOutcomeLabel('done').tone === 'ok' && computerOutcomeLabel('stopped').tone !== 'ok')
  check('failed wears the error tone', computerOutcomeLabel('failed').tone === 'err')

  // ── 8. The decoder's edges ──────────────────────────────────────────────────────────────────
  console.log('\n[edges] malformed and unrelated frames')
  {
    const base = fold(EMPTY_COMPUTER, scenarios.task.frames)
    check('an unrelated frame leaves the state alone (same ref)', reduceComputer(base, { type: 'chat_message', payload: { session_id: SID }, ts: 1 }) === base)
    check('an unrelated frame decodes as unknown', decodeComputerEvent({ type: 'tool_call_start', payload: {} }).kind === 'unknown')
    const noTask = { type: 'computer_step', payload: { session_id: SID, seq: 9, status: 'executed' }, ts: 1 }
    const d = decodeComputerEvent(noTask)
    check('a computer_step with no task_id decodes as unknown WITH a reason', d.kind === 'unknown' && d.why.includes('task_id'))
    check('...and is counted as unplaced, not dropped', reduceComputer(base, noTask).unplaced === base.unplaced + 1)
    // The failure this whole smoke exists for: a computer kind arriving wrapped as sentinel_signal
    // because the daemon's promotion regressed. It is still decoded and folded.
    // Found by CONTENT, not a positional index: the thumbnail frame sits before the first step, so
    // frames[2] would now be a computer_step_thumbnail, not the computer_step this asserts on.
    const step = scenarios.task.frames.find((f) => f.type === 'computer_step')!
    const wrapped = { type: 'sentinel_signal', payload: { kind: step.type, payload: step.payload, source: 'computer' }, ts: step.timestamp * 1000 }
    check('a computer kind wrapped as sentinel_signal still decodes as itself', decodeComputerEvent(wrapped).kind === 'computer_step')
    const fromWrapped = reduceComputer(EMPTY_COMPUTER, wrapped)
    check('...and folds', fromWrapped.sessions[SID]?.tasks[scenarios.task.task_id]?.steps[0]?.seq === 1)
    check('an unrelated sentinel_signal is left alone', reduceComputer(base, { type: 'sentinel_signal', payload: { kind: 'dream_start', payload: {} }, ts: 1 }) === base)
  }

  // ── 9. The step-by-step log (PR 7): rows, ordering, and the inline approval ────────────────
  console.log('\n[log] the whole log as rows the pane renders')
  {
    const step = (n: number, over: Partial<ComputerStep> = {}): ComputerStep => ({
      seq: n,
      status: 'executed',
      action: null,
      extent: null,
      consent: null,
      approvalRequestId: null,
      chooser: null,
      effect: 'CONFIRMED',
      verified: true,
      afterStop: false,
      candidatesOffered: 3,
      durationMs: 120,
      reason: '',
      thumbnail: null,
      thumbnailSkipReason: null,
      at: 1000 + n,
      ...over
    })
    const task: ComputerTaskLive = {
      taskId: 'T1',
      started: null,
      steps: [
        // Step 1 carries BOTH an app description and a reason on purpose: appText must win, and
        // a fixture with an empty reason cannot tell "reason suppressed" from "reason was never
        // there" — the mutation check below depends on this being non-empty.
        step(1, { action: { verb: 'click', description: 'Save', appText: true }, consent: 'binding', reason: 'a reason that must not show' }),
        step(2, { status: 'awaiting_approval', action: { verb: 'type_text', description: 'Search', appText: true }, consent: 'prompt', approvalRequestId: 'A9', effect: null, verified: null }),
        step(3, { status: 'refused', reason: 'not covered', effect: null, verified: null })
      ],
      ended: null,
      stopAck: null,
      streamError: null,
      firstAt: 1001,
      thumbs: {}
    }

    // The ordering is the log's whole point: oldest first, exactly the reducer's order, and NOT
    // re-sorted or renumbered — a gap must stay visible rather than being closed by a shift.
    const allPending = new Set(['A9'])
    const rows = computerLogRows(task, allPending)
    check('one row per step, in seq order', rows.map((r) => r.seq).join(',') === '1,2,3')
    check('each row carries Beacon\'s word for its status', rows[0].label === computerStepLabel('executed') && rows[2].label === computerStepLabel('refused'))
    check('an unknown status renders as itself, never blank', computerLogRows({ ...task, steps: [step(1, { status: 'brand_new_status' })] }, new Set())[0].label === 'brand_new_status')

    // THE JOIN. Whether an approval is still actionable is the store's business, not the log's —
    // so a step names the request it waits on and this answers from the ids it was given.
    check('a step waiting on a still-queued approval names its id', rows[1].pendingApprovalId === 'A9')
    check('...and the log says it has something to act on', hasPendingApproval(rows))
    const answered = computerLogRows(task, new Set())
    check('once the queue no longer holds it, the row names nothing', answered[1].pendingApprovalId === null)
    check('...and the log says there is nothing to act on', hasPendingApproval(answered) === false)
    check('the step itself is KEPT after its approval is answered', answered.length === 3 && answered[1].seq === 2)

    // appText wins over reason: the app's own description of the element is better evidence than
    // Beacon's words, and showing both would read as two claims about one action.
    check('a step with app text shows the app\'s words', rows[0].appText === 'Save' && rows[0].reason === null)
    check('a step with no app text shows the reason instead', rows[2].appText === null && rows[2].reason === 'not covered')
    check('a step with neither shows neither, not an empty string', computerLogRows({ ...task, steps: [step(1, { reason: '' })] }, new Set())[0].reason === null)

    check('consent and effect ride through untouched', rows[0].consent === 'binding' && rows[0].effect === 'CONFIRMED')
    check('a step that never dispatched has no effect claim', rows[1].effect === null)
    check('an in-flight-at-stop step says so', computerLogRows({ ...task, steps: [step(1, { afterStop: true })] }, new Set())[0].afterStop === true)

    check('consent words: each known term', consentLabel('binding') === 'covered by your pick' && consentLabel('prompt') === 'you approved it' && consentLabel('grant') === 'a remembered grant')
    check('consent words: an unknown term renders as itself', consentLabel('mystery') === 'mystery')
    check('consent words: null stays null — "no consent term" is not an unknown one', consentLabel(null) === null)

    // The real folded state, not a hand-built task: the rows come out of the same reducer the
    // socket feeds, so the log cannot drift from what the frames actually said.
    const folded = fold(EMPTY_COMPUTER, scenarios.task.frames)
    const live = latestTask(folded.sessions[SID])
    check('rows build from the reducer\'s own state', live !== null && computerLogRows(live, new Set()).length === live.steps.length)
  }

  // ── 10. The renderer is WIRED to the model (source check) ──────────────────────────────────
  // The pure model above is only half the claim: a correct computerLogRows that no component
  // calls renders nothing. The house pattern is to assert the wiring from source, because a
  // smoke cannot mount a window. Every slice asserts its own LENGTH first — an indexOf that
  // misses would otherwise return '' and pass the next check vacuously.
  console.log('\n[wiring] the pane renders the model, and the store feeds it')
  {
    const pane = readFileSync(new URL('../../src/renderer/src/components/ProgressPane.tsx', import.meta.url), 'utf8')
    const panel = readFileSync(new URL('../../src/renderer/src/components/SidePanel.tsx', import.meta.url), 'utf8')
    const main = readFileSync(new URL('../../src/renderer/src/components/MainView.tsx', import.meta.url), 'utf8')
    const store = readFileSync(new URL('../../src/renderer/src/gateway-store.tsx', import.meta.url), 'utf8')

    check('ProgressPane calls computerLogRows (the log is the model, not a re-implementation)', pane.includes('computerLogRows('))
    check('...and maps the rows rather than rendering only the last step', /rows\.map\(/.test(pane))
    check('the rows are keyed by seq', /key=\{r\.seq\}/.test(pane))

    // The approval join: the pane must ask the model which id is actionable, and answer through
    // the prop rather than reaching into a second approval source of its own.
    check('the pane renders an approve/deny control for a row with a pending approval', /r\.pendingApprovalId && onResolveApproval/.test(pane))
    const approveIdx = pane.indexOf("kind: 'approve', scope: 'once'")
    check('Approve answers with scope once — a desktop prompt offers no lasting scope', approveIdx !== -1)
    check('Deny carries no scope (denial creates no grant)', /kind: 'deny'/.test(pane))

    // The plumbing, at each hop. A prop that stops being forwarded renders a log with no controls
    // and nothing errors, so each hop is pinned.
    check('SidePanel forwards pendingApprovalIds to the pane', /pendingApprovalIds=\{pendingApprovalIds\}/.test(panel))
    check('SidePanel forwards onResolveApproval to the pane', /onResolveApproval=\{onResolveApproval\}/.test(panel))
    check('MainView derives the pending set from the approvals it already holds', /new Set\(approvals\.map\(\(a\) => a\.requestId\)\)/.test(main))
    check('MainView passes it to the dock', /pendingApprovalIds=\{pendingApprovalIds\}/.test(main))
    check('MainView passes its one resolve function to the dock', /onResolveApproval=\{\(id, d\) => void resolveApproval\(id, d\)\}/.test(main))

    // The store feeds the section, and keeps the per-step frames out of Activity (both from #194;
    // pinned here because the log depends on both and a regression would be silent).
    check('the store folds computer frames through the shared reducer', store.includes('reduceComputer('))
    check('the store keeps step frames out of the Activity feed', /computer_step/.test(store) && store.includes('ACTIVITY_EXCLUDED_KINDS'))

    // A surface with no approval context must SAY SO rather than render a log that looks
    // actionable and is not.
    const noCtx = pane.slice(pane.indexOf('anyPending && !onResolveApproval'))
    check('a pending approval with no way to answer it is announced, not silently inert',
      noCtx.length > 40 && /Approvals view/.test(noCtx.slice(0, 400)))

  }

  // ── 13. The per-step thumbnail (Prometheus#701): decode, the mime gate, keyed reduce ─────────
  console.log('\n[thumb] the direct-only thumbnail frame decodes and folds by seq')
  {
    const sid = scenarios.task.session_id
    const tid = scenarios.task.task_id
    const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC'
    const thumbFrame = (over: Record<string, unknown> = {}): GatewayEvent => ({
      type: COMPUTER_STEP_THUMBNAIL, ts: 1791144901400,
      payload: { session_id: sid, task_id: tid, seq: 1, app: 'gedit', mime_type: 'image/png', width: 480, height: 300, data_base64: PNG, captured_at: '2026-10-04T20:15:01Z', ...over }
    })

    // The mime gate: THE second gate. The daemon already refuses svg; this is what stops a
    // compromised or buggy daemon from getting a scriptable data URL rendered in an <img>.
    check('a png/jpeg/webp mime yields a data URL', thumbnailSrc('image/png', PNG)?.startsWith('data:image/png;base64,') === true)
    check('svg is REFUSED even though it is a valid image mime', thumbnailSrc('image/svg+xml', 'PHN2Zz48c2NyaXB0Lz48L3N2Zz4=') === null)
    check('an unknown mime is refused', thumbnailSrc('image/x-evil', PNG) === null)
    check('a non-string mime is refused', thumbnailSrc(undefined, PNG) === null)
    check('empty data is refused', thumbnailSrc('image/png', '') === null)
    check('non-base64 characters are refused (not handed to the browser)', thumbnailSrc('image/png', 'not base64!!') === null)
    check('the allowlist is exactly the three the daemon sends', THUMBNAIL_MIMES.join(',') === 'image/png,image/jpeg,image/webp')

    // Decode: a thumbnail frame becomes its own event, with src gated.
    const dec = decodeComputerEvent(thumbFrame())
    check('a thumbnail frame decodes as computer_step_thumbnail', dec.kind === 'computer_step_thumbnail')
    if (dec.kind === 'computer_step_thumbnail') {
      check('...carrying the seq it belongs to', dec.thumb.seq === 1)
      check('...and a validated src', dec.thumb.src?.startsWith('data:image/png') === true)
      check('...and the app, not a window title', dec.thumb.app === 'gedit')
      check('...and the capture time from the daemon\'s ISO captured_at', dec.thumb.at === Date.UTC(2026, 9, 4, 20, 15, 1))
    }
    const badDec = decodeComputerEvent(thumbFrame({ mime_type: 'image/svg+xml' }))
    check('a refused mime still decodes, with src null (so the pane can say "will not show")',
      badDec.kind === 'computer_step_thumbnail' && badDec.thumb.src === null && badDec.thumb.mimeType === 'image/svg+xml')
    const badTime = decodeComputerEvent(thumbFrame({ captured_at: 'not a time' }))
    check('an unparsable captured_at falls back to the frame time, not 0 or NaN',
      badTime.kind === 'computer_step_thumbnail' && badTime.thumb.at === 1791144901400)
    const noSeq = decodeComputerEvent(thumbFrame({ seq: undefined }))
    check('a thumbnail with no seq is unknown WITH a reason', noSeq.kind === 'unknown' && noSeq.why.includes('seq'))

    // Reduce: keyed by seq on the task, NOT merged into a step — because the frame arrives BEFORE
    // its step. This is the ordering the fixture reproduces and the join the pane does at render.
    const withThumb = reduceComputer(EMPTY_COMPUTER, thumbFrame())
    const t = withThumb.sessions[sid]?.tasks[tid]
    check('the thumbnail folds onto the task, keyed by seq', t?.thumbs[1]?.src?.startsWith('data:image/png') === true)
    check('...before any step frame arrived (there are no steps yet)', (t?.steps.length ?? -1) === 0)
    const same = reduceComputer(withThumb, thumbFrame())
    check('the identical thumbnail again is a no-op (same ref)', same === withThumb)

    // The full fixture task: thumbnail for seq 1 arrives before its step, then the step lands, and
    // both are on the same task — the join the pane performs.
    const folded = fold(EMPTY_COMPUTER, scenarios.task.frames)
    const ft = folded.sessions[sid]?.tasks[tid]
    check('the fixture task carries the seq-1 thumbnail', ft?.thumbs[1]?.src !== null && ft?.thumbs[1]?.src !== undefined)
    check('...and its step 1 says thumbnail:"sent"', ft?.steps.find((s) => s.seq === 1)?.thumbnail === 'sent')
    check('a step with no thumbnail carries null, not "skipped"', ft?.steps.find((s) => s.seq === 2)?.thumbnail === null)
    check('the thumbnail frame is NOT counted as unplaced', folded.unplaced === 0)
    // The promise the capability makes: the feed keeps payloads verbatim (rendered, copyable,
    // exported), so a thumbnail reaching it would put a picture of the desktop in a download.
    check('the thumbnail frame is kept OUT of the Activity feed (its payload is a screenshot)',
      !inActivityFeed(COMPUTER_STEP_THUMBNAIL))
    // The subscribe that declares the capability is answered with `subscribed` on every (re)connect;
    // that ack is protocol housekeeping, not activity.
    check('the daemon\'s subscribed ack is kept OUT of the Activity feed', !inActivityFeed('subscribed'))

    // The wiring half: the pane renders the image from the joined thumb, and declares the
    // capability on its subscribe so the daemon will send one at all (#701 gate condition 3).
    const pane = readFileSync(new URL('../../src/renderer/src/components/ProgressPane.tsx', import.meta.url), 'utf8')
    const ws = readFileSync(new URL('../../src/main/connection/ws.ts', import.meta.url), 'utf8')
    check('the pane joins a step row to its thumbnail by seq', pane.includes('task.thumbs[r.seq]'))
    check('the pane renders the gated src in an <img>', /<img\s+src=\{thumb\.src\}/.test(pane))
    // The wire-level half is section 6 (the mock daemon receives the subscribe frame); this pins
    // that the send is code, not a comment that happens to name the capability.
    check('the client sends its subscribe frame when the socket opens',
      ws.includes('ws.send(JSON.stringify(wsSubscribeFrame()))'))
  }

  // Last, so it covers every section above it.
  const MIN_CHECKS = 163
  if (checks < MIN_CHECKS) {
    check(`at least ${MIN_CHECKS} checks ran (got ${checks}) — a section stopped running`, false)
  }

  console.log(failures === 0 ? `\n[computer-smoke] PASS (${checks} checks)` : `\n[computer-smoke] FAIL (${failures})`)
  process.exit(failures === 0 ? 0 : 1)
}

void main()
