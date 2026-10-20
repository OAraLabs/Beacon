/**
 * Headless smoke for the Wiki explorer (roadmap item 9) — the Beacon half of Prometheus #288.
 * Pure model only: parsing, path arithmetic, match attribution, labels and URL encoding. Fetching
 * and rendering are hands-on against a live daemon; what this pins is the CONTRACT.
 *
 * Run: npm run smoke:wiki
 */
import {
  WIKI_SEARCH_MIN_QUERY,
  breadcrumbs,
  childPath,
  entryLabel,
  filterEntries,
  fmtWikiTime,
  isMarkdown,
  isOpenable,
  matchKind,
  parentPath,
  parseListing,
  parsePage,
  parseSearch,
  stemOf,
  truncationNotice,
  wikiSearchUrl,
  wikiUrl
} from '@shared/wiki'
import { NAV_VIEWS, NAV_TREE, flattenNavTree } from '@shared/views'

let failures = 0
function assert(cond: boolean, what: string): void {
  console.log(`[smoke] ${cond ? 'PASS' : 'FAIL'}  ${what}`)
  if (!cond) failures++
}

// ── FIXTURE ──────────────────────────────────────────────────────────────────────────────────
// Captured from the LIVE daemon on 2026-08-28, running 9e43f7d (the deploy of #288).
//
// VERBATIM from the wire — names, titles and flags read off real responses:
//   the root really holds a dot-DIRECTORY (.obsidian) and a dot-FILE (.last_compile_ts)
//   index.md sits at the root with the H1 "Prometheus Wiki Index"
//   page names contain SPACES ("Prometheus Daemon.md", "clone repositories.md")
//   `q=beacon&limit=3` came back truncated:true; `q=queries` came back truncated:false
//   one real row had in_path:true with in_title:false — the regression this fixture exists for
//
// SHAPE-ONLY (marked, not pretended): sizes and mtimes are representative rather than the exact
// bytes on that box, and the long `queries/insight-…` name is elided the way my terminal elided
// it — I never saw the full string, so inventing one would encode a fact I do not have.
const ROOT = {
  path: '',
  entries: [
    { name: '.obsidian', type: 'dir', size: 0, mtime: 1787870000.1 },
    { name: 'clients', type: 'dir', size: 0, mtime: 1787871000.2 },
    { name: 'projects', type: 'dir', size: 0, mtime: 1787872000.3 },
    { name: 'topics', type: 'dir', size: 0, mtime: 1787873000.4 },
    { name: '.last_compile_ts', type: 'file', size: 18, mtime: 1787874000.5 },
    { name: 'index.md', type: 'file', size: 4210, mtime: 1787875000.6, title: 'Prometheus Wiki Index' }
  ]
}

console.log('[smoke] === 1. the listing parses, including what is NOT a page ===')
const listing = parseListing(ROOT)
assert(listing !== null && listing.entries.length === 6, 'all six entries survive parsing')
assert(listing?.path === '', 'the root path is the empty string, not "/" or "."')
const byName = Object.fromEntries((listing?.entries ?? []).map((e) => [e.name, e]))
assert(byName['index.md'].title === 'Prometheus Wiki Index', 'an H1 arrives as the title')
assert(byName['.last_compile_ts'].title === undefined, 'a non-markdown file carries NO title')
assert(byName['clients'].type === 'dir', 'directories keep their type')
assert(parseListing({ entries: 'nope' }) === null, 'a malformed body parses to null, not a throw')
assert(parseListing({ entries: [{ type: 'file' }] })?.entries.length === 0, 'a nameless row is dropped')

console.log('')
console.log('[smoke] === 2. what can be opened — and what is still LISTED ===')
assert(isOpenable(byName['index.md']), 'a .md file opens')
assert(!isOpenable(byName['.last_compile_ts']), '.last_compile_ts does NOT open — the daemon 400s a non-.md path')
assert(!isOpenable(byName['clients']), 'a directory is navigated, not opened as a page')
assert(!isOpenable(byName['.obsidian']), 'a dot-directory is not a page either')
// The listing shows everything. A browser that silently omitted rows could not answer the one
// question it exists to answer — "what is in here".
assert(listing!.entries.length === 6, 'nothing is filtered OUT of the listing — inert rows still render')
assert(isMarkdown('a.MD') && !isMarkdown('a.md.txt'), 'markdown test is case-insensitive and anchored at the end')

console.log('')
console.log('[smoke] === 3. labels ===')
assert(entryLabel(byName['index.md']) === 'Prometheus Wiki Index', 'a titled page shows its H1')
assert(entryLabel({ name: 'untitled.md', type: 'file', size: 1, mtime: 1 }) === 'untitled', 'no H1 → the filename stem')
assert(entryLabel(byName['clients']) === 'clients', 'a directory keeps its RAW name — a prettier label would differ from the path')
assert(stemOf('topics/kling.md') === 'kling', 'stem drops the directory and the extension')
assert(stemOf('.last_compile_ts') === '.last_compile_ts', 'a leading dot is not an extension')

console.log('')
console.log('[smoke] === 4. path arithmetic ===')
assert(childPath('', 'index.md') === 'index.md', 'a child of the ROOT has no leading slash — "/x" reads as absolute')
assert(childPath('topics', 'kling.md') === 'topics/kling.md', 'a child of a section joins with one slash')
assert(parentPath('topics/kling.md') === 'topics', 'parent of a page is its section')
assert(parentPath('index.md') === '', 'parent of a root page is the root')
const crumbs = breadcrumbs('projects/deep')
assert(crumbs.length === 3 && crumbs[0].path === '' && crumbs[0].label === 'Wiki', 'breadcrumbs always start at the root')
assert(crumbs[2].path === 'projects/deep' && crumbs[2].label === 'deep', 'the last crumb is the full path with a leaf label')
assert(breadcrumbs('').length === 1, 'at the root there is exactly one crumb')

console.log('')
console.log('[smoke] === 5. URL encoding — live names contain SPACES ===')
assert(
  wikiUrl('page', 'clients/Prometheus Daemon.md') === '/api/wiki/page?path=clients%2FPrometheus%20Daemon.md',
  'a real page name with a space encodes — unencoded it is a malformed request line'
)
assert(
  wikiUrl('pages', '') === '/api/wiki/pages?path=',
  'the root listing sends an empty path, not a missing parameter'
)
assert(wikiSearchUrl('$BACKUP_ROOT & more').includes('%24BACKUP_ROOT%20%26%20more'), '$ and & in a query are encoded, not swallowed')
assert(!wikiSearchUrl('a#b').includes('#'), 'a # would truncate the query string — it must not survive raw')

console.log('')
console.log('[smoke] === 6. WHY a page matched — the field that used to lie ===')
// Captured shape: q=queries. The second row matched its PATH only; its title is "Insight: …".
const searched = parseSearch({
  query: 'queries',
  returned: 2,
  truncated: false,
  results: [
    { path: 'index.md', section: '', title: 'Prometheus Wiki Index', snippet: 'queries live under…', in_title: false, in_path: false, mtime: 1787875000.6 },
    // Name elided exactly as my terminal elided it — see the SHAPE-ONLY note above.
    { path: 'queries/insight-backup-root-doc-doc-file-gener.md', section: 'queries', title: 'Insight: $BACKUP_ROOT, .do', snippet: '', in_title: false, in_path: true, mtime: 1787876000.7 }
  ]
})
assert(searched !== null && searched.hits.length === 2, 'both hits parse')
assert(matchKind(searched!.hits[0]) === 'body', 'a body-only hit reports body')
assert(matchKind(searched!.hits[1]) === 'path', 'a PATH-only hit reports path — NOT title')
// The regression in one line: before #288's review these were one field, so this row said "title"
// about a page titled "Insight: $BACKUP_ROOT", which is what the badge renders from.
assert(searched!.hits[1].inTitle === false, 'in_title stays false when only the path matched')
assert(
  matchKind({ path: 'p', section: '', title: 't', snippet: '', inTitle: true, inPath: true, mtime: 0 }) === 'title',
  'title outranks path when BOTH are true — the strongest true claim wins'
)

console.log('')
console.log('[smoke] === 7. an older daemon (no in_path / no truncated) degrades, never throws ===')
const legacy = parseSearch({ query: 'x', returned: 1, results: [{ path: 'a.md', title: 'A', snippet: 's', in_title: true, mtime: 1 }] })
assert(legacy !== null, 'a pre-review response still parses')
assert(legacy!.hits[0].inPath === false, 'a missing in_path reads as false')
assert(legacy!.truncated === false, 'a missing truncated reads as false — the old silent-cap behaviour, not a crash')
assert(truncationNotice(legacy!) === '', 'and nothing is claimed about a cap that was not reported')

console.log('')
console.log('[smoke] === 8. a capped result set says so, and says the ORDER ===')
const capped = parseSearch({ query: 'beacon', returned: 3, truncated: true, results: [
  { path: 'index.md', title: 'I', snippet: 's', in_title: false, in_path: false, mtime: 1 },
  { path: 'projects/clone repositories.md', title: 'clone repositories', snippet: 's', in_title: false, in_path: false, mtime: 1 },
  { path: 'projects/prometheus-beacon.md', title: 'prometheus-beacon', snippet: 's', in_title: true, in_path: true, mtime: 1 }
] })
assert(capped!.truncated === true, 'truncated survives the parse')
const notice = truncationNotice(capped!)
assert(notice.includes('first 3'), 'the notice names how many came back')
assert(notice.toLowerCase().includes('path order'), 'and says the walk is PATH-ordered — otherwise a reader assumes these are the 3 best')
assert(capped!.returned === 3, 'returned counts the rows actually parsed, so it always describes the list shown')

console.log('')
console.log('[smoke] === 9. filtering one folder ===')
const entries = listing!.entries
assert(filterEntries(entries, '').length === 6, 'an empty filter changes nothing')
assert(filterEntries(entries, 'INDEX').length === 1, 'filter is case-insensitive')
assert(filterEntries(entries, 'Prometheus Wiki').length === 1, 'a page is findable by its TITLE')
assert(filterEntries(entries, 'index.md').length === 1, 'and by its FILENAME')
assert(filterEntries(entries, 'zzz').length === 0, 'no match is empty, not everything')

console.log('')
console.log('[smoke] === 10. mtime is float SECONDS (reading it as ms lands in 1970) ===')
const now = 1787875600_000
// 1787875600000 − 1787875000600 = 599_400 ms = 9.99 minutes, and the formatter FLOORS.
assert(fmtWikiTime(1787875000.6, now) === '9m ago', 'float epoch seconds render as a recent, floored time')
assert(fmtWikiTime(undefined) === '', 'a missing mtime renders as nothing, not "Jan 1"')
assert(fmtWikiTime(0) === '', 'a zero mtime is treated as absent')
assert(new Date(1787875000.6 * 1000).getUTCFullYear() > 2020, 'sanity: seconds×1000 is a modern date, ms would be 1970')

console.log('')
console.log('[smoke] === 11. the page read ===')
const pg = parsePage({ path: 'index.md', size: 4210, truncated: false, binary: false, content: '# Prometheus Wiki Index\n' })
assert(pg !== null && pg.content.startsWith('# '), 'markdown arrives raw for the renderer')
assert(parsePage({ path: 'x', size: 1 }) === null, 'a body with no content field is null, not an empty page')
assert(parsePage({ content: '', path: 'e.md', size: 0 })?.content === '', 'a genuinely EMPTY page is a page, not a parse failure')
assert(WIKI_SEARCH_MIN_QUERY === 2, 'the client never sends a query the daemon would answer with nothing')

console.log('')
console.log('[smoke] === 12. the view is registered, once, under Workspace ===')
assert(NAV_VIEWS.some((v) => v.id === 'wiki'), 'wiki is in the view registry')
assert(flattenNavTree().filter((id) => id === 'wiki').length === 1, 'reachable exactly once in the rail')
const workspace = NAV_TREE.find((e) => e.kind === 'group' && e.group.id === 'grp:workspace')
assert(
  workspace !== undefined && workspace.kind === 'group' && workspace.group.children.includes('wiki'),
  'nested under Workspace, beside Documents — a different corpus, not a different file browser'
)
assert(NAV_TREE.every((e) => e.kind !== 'view' || e.id !== 'wiki'), 'and it is NOT also a top-level entry')

console.log('')
console.log('[smoke] ===================== RESULT =====================')
console.log(`[smoke] outcome: ${failures === 0 ? 'PASS ✓' : `FAIL ✗ (${failures})`} (parse, openability, labels, paths, encoding, match attribution, caps, filter, seconds, nav)`)
console.log('[smoke] ===================================================')
process.exit(failures === 0 ? 0 : 1)
