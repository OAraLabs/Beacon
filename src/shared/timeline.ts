// Pure per-turn tool-call timeline model (Makeover Slice 4) — shared by the chat strip, the
// history adapter, and the headless smoke. NO DOM/Node imports.
//
// The daemon runs tools through hooks + parallel dispatch; the timeline makes that visible:
// chronological chips, with overlapping execution windows rendered as one PARALLEL batch.

import type { ContentPart } from './parts'

export interface TimelineCall {
  callId: string
  name: string
  args?: unknown
  result?: string
  /** true = the call failed (tool_call_end success=false / is_error). */
  error?: boolean
  /** start seen, no end yet — renders the pulsing live chip. */
  running: boolean
  startTs?: number
  endTs?: number
  durationMs?: number
}

/**
 * Group chronologically-ordered calls into sequential batches; a call whose start falls inside the
 * previous batch's open execution window (max endTs, or ∞ while any member still runs) joins that
 * batch — that's a PARALLEL dispatch. Calls without timestamps (history rows) never overlap.
 */
export function batchTimeline(calls: TimelineCall[]): TimelineCall[][] {
  const batches: TimelineCall[][] = []
  let cur: TimelineCall[] = []
  let windowEnd = -Infinity // max end of the current batch; Infinity while a member runs

  for (const c of calls) {
    const start = c.startTs
    const overlaps = cur.length > 0 && start !== undefined && start < windowEnd
    if (!overlaps && cur.length > 0) {
      batches.push(cur)
      cur = []
      windowEnd = -Infinity
    }
    cur.push(c)
    const end = c.running ? Infinity : c.endTs
    if (end !== undefined) windowEnd = Math.max(windowEnd, end)
  }
  if (cur.length > 0) batches.push(cur)
  return batches
}

/** Human duration: 320ms / 1.4s / 2m05s. Tabular-friendly. */
export function fmtDuration(ms?: number): string {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return ''
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const m = Math.floor(ms / 60_000)
  const s = Math.round((ms % 60_000) / 1000)
  return `${m}m${String(s).padStart(2, '0')}s`
}

/**
 * Pair a run of toolCall/toolResult ContentParts (history rows via content_json, or the live tool
 * row's parts) into TimelineCalls: a result attaches to its call by toolUseId↔id; an orphan result
 * synthesizes a finished call so nothing is dropped. History parts carry no timestamps → durations
 * stay blank and batches are sequential.
 */
export function callsFromParts(parts: ContentPart[], meta?: { startTs?: number; endTs?: number }): TimelineCall[] {
  const calls: TimelineCall[] = []
  for (const p of parts) {
    if (p.type === 'toolCall') {
      calls.push({
        callId: p.id ?? `call-${calls.length}`,
        name: p.name ?? 'tool',
        args: p.args,
        running: true,
        startTs: meta?.startTs
      })
    } else if (p.type === 'toolResult') {
      const call = p.toolUseId ? calls.find((c) => c.callId === p.toolUseId) : calls.find((c) => c.running)
      if (call) {
        call.result = p.output
        call.error = !!p.error
        call.running = false
        call.endTs = meta?.endTs
        if (call.startTs !== undefined && call.endTs !== undefined) {
          call.durationMs = Math.max(0, call.endTs - call.startTs)
        }
      } else {
        calls.push({
          callId: p.toolUseId ?? `result-${calls.length}`,
          name: 'tool',
          result: p.output,
          error: !!p.error,
          running: false
        })
      }
    }
  }
  return calls
}

/**
 * Reunite split tool turns from durable history. The daemon persists an assistant `tool_use` and its
 * `tool_result` as SEPARATE messages (Anthropic wire format); per-message pairing (callsFromParts)
 * only matches a result to a call inside ONE parts array, so a reloaded session shows every tool card
 * stuck "running" with the result orphaned as its own card. The live stream avoids this by folding
 * tool_start+tool_end into one row — this does the same for history: hoist each toolResult into the
 * message holding its toolCall (toolUseId↔id), then drop any message left with no parts. Pure &
 * order-preserving; string content and genuinely-unmatched results pass through untouched.
 */
export function coalesceToolResults<T extends { content: string | ContentPart[] }>(messages: T[]): T[] {
  const callMsg = new Map<string, T>() // toolCall id → the message that holds it
  for (const m of messages) {
    if (!Array.isArray(m.content)) continue
    for (const p of m.content) if (p.type === 'toolCall' && p.id) callMsg.set(p.id, m)
  }
  if (callMsg.size === 0) return messages

  const extra = new Map<T, ContentPart[]>() // results to append onto their call's message
  const moved = new Set<ContentPart>() // results to strip from their origin message
  for (const m of messages) {
    if (!Array.isArray(m.content)) continue
    for (const p of m.content) {
      if (p.type !== 'toolResult' || !p.toolUseId) continue
      const target = callMsg.get(p.toolUseId)
      if (!target || target === m) continue // genuine orphan / already same message → leave it
      const bucket = extra.get(target) ?? []
      bucket.push(p)
      extra.set(target, bucket)
      moved.add(p)
    }
  }
  if (moved.size === 0) return messages

  const out: T[] = []
  for (const m of messages) {
    if (!Array.isArray(m.content)) {
      out.push(m)
      continue
    }
    const add = extra.get(m)
    if (!add && !m.content.some((p) => moved.has(p))) {
      out.push(m) // untouched — preserve ref so React skips re-render
      continue
    }
    const content = [...m.content.filter((p) => !moved.has(p)), ...(add ?? [])]
    if (content.length === 0) continue // result-only row, now empty → drop
    out.push({ ...m, content })
  }
  return out
}

/** Strip summary: "3 calls · 2 parallel · 4.2s" (longest batch member per batch summed). */
/**
 * Is this row nothing but tool activity?
 *
 * WHY ROLE IS NOT ENOUGH. The live stream mints tool rows as `role: 'tool'`, but
 * HISTORY stores a tool call as an ordinary `assistant` row (its `user`-role
 * tool_result row is hoisted away by coalesceToolResults). So a reloaded
 * conversation had every call rendered as its own labelled ASSISTANT block with
 * its own one-call strip, while the same conversation live showed one merged
 * strip. Same data, two shapes, depending only on whether you had scrolled back.
 *
 * Content decides, not role. A row that is only calls is activity and joins the run.
 *
 * ⚠ THIS ALONE WAS NOT ENOUGH, and the remaining half is what `groupForRender`
 * fixes. It rescues rows with NO prose — but the daemon writes a narrating turn
 * as prose AND calls on the SAME row ("Let me verify the schema, then write the
 * spec." + the bash call). Those rows are not tool-only, so live they merged
 * (the stream mints a separate `role: 'tool'` row per call) and reloaded they did
 * not. Observed 2026-08-25 on a real thread: three consecutive `1 CALL` strips
 * after a restart where the live view had shown one. Same turn, two shapes,
 * depending only on whether you had restarted the app.
 */
export function isToolOnlyContent(content: string | ContentPart[]): boolean {
  if (!Array.isArray(content) || content.length === 0) return false
  return content.every((p) => p.type === 'toolCall' || p.type === 'toolResult')
}

/**
 * How long this call has taken so far: its finished duration, or — when a clock is supplied —
 * the in-flight time of a call that is still running. `now` is only ever passed by a live strip.
 */
function elapsed(call: TimelineCall, now?: number): number {
  if (call.durationMs !== undefined) return call.durationMs
  if (call.running && now !== undefined && call.startTs !== undefined) return Math.max(0, now - call.startTs)
  return 0
}

/**
 * Any call still in flight AND timestamped — i.e. this strip has a duration worth ticking.
 *
 * The `running` flag alone is not enough: a history row whose result fell outside the loaded
 * window keeps a call marked running forever, with no startTs to measure from. Ticking on that
 * would start a clock that never stops and never shows anything.
 */
export function hasLiveCall(calls: TimelineCall[]): boolean {
  return calls.some((c) => c.running && c.startTs !== undefined)
}

/** Pass `now` (a live strip's clock) to count in-flight calls into the total; omit it and the
 *  summary reports finished work only. */
export function timelineSummary(calls: TimelineCall[], now?: number): string {
  const batches = batchTimeline(calls)
  const parallel = batches.filter((b) => b.length > 1).length
  const total = batches.reduce((acc, b) => {
    const longest = Math.max(...b.map((c) => elapsed(c, now)))
    return acc + (Number.isFinite(longest) ? longest : 0)
  }, 0)
  const bits = [`${calls.length} call${calls.length === 1 ? '' : 's'}`]
  if (parallel > 0) bits.push(`${parallel} parallel batch${parallel === 1 ? '' : 'es'}`)
  if (total > 0) bits.push(fmtDuration(total))
  return bits.join(' · ')
}

/**
 * Per-tool tally for a collapsed timeline: [{name, count, running, error}].
 *
 * A long agent turn can emit 20+ calls, which rendered as 20 stacked chips —
 * a wall that pushed the actual reply off screen. Collapsed, the strip shows
 * this tally instead: same information ("what did it run, how many times"),
 * one line. Order is first-appearance so it reads chronologically.
 */
export function toolTally(
  calls: TimelineCall[]
): Array<{ name: string; count: number; running: boolean; error: boolean }> {
  const order: string[] = []
  const acc = new Map<string, { count: number; running: boolean; error: boolean }>()
  for (const c of calls) {
    const cur = acc.get(c.name)
    if (cur) {
      cur.count += 1
      cur.running = cur.running || !!c.running
      cur.error = cur.error || !!c.error
    } else {
      order.push(c.name)
      acc.set(c.name, { count: 1, running: !!c.running, error: !!c.error })
    }
  }
  return order.map((name) => ({ name, ...acc.get(name)! }))
}

/** Above this many calls a strip collapses itself. A handful of chips is useful context;
 *  twenty is a wall that pushes the actual reply off screen. Verified live: one agent turn
 *  produced 20 bash calls in a single strip. Lowered 6 -> 4 (2026-08-18) once history rows
 *  merged into one strip too — before that fix a run of five calls was five separate blocks
 *  and never reached any threshold at all. */
export const COLLAPSE_ABOVE = 4

/**
 * Is the strip open? `userChoice` is null until the reader clicks the header, then it pins.
 *
 * WHY THIS IS DERIVED AND NOT SEEDED INTO STATE. The strip used to compute this once, at
 * mount, from the count it had then. A history row mounts holding its whole run, so it
 * collapsed correctly — but a LIVE strip is born at one call and grows, so it was judged at
 * length 1 and stayed open through call twenty-one: chips stacked down the thread while the
 * reply they were working toward sat off screen. Same data, two shapes, decided by nothing but
 * whether you were watching it happen. Derived per render, the live strip folds itself the
 * moment it crosses COLLAPSE_ABOVE, and a click still wins for the rest of the turn.
 */
export function stripOpen(callCount: number, userChoice: boolean | null): boolean {
  return userChoice ?? callCount <= COLLAPSE_ABOVE
}

/** One rendered row: a message bubble, or a run of tool activity merged into ONE strip. */
export type RenderRow<M> =
  | { kind: 'msg'; key: string; m: M }
  | { kind: 'timeline'; key: string; calls: TimelineCall[] }

/** The minimum a row must expose to be grouped. Structural, so the renderer's UiMessage and the
 *  smoke's fixtures both satisfy it without importing each other. */
export interface GroupableRow {
  key: string
  role: string
  content: string | ContentPart[]
  startTs?: number
  endTs?: number
}

/**
 * Group rows into what the chat actually renders, so a turn looks the SAME whether you watched
 * it stream or reloaded it.
 *
 * The rule is about PARTS, not rows: prose is a message, calls are activity, and consecutive
 * activity — across rows, and across the boundary between a row's own prose and the tool-only
 * rows after it — merges into one strip. That is what makes the two shapes converge:
 *
 *   live      [text] [call] [call]                      -> msg(text) + strip(2)
 *   reloaded  [text+call+result] [call+result]          -> msg(text) + strip(2)
 *
 * Before this, the reloaded form produced msg(text)+strip(1) then strip(1) — two strips for one
 * turn, and a different picture from the same data.
 *
 * Order within a row is preserved: a row is walked part by part, so prose that FOLLOWS a call
 * still lands after it rather than being hoisted.
 */
export function groupForRender<M extends GroupableRow>(rows: M[]): RenderRow<M>[] {
  const items: RenderRow<M>[] = []

  const pushCalls = (calls: TimelineCall[], key: string): void => {
    if (calls.length === 0) return
    const last = items[items.length - 1]
    // Merge into the open strip rather than starting a new one — this is the whole point.
    if (last && last.kind === 'timeline') last.calls.push(...calls)
    else items.push({ kind: 'timeline', key: `tl-${key}`, calls })
  }

  for (const m of rows) {
    if (!Array.isArray(m.content)) {
      items.push({ kind: 'msg', key: m.key, m })
      continue
    }
    // An empty row is not activity and not prose. Kept as a message so it renders exactly as
    // before rather than silently vanishing into a strip.
    if (m.content.length === 0) {
      items.push({ kind: 'msg', key: m.key, m })
      continue
    }

    let prose: ContentPart[] = []
    let tools: ContentPart[] = []
    let proseRuns = 0
    const flushProse = (): void => {
      if (prose.length === 0) return
      // A row can yield more than one prose run (prose, call, prose). React keys must stay
      // unique or the second block silently reuses the first one's DOM node.
      const key = proseRuns === 0 ? m.key : `${m.key}#${proseRuns}`
      proseRuns += 1
      items.push({ kind: 'msg', key, m: { ...m, content: prose } })
      prose = []
    }
    const flushTools = (): void => {
      if (tools.length === 0) return
      pushCalls(callsFromParts(tools, { startTs: m.startTs, endTs: m.endTs }), m.key)
      tools = []
    }

    for (const part of m.content) {
      if (part.type === 'toolCall' || part.type === 'toolResult') {
        flushProse()
        tools.push(part)
      } else {
        flushTools()
        prose.push(part)
      }
    }
    flushProse()
    flushTools()
  }
  return items
}

/**
 * A one-line summary of a call's arguments, for the run card's middle column.
 *
 * The card has one row per call and about 40 characters of room, so this answers "which file /
 * which command", not "what were all the arguments" — the full set is one click away in the run
 * inspector's Args tab. The rules are about not lying in the space available:
 *
 *   * a single-key object shows its VALUE (`bash {command: "ls -la"}` → `ls -la`), because the
 *     key is already implied by the tool's name;
 *   * multiple keys show `key=value` pairs, so the reader can see which knob was set;
 *   * a value that is itself structured collapses to its type rather than a JSON fragment cut
 *     mid-token, which reads as corruption.
 *
 * Truncation is marked with an ellipsis. An argument summary that silently drops its tail is how
 * two different calls come to look identical in the list.
 */
export function argSummary(args: unknown, max = 48): string {
  const clip = (s: string): string => (s.length > max ? s.slice(0, max - 1) + '…' : s)
  if (args === null || args === undefined) return ''
  if (typeof args === 'string') return clip(args.replace(/\s+/g, ' ').trim())
  if (typeof args !== 'object') return clip(String(args))
  const entries = Object.entries(args as Record<string, unknown>)
  if (entries.length === 0) return ''
  const show = (v: unknown): string => {
    if (typeof v === 'string') return v.replace(/\s+/g, ' ').trim()
    if (v === null) return 'null'
    if (Array.isArray(v)) return `[${v.length}]`
    if (typeof v === 'object') return '{…}'
    return String(v)
  }
  if (entries.length === 1) return clip(show(entries[0][1]))
  return clip(entries.map(([k, v]) => `${k}=${show(v)}`).join(' '))
}

/**
 * The result column: what came back, in a few characters.
 *
 * A failed call says `failed` — the reason is in the inspector, and a truncated stack trace in a
 * 10px column is neither the reason nor readable. A running call says nothing yet rather than
 * claiming an empty result. Otherwise it is the first non-blank line, clipped.
 */
export function resultSummary(call: TimelineCall, max = 28): string {
  if (call.running) return ''
  if (call.error) return 'failed'
  const first = (call.result ?? '').split('\n').map((l) => l.trim()).find((l) => l.length > 0)
  if (!first) return ''
  return first.length > max ? first.slice(0, max - 1) + '…' : first
}

/** `Ran 2 tools` / `Ran 1 tool` — the card's headline, with the count spelled as a count. */
export function ranLabel(calls: TimelineCall[]): string {
  return `Ran ${calls.length} tool${calls.length === 1 ? '' : 's'}`
}

/** Total wall time across the run: last end minus first start, or undefined without timestamps. */
export function runDuration(calls: TimelineCall[]): number | undefined {
  let start: number | undefined
  let end: number | undefined
  for (const c of calls) {
    if (typeof c.startTs === 'number') start = start === undefined ? c.startTs : Math.min(start, c.startTs)
    const e = typeof c.endTs === 'number' ? c.endTs : undefined
    if (e !== undefined) end = end === undefined ? e : Math.max(end, e)
  }
  if (start === undefined || end === undefined) {
    // No clocks (history rows): fall back to the SUM of the per-call durations, which the daemon
    // does record. It is not wall time when calls ran in parallel, so the caller labels it plainly.
    const sum = calls.reduce((n, c) => n + (c.durationMs ?? 0), 0)
    return sum > 0 ? sum : undefined
  }
  return Math.max(0, end - start)
}

/**
 * The duration CELL for a call row — or nothing.
 *
 * An empty cell where a number belongs looks like a failed load (the same reason the `— tools`
 * chip was worse than no chip). History rows carry no clocks, so their duration is not zero and
 * not slow — it is unknown, and unknown renders as no element at all. A running call shows `…`
 * because "in flight" IS a value. Returns null when the row should render no duration element.
 */
export function durationCell(call: Pick<TimelineCall, 'running' | 'durationMs'>): string | null {
  if (call.running) return '…'
  const text = fmtDuration(call.durationMs)
  return text || null
}
