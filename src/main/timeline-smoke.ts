// Headless Slice-4 smoke (ELECTRON_RUN_AS_NODE electron out/main/timeline-smoke.js).
// Proves the pure tool-timeline model: parallel-batch detection from overlapping execution
// windows, duration formatting, content-part pairing (history analog), and the strip summary.

import type { ContentPart } from '@shared/parts'
import {
  batchTimeline,
  callsFromParts,
  coalesceToolResults,
  COLLAPSE_ABOVE,
  hasLiveCall,
  groupForRender,
  isToolOnlyContent,
  fmtDuration,
  stripOpen,
  timelineSummary,
  toolTally,
  type TimelineCall
} from '@shared/timeline'

let failures = 0
function check(name: string, cond: boolean): void {
  if (cond) console.log(`  ✓ ${name}`)
  else {
    console.error(`  ✗ ${name}`)
    failures++
  }
}

const call = (id: string, startTs?: number, endTs?: number, running = false): TimelineCall => ({
  callId: id,
  name: id,
  running,
  startTs,
  endTs,
  durationMs: startTs !== undefined && endTs !== undefined ? endTs - startTs : undefined
})

console.log('batchTimeline (parallel detection):')
{
  // A: 0–100, B: 50–150 (overlaps A) → one parallel batch; C: 200–250 → its own batch.
  const b = batchTimeline([call('A', 0, 100), call('B', 50, 150), call('C', 200, 250)])
  check('overlap → same batch', b.length === 2 && b[0].length === 2 && b[1].length === 1)
}
{
  // strictly sequential: A 0–100, B 100–200 (start == prev end is NOT inside the window)
  const b = batchTimeline([call('A', 0, 100), call('B', 100, 200)])
  check('sequential → separate batches', b.length === 2)
}
{
  // a RUNNING call holds its window open — everything after joins its batch
  const b = batchTimeline([call('A', 0, undefined, true), call('B', 5_000), call('C', 9_000)])
  check('running call absorbs followers', b.length === 1 && b[0].length === 3)
}
{
  // history rows (no timestamps) never overlap
  const b = batchTimeline([call('A'), call('B'), call('C')])
  check('no timestamps → all sequential', b.length === 3)
}

console.log('fmtDuration:')
check('ms', fmtDuration(320) === '320ms')
check('seconds', fmtDuration(1400) === '1.4s')
check('minutes', fmtDuration(125_000) === '2m05s')
check('undefined → empty', fmtDuration(undefined) === '')

console.log('callsFromParts (history pairing):')
{
  const parts: ContentPart[] = [
    { type: 'toolCall', id: 'c1', name: 'grep', args: { q: 'x' } },
    { type: 'toolResult', toolUseId: 'c1', output: 'hit', error: false },
    { type: 'toolCall', id: 'c2', name: 'bash', args: {} },
    { type: 'toolResult', toolUseId: 'c2', output: 'boom', error: true }
  ]
  const calls = callsFromParts(parts)
  check('pairs by toolUseId', calls.length === 2 && calls[0].result === 'hit' && !calls[0].running)
  check('error flag carried', calls[1].error === true)
}
{
  const calls = callsFromParts([{ type: 'toolResult', toolUseId: 'orphan', output: 'lost' }])
  check('orphan result synthesizes a call', calls.length === 1 && calls[0].result === 'lost' && !calls[0].running)
}
{
  const calls = callsFromParts([{ type: 'toolCall', id: 'c9', name: 'slow' }], { startTs: 1000 })
  check('unfinished call stays running', calls[0].running && calls[0].startTs === 1000)
}
{
  const calls = callsFromParts(
    [
      { type: 'toolCall', id: 'c1', name: 'f' },
      { type: 'toolResult', toolUseId: 'c1', output: 'ok' }
    ],
    { startTs: 100, endTs: 350 }
  )
  check('live row meta → duration', calls[0].durationMs === 250)
}

console.log('timelineSummary:')
{
  // batch1 = [A(100ms) ‖ B(100ms)] wall-clock 100ms (longest member), batch2 = [C] 50ms → 150ms.
  const s = timelineSummary([call('A', 0, 100), call('B', 50, 150), call('C', 200, 250)])
  check('counts calls + parallel + wall-clock total', s.includes('3 calls') && s.includes('1 parallel batch') && s.includes('150ms'))
}

console.log('timelineSummary (live clock — a collapsed strip is all you see while it runs):')
{
  const live: TimelineCall[] = [call('A', 0, 100), { callId: 'B', name: 'B', running: true, startTs: 200 }]
  check('in-flight call counted from the clock', timelineSummary(live, 900).includes('800ms')) // 100 + (900-200)
  check('the same strip a tick later reads higher', timelineSummary(live, 1100).includes('1.0s'))
  check('no clock → finished work only', timelineSummary(live).includes('100ms'))
  check('a clock cannot rewind a call', timelineSummary([{ callId: 'B', name: 'B', running: true, startTs: 500 }], 100) === '1 call')
}

console.log('hasLiveCall (does this strip get a ticking clock?):')
check('a running, timestamped call ticks', hasLiveCall([{ callId: 'B', name: 'B', running: true, startTs: 200 }]))
check('a finished strip does not', !hasLiveCall([call('A', 0, 100)]))
// A history row whose result fell outside the loaded window stays `running` forever with no
// startTs. Ticking on `running` alone would spin an interval that never stops and never shows.
check('a history orphan never starts a clock', !hasLiveCall([{ callId: 'x', name: 'x', running: true }]))

console.log('stripOpen (auto-collapse after a few calls, reader overrides):')
check('at the threshold the strip is open', stripOpen(COLLAPSE_ABOVE, null))
check('one past it, the strip folds itself', !stripOpen(COLLAPSE_ABOVE + 1, null))
// THE DEFECT THIS FIXES: the strip used to seed this into useState at mount. A history row
// mounts holding its whole run and collapsed correctly; a LIVE strip is born at one call, so it
// was judged at length 1 and stayed open through call twenty-one — the same run rendered two
// ways depending only on whether you watched it happen. Derived per render, growth collapses it.
check('a strip that GREW to 21 collapses, same as one that mounted at 21', !stripOpen(21, null))
check('a click pins it open no matter how long the run gets', stripOpen(999, true))
check('a click pins it shut', !stripOpen(5, false))

console.log('toolTally (what the collapsed strip actually shows):')
{
  const t = toolTally([
    { callId: 'a1', name: 'bash', running: false, durationMs: 10 },
    { callId: 'a2', name: 'bash', running: false, error: true },
    { callId: 'b1', name: 'read_file', running: true, startTs: 40 }
  ])
  check('groups by name, first-appearance order', t.length === 2 && t[0].name === 'bash' && t[1].name === 'read_file')
  check('counts repeats', t[0].count === 2 && t[1].count === 1)
  check('one failure marks the group failed', t[0].error === true && t[0].running === false)
  check('a still-running tool stays lit while collapsed', t[1].running === true)
}

console.log('\nisToolOnlyContent (live vs history shape):')
{
  const call = { type: 'toolCall' as const, id: 'c1', name: 'bash' }
  const result = { type: 'toolResult' as const, toolUseId: 'c1', output: 'ok' }
  const text = { type: 'text' as const, text: 'I see two drives.' }
  check('a lone call is tool-only', isToolOnlyContent([call]))
  check('a coalesced call+result pair is tool-only', isToolOnlyContent([call, result]))
  // THE DEFECT THIS FIXES: history stores a call on an `assistant` row, so matching
  // on role alone merged the live shape and left history rendering one labelled
  // block per call — the same conversation looked different once reloaded.
  check("a history assistant row carrying only a call joins the run — role is not consulted", isToolOnlyContent([call, result]) === true)
  check('prose plus a call is a real message, not activity', !isToolOnlyContent([text, call]))
  check('text alone is not tool-only', !isToolOnlyContent([text]))
  check('an empty row is not tool-only (nothing to merge)', !isToolOnlyContent([]))
  check('string content is never tool-only', !isToolOnlyContent('plain string content'))
}

console.log('coalesceToolResults (history split-turn pairing):')
type Row = { key: string; role?: string; content: string | ContentPart[] }
{
  // The bug: assistant tool_use (row A) + user tool_result (row B) are SEPARATE durable rows, so
  // per-message pairing leaves A's call "running" and B's result orphaned. Coalescing folds it back.
  const A: Row = { key: 'a', role: 'assistant', content: [{ type: 'toolCall', id: 'c1', name: 'bash', args: {} }] }
  const B: Row = { key: 'b', role: 'user', content: [{ type: 'toolResult', toolUseId: 'c1', output: 'ok' }] }
  const out = coalesceToolResults([A, B])
  check('result-only row dropped', out.length === 1 && out[0].key === 'a')
  check('non-content fields preserved', out[0].role === 'assistant')
  const calls = callsFromParts(out[0].content as ContentPart[])
  check('call now pairs → not running', calls.length === 1 && !calls[0].running && calls[0].result === 'ok')
}
{
  // Parallel batch: two calls in one assistant row, two results in one user row, REVERSE order.
  const A: Row = { key: 'a', content: [{ type: 'toolCall', id: 'c1', name: 'f' }, { type: 'toolCall', id: 'c2', name: 'g' }] }
  const B: Row = { key: 'b', content: [{ type: 'toolResult', toolUseId: 'c2', output: 'g!' }, { type: 'toolResult', toolUseId: 'c1', output: 'f!' }] }
  const calls = callsFromParts(coalesceToolResults([A, B])[0].content as ContentPart[])
  check('parallel results matched by id (order-independent)', calls.length === 2 && calls.every((c) => !c.running))
}
{
  // Leading assistant text is kept; the result is appended after the call.
  const A: Row = { key: 'a', content: [{ type: 'text', text: 'running tests' }, { type: 'toolCall', id: 'c1', name: 'bash' }] }
  const B: Row = { key: 'b', content: [{ type: 'toolResult', toolUseId: 'c1', output: 'ok' }] }
  const parts = coalesceToolResults([A, B])[0].content as ContentPart[]
  check('leading text preserved', parts[0].type === 'text' && parts[2]?.type === 'toolResult')
}
{
  // A genuinely-unmatched result (its call is outside the loaded window) is left in place untouched.
  const B: Row = { key: 'b', content: [{ type: 'toolResult', toolUseId: 'gone', output: 'x' }] }
  const out = coalesceToolResults([B])
  check('orphan result passes through (same ref)', out.length === 1 && out[0] === B)
}
{
  // Already-coalesced live row + string-content row → no-op, references preserved (no needless rerender).
  const live: Row = { key: 'l', content: [{ type: 'toolCall', id: 'c1', name: 'f' }, { type: 'toolResult', toolUseId: 'c1', output: 'ok' }] }
  const txt: Row = { key: 't', content: 'hello' }
  const out = coalesceToolResults([live, txt])
  check('no-op preserves refs', out.length === 2 && out[0] === live && out[1] === txt)
}

// ── THE PROPERTY: one turn, two shapes, one picture ──────────────────────────
//
// The chat receives a turn twice in its life: as a live stream (each tool call arrives as its own
// `role: 'tool'` row) and as history after a reload (the daemon wrote the prose and the call on the
// SAME assistant row). #60 merged consecutive tool-ONLY rows, which fixed the shape live but not the
// shape reloaded — a narrating turn ("Let me verify the schema, then write the spec." + a bash call)
// still rendered one strip per call after a restart. Observed 2026-08-25 on a real thread: three
// consecutive `1 CALL` strips where the live view had shown one.
//
// The assertion is the EQUIVALENCE, not either shape on its own. Checking only the reloaded form
// would go green again the next time the live path changed.
console.log('\ngroupForRender — the same turn groups the same, streamed or reloaded:')
{
  const shape = (rows: Row[]): string =>
    groupForRender(rows as never)
      .map((i) => (i.kind === 'timeline' ? `strip(${i.calls.length})` : `msg(${
        (i.m.content as ContentPart[]).map((p) => p.type).join('+')})`))
      .join(' ')

  // Live: prose lands alone, then the stream mints one row per call.
  const live: Row[] = [
    { key: 'm1', content: [{ type: 'text', text: 'Let me verify the schema.' }] },
    { key: 't1', content: [{ type: 'toolCall', id: 'c1', name: 'bash' }, { type: 'toolResult', toolUseId: 'c1', output: 'ok' }] },
    { key: 't2', content: [{ type: 'toolCall', id: 'c2', name: 'write_file' }, { type: 'toolResult', toolUseId: 'c2', output: 'ok' }] }
  ]
  // Reloaded: the daemon put the prose and the first call on one row.
  const reloaded: Row[] = [
    { key: 'r1', content: [{ type: 'text', text: 'Let me verify the schema.' }, { type: 'toolCall', id: 'c1', name: 'bash' }, { type: 'toolResult', toolUseId: 'c1', output: 'ok' }] },
    { key: 'r2', content: [{ type: 'toolCall', id: 'c2', name: 'write_file' }, { type: 'toolResult', toolUseId: 'c2', output: 'ok' }] }
  ]
  check(`live shape is msg + ONE strip (got: ${shape(live)})`, shape(live) === 'msg(text) strip(2)')
  check(`reloaded shape matches it (got: ${shape(reloaded)})`, shape(reloaded) === 'msg(text) strip(2)')
  check('the two are IDENTICAL — this is the whole property', shape(live) === shape(reloaded))
}
{
  // Order inside a row is preserved: prose AFTER a call stays after it.
  const rows: Row[] = [{ key: 'x', content: [
    { type: 'toolCall', id: 'c1', name: 'bash' },
    { type: 'toolResult', toolUseId: 'c1', output: 'ok' },
    { type: 'text', text: 'done' }
  ] }]
  const kinds = groupForRender(rows as never).map((i) => i.kind).join(',')
  check(`a call followed by prose renders strip then message (got: ${kinds})`, kinds === 'timeline,msg')
}
{
  // Two prose runs in one row must not collide on the React key.
  const rows: Row[] = [{ key: 'dup', content: [
    { type: 'text', text: 'first' },
    { type: 'toolCall', id: 'c1', name: 'bash' },
    { type: 'text', text: 'second' }
  ] }]
  const keys = groupForRender(rows as never).map((i) => i.key)
  check(`keys are unique across one row's runs (got: ${keys.join(',')})`, new Set(keys).size === keys.length)
}
{
  // An empty row still renders as a message — it must not vanish into a strip.
  const rows: Row[] = [{ key: 'e', content: [] }]
  // Defensive shape check, not just [0].kind: dropping the empty-row branch makes this row vanish
  // entirely, and an index into an empty array throws a stack trace instead of naming the check.
  const grouped = groupForRender(rows as never)
  check('an empty row stays a message', grouped.length === 1 && grouped[0]?.kind === 'msg')
}
{
  // String content (legacy rows) is a message, untouched.
  const rows: Row[] = [{ key: 's', content: 'plain' }]
  check('string content stays a message', groupForRender(rows as never)[0].kind === 'msg')
}

if (failures > 0) {
  console.error(`\n[timeline-smoke] FAILED — ${failures} check(s)`)
  process.exit(1)
}
console.log('\n[timeline-smoke] PASS')
process.exit(0)
