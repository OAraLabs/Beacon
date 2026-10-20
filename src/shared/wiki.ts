// Pure wiki-explorer model — shared by the renderer panel and the headless smoke. No DOM/React.
//
// The daemon half is Prometheus #288 (+ the review fixes in that PR's second commit):
//   GET /api/wiki/pages?path=   list one directory; empty path = the sections
//   GET /api/wiki/page?path=    one page's markdown
//   GET /api/wiki/search?q=     substring walk over titles, paths and bodies
//
// Answering "what does the agent know about X" was previously only possible by ASKING the agent
// and hoping it looked. /api/wiki/stats has counted ~318 pages for months with no way to read one.
//
// Three facts from that contract drive this module:
//
//  1. `mtime` is FLOAT EPOCH SECONDS, not milliseconds — the same shape artifacts use, and the
//     same trap: reading it as ms puts every page in 1970. The formatter is IMPORTED from
//     artifacts rather than re-implemented, because a copied date helper is exactly where that
//     lesson gets silently dropped.
//  2. A hit carries `in_title` and `in_path` SEPARATELY. They were one conflated field until the
//     #288 review: a page at `queries/insight-backup-root-…md` titled "Insight: $BACKUP_ROOT"
//     matched "queries" in its PATH only, and reported it as a title match. The client renders a
//     name-match badge off this, so folding them makes the badge lie.
//  3. `truncated` says whether more hits existed. `returned: 20` cannot be told apart from "that
//     is all of them", and this walk is path-ordered, not relevance-ranked — so a capped result
//     set is the alphabetically-first N, which is worth saying out loud.

import { fmtArtifactTime, fmtSize } from './artifacts'

/** Re-exported so the panel and smoke have ONE import site and the seconds-not-ms decision above
 *  stays visible at the point of reuse. */
export const fmtWikiTime = fmtArtifactTime
export { fmtSize }

/** Below this the daemon returns an empty result rather than matching everything. */
export const WIKI_SEARCH_MIN_QUERY = 2
/** Debounce before a keystroke becomes a request. Matches the global-search overlay. */
export const WIKI_SEARCH_DEBOUNCE_MS = 250
/** Default page size. The daemon clamps at 100. */
export const WIKI_SEARCH_LIMIT = 20

export interface WikiEntry {
  name: string
  type: 'dir' | 'file'
  size: number
  mtime: number
  /** First markdown heading, else the filename stem. Present for `.md` files ONLY. */
  title?: string
}

export interface WikiListing {
  /** The directory actually listed, relative to the wiki root. '' is the root. */
  path: string
  entries: WikiEntry[]
}

export interface WikiPage {
  path: string
  size: number
  truncated: boolean
  binary: boolean
  content: string
}

export interface WikiSearchHit {
  path: string
  /** First path segment, or '' for a page at the root. */
  section: string
  title: string
  snippet: string
  inTitle: boolean
  inPath: boolean
  mtime: number
}

export interface WikiSearchResult {
  query: string
  returned: number
  /** True when more pages matched than were returned — see fact 3 above. */
  truncated: boolean
  hits: WikiSearchHit[]
}

// ── Parsing ──────────────────────────────────────────────────────────────────────────────────
// Defensive by construction: these cross an IPC boundary as `unknown`, and a daemon that predates
// the review fixes returns neither `in_path` nor `truncated`. A missing flag reads as false, which
// degrades to the old behaviour instead of throwing.

function str(v: unknown, dflt = ''): string {
  return typeof v === 'string' ? v : dflt
}
function num(v: unknown, dflt = 0): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : dflt
}
function bool(v: unknown): boolean {
  return v === true
}

export function parseListing(raw: unknown): WikiListing | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  if (!Array.isArray(o.entries)) return null
  const entries: WikiEntry[] = []
  for (const e of o.entries) {
    if (!e || typeof e !== 'object') continue
    const r = e as Record<string, unknown>
    const name = str(r.name)
    if (!name) continue
    const entry: WikiEntry = {
      name,
      type: r.type === 'dir' ? 'dir' : 'file',
      size: num(r.size),
      mtime: num(r.mtime)
    }
    if (typeof r.title === 'string') entry.title = r.title
    entries.push(entry)
  }
  return { path: str(o.path), entries }
}

export function parsePage(raw: unknown): WikiPage | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  if (typeof o.content !== 'string') return null
  return {
    path: str(o.path),
    size: num(o.size),
    truncated: bool(o.truncated),
    binary: bool(o.binary),
    content: o.content
  }
}

export function parseSearch(raw: unknown): WikiSearchResult | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const rows = Array.isArray(o.results) ? o.results : []
  const hits: WikiSearchHit[] = []
  for (const r0 of rows) {
    if (!r0 || typeof r0 !== 'object') continue
    const r = r0 as Record<string, unknown>
    const path = str(r.path)
    if (!path) continue
    hits.push({
      path,
      section: str(r.section),
      title: str(r.title) || stemOf(path),
      snippet: wikiSnippet(str(r.snippet), str(o.query)),
      inTitle: bool(r.in_title),
      inPath: bool(r.in_path),
      mtime: num(r.mtime)
    })
  }
  return {
    query: str(o.query),
    // Trust the rows we could actually parse over the daemon's count — they disagree only when
    // something was malformed, and the number next to a list should describe THAT list.
    returned: hits.length,
    truncated: bool(o.truncated),
    hits
  }
}

// ── Paths ────────────────────────────────────────────────────────────────────────────────────

export function isMarkdown(name: string): boolean {
  return name.toLowerCase().endsWith('.md')
}

/** Filename without its extension — the fallback label when a page has no H1. */
export function stemOf(path: string): string {
  const base = path.slice(path.lastIndexOf('/') + 1)
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(0, dot) : base
}

/** Join a listing's path with a child name. The root case must not produce a leading slash — the
 *  daemon confines the result, and '/x' reads as absolute. */
export function childPath(dir: string, name: string): string {
  return dir ? `${dir}/${name}` : name
}

/** The containing directory, or '' at the root. */
export function parentPath(path: string): string {
  const i = path.lastIndexOf('/')
  return i < 0 ? '' : path.slice(0, i)
}

export interface Crumb {
  label: string
  path: string
}

/** Breadcrumbs for a directory path, always led by the root. `topics/deep` → Wiki / topics / deep */
export function breadcrumbs(path: string, rootLabel = 'Wiki'): Crumb[] {
  const out: Crumb[] = [{ label: rootLabel, path: '' }]
  if (!path) return out
  const parts = path.split('/').filter(Boolean)
  let acc = ''
  for (const p of parts) {
    acc = acc ? `${acc}/${p}` : p
    out.push({ label: p, path: acc })
  }
  return out
}

/**
 * Build a wiki request URL. EVERY wiki fetch goes through here so encoding cannot be forgotten at
 * a call site.
 *
 * This is correctness, not tidiness. The live wiki really contains `clients/Prometheus Daemon.md`
 * and `projects/clone repositories.md` — an unencoded space is a malformed request line, and a
 * page whose title starts with `$` or contains `#` would truncate the query silently.
 */
export function wikiUrl(route: 'pages' | 'page', path: string): string {
  return `/api/wiki/${route}?path=${encodeURIComponent(path)}`
}

/** Search URL. `q` is user text and always encoded; `limit` is clamped by the daemon at 100. */
export function wikiSearchUrl(query: string, limit: number = WIKI_SEARCH_LIMIT): string {
  return `/api/wiki/search?q=${encodeURIComponent(query)}&limit=${limit}`
}

// ── Display ──────────────────────────────────────────────────────────────────────────────────

/**
 * The label for one listing row: an H1 when the daemon found one, else the filename stem.
 *
 * Directories keep their raw name — a folder called `topics` is not improved by title-casing, and
 * inventing a prettier label would make the string in the UI differ from the string in the path.
 */
export function entryLabel(entry: WikiEntry): string {
  if (entry.type === 'dir') return entry.name
  return entry.title?.trim() || stemOf(entry.name)
}

/**
 * Why this row matched. The daemon reports three independent facts; a reader wants one sentence.
 *
 * Order matters: a title match is the strongest claim ("this page is ABOUT X"), a path match is
 * weaker ("it lives somewhere called X"), and a body match is weakest ("X is mentioned"). Reporting
 * the strongest TRUE one keeps the badge honest — which is the whole reason in_title and in_path
 * are separate fields.
 */
export type WikiMatchKind = 'title' | 'path' | 'body'

export function matchKind(hit: WikiSearchHit): WikiMatchKind {
  if (hit.inTitle) return 'title'
  if (hit.inPath) return 'path'
  return 'body'
}

export function matchLabel(hit: WikiSearchHit): string {
  const k = matchKind(hit)
  return k === 'title' ? 'title' : k === 'path' ? 'path' : 'body'
}

/**
 * A one-line explanation of a capped result set, or '' when nothing was withheld.
 *
 * Says the ORDERING too, because "the first 20" is only actionable if you know the walk is
 * path-ordered rather than best-first — otherwise a user reasonably assumes the 20 shown are the
 * 20 most relevant.
 */
export function truncationNotice(result: WikiSearchResult): string {
  if (!result.truncated) return ''
  return `Showing the first ${result.returned} matches in path order — narrow the query to see the rest.`
}

/** Filter a listing client-side. Matches the display label AND the raw name, so typing either the
 *  H1 or the filename finds the row. */
export function filterEntries(entries: WikiEntry[], query: string): WikiEntry[] {
  const q = query.trim().toLowerCase()
  if (!q) return entries
  return entries.filter((e) => entryLabel(e).toLowerCase().includes(q) || e.name.toLowerCase().includes(q))
}

/**
 * Can this row be opened as a page?
 *
 * The daemon refuses a non-`.md` path with 400, and the live root really does contain
 * `.last_compile_ts` and an `.obsidian/` directory. Rows that cannot open are still LISTED — a
 * directory listing that quietly omits entries cannot answer "what is in here", which is the one
 * question it exists to answer. They render inert instead of hidden.
 */
export function isOpenable(entry: WikiEntry): boolean {
  return entry.type === 'file' && isMarkdown(entry.name)
}

// ── Frontmatter ──────────────────────────────────────────────────────────────────────────────
// Prometheus's wiki compiler (v0.9.10, seen 2026-10-14) opens each page with a YAML block:
//
//     ---
//     type: note
//     first_seen: '2026-10-14'
//     ...
//     ---
//
// Markdown has no frontmatter. It reads the opening `---` as a thematic break, then the key lines
// as a paragraph whose following `---` underlines it into a SETEXT HEADING, so the page rendered a
// bold run-on "type: note first_seen: '2026-10-14' …" above its own title. The block is lifted
// off before rendering, and only when it is the FIRST thing in the file and reads as YAML: a `---`
// anywhere else is a horizontal rule, and stays one.

export interface WikiFrontmatter {
  /** Top-level `key: value` pairs in file order, quotes removed. A list under a key joins with ", ". */
  fields: Array<[string, string]>
}

export interface WikiPageParts {
  frontmatter: WikiFrontmatter | null
  /** What the reader renders: the page with the block and the blank lines after it removed, or
   *  the page untouched when it has no block. */
  body: string
}

const FM_OPEN = /^---[ \t]*$/
const FM_CLOSE = /^(?:---|\.\.\.)[ \t]*$/
const FM_KEY = /^([^\s#:'"\-][^:]*?)[ \t]*:(?:[ \t]+(.*))?$/
const FM_ITEM = /^[ \t]*-[ \t]+(.*)$/

function unquote(v: string): string {
  const s = v.trim()
  if (s.length >= 2 && s.startsWith("'") && s.endsWith("'")) return s.slice(1, -1).replace(/''/g, "'")
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) return s.slice(1, -1).replace(/\\"/g, '"')
  return s
}

/**
 * Split a leading YAML frontmatter block off a page.
 *
 * The block must open on the file's first line (a BOM before it is allowed), close with `---` or
 * `...`, and hold only YAML-shaped lines: `key: value`, `- item`, indented continuations, comments
 * and blank lines, with at least one key. Anything else — an opening rule followed by prose, a
 * block that never closes (a page cut at the read cap), a block that is not at line 1 — leaves
 * the page exactly as it was, so markdown renders it as before.
 */
export function splitFrontmatter(content: string): WikiPageParts {
  const none: WikiPageParts = { frontmatter: null, body: content }
  const text = content.startsWith('﻿') ? content.slice(1) : content
  const lines = text.split('\n').map((l) => l.replace(/\r$/, ''))
  if (lines.length < 2 || !FM_OPEN.test(lines[0])) return none

  const fields: Array<[string, string]> = []
  let scalar = false // the last key opened a `|` / `>` block scalar, so indented lines are its text
  let close = -1
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]
    if (FM_CLOSE.test(line)) {
      close = i
      break
    }
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue
    const item = FM_ITEM.exec(line)
    if (item) {
      // A list item belongs to the key above it: `aliases:` then `  - Tern`.
      const last = fields[fields.length - 1]
      if (!last) return none
      last[1] = last[1] ? `${last[1]}, ${unquote(item[1])}` : unquote(item[1])
      continue
    }
    if (/^[ \t]/.test(line)) {
      // Belongs to the key above: a block scalar's text, or a nested mapping (not shown apart).
      const last = fields[fields.length - 1]
      if (!last) return none
      if (scalar) last[1] = last[1] ? `${last[1]} ${line.trim()}` : line.trim()
      continue
    }
    const kv = FM_KEY.exec(line)
    if (!kv) return none
    const value = kv[2] ?? ''
    scalar = /^[|>][+-]?\d*\s*$/.test(value)
    fields.push([kv[1], scalar ? '' : unquote(value)])
  }
  if (close < 0 || !fields.length) return none

  const body = text
    .split('\n')
    .slice(close + 1)
    .join('\n')
    .replace(/^(?:[ \t]*\r?\n)+/, '')
  return { frontmatter: { fields }, body }
}

/**
 * A search snippet with a page's frontmatter cut out of it.
 *
 * The daemon cuts the snippet from the RAW page (Prometheus server.py `search_wiki`: 60 characters
 * before the first match to 140 after, newlines flattened to spaces), so a body match near the top
 * of a compiled page arrived as "…source_count: 4 manual: true --- # Tern Seabirds…". Flattened,
 * the closing fence is a bare ` --- `. When the text before the first such fence (after an opening
 * one at the very start) holds a `key:` and the match is after the fence, the snippet starts after
 * it. A match INSIDE the properties keeps them, fences dropped: they are the reason the page matched.
 * The cost of working on flattened text: a body rule whose preceding prose has a `word:` cuts that
 * prose too. The match is still shown.
 */
export function wikiSnippet(snippet: string, query: string): string {
  const s = snippet.trim()
  const fences = [...s.matchAll(/(?:^|\s)(?:---|\.\.\.)(?=\s|$)/g)]
  if (!fences.length) return s
  let from = 0
  let closer: RegExpMatchArray | undefined = fences[0]
  if (closer.index === 0) {
    from = closer[0].length
    closer = fences[1]
  }
  const head = s.slice(from, closer?.index ?? s.length)
  if (!/(?:^|\s)[A-Za-z_][\w.-]*:(?:\s|$)/.test(head)) return s
  const tail = closer ? s.slice((closer.index ?? 0) + closer[0].length).trim() : ''
  const q = query.trim().toLowerCase()
  if (tail && q && tail.toLowerCase().includes(q)) return tail
  return head.trim()
}
