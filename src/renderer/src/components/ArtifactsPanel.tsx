import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react'
import type { ArtifactEntry } from '@shared/ipc'
import {
  filterArtifacts,
  fmtArtifactTime,
  fmtSize,
  previewKindFor,
  previewNotice,
  renderKindFor,
  renderTargetFor,
  shortType,
  sortArtifacts
} from '@shared/artifacts'
import { usePreview } from '../preview-store'
import { Icon } from './Icon'

// Artifacts — the agent's OUTBOX as a first-class surface (roadmap item 4).
//
// Nested under Workspace in the rail rather than promoted to a top-level entry: it earns a view
// because artifacts have a different producer, lifecycle and trust story than workspace Files —
// the same boundary the vault draws between raw/ and wiki/ — but it does not earn one of the
// dozen slots people scan first.
//
// Before this, artifacts existed in the app only as download chips under a reply, and only when
// the reply happened to name the file. Everything else the agent produced was unreachable without
// asking it in chat.

const panel: CSSProperties = { flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column' }
const head: CSSProperties = {
  padding: '10px 16px',
  borderBottom: '1px solid var(--c-line)',
  display: 'flex',
  alignItems: 'center',
  gap: 14,
  flexShrink: 0
}
const input: CSSProperties = {
  marginLeft: 'auto',
  padding: '4px 9px',
  fontSize: 12,
  background: 'var(--c-inset)',
  border: '1px solid var(--c-line)',
  borderRadius: 6,
  color: 'var(--c-text)',
  outline: 'none',
  minWidth: 160
}
const note: CSSProperties = { padding: '48px 16px', textAlign: 'center', color: 'var(--c-text-dim)', fontSize: 13 }

// One glyph for every artifact, deliberately: the icon set has no image or binary mark, and a
// three-entry map with three identical values reads as differentiation that is not happening.
const ROW_ICON = 'document' as const

export function ArtifactsPanel() {
  const [items, setItems] = useState<ArtifactEntry[] | null>(null)
  const [filter, setFilter] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [rowNote, setRowNote] = useState<Record<string, string>>({})
  const preview = usePreview()

  const load = useCallback(() => {
    const b = window.beacon
    if (!b) return
    void b.artifacts
      .list()
      .then((rows) => setItems(Array.isArray(rows) ? rows : []))
      // An older daemon has no /api/artifacts; main already degrades that to [], so an empty list
      // here means "nothing to show", not "something broke".
      .catch(() => setItems([]))
  }, [])

  useEffect(() => load(), [load])

  const rows = useMemo(() => sortArtifacts(filterArtifacts(items ?? [], filter)), [items, filter])

  const open = (a: ArtifactEntry): void => {
    // A pdf skips the peek read entirely — its preview IS the render (Chromium's viewer, full
    // bytes over beacon-artifact://), and the 512 KB text peek has nothing to say about it.
    if (renderKindFor(a.mime, a.name) === 'pdf') {
      preview.open(renderTargetFor(a, 'pdf'))
      return
    }
    setBusy(a.id)
    setRowNote((n) => ({ ...n, [a.id]: '' }))
    void window.beacon?.artifacts
      .read(a.id, a.name, a.mime, a.size)
      .then((p) => {
        setBusy(null)
        if (!p) return
        const notice = previewNotice(p, a.name)
        const rk = renderKindFor(a.mime, a.name)
        // html/svg open RENDERED (with a Source toggle). The read is still what gates it — a
        // failed or refused read falls through to the same refusal surfaces as everything else.
        if (rk && p.kind === 'text') preview.open(renderTargetFor(a, rk, { text: p.text, truncated: p.truncated }))
        else if (p.kind === 'text') preview.open({ kind: 'text', title: notice, body: p.text })
        else if (p.kind === 'image') preview.open({ kind: 'image', dataUrl: p.dataUrl, title: a.name })
        else {
          // Refusals are shown in BOTH places: in the pane where the content was expected, and on
          // the row that was clicked. A pane that simply fails to open reads as a dead button.
          preview.open({ kind: 'text', title: a.name, body: notice })
          setRowNote((n) => ({ ...n, [a.id]: notice }))
        }
      })
      .catch((err) => {
        setBusy(null)
        setRowNote((n) => ({ ...n, [a.id]: `Could not read it: ${err?.message ?? err}` }))
      })
  }

  const download = (a: ArtifactEntry): void => {
    setRowNote((n) => ({ ...n, [a.id]: 'saving…' }))
    void window.beacon?.artifacts
      .download(a.id, a.name)
      .then((r) => setRowNote((n) => ({ ...n, [a.id]: r && r.ok ? 'saved to Downloads ✓' : 'download failed — retry' })))
      .catch(() => setRowNote((n) => ({ ...n, [a.id]: 'download failed — retry' })))
  }

  return (
    <div style={panel}>
      <div style={head}>
                <span style={{ fontSize: 11, color: 'var(--c-text-dim)' }}>
          {items === null ? 'loading…' : `${items.length} from the agent's outbox`}
        </span>
        <input
          style={input}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter artifacts…"
          aria-label="Filter artifacts"
          spellCheck={false}
        />
        <button
          onClick={load}
          title="Refresh"
          aria-label="Refresh artifacts"
          style={{ background: 'transparent', border: 'none', color: 'var(--c-text-dim)', cursor: 'pointer', display: 'inline-flex' }}
        >
          <Icon name="refresh" size={14} />
        </button>
      </div>

      <div style={{ flex: 1, overflowY: 'auto' }}>
        {items === null ? (
          <div style={note}>Loading…</div>
        ) : rows.length === 0 ? (
          <div style={note}>
            {items.length === 0
              ? 'No artifacts yet — files the agent produces land here.'
              : `Nothing matches “${filter.trim()}”.`}
          </div>
        ) : (
          rows.map((a) => {
            const kind = previewKindFor(a.mime, a.name)
            const when = fmtArtifactTime(a.mtime)
            return (
              <div key={a.id} style={{ borderBottom: '1px solid var(--c-line)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 16px' }}>
                  <span style={{ display: 'inline-flex', color: 'var(--c-text-faint)', flexShrink: 0 }} aria-hidden>
                    <Icon name={ROW_ICON} size={14} />
                  </span>
                  <button
                    onClick={() => open(a)}
                    disabled={busy === a.id}
                    title={kind === 'binary' ? `${a.name} — no inline preview for this type` : `Preview ${a.name}`}
                    style={{
                      flex: 1,
                      minWidth: 0,
                      textAlign: 'left',
                      background: 'transparent',
                      border: 'none',
                      color: 'var(--c-text)',
                      cursor: 'pointer',
                      font: 'inherit',
                      fontSize: 13,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap'
                    }}
                  >
                    {a.name}
                  </button>
                  <span
                    title={a.mime || 'unknown type'}
                    style={{
                      fontSize: 11,
                      color: 'var(--c-text-faint)',
                      // NOT flexShrink: 0 — the live docx mime is 71 characters and an
                      // unshrinkable column pushes size, time and Save off the row.
                      minWidth: 0,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      maxWidth: 90,
                      textAlign: 'right'
                    }}
                  >
                    {shortType(a.mime, a.name)}
                  </span>
                  <span style={{ fontSize: 11, color: 'var(--c-text-dim)', fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}>
                    {fmtSize(a.size)}
                  </span>
                  {when ? (
                    <span style={{ fontSize: 11, color: 'var(--c-text-faint)', flexShrink: 0, minWidth: 56, textAlign: 'right' }}>{when}</span>
                  ) : null}
                  <button
                    onClick={() => download(a)}
                    title={`Download ${a.name}`}
                    aria-label={`Download ${a.name}`}
                    style={{
                      background: 'transparent',
                      border: '1px solid var(--c-line)',
                      borderRadius: 6,
                      color: 'var(--c-text-dim)',
                      cursor: 'pointer',
                      fontSize: 11,
                      padding: '2px 8px',
                      flexShrink: 0
                    }}
                  >
                    Save
                  </button>
                </div>
                {rowNote[a.id] ? (
                  <div style={{ padding: '0 16px 8px 40px', fontSize: 11, color: 'var(--c-text-dim)' }} role="status">
                    {rowNote[a.id]}
                  </div>
                ) : null}
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}
