/**
 * voice-stream-smoke — the pure core of STREAMING voice turns (oara-voice #12's Beacon half).
 *
 * PINS THE CONTRACT of shared/voice-stream.ts:
 *   1. NdjsonBuffer — lines split at arbitrary chunk boundaries reassemble; a trailing line without
 *      a newline is flushed; a non-JSON line is REPORTED (malformed), never dropped silently.
 *   2. parseStreamLine — transcript/segment/done shapes; a segment without audio is not a segment.
 *   3. playbackReduce/playbackStart — the first segment starts the moment it arrives; each `ended`
 *      starts the next; nothing starts twice; late lower-seq is inserted by seq; idle is exact.
 *   4. outcomeFromDone — the done line maps through the SAME single mapper as /bridge/voice
 *      (every status → one visible state); a partial reply is SAID via partialSpeechNotice.
 *   5. streamUnsupported — only 404/405 mean "fall back to /bridge/voice"; a 500 is a failure.
 *
 * Fetch/IPC/<audio> are hands-on; everything that CAN be asserted headlessly is asserted here.
 *
 * Run: npm run smoke:voice-stream
 */
import {
  NdjsonBuffer,
  VOICE_PATH,
  VOICE_STREAM_PATH,
  initialPlayback,
  outcomeFromDone,
  parseStreamLine,
  partialSpeechNotice,
  playbackIdle,
  playbackReduce,
  playbackStart,
  streamUnsupported,
  type PlaybackState,
  type VoiceStreamEvent
} from '@shared/voice-stream'

let failures = 0
function assert(cond: boolean, what: string): void {
  console.log(`[smoke] ${cond ? 'PASS' : 'FAIL'}  ${what}`)
  if (!cond) failures++
}

// ── 1/2. NDJSON across chunk boundaries ──────────────────────────────────────────────────────
// Shapes captured from the live scratch run on 2026-09-02 (oara-voice PR #12 body).
const lines = [
  '{"type": "transcript", "task_id": "oara-1", "transcript": "What time is it?", "stt_ms": 133, "level_rms": 1258.4}',
  '{"type": "segment", "seq": 0, "text": "It is early.", "audio_base64": "UklGRg==", "synth_ms": 719, "t_ms": 2016}',
  '{"type": "segment", "seq": 1, "text": "Very early.", "audio_base64": "UklGRh==", "synth_ms": 500, "t_ms": 2516}',
  'this is not json',
  '{"type": "done", "status": "complete", "transcript": "What time is it?", "speak": "It is early. Very early.", "full": "It is early. Very early.", "segments": 2, "audio_error": null, "stage_ms": {"stt": 133, "agent": 1359, "tts": 1544, "ttfa": 2015, "tts_gpu": 1739}}'
]
const whole = lines.join('\n') + '\n'
{
  const b = new NdjsonBuffer()
  const got: VoiceStreamEvent[] = []
  const bad: string[] = []
  // Feed in awkward 7-byte chunks — a line boundary lands mid-chunk, a JSON string is split mid-token.
  for (let i = 0; i < whole.length; i += 7) {
    const r = b.push(whole.slice(i, i + 7))
    got.push(...r.events)
    bad.push(...r.malformed)
  }
  got.push(...b.flush().events)
  assert(got.map((e) => e.type).join(',') === 'transcript,segment,segment,done', `chunked feed reassembles every line in order (${got.map((e) => e.type).join(',')})`)
  assert(bad.length === 1 && bad[0] === 'this is not json', 'a non-JSON line is reported as malformed, not dropped silently')
  const seg = got[1]
  assert(seg.type === 'segment' && seg.seq === 0 && seg.audio_base64 === 'UklGRg==' && seg.synth_ms === 719, 'segment fields survive')
  const done = got[3]
  assert(done.type === 'done' && done.segments === 2 && done.stage_ms?.ttfa === 2015, 'done fields survive, incl. stage_ms.ttfa')
}
{
  const b = new NdjsonBuffer()
  assert(b.push('{"type":"done","status":"no_speech"').events.length === 0, 'an incomplete line is held')
  b.push('}')
  const r = b.flush()
  assert(r.events.length === 1 && r.events[0].type === 'done' && r.events[0].status === 'no_speech', 'flush releases a trailing line with no newline')
  assert(new NdjsonBuffer().flush().events.length === 0, 'empty flush is empty')
}
assert(parseStreamLine('{"type":"segment","seq":0,"text":"x"}') === null, 'a segment without audio_base64 is NOT a segment')
assert(parseStreamLine('{"type":"weird"}') === null, 'unknown event types are ignored')
assert(parseStreamLine('[1,2]') === null, 'a JSON array is not an event')

// ── 3. playback queue ────────────────────────────────────────────────────────────────────────
{
  let s: PlaybackState = initialPlayback
  let n = playbackReduce(s, { kind: 'segment', seq: 0, url: 'blob:a' })
  assert(playbackStart(s, n) === 'blob:a', 'the FIRST segment starts the moment it arrives')
  s = n
  n = playbackReduce(s, { kind: 'segment', seq: 1, url: 'blob:b' })
  assert(playbackStart(s, n) === null && n.playing === 0, 'a second segment queues without interrupting the first')
  s = n
  n = playbackReduce(s, { kind: 'ended' })
  assert(playbackStart(s, n) === 'blob:b' && n.playing === 1, 'ended → the next segment starts')
  s = n
  n = playbackReduce(s, { kind: 'ended' })
  assert(playbackStart(s, n) === null && n.playing === -1, 'ended with nothing queued → idle, starts nothing')
  assert(!playbackIdle(n), 'not idle yet: done has not arrived (more segments may come)')
  s = n
  n = playbackReduce(s, { kind: 'segment', seq: 2, url: 'blob:c' })
  assert(playbackStart(s, n) === 'blob:c' && n.playing === 2, 'a segment arriving after a drain restarts playback')
  s = playbackReduce(n, { kind: 'ended' })
  s = playbackReduce(s, { kind: 'done' })
  assert(playbackIdle(s), 'done + nothing playing → idle')
  assert(playbackReduce(s, { kind: 'reset' }) === initialPlayback, 'reset returns the initial state')
  assert(playbackReduce(initialPlayback, { kind: 'ended' }) === initialPlayback, 'ended while idle is a no-op')
}
{
  // Late lower seq (not expected from one ordered worker, but never play it AFTER a later phrase).
  let s: PlaybackState = playbackReduce(initialPlayback, { kind: 'segment', seq: 1, url: 'blob:b' })
  s = playbackReduce(s, { kind: 'segment', seq: 0, url: 'blob:a' })
  assert(s.queue.map((q) => q.seq).join(',') === '0,1', 'queue is kept in seq order')
}

// ── 4. outcomes ──────────────────────────────────────────────────────────────────────────────
const doneOk: Extract<VoiceStreamEvent, { type: 'done' }> = { type: 'done', status: 'complete', transcript: 'hi', speak: 'Hello there.', full: 'Hello there.', segments: 1, audio_error: null }
{
  const o = outcomeFromDone(doneOk)
  assert(o.kind === 'spoken' && o.reply === 'Hello there.' && o.audioUrl === null, 'complete → spoken, audioUrl null (segments already played)')
  assert(outcomeFromDone({ type: 'done', status: 'no_speech' }).kind === 'no_speech', 'no_speech → the same single mapper as /bridge/voice')
  assert(outcomeFromDone({ type: 'done', status: 'timeout' }).kind === 'timeout', 'timeout maps')
  assert(outcomeFromDone({ type: 'done', status: 'agent_unavailable' }).kind === 'error', 'agent_unavailable → error, never silence')
  assert(partialSpeechNotice(doneOk) === '', 'no audio_error → no notice')
  const partial = { ...doneOk, audio_error: "segment 1 ('Very early.') failed: RuntimeError: TTS 500 (reply partly spoken: 1 segment(s))" }
  assert(partialSpeechNotice(partial).startsWith('Speech stopped early — segment 1'), 'a partly spoken reply is SAID, with the bridge\'s own words')
}

// ── 5. fallback rule ─────────────────────────────────────────────────────────────────────────
assert(streamUnsupported(404) && streamUnsupported(405), '404/405 → the bridge predates the stream route → fall back')
assert(!streamUnsupported(500) && !streamUnsupported(401) && !streamUnsupported(502), '500/401/502 are real failures — never masked by a fallback')
assert(VOICE_STREAM_PATH === '/bridge/voice/stream' && VOICE_PATH === '/bridge/voice', 'paths pinned')

console.log(`\n[smoke] voice-stream: ${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)
