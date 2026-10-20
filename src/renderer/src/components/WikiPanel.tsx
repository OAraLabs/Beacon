import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import {
  WIKI_SEARCH_DEBOUNCE_MS,
  WIKI_SEARCH_MIN_QUERY,
  breadcrumbs,
  childPath,
  entryLabel,
  filterEntries,
  fmtSize,
  fmtWikiTime,
  isOpenable,
  matchLabel,
  parseListing,
  parsePage,
  parseSearch,
  stemOf,
  truncationNotice,
  wikiSearchUrl,
  wikiUrl,
  type WikiEntry,
  type WikiListing,
  type WikiPage,
  type WikiSearchResult
} from '@shared/wiki'
import { WikiPageBody } from './WikiPageBody'
import { Icon } from './Icon'

// Wiki explorer — roadmap item 9, the Beacon half of Prometheus PR 288.
//
// "What does the agent know about X" was answerable only by asking the agent and hoping it looked.
// /api/wiki/stats has counted ~318 pages for months with no route to read one; PR 288 added the read
// surface and this is the surface that uses it.
//
// READ-ONLY, matching the daemon. DocumentsService can save and edit and none of it is wired: the
// wiki is agent-authored and compiled, so a human editing it underneath the compiler is a different
// feature with a different set of questions.
//
// Master-detail like Documents rather than a row list like Artifacts, because the deliverable here
// is the PAGE. A wiki you can list but not read comfortably has missed the point.

const panel: CSSProperties = { flex: 1, minWidth: 0, minHeight: 0, display: 'flex', overflow: 'hidden' }
const rail: CSSProperties = {
  width: 288,
  flexShrink: 0,
  display: 'flex',
  flexDirection: 'column',
  borderRight: '1px solid var(--c-line)',
  background: 'var(--c-panel, var(--c-base))',
  overflow: 'hidden'
}
const railHead: CSSProperties = { padding: '10px 12px', borderBottom: '1px solid var(--c-line)', flexShrink: 0 }
const input: CSSProperties = {
  width: '100%',
  padding: '5px 9px',
  fontSize: 12,
  background: 'var(--c-inset)',
  border: '1px solid var(--c-line)',
  borderRadius: 6,
  color: 'var(--c-text)',
  outline: 'none',
  boxSizing: 'border-box'
}
const crumbBar: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 2,
  flexWrap: 'wrap',
  padding: '7px 12px',
  borderBottom: '1px solid var(--c-line)',
  fontSize: 11,
  color: 'var(--c-text-dim)',
  flexShrink: 0
}
const crumbBtn: CSSProperties = {
  background: 'transparent',
  border: 'none',
  padding: '1px 3px',
  color: 'var(--c-text-dim)',
  cursor: 'pointer',
  font: 'inherit',
  fontSize: 11,
  borderRadius: 4
}
const rowBase: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  width: '100%',
  padding: '6px 12px',
  background: 'transparent',
  border: 'none',
  textAlign: 'left',
  font: 'inherit',
  fontSize: 12.5,
  color: 'var(--c-text)',
  cursor: 'pointer'
}
const note: CSSProperties = { padding: '28px 14px', textAlign: 'center', color: 'var(--c-text-dim)', fontSize: 12 }
const readerWrap: CSSProperties = { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden', background: 'var(--c-base)' }
const readerScroll: CSSProperties = { flex: 1, overflowY: 'auto', display: 'flex', justifyContent: 'center' }
const READ_COL = 720
const column: CSSProperties = { width: '100%', maxWidth: READ_COL, padding: '40px 24px 140px' }
const badge: CSSProperties = {
  fontSize: 9.5,
  textTransform: 'uppercase',
  letterSpacing: 0.4,
  padding: '1px 5px',
  borderRadius: 4,
  border: '1px solid var(--c-line)',
  color: 'var(--c-text-faint)',
  flexShrink: 0
}
const banner: CSSProperties = {
  margin: '0 0 18px',
  padding: '8px 11px',
  fontSize: 11.5,
  borderRadius: 6,
  border: '1px solid var(--c-line)',
  background: 'var(--c-inset)',
  color: 'var(--c-text-dim)'
}

function errText(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e)
  // The REST layer prefixes "HTTP 404: GET /api/… — body". Keep it: the status is the useful half
  // when an older daemon simply has no wiki routes.
  return m.length > 300 ? `${m.slice(0, 300)}…` : m
}

export function WikiPanel() {
  const [dir, setDir] = useState('')
  const [listing, setListing] = useState<WikiListing | null>(null)
  const [listErr, setListErr] = useState<string | null>(null)
  const [filter, setFilter] = useState('')

  const [query, setQuery] = useState('')
  const [results, setResults] = useState<WikiSearchResult | null>(null)
  const [searchErr, setSearchErr] = useState<string | null>(null)
  const [searching, setSearching] = useState(false)

  const [openPath, setOpenPath] = useState<string | null>(null)
  const [page, setPage] = useState<WikiPage | null>(null)
  const [pageErr, setPageErr] = useState<string | null>(null)
  const [pageBusy, setPageBusy] = useState(false)

  const searching_ = query.trim().length >= WIKI_SEARCH_MIN_QUERY

  const loadDir = useCallback((path: string): void => {
    setListErr(null)
    setListing(null)
    window.beacon.daemon
      .get(wikiUrl('pages', path))
      .then((raw) => {
        const parsed = parseListing(raw)
        if (!parsed) throw new Error('unrecognised listing shape')
        setListing(parsed)
      })
      .catch((e) => setListErr(errText(e)))
  }, [])

  useEffect(() => loadDir(dir), [dir, loadDir])

  // Debounced server-side search. The seq guard drops a slow response that lands after a newer
  // one — without it, typing "beacon" can end up showing the results for "beac".
  const seq = useRef(0)
  useEffect(() => {
    const q = query.trim()
    if (q.length < WIKI_SEARCH_MIN_QUERY) {
      setResults(null)
      setSearchErr(null)
      setSearching(false)
      return
    }
    const mine = ++seq.current
    setSearching(true)
    const t = setTimeout(() => {
      window.beacon.daemon
        .get(wikiSearchUrl(q))
        .then((raw) => {
          if (mine !== seq.current) return
          const parsed = parseSearch(raw)
          if (!parsed) throw new Error('unrecognised search shape')
          setResults(parsed)
          setSearchErr(null)
        })
        .catch((e) => {
          if (mine !== seq.current) return
          setSearchErr(errText(e))
          setResults(null)
        })
        .finally(() => {
          if (mine === seq.current) setSearching(false)
        })
    }, WIKI_SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(t)
  }, [query])

  const openPage = useCallback((path: string): void => {
    setOpenPath(path)
    setPage(null)
    setPageErr(null)
    setPageBusy(true)
    window.beacon.daemon
      .get(wikiUrl('page', path))
      .then((raw) => {
        const parsed = parsePage(raw)
        if (!parsed) throw new Error('unrecognised page shape')
        setPage(parsed)
      })
      .catch((e) => setPageErr(errText(e)))
      .finally(() => setPageBusy(false))
  }, [])

  const rows = useMemo(() => filterEntries(listing?.entries ?? [], filter), [listing, filter])
  const crumbs = useMemo(() => breadcrumbs(dir), [dir])

  const openEntry = (e: WikiEntry): void => {
    if (e.type === 'dir') {
      setDir(childPath(dir, e.name))
      setFilter('')
      return
    }
    if (isOpenable(e)) openPage(childPath(dir, e.name))
  }

  return (
    <div style={panel}>
      <div style={rail}>
        <div style={railHead}>
          <input
            style={input}
            value={query}
            onChange={(ev) => setQuery(ev.target.value)}
            placeholder="Search the wiki…"
            aria-label="Search the wiki"
            spellCheck={false}
          />
        </div>

        {searching_ ? (
          <div style={{ flex: 1, overflowY: 'auto' }}>
            {searchErr ? (
              <div style={{ ...note, color: 'var(--c-err)' }}>{searchErr}</div>
            ) : searching && !results ? (
              <div style={note}>Searching…</div>
            ) : !results || results.hits.length === 0 ? (
              <div style={note}>No page mentions “{query.trim()}”.</div>
            ) : (
              <>
                <div style={{ padding: '7px 12px', fontSize: 11, color: 'var(--c-text-dim)', borderBottom: '1px solid var(--c-line)' }}>
                  {results.returned} {results.returned === 1 ? 'page' : 'pages'}
                </div>
                {results.hits.map((h) => (
                  <button
                    key={h.path}
                    onClick={() => openPage(h.path)}
                    title={h.path}
                    style={{
                      ...rowBase,
                      flexDirection: 'column',
                      alignItems: 'stretch',
                      gap: 3,
                      padding: '8px 12px',
                      borderBottom: '1px solid var(--c-line)',
                      background: openPath === h.path ? 'var(--c-inset)' : 'transparent'
                    }}
                  >
                    <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {h.title}
                      </span>
                      {/* Which of title / path / body matched. These are separate daemon fields on
                          purpose — a path-only hit used to report itself as a title hit. */}
                      <span style={badge} title={`matched in the ${matchLabel(h)}`}>
                        {matchLabel(h)}
                      </span>
                    </span>
                    <span style={{ fontSize: 10.5, color: 'var(--c-text-faint)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {h.path}
                    </span>
                    {h.snippet ? (
                      <span style={{ fontSize: 11, color: 'var(--c-text-dim)', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                        {h.snippet}
                      </span>
                    ) : null}
                  </button>
                ))}
                {results.truncated ? (
                  <div style={{ ...note, padding: '12px 14px', textAlign: 'left', fontSize: 11 }}>{truncationNotice(results)}</div>
                ) : null}
              </>
            )}
          </div>
        ) : (
          <>
            <div style={crumbBar}>
              {crumbs.map((c, i) => (
                <span key={c.path || 'root'} style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
                  {i > 0 ? <span style={{ color: 'var(--c-text-faint)' }}>/</span> : null}
                  <button
                    onClick={() => { setDir(c.path); setFilter('') }}
                    style={{ ...crumbBtn, color: i === crumbs.length - 1 ? 'var(--c-text)' : 'var(--c-text-dim)' }}
                  >
                    {c.label}
                  </button>
                </span>
              ))}
              <button
                onClick={() => loadDir(dir)}
                title="Refresh"
                aria-label="Refresh listing"
                style={{ ...crumbBtn, marginLeft: 'auto', display: 'inline-flex' }}
              >
                <Icon name="refresh" size={12} />
              </button>
            </div>

            {/* Filters THIS directory only — distinct from the search box, which walks every page.
                It earns its place because the live wiki's projects/ holds 197 entries, and the
                server walk caps at 20 in path order, so it cannot stand in for narrowing a listing. */}
            <div style={{ padding: '6px 12px', borderBottom: '1px solid var(--c-line)', flexShrink: 0 }}>
              <input
                style={{ ...input, fontSize: 11, padding: '3px 8px' }}
                value={filter}
                onChange={(ev) => setFilter(ev.target.value)}
                placeholder={`Filter ${listing ? listing.entries.length : ''} in this folder…`.replace('  ', ' ')}
                aria-label="Filter this folder"
                spellCheck={false}
              />
            </div>

            <div style={{ flex: 1, overflowY: 'auto' }}>
              {listErr ? (
                <div style={{ ...note, color: 'var(--c-err)' }}>{listErr}</div>
              ) : listing === null ? (
                <div style={note}>Loading…</div>
              ) : rows.length === 0 ? (
                <div style={note}>{listing.entries.length === 0 ? 'Empty.' : `Nothing matches “${filter.trim()}”.`}</div>
              ) : (
                rows.map((e) => {
                  const openable = isOpenable(e)
                  const isDir = e.type === 'dir'
                  const active = !isDir && openPath === childPath(dir, e.name)
                  return (
                    <button
                      key={e.name}
                      onClick={() => openEntry(e)}
                      disabled={!isDir && !openable}
                      title={
                        isDir
                          ? `Open ${e.name}`
                          : openable
                            ? `${e.name} · ${fmtSize(e.size)}`
                            : `${e.name} — not a wiki page, so it has no reader`
                      }
                      style={{
                        ...rowBase,
                        background: active ? 'var(--c-inset)' : 'transparent',
                        cursor: isDir || openable ? 'pointer' : 'default',
                        color: isDir || openable ? 'var(--c-text)' : 'var(--c-text-faint)'
                      }}
                    >
                      <span style={{ display: 'inline-flex', color: 'var(--c-text-faint)', flexShrink: 0 }} aria-hidden>
                        <Icon name={isDir ? 'files' : 'document'} size={13} />
                      </span>
                      <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {entryLabel(e)}
                      </span>
                      {isDir ? (
                        <span style={{ display: 'inline-flex', color: 'var(--c-text-faint)', flexShrink: 0 }} aria-hidden>
                          <Icon name="chevron-right" size={12} />
                        </span>
                      ) : (
                        <span style={{ fontSize: 10, color: 'var(--c-text-faint)', flexShrink: 0 }}>{fmtWikiTime(e.mtime)}</span>
                      )}
                    </button>
                  )
                })
              )}
            </div>
          </>
        )}
      </div>

      <div style={readerWrap}>
        {openPath === null ? (
          <div style={{ ...note, margin: 'auto', maxWidth: 380 }}>
            Pick a page to read it. The wiki is what the agent has compiled about people, projects,
            clients and topics — search above to find what it knows about something.
          </div>
        ) : (
          <>
            <div style={{ padding: '12px 20px', borderBottom: '1px solid var(--c-line)', flexShrink: 0, display: 'flex', alignItems: 'center', gap: 10 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--c-text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {stemOf(openPath)}
                </div>
                <div style={{ fontSize: 10.5, color: 'var(--c-text-faint)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {openPath}
                  {page ? ` · ${fmtSize(page.size)}` : ''}
                </div>
              </div>
              <button
                onClick={() => openPage(openPath)}
                title="Reload this page"
                aria-label="Reload page"
                style={{ ...crumbBtn, display: 'inline-flex' }}
              >
                <Icon name="refresh" size={13} />
              </button>
            </div>
            <div style={readerScroll}>
              <div style={column}>
                {pageErr ? (
                  <div style={{ ...banner, color: 'var(--c-err)' }}>{pageErr}</div>
                ) : pageBusy || !page ? (
                  <div style={note}>Loading…</div>
                ) : page.binary ? (
                  <div style={banner}>This file is not text, so there is nothing to render.</div>
                ) : (
                  <>
                    {/* The daemon caps a read at 256 KB. Saying so beats a page that just stops. */}
                    {page.truncated ? (
                      <div style={banner}>
                        Showing the first {fmtSize(page.content.length)} of {fmtSize(page.size)} — this page is
                        longer than the read cap.
                      </div>
                    ) : null}
                    <WikiPageBody content={page.content} />
                  </>
                )}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
