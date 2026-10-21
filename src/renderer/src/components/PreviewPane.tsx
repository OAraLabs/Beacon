import { useEffect, useState, type CSSProperties } from 'react'
import { usePreview } from '../preview-store'
import { previewTitle, previewImageSrc, type PreviewTarget } from '@shared/preview'
import { fmtBytes, isAuthError, type FileReadDTO } from '@shared/daemon-api'
import { NotAuthorized } from './NotAuthorized'
import { RunInspector } from './RunInspector'

// Hermes preview pane (Phase 7). Renders the one open PreviewTarget (file / image / text / render /
// summary). On the chat view it is EMBEDDED as the dock's inspector pane (R3: one dock slot on the
// right of the thread, so this is no longer a second dock of its own there); on every other view
// it is still the standalone right-hand pane beside the surface.

const MONO = 'var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)'
const pane: CSSProperties = {
  width: 'min(46%, 560px)',
  minWidth: 320,
  flexShrink: 0,
  borderLeft: '1px solid var(--c-line)',
  background: 'var(--c-base)',
  display: 'flex',
  flexDirection: 'column',
  height: '100vh'
}
const header: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '8px 12px',
  borderBottom: '1px solid var(--c-line)',
  background: 'var(--c-raise)',
  flexShrink: 0
}
const bodyStyle: CSSProperties = { flex: 1, overflow: 'auto', padding: 12 }
const preStyle: CSSProperties = { margin: 0, fontFamily: MONO, fontSize: 12, color: 'var(--c-text)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }
const toolbar: CSSProperties = { display: 'flex', gap: 6, marginBottom: 10 }
const copyBtn = (disabled = false): CSSProperties => ({
  fontSize: 11,
  padding: '3px 9px',
  borderRadius: 6,
  border: '1px solid var(--c-line)',
  background: 'var(--c-raise)',
  color: disabled ? 'var(--c-text-faint)' : 'var(--c-text)',
  cursor: disabled ? 'not-allowed' : 'pointer',
  font: 'inherit'
})

function copyText(s: string): void {
  void navigator.clipboard?.writeText(s).catch(() => undefined)
}

function FilePreview({ path }: { path: string }) {
  const [data, setData] = useState<FileReadDTO | null>(null)
  const [err, setErr] = useState(false)
  const [authErr, setAuthErr] = useState(false)
  useEffect(() => {
    const b = window.beacon
    if (!b) return
    let alive = true
    setData(null)
    setErr(false)
    setAuthErr(false)
    void b.daemon
      .get(`/api/files/read?path=${encodeURIComponent(path)}`)
      .then((r) => {
        if (alive) setData(r as FileReadDTO)
      })
      .catch((e) => {
        if (!alive) return
        // A 401 is an auth failure, not a "bad file" — show the same Open-Settings state every
        // other panel shows, not a generic "Failed to read file." (the documented PreviewPane gap).
        if (isAuthError(e)) setAuthErr(true)
        else setErr(true)
      })
    return () => {
      alive = false
    }
  }, [path])
  // The auth state replaces the whole preview body — no toolbar over a 401.
  if (authErr) return <NotAuthorized what="this file" />
  const canCopyContent = !!data && !data.binary && data.content != null
  return (
    <div>
      <div style={toolbar}>
        <button style={copyBtn()} title={`Copy path: ${path}`} onClick={() => copyText(path)}>
          ⧉ Copy path
        </button>
        <button
          style={copyBtn(!canCopyContent)}
          disabled={!canCopyContent}
          title="Copy file content"
          onClick={() => data?.content != null && copyText(data.content)}
        >
          ⧉ Copy content
        </button>
      </div>
      {err ? (
        <div style={{ color: 'var(--c-err)', fontSize: 13 }}>Failed to read file.</div>
      ) : !data ? (
        <div style={{ color: 'var(--c-text-dim)', fontSize: 13 }}>Loading…</div>
      ) : data.binary ? (
        <div style={{ color: 'var(--c-text-dim)', fontSize: 13 }}>Binary file — no preview ({fmtBytes(data.size)}).</div>
      ) : (
        <pre style={preStyle}>
          {data.content}
          {data.truncated ? '\n\n… (truncated at 256 KB)' : ''}
        </pre>
      )}
    </div>
  )
}

// Rendered artifact — a beacon-artifact:// document in a sandboxed iframe (html)
// or an <img> (svg, script-inert by spec), with a Rendered ⇄ Source toggle. The render is the FULL
// file served by main under its own no-network CSP; `source` is the 512 KB peek, and says so when
// it was cut. The white field is deliberate and theme-independent (like the QR quiet zone): an
// agent-built page assumes paper unless it says otherwise, and NOX behind a bare page is unreadable.
function RenderPreview({ target }: { target: Extract<PreviewTarget, { kind: 'render' }> }) {
  const [view, setView] = useState<'rendered' | 'source'>('rendered')
  useEffect(() => setView('rendered'), [target.url])
  const toggle = (v: 'rendered' | 'source', label: string) => (
    <button
      key={v}
      style={{ ...copyBtn(), ...(view === v ? { borderColor: 'var(--c-arc)', color: 'var(--c-text)' } : {}) }}
      aria-pressed={view === v}
      onClick={() => setView(v)}
    >
      {label}
    </button>
  )
  // A pdf rides Chromium's own viewer: no source toggle (there is no useful text source), and no
  // sandbox attribute — a sandboxed frame disables the plugin viewer and shows nothing. The
  // content-type is pinned by the protocol (kind=pdf → application/pdf + nosniff), so what loads
  // here is data for PDFium, never a document that can script.
  if (target.renderKind === 'pdf') {
    return (
      <iframe
        src={target.url}
        title={target.title}
        style={{ width: '100%', height: '100%', minHeight: 420, border: '1px solid var(--c-line)', borderRadius: 8, background: 'var(--c-render-paper)' }}
      />
    )
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div style={toolbar}>
        {toggle('rendered', '▶ Rendered')}
        {toggle('source', '⌗ Source')}
      </div>
      {view === 'source' ? (
        <pre style={{ ...preStyle, overflow: 'auto', flex: 1, minHeight: 0 }}>
          {target.source}
          {target.sourceTruncated ? '\n\n… (source view shows the first 512 KB — the rendered view is the whole file)' : ''}
        </pre>
      ) : target.renderKind === 'svg' ? (
        <img
          src={target.url}
          alt={target.title}
          style={{ maxWidth: '100%', borderRadius: 8, border: '1px solid var(--c-line)', background: 'var(--c-render-paper)', display: 'block' }}
        />
      ) : (
        <iframe
          // allow-scripts WITHOUT allow-same-origin: the page runs under an opaque origin and its
          // response CSP has no network sources — it can compute and draw, and nothing else.
          sandbox="allow-scripts"
          src={target.url}
          title={target.title}
          style={{
            flex: 1,
            minHeight: 0,
            width: '100%',
            border: '1px solid var(--c-line)',
            borderRadius: 8,
            background: 'var(--c-render-paper)'
          }}
        />
      )}
    </div>
  )
}

function PreviewBody({ target, onOpenSession }: { target: PreviewTarget; onOpenSession?: (id: string) => void }) {
  if (target.kind === 'file') return <FilePreview path={target.path} />
  if (target.kind === 'render') return <RenderPreview target={target} />
  if (target.kind === 'run') return <RunInspector target={target} />
  if (target.kind === 'image') {
    const src = previewImageSrc(target)
    return <img src={src} alt={target.title ?? 'image'} style={{ maxWidth: '100%', borderRadius: 8, border: '1px solid var(--c-line)', display: 'block' }} />
  }
  if (target.kind === 'summary') {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ fontSize: 11, color: 'var(--c-text-dim)', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span>
            {/* The honest claim: a count, not a position. See PreviewTarget's summary kind. */}
            covers {target.anchorCount} compressed message{target.anchorCount === 1 ? '' : 's'}
          </span>
          <span style={{ color: 'var(--c-text-faint)' }}>depth {target.depth}</span>
          {onOpenSession ? (
            <button
              onClick={() => onOpenSession(target.sessionId)}
              style={{ fontSize: 11, padding: '2px 8px', borderRadius: 6, border: '1px solid var(--c-line)', background: 'var(--c-raise)', color: 'var(--c-text)', cursor: 'pointer' }}
            >
              Open session
            </button>
          ) : null}
        </div>
        <pre style={preStyle}>{target.body}</pre>
      </div>
    )
  }
  return <pre style={preStyle}>{target.body}</pre>
}

export function PreviewPane({ onOpenSession, embedded = false }: { onOpenSession?: (id: string) => void; embedded?: boolean } = {}) {
  const { target, close } = usePreview()
  if (!target) {
    if (!embedded) return null
    // The inspector with nothing selected says what selects something, rather than showing a void.
    return (
      <div style={{ ...bodyStyle, color: 'var(--ink4)', fontSize: 13, fontFamily: 'var(--font-body)' }} data-testid="inspector-empty">
        Nothing selected. Click a tool call in the thread to inspect its arguments and result here.
      </div>
    )
  }
  return (
    <aside style={embedded ? { display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, minWidth: 0 } : pane} data-embedded={embedded || undefined}>
      <div style={header}>
        <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--c-text)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {previewTitle(target)}
        </span>
        <button
          onClick={close}
          title={embedded ? 'Clear the inspector' : 'Close preview'}
          aria-label={embedded ? 'Clear the inspector' : 'Close preview'}
          style={{ background: 'transparent', border: 'none', color: 'var(--c-text-dim)', cursor: 'pointer', fontSize: 16, lineHeight: 1, padding: 0 }}
        >
          ✕
        </button>
      </div>
      <div style={bodyStyle}>
        <PreviewBody target={target} onOpenSession={onOpenSession} />
      </div>
    </aside>
  )
}
