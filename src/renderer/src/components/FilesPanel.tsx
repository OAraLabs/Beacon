import { useEffect, useState, type CSSProperties } from 'react'
import { breadcrumbs, joinFilePath, parentFilePath, fmtBytes, asList, isAuthError, type FileEntry, type FileListDTO } from '@shared/daemon-api'
import { NotAuthorized } from './NotAuthorized'
import { usePreview } from '../preview-store'

// Files view (Phase 6 + Hermes) — the sandboxed workspace directory list over GET /api/files. Click a
// folder to navigate in place; click a FILE to open it in the global Hermes preview pane (so the list
// stays put while you read). The desktop is remote from the workspace, so this is its only file access.

const MONO = 'var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)'
const panel: CSSProperties = { flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }
const head: CSSProperties = { padding: '10px 16px', borderBottom: '1px solid var(--c-line)', background: 'var(--c-raise)', flexShrink: 0, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }
const rowBtn = (active: boolean): CSSProperties => ({
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  width: '100%',
  padding: '6px 16px',
  background: active ? 'var(--c-raise)' : 'transparent',
  border: 'none',
  borderLeft: `2px solid ${active ? 'var(--c-arc)' : 'transparent'}`,
  cursor: 'pointer',
  textAlign: 'left',
  font: 'inherit',
  color: 'var(--c-text)'
})
// Entry rows wrap a main (navigate/open) button + a copy-path button, so the copy control isn't nested
// inside another button. The active highlight (border + bg) moves to the wrapper.
const rowWrap = (active: boolean): CSSProperties => ({
  display: 'flex',
  alignItems: 'center',
  borderLeft: `2px solid ${active ? 'var(--c-arc)' : 'transparent'}`,
  background: active ? 'var(--c-raise)' : 'transparent'
})
const rowMain: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  flex: 1,
  minWidth: 0,
  padding: '6px 4px 6px 16px',
  background: 'transparent',
  border: 'none',
  cursor: 'pointer',
  textAlign: 'left',
  font: 'inherit',
  color: 'var(--c-text)'
}
const copyBtn: CSSProperties = {
  fontSize: 12,
  padding: '4px 10px',
  marginRight: 8,
  borderRadius: 4,
  border: 'none',
  background: 'transparent',
  color: 'var(--c-text-faint)',
  cursor: 'pointer',
  flexShrink: 0,
  font: 'inherit'
}

function copyText(s: string): void {
  void navigator.clipboard?.writeText(s).catch(() => undefined)
}

async function listDir(path: string): Promise<FileListDTO> {
  const b = window.beacon
  if (!b) throw new Error('bridge unavailable')
  return (await b.daemon.get(`/api/files?path=${encodeURIComponent(path)}`)) as FileListDTO
}

export function FilesPanel() {
  const { open } = usePreview()
  const [path, setPath] = useState('')
  const [entries, setEntries] = useState<FileEntry[]>([])
  const [listErr, setListErr] = useState(false)
  const [authErr, setAuthErr] = useState(false)
  const [opened, setOpened] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    setListErr(false)
    setAuthErr(false)
    void listDir(path)
      .then((d) => {
        if (alive) setEntries(asList<FileEntry>(d.entries))
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
  }, [path])

  const crumbs = breadcrumbs(path)

  if (authErr)
    return (
      <div style={panel}>
        <div style={head}>
          <span style={{ fontSize: 15, fontWeight: 600, color: 'var(--c-text)', marginRight: 8 }}>Files</span>
        </div>
        <NotAuthorized what="files" />
      </div>
    )

  return (
    <div style={panel}>
      <div style={head}>
        <span style={{ fontSize: 15, fontWeight: 600, color: 'var(--c-text)', marginRight: 8 }}>Files</span>
        {crumbs.map((c, i) => (
          <span key={c.path} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            {i > 0 ? <span style={{ color: 'var(--c-text-faint)' }}>/</span> : null}
            <button
              onClick={() => setPath(c.path)}
              style={{ background: 'transparent', border: 'none', cursor: 'pointer', font: 'inherit', fontSize: 13, color: i === crumbs.length - 1 ? 'var(--c-text)' : 'var(--c-arc)' }}
            >
              {c.name}
            </button>
          </span>
        ))}
      </div>
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {path ? (
          <button style={rowBtn(false)} onClick={() => setPath(parentFilePath(path))}>
            <span style={{ width: 16 }}>↩</span>
            <span style={{ fontFamily: MONO, fontSize: 13 }}>..</span>
          </button>
        ) : null}
        {listErr ? (
          <div style={{ padding: 14, color: 'var(--c-err)', fontSize: 13 }}>Failed to list (daemon /api/files).</div>
        ) : entries.length === 0 ? (
          <div style={{ padding: 14, color: 'var(--c-text-dim)', fontSize: 13 }}>
            {path
              ? 'Empty folder.'
              : 'Nothing here yet — this browses the agent’s workspace on the daemon. Ask it to save a file and it shows up here.'}
          </div>
        ) : (
          entries.map((e) => {
            const rel = joinFilePath(path, e.name)
            return (
              <div key={e.name} style={rowWrap(e.type === 'file' && opened === rel)}>
                <button
                  style={rowMain}
                  onClick={() => {
                    if (e.type === 'dir') setPath(rel)
                    else {
                      setOpened(rel)
                      open({ kind: 'file', path: rel })
                    }
                  }}
                >
                  <span style={{ width: 16 }}>{e.type === 'dir' ? '📁' : '📄'}</span>
                  <span style={{ flex: 1, minWidth: 0, fontFamily: MONO, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.name}</span>
                  {e.type === 'file' ? <span style={{ fontSize: 11, color: 'var(--c-text-faint)', flexShrink: 0 }}>{fmtBytes(e.size)}</span> : null}
                </button>
                <button style={copyBtn} title={`Copy path: ${rel}`} onClick={() => copyText(rel)}>
                  ⧉
                </button>
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}
