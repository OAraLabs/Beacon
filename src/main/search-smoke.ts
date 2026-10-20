/**
 * Headless smoke for global search (frozen spec: beacon-search-spec.md v2, §3 Tests).
 * Pure model only — parse, snippet segmentation, error mapping, the sequence guard, and the
 * palette's pinned row. Capture/render/IPC are exercised hands-on against a live daemon; the
 * value here is that the CONTRACT with the daemon cannot drift silently.
 *
 * Run: npm run smoke:search
 */
import {
  EMPTY_RESULTS,
  SEARCH_DEBOUNCE_MS,
  SEARCH_LIMIT,
  SEARCH_MIN_QUERY,
  formatHitTime,
  isCurrentResponse,
  isSearchable,
  parseSearchResults,
  plainSnippet,
  searchErrorMessage,
  searchRequestBody,
  segmentSnippet
} from '@shared/search'
import { searchRowLabel, shouldOfferSearch, SHORTCUTS } from '@shared/commands'
import { previewTitle, type PreviewTarget } from '@shared/preview'
import { sourceOfSessionId } from '@shared/session-sources'

let failures = 0
function assert(cond: boolean, what: string): void {
  console.log(`[smoke] ${cond ? 'PASS' : 'FAIL'}  ${what}`)
  if (!cond) failures++
}

// ── 1. FIXTURE ───────────────────────────────────────────────────────────────────────────────
// SHAPE captured, TEXT synthetic. Every field name, type, format and ordering below was read off
// a live POST /api/search against the deployed daemon (Prometheus #279 on d5253a6, 2026-08-27,
// q="beacon", 20+20 rows); the snippets, ids and session names are written here rather than
// copied, because a repo fixture is not the place for the contents of private conversations.
//
// What the live read CONFIRMED, rather than what I assumed:
//   message_id      numeric STRING (all 20), always distinct from uuid
//   score           negative float, ASCENDING within each bucket (BM25: more negative is better)
//   ts              '2026-08-26T04:41:21Z' — Z-suffixed, second precision
//   anchor_message_ids  empty on 6 of 20 summary rows — the empty case is REAL, not defensive
//   depth           0 and 1 both occur
//   snippet         markers present on all 40 rows; 18 of 40 contained a backtick, so the
//                   marker-inside-code-span case below is the corpus, not a hypothetical
//   buckets         best summary -2.663 vs worst message -5.155 — the two score spaces do not
//                   overlap at all, which is the whole argument for not merging them
const CAPTURED = {
  query: 'beacon',
  returned: 4,
  messages: [
    {
      kind: 'message',
      session_id: 'desktop:beacon-mac',
      message_id: '8871',
      uuid: 'ccbe40a8-2f1e-4a53-9d64-7f0f0a2b1c33',
      role: 'user',
      snippet: 'the ⟦beacon⟧ tool feed opens empty every launch',
      score: -7.0512,
      ts: '2026-08-26T04:41:21Z'
    },
    {
      kind: 'message',
      session_id: 'telegram:5521',
      message_id: '8102',
      uuid: 'a36a6c9d-51bb-4a0e-9d0e-2b8a7c441e90',
      role: 'assistant',
      snippet: '…shipped ⟦Beacon⟧ 0.2.0 with the voice turn',
      score: -6.58,
      ts: '2026-08-20T18:02:00Z'
    }
  ],
  summaries: [
    {
      kind: 'summary',
      session_id: 'telegram:5521',
      summary_id: '412ced18aa',
      anchor_message_ids: ['ccbe40a8-2f1e-4a53-9d64-7f0f0a2b1c33', 'a36a6c9d-51bb-4a0e-9d0e-2b8a7c441e90'],
      depth: 0,
      snippet: '…resolved the ⟦beacon⟧ pairing flow…',
      summary_text: 'The user paired Beacon to the mini and confirmed streaming replies.',
      score: -3.2,
      ts: '2026-08-10T09:00:00Z'
    },
    {
      kind: 'summary',
      session_id: 'desktop:beacon-mac',
      summary_id: '77aa01bc',
      anchor_message_ids: [],
      depth: 1,
      snippet: 'rolled up ⟦beacon⟧ packaging work',
      summary_text: 'Packaging: universal dmg, notarization gate.',
      score: -2.9,
      ts: '2026-07-30T11:30:00Z'
    }
  ]
}

console.log('[smoke] === 1. captured wire → results ===')
const parsed = parseSearchResults(CAPTURED)
assert(parsed.messages.length === 2 && parsed.summaries.length === 2, 'both buckets survive the parse')
assert(parsed.returned === 4, `returned carries through (${parsed.returned})`)
assert(parsed.messages[0].messageId === '8871', 'message_id (the rowid, as a string) is the jump target')
assert(parsed.messages[0].uuid !== parsed.messages[0].messageId, 'uuid and rowid stay distinct — jumping by uuid would miss')
assert(parsed.summaries[0].anchorMessageIds.length === 2, 'anchor uuids carry through')
assert(parsed.summaries[1].anchorMessageIds.length === 0, 'an EMPTY anchor list is legal, not a parse failure')
assert(parsed.summaries[0].summaryText.startsWith('The user paired'), 'full summary_text rides along for the peek panel')
assert(parsed.messages[0].score < 0, 'BM25 score is negative — never rendered as a percentage')

// ── 2. THE BUCKETS ARE NEVER MERGED ──────────────────────────────────────────────────────────
// The whole reason the endpoint groups: BM25 across two FTS tables is not comparable. A summary
// scoring -2.9 is not "better" than a message scoring -7.05.
console.log('[smoke] === 2. bucketing ===')
// The captured scores show the two spaces plainly: the BEST summary (-3.2) scores "worse" than the
// WORST message (-6.58). Rank them together and the entire compressed bucket sinks below every
// message — which is 75% of the corpus buried by an ordering that never meant anything.
const bestSummary = parsed.summaries[0]
const worstMessage = parsed.messages[parsed.messages.length - 1]
assert(
  bestSummary.score > worstMessage.score,
  `the best summary scores below every message (${bestSummary.score} vs ${worstMessage.score}) — a merged rank would bury the compressed bucket`
)
assert(
  parsed.summaries[0].score <= parsed.summaries[1].score && parsed.messages[0].score <= parsed.messages[1].score,
  'each bucket keeps the server’s own order: BM25 ascending, most-negative first — the client re-ranks neither'
)
assert(parsed.messages.every((m) => m.kind === 'message') && parsed.summaries.every((x) => x.kind === 'summary'), 'no row lands in the wrong bucket')

// ── 3. MALFORMED PAYLOADS DEGRADE, NEVER THROW ───────────────────────────────────────────────
console.log('[smoke] === 3. defensive parse ===')
assert(parseSearchResults(null).returned === 0, 'null payload → empty results')
assert(parseSearchResults('nope' as unknown).messages.length === 0, 'string payload → empty results')
assert(parseSearchResults({ messages: 'not-an-array' }).messages.length === 0, 'wrong-typed bucket → empty, not a crash')
assert(parseSearchResults({ messages: [{ session_id: 's' }] }).messages.length === 0, 'a message hit with NO message_id is dropped — it could not navigate')
assert(parseSearchResults({ messages: [{ message_id: '5' }] }).messages.length === 0, 'a hit with no session_id is dropped')
assert(
  parseSearchResults({ messages: [{ session_id: 's', message_id: 91 }] }).messages[0].messageId === '91',
  'a numeric message_id is coerced, not dropped — it is still navigable'
)
assert(
  parseSearchResults({ returned: 99, messages: [{ session_id: 's', message_id: '1' }], summaries: [] }).returned === 1,
  'a `returned` the buckets do not support is replaced by what survived — the count never overclaims'
)

// ── 4. SNIPPET MARKERS ───────────────────────────────────────────────────────────────────────
console.log('[smoke] === 4. snippet segmentation ===')
const segs = segmentSnippet('the ⟦beacon⟧ feed')
assert(segs.length === 3 && segs[1].mark && segs[1].text === 'beacon', 'marked run is isolated')
assert(segs[0].mark === false && segs[2].mark === false, 'surrounding runs are unmarked')
assert(plainSnippet('the ⟦beacon⟧ feed') === 'the beacon feed', 'markers strip cleanly for copy/screen readers')
// The spec's named case: a marker inside a code span must not break the render. It cannot, because
// segments are TEXT — the renderer emits React children, so backticks and angle brackets are data.
const codey = segmentSnippet('run `grep -a ⟦beacon⟧ <file>` now')
assert(codey.some((x) => x.mark && x.text === 'beacon'), 'a marker INSIDE a code span still marks')
assert(codey.map((x) => x.text).join('') === 'run `grep -a beacon <file>` now', 'backticks and angle brackets survive verbatim as text')
assert(segmentSnippet('unclosed ⟦tail').slice(-1)[0].mark === true, 'an unclosed marker marks the remainder (server truncates snippets)')
assert(segmentSnippet('stray ⟧ close').every((x) => !x.mark), 'a stray close marker is dropped as a delimiter, not shown')
assert(segmentSnippet('').length === 0, 'empty snippet → no segments')

// ── 5. THE SKEW MESSAGE ──────────────────────────────────────────────────────────────────────
// Beacon and the daemon deploy separately. A 404 here means the daemon predates /api/search —
// naming that is the difference between "check your version" and "check your network".
console.log('[smoke] === 5. error mapping ===')
const e404 = searchErrorMessage(new Error('HTTP 404: POST /api/search — Not Found'))
assert(/no \/api\/search/.test(e404) && /#279/.test(e404), 'a 404 names daemon skew, not a network failure')
assert(!/unreachable|offline/i.test(e404), 'the skew message never blames the connection')
assert(/Not authorized/.test(searchErrorMessage(new Error('HTTP 401: POST /api/search — unauthorized'))), '401 renders as a named auth failure')
assert(/conversation store/.test(searchErrorMessage(new Error('HTTP 503: POST /api/search — lcm not wired'))), '503 says the store is missing, not that search is broken')
assert(/rejected that query/.test(searchErrorMessage(new Error('HTTP 400: POST /api/search — query must be at least 3 characters'))), '400 surfaces the daemon’s own reason')
assert(/timed out/.test(searchErrorMessage(new Error('The operation timed out'))), 'a timeout says so')
assert(searchErrorMessage(new Error('')) === 'Search failed.', 'an empty error still says something')

// ── 6. THE SEQUENCE GUARD ────────────────────────────────────────────────────────────────────
// There is no AbortController across IPC: main owns the fetch. So a stale answer is discarded on
// arrival. The guarantee is the observable one — an older query can never overwrite a newer one.
console.log('[smoke] === 6. stale responses ===')
assert(isCurrentResponse(7, 7), 'the latest response is accepted')
assert(!isCurrentResponse(6, 7), 'an older in-flight response is discarded')
assert(!isCurrentResponse(8, 7), 'a seq from the future is not accepted either')

// ── 7. QUERY FLOOR + REQUEST SHAPE ───────────────────────────────────────────────────────────
console.log('[smoke] === 7. request contract ===')
assert(SEARCH_MIN_QUERY === 3, 'client floor matches the endpoint-enforced minimum')
assert(!isSearchable('ab') && !isSearchable('   ') && isSearchable('abc'), 'the floor counts TRIMMED characters')
assert(SEARCH_DEBOUNCE_MS === 250, 'debounce is the specified 250ms')
const body = searchRequestBody('  beacon  ')
assert(body.q === 'beacon', 'the query is trimmed before it goes on the wire')
assert(body.scope === 'both', 'v1 always asks for both corpora — compressed history is the majority of the corpus')
assert(body.limit === SEARCH_LIMIT && SEARCH_LIMIT <= 50, `limit is per-scope and within the daemon clamp (${SEARCH_LIMIT})`)

// ── 8. PINNED PALETTE ROW ────────────────────────────────────────────────────────────────────
console.log('[smoke] === 8. palette hand-off ===')
assert(!shouldOfferSearch('ab'), 'the pinned row stays hidden below the query floor')
assert(shouldOfferSearch('abc'), 'the pinned row appears at the floor')
assert(searchRowLabel('  beacon ').includes('beacon'), 'the row quotes the typed query')
assert(SHORTCUTS.some((x) => x.keys.includes('⌘⇧F')), 'the shortcut sheet documents ⌘⇧F')
assert(SHORTCUTS.every((x) => !x.keys.startsWith('⌘F')), '⌘F stays unclaimed for a future find-in-conversation')

// ── 9. PEEK TARGET ───────────────────────────────────────────────────────────────────────────
console.log('[smoke] === 9. compressed-history peek ===')
const peek: PreviewTarget = {
  kind: 'summary',
  title: 'Compressed history',
  body: parsed.summaries[0].summaryText,
  sessionId: parsed.summaries[0].sessionId,
  anchorCount: parsed.summaries[0].anchorMessageIds.length,
  depth: parsed.summaries[0].depth
}
assert(previewTitle(peek) === 'Compressed history', 'the peek target titles itself')
assert(peek.kind === 'summary' && peek.anchorCount === 2, 'the peek carries a COUNT of anchors, not a position — no uuid→rowid map exists')

// ── 10. SOURCE LABELLING FROM AN ID ALONE ────────────────────────────────────────────────────
// A hit carries a session_id and nothing else — no session row, so no gateway field to read.
console.log('[smoke] === 10. hit provenance ===')
assert(sourceOfSessionId('telegram:5521') === 'telegram', 'a hit names its source from the id alone')
assert(sourceOfSessionId('nocolon') === 'unknown', 'an id with no gateway prefix reads as unknown, not as itself')

// ── 11. TIME FORMATTING ──────────────────────────────────────────────────────────────────────
console.log('[smoke] === 11. hit timestamps ===')
const now = Date.parse('2026-08-27T12:00:00Z')
assert(formatHitTime('2026-08-27T11:59:40Z', now) === 'just now', 'sub-minute reads as just now')
assert(formatHitTime('2026-08-27T09:00:00Z', now) === '3h ago', 'same-day hits read relative')
assert(formatHitTime('2026-08-10T09:00:00Z', now) === 'Aug 10', 'older hits read as a date')
assert(formatHitTime('not-a-date', now) === '', 'an unparseable stamp renders as nothing, never "Invalid Date"')

assert(EMPTY_RESULTS.messages.length === 0 && EMPTY_RESULTS.summaries.length === 0, 'the empty sentinel is empty')

console.log('')
console.log('[smoke] ===================== RESULT =====================')
console.log(`[smoke] outcome: ${failures === 0 ? 'PASS ✓' : `FAIL ✗ (${failures})`} (fixture, bucketing, defensive parse, markers, skew, stale guard, palette row, peek)`)
console.log('[smoke] ===================================================')
process.exit(failures === 0 ? 0 : 1)
