import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'
import { asList, fmtBytes, isAuthError, joinFilePath, parentFilePath } from '@shared/daemon-api'
import {
  docBaseName,
  docBreadcrumbs,
  docsListPath,
  docsReadPath,
  DOCS_CONTENT_PATH,
  DOCS_EDIT_PATH,
  DOCS_SUGGEST_PATH,
  openDocTab,
  setTabContent,
  closeDocTab,
  nextActiveAfterClose,
  tabDirty,
  applyOnce,
  validDocName,
  reviewSegments,
  reviewTally,
  type DocEntry,
  type DocListDTO,
  type DocReadDTO,
  type DocSaveDTO,
  type DocSuggestion,
  type DocSuggestDTO,
  type DocEditResultDTO,
  type DocTab,
  type ReviewStatus
} from '@shared/documents'
import { NotAuthorized } from './NotAuthorized'
import { InlineConfirm, InlinePrompt } from './InlineDialogs'
import { Icon } from './Icon'

// Documents Editor — Makeover (layout + redline). The plumbing (list/read/save/suggest/edit over
// /api/documents) is unchanged; this is the calm writing surface + inline tracked-changes review.
//   • Body: a centered ~720px Inter reading column on calm ground (not a full-bleed mono code field).
//   • Save: client-side DEBOUNCED auto-save over the existing PUT endpoint (no daemon change). The
//     toolbar shows honest status (Unsaved during the debounce window → Saving… → Saved ✓); there is
//     no manual Save button (⌘S still forces an immediate save).
//   • Ask AI: instruction → /suggest → the body swaps to a review-view rendering each {find,replace,
//     reason} as an INLINE redline with per-edit Accept/Reject. Accept applies one /edit (persists);
//     Reject discards; nothing touches disk until you accept (the human-gate model). Done returns to
//     the editing surface — the swap is clean both ways, so you're never stuck in review.
// Every 401 deep-links to Settings via NotAuthorized — never a silent blank.

const UI = 'var(--font-ui)'
const READ_COL = 720 // centered reading-width column (north star: ~700–760px)
const AUTOSAVE_MS = 900 // debounce: persist a beat after you stop typing — never per-keystroke
const SENTINEL_NEW = '  documents:new' // a fresh tab's `saved` ≠ '' so it is dirty (createable)

const panel: CSSProperties = { flex: 1, minWidth: 0, minHeight: 0, display: 'flex', overflow: 'hidden' }
const sidebar: CSSProperties = {
  width: 264,
  flexShrink: 0,
  minHeight: 0,
  display: 'flex',
  flexDirection: 'column',
  borderRight: '1px solid var(--c-line)',
  background: 'var(--c-base)'
}
const head: CSSProperties = {
  padding: '10px 14px',
  borderBottom: '1px solid var(--c-line)',
  background: 'var(--c-raise)',
  flexShrink: 0,
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  flexWrap: 'wrap'
}
const closeX: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 18,
  height: 18,
  borderRadius: 4,
  border: 'none',
  background: 'transparent',
  color: 'var(--c-text-faint)',
  cursor: 'pointer'
}
const rowMain: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  width: '100%',
  padding: '6px 14px',
  background: 'transparent',
  border: 'none',
  cursor: 'pointer',
  textAlign: 'left',
  font: 'inherit',
  color: 'var(--c-text)'
}

// ── Editor (calm writing surface) ──
const editorWrap: CSSProperties = { flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden', position: 'relative', background: 'var(--c-base)' }
const tabsBar: CSSProperties = { display: 'flex', alignItems: 'stretch', borderBottom: '1px solid var(--c-line)', background: 'var(--c-base)', overflowX: 'auto', flexShrink: 0, minHeight: 34 }
const tabBtn = (active: boolean): CSSProperties => ({
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  padding: '0 8px 0 14px',
  borderRight: '1px solid var(--c-line)',
  borderBottom: `2px solid ${active ? 'var(--c-arc)' : 'transparent'}`,
  background: 'transparent',
  color: active ? 'var(--c-text)' : 'var(--c-text-dim)',
  cursor: 'pointer',
  font: 'inherit',
  fontFamily: UI,
  fontSize: 13,
  whiteSpace: 'nowrap',
  border: 'none'
})
const toolbar: CSSProperties = { display: 'flex', alignItems: 'center', gap: 14, padding: '12px 20px', borderBottom: '1px solid var(--c-line)', background: 'var(--c-base)', flexShrink: 0 }
const titleWrap: CSSProperties = { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 1 }
const docTitle: CSSProperties = { fontFamily: UI, fontSize: 'var(--fs-5)', fontWeight: 600, color: 'var(--c-text)', lineHeight: 1.2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }
const docPathLine: CSSProperties = { fontFamily: UI, fontSize: 'var(--fs-0)', color: 'var(--c-text-faint)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }
const askBtn = (on: boolean): CSSProperties => ({
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  fontFamily: UI,
  fontSize: 'var(--fs-1)',
  padding: '6px 13px',
  borderRadius: 'var(--r-2)',
  border: `1px solid ${on ? 'var(--c-arc)' : 'var(--c-line)'}`,
  background: on ? 'var(--c-arc-soft)' : 'transparent',
  color: on ? 'var(--c-arc)' : 'var(--c-text-dim)',
  cursor: 'pointer'
})
const scrollCol: CSSProperties = { flex: 1, overflowY: 'auto', background: 'var(--c-base)', display: 'flex', justifyContent: 'center' }
const column: CSSProperties = { width: '100%', maxWidth: READ_COL, padding: '56px 24px 160px' }
const proseArea: CSSProperties = {
  display: 'block',
  width: '100%',
  border: 'none',
  outline: 'none',
  resize: 'none',
  background: 'transparent',
  color: 'var(--c-text)',
  fontFamily: UI,
  fontSize: 'var(--fs-4)',
  lineHeight: 1.7,
  padding: 0,
  margin: 0,
  minHeight: '46vh',
  overflow: 'hidden' // height is driven to scrollHeight (auto-grow); the column scrolls, not the box
}
const aiBar: CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, padding: '10px 20px', borderBottom: '1px solid var(--c-line)', background: 'var(--c-base)', flexShrink: 0 }
// Disabled is a visible state (see DevicesPanel btn): the flag drives prop + style together.
const aiInput = (disabled = false): CSSProperties => ({
  flex: 1,
  minWidth: 0,
  opacity: disabled ? 0.55 : 1,
  cursor: disabled ? 'wait' : undefined,
  fontFamily: UI,
  fontSize: 'var(--fs-2)',
  padding: '8px 12px',
  borderRadius: 'var(--r-2)',
  border: '1px solid var(--c-line)',
  background: 'var(--c-inset)',
  color: 'var(--c-text)'
})
const smallBtn = (kind: 'ok' | 'err' | 'neutral'): CSSProperties => ({
  display: 'inline-flex',
  alignItems: 'center',
  gap: 5,
  fontFamily: UI,
  fontSize: 'var(--fs-1)',
  padding: '5px 11px',
  borderRadius: 'var(--r-2)',
  border: `1px solid var(--c-${kind === 'ok' ? 'ok' : kind === 'err' ? 'err' : 'line'})`,
  background: kind === 'ok' ? 'var(--c-ok-soft)' : kind === 'err' ? 'var(--c-err-soft)' : 'transparent',
  color: kind === 'ok' ? 'var(--c-ok)' : kind === 'err' ? 'var(--c-err)' : 'var(--c-text-dim)',
  cursor: 'pointer'
})

// ── Inline redline review-view ──
const reviewProse: CSSProperties = { fontFamily: UI, fontSize: 'var(--fs-4)', lineHeight: 1.7, color: 'var(--c-text)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }
const redlineGroup: CSSProperties = { display: 'inline', whiteSpace: 'normal' }
const redlineDel: CSSProperties = { color: 'var(--c-err)', textDecoration: 'line-through', background: 'var(--c-err-soft)', borderRadius: 'var(--r-1)', padding: '0 2px' }
const redlineIns: CSSProperties = { color: 'var(--c-ok)', background: 'var(--c-ok-soft)', borderRadius: 'var(--r-1)', padding: '0 2px', marginLeft: 2 }
const ctlBtn = (kind: 'ok' | 'err'): CSSProperties => ({
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 20,
  height: 18,
  marginLeft: 3,
  borderRadius: 'var(--r-1)',
  border: `1px solid var(--c-${kind})`,
  background: 'transparent',
  color: `var(--c-${kind})`,
  cursor: 'pointer',
  verticalAlign: 'middle'
})
const redlineReason: CSSProperties = { fontFamily: UI, fontSize: 'var(--fs-0)', fontStyle: 'italic', color: 'var(--c-text-faint)', marginLeft: 6 }

async function listDir(path: string): Promise<DocListDTO> {
  const b = window.beacon
  if (!b) throw new Error('bridge unavailable')
  return (await b.daemon.get(docsListPath(path))) as DocListDTO
}
async function readDoc(path: string): Promise<DocReadDTO> {
  const b = window.beacon
  if (!b) throw new Error('bridge unavailable')
  return (await b.daemon.get(docsReadPath(path))) as DocReadDTO
}
async function saveDoc(path: string, content: string): Promise<DocSaveDTO> {
  const b = window.beacon
  if (!b) throw new Error('bridge unavailable')
  return (await b.daemon.write(DOCS_CONTENT_PATH, { path, content }, 'PUT')) as DocSaveDTO
}
async function suggestDocs(path: string, instruction: string): Promise<DocSuggestDTO> {
  const b = window.beacon
  if (!b) throw new Error('bridge unavailable')
  return (await b.daemon.write(DOCS_SUGGEST_PATH, { path, instruction }, 'POST')) as DocSuggestDTO
}
async function editDoc(path: string, oldStr: string, newStr: string): Promise<DocEditResultDTO> {
  const b = window.beacon
  if (!b) throw new Error('bridge unavailable')
  return (await b.daemon.write(DOCS_EDIT_PATH, { path, old_str: oldStr, new_str: newStr }, 'POST')) as DocEditResultDTO
}

type ReviewItem = { sugg: DocSuggestion; status: ReviewStatus }

export function DocumentsPanel() {
  // ── browser state ──
  const [path, setPath] = useState('')
  const [entries, setEntries] = useState<DocEntry[]>([])
  const [listErr, setListErr] = useState(false)
  const [authErr, setAuthErr] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)
  const [openErr, setOpenErr] = useState<string | null>(null)
  const [newOpen, setNewOpen] = useState(false)

  // ── editor state ──
  const [tabs, setTabs] = useState<DocTab[]>([])
  const [active, setActive] = useState(-1)
  const [saving, setSaving] = useState(false)
  const [saveErr, setSaveErr] = useState<string | null>(null)
  const [savedTick, setSavedTick] = useState(0)
  const [pendingClose, setPendingClose] = useState<number | null>(null)

  // ── AI review state ──
  const [aiOpen, setAiOpen] = useState(false)
  const [aiInstr, setAiInstr] = useState('')
  const [aiBusy, setAiBusy] = useState(false)
  const [aiErr, setAiErr] = useState<string | null>(null)
  const [items, setItems] = useState<ReviewItem[] | null>(null) // non-null ⇒ in review-view

  const tabsRef = useRef(tabs)
  tabsRef.current = tabs
  const taRef = useRef<HTMLTextAreaElement>(null)
  const autosaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    let alive = true
    setListErr(false)
    void listDir(path)
      .then((d) => {
        if (alive) setEntries(asList<DocEntry>(d.entries))
      })
      .catch((e) => {
        if (!alive) return
        if (isAuthError(e)) setAuthErr(true)
        else {
          setListErr(true)
          setEntries([])
        }
      })
    return () => {
      alive = false
    }
  }, [path, reloadKey])

  const activePath = active >= 0 ? tabs[active]?.path : undefined
  // A review/instruction is tied to the active document — reset on a tab switch.
  useEffect(() => {
    setItems(null)
    setAiErr(null)
    setAiOpen(false)
  }, [activePath])

  // Auto-grow the writing surface so the document flows and the COLUMN scrolls (not the textbox).
  useEffect(() => {
    const el = taRef.current
    if (el) {
      el.style.height = 'auto'
      el.style.height = `${el.scrollHeight}px`
    }
  }, [activePath, active, items])

  const syncTabToDisk = useCallback((p: string, content: string) => {
    setTabs((prev) => prev.map((t) => (t.path === p ? { ...t, content, saved: content } : t)))
  }, [])

  const openFile = useCallback(async (rel: string) => {
    setOpenErr(null)
    try {
      const d = await readDoc(rel)
      if (d.binary) {
        setOpenErr(`${docBaseName(rel)} is a binary file — not editable here.`)
        return
      }
      if (d.truncated) {
        setOpenErr(`${docBaseName(rel)} is too large to edit safely (truncated) — saving would clobber the rest.`)
        return
      }
      setTabs((prev) => {
        const { tabs: next, index } = openDocTab(prev, rel, d.content ?? '')
        setActive(index)
        return next
      })
    } catch (e) {
      if (isAuthError(e)) setAuthErr(true)
      else setOpenErr(`Could not open ${docBaseName(rel)}.`)
    }
  }, [])

  const createNew = useCallback(
    (name: string) => {
      const rel = joinFilePath(path, name.trim())
      setNewOpen(false)
      setTabs((prev) => {
        const existing = prev.findIndex((t) => t.path === rel)
        if (existing >= 0) {
          setActive(existing)
          return prev
        }
        setActive(prev.length)
        return [...prev, { path: rel, content: '', saved: SENTINEL_NEW }]
      })
    },
    [path]
  )

  // Persist one tab by PATH (so a debounced save survives a tab switch). Skips a clean tab and an
  // empty brand-new doc (don't create empty files just because you clicked ＋).
  const saveByPath = useCallback(
    async (p: string): Promise<boolean> => {
      const tab = tabsRef.current.find((t) => t.path === p)
      if (!tab || !tabDirty(tab)) return true
      if (tab.saved === SENTINEL_NEW && tab.content.trim() === '') return true
      setSaving(true)
      setSaveErr(null)
      try {
        await saveDoc(tab.path, tab.content)
        syncTabToDisk(tab.path, tab.content)
        setSavedTick((t) => t + 1)
        setReloadKey((k) => k + 1)
        return true
      } catch (e) {
        if (isAuthError(e)) setAuthErr(true)
        else setSaveErr('Auto-save failed — the gateway rejected the write.')
        return false
      } finally {
        setSaving(false)
      }
    },
    [syncTabToDisk]
  )

  const save = useCallback((): Promise<boolean> => {
    const tab = active >= 0 ? tabsRef.current[active] : null
    return tab ? saveByPath(tab.path) : Promise.resolve(false)
  }, [active, saveByPath])

  // Edit → update the buffer + (re)arm the debounced auto-save. During the window the tab stays
  // dirty, so the toolbar honestly reads "Unsaved" until the write lands — never a false "Saved".
  const onEdit = useCallback(
    (content: string) => {
      const p = active >= 0 ? tabsRef.current[active]?.path : undefined
      setActive((a) => {
        if (a >= 0) setTabs((prev) => setTabContent(prev, a, content))
        return a
      })
      if (!p) return
      if (autosaveTimer.current) clearTimeout(autosaveTimer.current)
      autosaveTimer.current = setTimeout(() => {
        autosaveTimer.current = null
        void saveByPath(p)
      }, AUTOSAVE_MS)
    },
    [active, saveByPath]
  )

  // ⌘S / Ctrl+S forces an immediate save (flush the pending debounce).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault()
        if (autosaveTimer.current) {
          clearTimeout(autosaveTimer.current)
          autosaveTimer.current = null
        }
        void save()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [save])

  // ── Ask AI: instruction → /suggest → enter the inline review-view ──
  const askAi = useCallback(async () => {
    const a = active
    const tab = a >= 0 ? tabsRef.current[a] : null
    if (!tab || !aiInstr.trim() || aiBusy) return
    setAiBusy(true)
    setAiErr(null)
    setItems(null)
    try {
      if (tabDirty(tab) && !(await save())) return // suggest reasons about the saved baseline
      const { edits } = await suggestDocs(tab.path, aiInstr.trim())
      if (!edits || edits.length === 0) {
        setAiErr('The model proposed no edits — try rephrasing.')
        return
      }
      setItems(edits.map((s) => ({ sugg: s, status: s.applicable ? 'pending' : 'na' })))
      setAiOpen(false) // the review-view replaces the body; the input bar collapses
      setAiInstr('')
    } catch (e) {
      if (isAuthError(e)) setAuthErr(true)
      else setAiErr('Ask AI failed — the model may be unavailable.')
    } finally {
      setAiBusy(false)
    }
  }, [active, aiInstr, aiBusy, save])

  // Accept one redline: apply via /edit (persists) and reflect it in the buffer; re-layout the rest.
  const acceptEdit = useCallback(
    async (idx: number) => {
      const a = active
      const tab = a >= 0 ? tabsRef.current[a] : null
      const cur = items
      if (!tab || !cur) return
      const it = cur[idx]
      if (!it || it.status !== 'pending') return
      try {
        const res = await editDoc(tab.path, it.sugg.find, it.sugg.replace)
        const ok = !!res.ok
        if (ok) syncTabToDisk(tab.path, applyOnce(tabsRef.current[a]?.content ?? tab.content, it.sugg.find, it.sugg.replace))
        setItems((p) => (p ? p.map((x, i) => (i === idx ? { ...x, status: ok ? 'approved' : 'failed' } : x)) : p))
      } catch (e) {
        if (isAuthError(e)) setAuthErr(true)
        else setItems((p) => (p ? p.map((x, i) => (i === idx ? { ...x, status: 'failed' } : x)) : p))
      }
    },
    [active, items, syncTabToDisk]
  )

  const rejectEdit = useCallback((idx: number) => {
    setItems((p) => (p ? p.map((x, i) => (i === idx && x.status === 'pending' ? { ...x, status: 'rejected' } : x)) : p))
  }, [])

  const acceptAll = useCallback(async () => {
    const a = active
    const tab = a >= 0 ? tabsRef.current[a] : null
    const cur = items
    if (!tab || !cur) return
    const next = [...cur]
    for (let i = 0; i < next.length; i++) {
      if (next[i].status !== 'pending') continue
      try {
        const res = await editDoc(tab.path, next[i].sugg.find, next[i].sugg.replace)
        if (res.ok) {
          syncTabToDisk(tab.path, applyOnce(tabsRef.current[a]?.content ?? '', next[i].sugg.find, next[i].sugg.replace))
          next[i] = { ...next[i], status: 'approved' }
        } else next[i] = { ...next[i], status: 'failed' }
      } catch (e) {
        if (isAuthError(e)) {
          setAuthErr(true)
          return
        }
        next[i] = { ...next[i], status: 'failed' }
      }
    }
    setItems(next)
  }, [active, items, syncTabToDisk])

  const requestClose = useCallback((idx: number) => {
    const tab = tabsRef.current[idx]
    if (tab && tabDirty(tab)) {
      setPendingClose(idx)
      return
    }
    doClose(idx)
  }, [])

  const doClose = useCallback((idx: number) => {
    setPendingClose(null)
    setTabs((prev) => {
      const next = closeDocTab(prev, idx)
      setActive((a) => nextActiveAfterClose(prev.length, idx, a))
      return next
    })
  }, [])

  const crumbs = docBreadcrumbs(path)
  const activeTab = active >= 0 ? tabs[active] : null
  const dirty = activeTab ? tabDirty(activeTab) : false
  const inReview = items !== null

  // Status: honest across the debounce window (dirty → Unsaved) → Saving… → Saved ✓.
  const status: { text: string; color: string } | null = saveErr
    ? { text: saveErr, color: 'var(--c-err)' }
    : saving
      ? { text: 'Saving…', color: 'var(--c-text-dim)' }
      : dirty
        ? { text: 'Unsaved', color: 'var(--c-text-faint)' }
        : savedTick > 0
          ? { text: 'Saved ✓', color: 'var(--c-text-dim)' }
          : null

  if (authErr)
    return (
      <div style={editorWrap}>
        <div style={head}>
          <span style={{ fontFamily: UI, fontSize: 15, fontWeight: 600, color: 'var(--c-text)' }}>Documents</span>
        </div>
        <NotAuthorized what="documents" />
      </div>
    )

  // Pending edits → inline layout (re-derived each render from the live buffer + remaining pending).
  const pending = items ? items.map((it, i) => ({ it, i })).filter((x) => x.it.status === 'pending').map((x) => ({ idx: x.i, sugg: x.it.sugg })) : []
  const layout = inReview && activeTab ? reviewSegments(activeTab.content, pending) : null
  const tally = items ? reviewTally(items.map((x) => x.status)) : null

  return (
    <div style={panel}>
      {/* ── Browser ── */}
      <div style={sidebar}>
        <div style={head}>
          <Icon name="document" size={16} />
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', flex: 1, minWidth: 0 }}>
            {crumbs.map((c, i) => (
              <span key={c.path} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                {i > 0 ? <span style={{ color: 'var(--c-text-faint)' }}>/</span> : null}
                <button
                  onClick={() => setPath(c.path)}
                  style={{ background: 'transparent', border: 'none', cursor: 'pointer', font: 'inherit', fontFamily: UI, fontSize: 13, color: i === crumbs.length - 1 ? 'var(--c-text)' : 'var(--c-arc)' }}
                >
                  {c.name}
                </button>
              </span>
            ))}
          </div>
          <button style={closeX} title="New document here" onClick={() => setNewOpen(true)}>
            <Icon name="plus" size={14} />
          </button>
        </div>
        {newOpen ? <InlinePrompt placeholder="new-note.md" validate={validDocName} onSubmit={createNew} onCancel={() => setNewOpen(false)} /> : null}
        <div style={{ flex: 1, overflowY: 'auto' }}>
          {path ? (
            <button style={rowMain} onClick={() => setPath(parentFilePath(path))}>
              <span style={{ width: 16 }}>↩</span>
              <span style={{ fontFamily: UI, fontSize: 13 }}>..</span>
            </button>
          ) : null}
          {listErr ? (
            <div style={{ padding: 14, color: 'var(--c-err)', fontSize: 13 }}>Failed to list (daemon /api/documents).</div>
          ) : entries.length === 0 ? (
            <div style={{ padding: 14, color: 'var(--c-text-dim)', fontSize: 13 }}>Empty — use ＋ to create a document.</div>
          ) : (
            entries.map((e) => {
              const rel = joinFilePath(path, e.name)
              const isOpen = e.type === 'file' && tabs.some((t) => t.path === rel)
              return (
                <button
                  key={e.name}
                  style={{ ...rowMain, borderLeft: `2px solid ${isOpen ? 'var(--c-arc)' : 'transparent'}` }}
                  onClick={() => {
                    if (e.type === 'dir') setPath(rel)
                    else void openFile(rel)
                  }}
                >
                  <span style={{ width: 16 }}>{e.type === 'dir' ? '📁' : '📄'}</span>
                  <span style={{ flex: 1, minWidth: 0, fontFamily: UI, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.name}</span>
                  {e.type === 'file' ? <span style={{ fontSize: 11, color: 'var(--c-text-faint)', flexShrink: 0 }}>{fmtBytes(e.size)}</span> : null}
                </button>
              )
            })
          )}
          {openErr ? <div style={{ padding: '10px 14px', color: 'var(--c-warn)', fontSize: 12, lineHeight: 1.4 }}>{openErr}</div> : null}
        </div>
      </div>

      {/* ── Editor ── */}
      <div style={editorWrap}>
        {tabs.length === 0 ? (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--c-text-dim)', fontFamily: UI, fontSize: 14 }}>
            Open a document on the left, or use ＋ to create one.
          </div>
        ) : (
          <>
            <div style={tabsBar}>
              {tabs.map((t, i) => (
                <div key={t.path} style={tabBtn(i === active)} onClick={() => setActive(i)} role="button">
                  <span title={t.path} style={{ overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 180 }}>{docBaseName(t.path)}</span>
                  {tabDirty(t) ? <span title="unsaved" style={{ color: 'var(--c-arc)', fontSize: 16, lineHeight: 1 }}>•</span> : null}
                  <span style={closeX} title="Close" onClick={(ev) => { ev.stopPropagation(); requestClose(i) }}>
                    <Icon name="x" size={13} />
                  </span>
                </div>
              ))}
            </div>

            {activeTab ? (
              <>
                {/* Toolbar: title LEFT · status + actions RIGHT (status is not a button). */}
                <div style={toolbar}>
                  <div style={titleWrap}>
                    <span style={docTitle} title={activeTab.path}>{docBaseName(activeTab.path)}</span>
                    <span style={docPathLine}>{activeTab.path}</span>
                  </div>
                  {status ? <span style={{ fontFamily: UI, fontSize: 'var(--fs-1)', color: status.color, whiteSpace: 'nowrap' }}>{status.text}</span> : null}
                  {!inReview ? (
                    <button style={askBtn(aiOpen)} onClick={() => setAiOpen((v) => !v)} title="Ask AI to propose edits">
                      <Icon name="zap" size={13} />
                      Ask AI
                    </button>
                  ) : null}
                </div>

                {/* Ask-AI input (only outside review) */}
                {aiOpen && !inReview ? (
                  <div style={aiBar}>
                    <input
                      style={aiInput(aiBusy)}
                      value={aiInstr}
                      placeholder="Describe a change — e.g. “tighten the intro” or “fix the typo in line 2”"
                      onChange={(e) => setAiInstr(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') void askAi() }}
                      disabled={aiBusy}
                      autoFocus
                    />
                    <button style={askBtn(!aiBusy && aiInstr.trim().length > 0)} disabled={aiBusy || !aiInstr.trim()} onClick={() => void askAi()}>
                      {aiBusy ? 'Thinking…' : 'Propose edits'}
                    </button>
                  </div>
                ) : null}
                {aiErr ? <div style={{ padding: '8px 20px', fontFamily: UI, fontSize: 12, color: 'var(--c-warn)', background: 'var(--c-base)', borderBottom: '1px solid var(--c-line)' }}>{aiErr}</div> : null}

                {/* Review action bar (only in review) */}
                {inReview && tally ? (
                  <div style={aiBar}>
                    <span style={{ fontFamily: UI, fontSize: 'var(--fs-1)', color: 'var(--c-text-dim)', flex: 1, minWidth: 0 }}>
                      Reviewing proposed edits — {tally.pending} pending
                      {tally.approved ? `, ${tally.approved} accepted` : ''}
                      {tally.rejected ? `, ${tally.rejected} rejected` : ''}
                    </span>
                    {tally.pending > 0 ? <button style={smallBtn('ok')} onClick={() => void acceptAll()}>Accept all</button> : null}
                    <button style={smallBtn('neutral')} onClick={() => setItems(null)} title="Return to editing (keeps what you've accepted)">Done</button>
                  </div>
                ) : null}

                {/* Body: writing surface, or the inline redline review-view */}
                {!inReview ? (
                  <div style={scrollCol}>
                    <div style={column}>
                      <textarea ref={taRef} style={proseArea} value={activeTab.content} placeholder="Start writing…" onChange={(e) => onEdit(e.target.value)} />
                    </div>
                  </div>
                ) : (
                  <div style={scrollCol}>
                    <div style={column}>
                      <div style={reviewProse}>
                        {layout!.segments.map((seg, i) =>
                          seg.kind === 'text' ? (
                            <span key={i}>{seg.text}</span>
                          ) : (
                            <span key={i} style={redlineGroup}>
                              <del style={redlineDel}>{seg.find}</del>
                              <ins style={redlineIns}>{seg.replace}</ins>
                              <button style={ctlBtn('ok')} title="Accept this edit" onClick={() => void acceptEdit(seg.idx)}>
                                <Icon name="check" size={11} />
                              </button>
                              <button style={ctlBtn('err')} title="Reject this edit" onClick={() => rejectEdit(seg.idx)}>
                                <Icon name="x" size={11} />
                              </button>
                              {seg.reason ? <span style={redlineReason} title={seg.reason}>{seg.reason}</span> : null}
                            </span>
                          )
                        )}
                      </div>
                      {layout!.unplaceable.length > 0 ? (
                        <div style={{ marginTop: 24, paddingTop: 14, borderTop: '1px solid var(--c-line)' }}>
                          <div style={{ fontFamily: UI, fontSize: 'var(--fs-1)', color: 'var(--c-text-faint)', marginBottom: 8 }}>Couldn’t place inline:</div>
                          {layout!.unplaceable.map((u) => (
                            <div key={u.idx} style={{ marginBottom: 8, fontFamily: UI, fontSize: 'var(--fs-1)' }}>
                              <span style={{ color: 'var(--c-err)', textDecoration: 'line-through' }}>{u.find}</span>
                              <span style={{ color: 'var(--c-text-faint)' }}> → </span>
                              <span style={{ color: 'var(--c-ok)' }}>{u.replace}</span>
                              <span style={{ color: 'var(--c-text-faint)' }}> — {u.note}</span>
                            </div>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  </div>
                )}
              </>
            ) : null}
          </>
        )}

        {/* Dirty-close confirmation (Electron has no reliable window.confirm). */}
        {pendingClose !== null && tabs[pendingClose] ? (
          <InlineConfirm
            title="Discard unsaved changes?"
            detail={docBaseName(tabs[pendingClose].path)}
            confirmLabel="Discard"
            danger
            onConfirm={() => doClose(pendingClose)}
            onCancel={() => setPendingClose(null)}
          />
        ) : null}
      </div>
    </div>
  )
}
