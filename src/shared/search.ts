// Pure global-search model (frozen spec: beacon-search-spec.md v2, §3) — shared by the renderer
// overlay and the headless smoke. NO DOM/React imports.
//
// The daemon half is Prometheus #279: POST /api/search over the two LCM FTS corpora. Two facts
// from that contract drive everything here:
//
//  1. The response is GROUPED, never merged. BM25 scores from lcm_messages and lcm_summaries are
//     not comparable, so a single ranked list would be a lie dressed as an ordering. The parse
//     keeps the buckets apart and nothing in this module ever concatenates them.
//  2. Snippets arrive with ⟦⟧ markers around the matched terms (FTS5 snippet(), server-generated —
//     prefix/phrase/stemmed matches have no literal substring the client could find itself).
//     They are RAW text: the client escapes at render. segmentSnippet() turns them into plain
//     text runs so the renderer emits React text nodes + <mark> and never innerHTML.

/** Endpoint-enforced too — a shorter query is rejected 400, so the client never sends one. */
export const SEARCH_MIN_QUERY = 3
/** Debounce before a keystroke becomes a request. */
export const SEARCH_DEBOUNCE_MS = 250
/** Per SCOPE — `both` can therefore return up to 2× this. Daemon clamps at 50. */
export const SEARCH_LIMIT = 20

export interface SearchMessageHit {
  kind: 'message'
  sessionId: string
  /** The durable LCM rowid AS A STRING — the wire cursor Beacon jumps to. Never the uuid. */
  messageId: string
  uuid: string
  role: string
  /** Raw text with ⟦⟧ match markers. Escape at render. */
  snippet: string
  /** BM25 passthrough: NEGATIVE, ascending = better. Display only; ordering is the server's. */
  score: number
  ts: string
}

export interface SearchSummaryHit {
  kind: 'summary'
  sessionId: string
  summaryId: string
  /** Message UUIDs this summary covers. May be empty on pre-migration rows. */
  anchorMessageIds: string[]
  depth: number
  snippet: string
  /** The whole summary — small, and the peek panel wants it entire. */
  summaryText: string
  score: number
  ts: string
}

export interface SearchResults {
  messages: SearchMessageHit[]
  summaries: SearchSummaryHit[]
  /** The daemon's own count of what it returned across both buckets. */
  returned: number
}

export const EMPTY_RESULTS: SearchResults = { messages: [], summaries: [], returned: 0 }

/** Client-side gate matching the endpoint's own minimum. */
export function isSearchable(q: string): boolean {
  return q.trim().length >= SEARCH_MIN_QUERY
}

/** The POST body for /api/search. Kept here so the request shape is testable without a socket. */
export function searchRequestBody(q: string, limit = SEARCH_LIMIT): { q: string; scope: 'both'; limit: number } {
  return { q: q.trim(), scope: 'both', limit }
}

const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback)
const num = (v: unknown, fallback = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback)

/**
 * Daemon payload → results. Defensive by construction: a wrong-shape or partial row is DROPPED,
 * never rendered half-built, and a malformed payload yields empty buckets instead of throwing into
 * a white screen. A message hit with no messageId is dropped specifically — it is the jump target,
 * and a row that cannot navigate is a row that lies about being clickable.
 */
export function parseSearchResults(data: unknown): SearchResults {
  if (!data || typeof data !== 'object') return EMPTY_RESULTS
  const d = data as Record<string, unknown>
  const rawMessages = Array.isArray(d.messages) ? d.messages : []
  const rawSummaries = Array.isArray(d.summaries) ? d.summaries : []

  const messages: SearchMessageHit[] = []
  for (const r of rawMessages) {
    if (!r || typeof r !== 'object') continue
    const row = r as Record<string, unknown>
    const sessionId = str(row.session_id)
    // message_id arrives as a string per the contract, but a daemon that sends the rowid as a
    // number is still navigable — coerce rather than drop.
    const messageId =
      typeof row.message_id === 'number' && Number.isFinite(row.message_id) ? String(row.message_id) : str(row.message_id)
    if (!sessionId || !messageId) continue
    messages.push({
      kind: 'message',
      sessionId,
      messageId,
      uuid: str(row.uuid),
      role: str(row.role, 'assistant'),
      snippet: str(row.snippet),
      score: num(row.score),
      ts: str(row.ts)
    })
  }

  const summaries: SearchSummaryHit[] = []
  for (const r of rawSummaries) {
    if (!r || typeof r !== 'object') continue
    const row = r as Record<string, unknown>
    const sessionId = str(row.session_id)
    if (!sessionId) continue
    summaries.push({
      kind: 'summary',
      sessionId,
      summaryId: str(row.summary_id),
      anchorMessageIds: Array.isArray(row.anchor_message_ids)
        ? row.anchor_message_ids.filter((a): a is string => typeof a === 'string')
        : [],
      depth: num(row.depth),
      snippet: str(row.snippet),
      summaryText: str(row.summary_text),
      score: num(row.score),
      ts: str(row.ts)
    })
  }

  // `returned` is the daemon's; fall back to what actually survived the parse rather than
  // reporting a count the buckets don't contain.
  const claimed = num(d.returned, -1)
  const kept = messages.length + summaries.length
  return { messages, summaries, returned: claimed >= 0 && claimed === kept ? claimed : kept }
}

export interface SnippetSegment {
  text: string
  /** True = inside ⟦⟧, i.e. a matched term the renderer marks. */
  mark: boolean
}

export const MARK_OPEN = '⟦' // ⟦
export const MARK_CLOSE = '⟧' // ⟧

/**
 * Split a server snippet into marked/unmarked runs. Pure text in, pure text out — the renderer
 * emits these as React children, so escaping is React's and markdown is never invoked. That is
 * the whole defence: a snippet containing backticks, angle brackets or a stray marker is text,
 * not markup, and cannot break the row it renders in.
 *
 * An unclosed ⟦ marks the remainder (the server truncates snippets, so a cut-off close is real);
 * a stray ⟧ with no open is dropped as a delimiter rather than shown.
 */
export function segmentSnippet(snippet: string): SnippetSegment[] {
  const out: SnippetSegment[] = []
  let buf = ''
  let marking = false
  for (const ch of snippet) {
    if (ch === MARK_OPEN) {
      if (buf) out.push({ text: buf, mark: marking })
      buf = ''
      marking = true
    } else if (ch === MARK_CLOSE) {
      if (buf) out.push({ text: buf, mark: marking })
      buf = ''
      marking = false
    } else {
      buf += ch
    }
  }
  if (buf) out.push({ text: buf, mark: marking })
  return out
}

/** The snippet with its markers stripped — what a screen reader or a copy should get. */
export function plainSnippet(snippet: string): string {
  return segmentSnippet(snippet)
    .map((s) => s.text)
    .join('')
}

/**
 * One honest sentence per failure. The 404 case is the one the spec calls out: the daemon and
 * Beacon deploy separately, so "no such route" means SKEW, not "search is broken" — and a generic
 * unreachable error would send someone to check the network instead of the daemon version.
 */
export function searchErrorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err ?? '')
  const status = /HTTP (\d{3})/.exec(raw)?.[1]
  if (status === '404')
    return 'This daemon has no /api/search — global search needs the Prometheus build that added it (#279). Everything else keeps working.'
  if (status === '401' || status === '403') return 'Not authorized — check the gateway token in Connection Settings.'
  if (status === '503') return 'The daemon has no conversation store wired, so there is nothing to search.'
  if (status === '400') {
    const detail = /—\s*(.+)$/.exec(raw)?.[1]
    return detail ? `The daemon rejected that query: ${detail}` : 'The daemon rejected that query.'
  }
  if (/timed?\s*out|abort/i.test(raw)) return 'The search timed out before the daemon answered.'
  return raw ? `Search failed: ${raw}` : 'Search failed.'
}

/**
 * Sequence guard. Requests go out over IPC, where there is no AbortController to reach the fetch
 * main already has in flight — so a stale answer is DISCARDED on arrival rather than cancelled at
 * the source. The observable contract is the one that matters: a slower earlier query can never
 * overwrite the results of a later one.
 */
export function isCurrentResponse(responseSeq: number, latestSeq: number): boolean {
  return responseSeq === latestSeq
}

/**
 * Hit timestamps are ISO-8601 UTC from the daemon. Recent hits read better relative ("2h ago"),
 * older ones need the date. Pure, with an injectable `now` so the smoke does not depend on when
 * it runs. An unparseable stamp yields '' rather than "Invalid Date".
 */
export function formatHitTime(ts: string, now: number = Date.now()): string {
  const t = Date.parse(ts)
  if (!Number.isFinite(t)) return ''
  const mins = Math.floor((now - t) / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const d = new Date(t)
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`
}
