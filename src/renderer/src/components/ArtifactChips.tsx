import { useState } from 'react'
import type { ArtifactEntry } from '@shared/ipc'
import { artifactThumbUrl, fmtSize, isThumbnailableImage, renderKindFor, renderTargetFor, type ArtifactRenderKind } from '@shared/artifacts'
import { Icon } from './Icon'
import { usePreview } from '../preview-store'

/** Download chips (harness sprint — file downloads, Prometheus PR 109): rendered under an
 * assistant message when its text mentions a REGISTERED outbox artifact by name — an exact match
 * against the /api/artifacts manifest, never path parsing. Click fetches by content id in main
 * and saves to ~/Downloads (revealed, never opened); the chip narrates its own state. Feature-
 * detected: an older daemon yields an empty manifest and no chip ever renders.
 *
 * A RASTER IMAGE grows a thumbnail instead of a filename chip: an image's whole point is being
 * looked at, and making someone download a picture before seeing it asks them to take custody of
 * a file just to decide whether they want it. The thumbnail rides beacon-artifact://image/<id> —
 * main fetches by content id and serves under a type sniffed from the bytes, so the token still
 * never reaches the renderer and no path is ever sent back to the daemon. Clicking the thumbnail
 * opens the preview pane; the download control stays on the chip beneath it.
 *
 * A PAGE (html), a vector image (svg) or a pdf grows a View button beside the chip, for the same
 * reason in the other direction: a deliverable meant to be looked at should not have to be saved,
 * found in Finder and opened before anyone can tell whether it is any good. View opens it RENDERED
 * in the dock's inspector pane through the same sandboxed path the Artifacts panel uses (opaque
 * origin, a CSP with no network) — NOT in the browser pane. The browser pane is a human-driven
 * http(s) viewer and browser-invariant-smoke fails any chat-side code that reaches its navigation;
 * agent-written script belongs behind the sandbox, not in a window with a network. */

export function ArtifactChips({ text, artifacts }: { text: string; artifacts: ArtifactEntry[] }) {
  const [state, setState] = useState<Record<string, 'busy' | 'saved' | 'error'>>({})
  const [failedThumbs, setFailedThumbs] = useState<Record<string, true>>({})
  const [viewState, setViewState] = useState<Record<string, 'busy' | 'error'>>({})
  const preview = usePreview()
  if (artifacts.length === 0 || !text) return null
  const seen = new Set<string>()
  const chips = artifacts.filter((a) => {
    if (!text.includes(a.name)) return false
    const k = `${a.id}:${a.name}`
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
  if (chips.length === 0) return null

  const download = (a: ArtifactEntry): void => {
    setState((s) => ({ ...s, [a.id]: 'busy' }))
    void window.beacon?.artifacts
      .download(a.id, a.name)
      .then((r) => setState((s) => ({ ...s, [a.id]: r && r.ok ? 'saved' : 'error' })))
      .catch(() => setState((s) => ({ ...s, [a.id]: 'error' })))
  }

  // Same shape as the Artifacts panel's open(): a pdf IS its render (Chromium's viewer), while a
  // page or svg is gated on the source read succeeding — it is what feeds the Source toggle, and a
  // refused or failed read is shown on the button rather than as a pane that quietly never opens.
  const view = (a: ArtifactEntry, kind: ArtifactRenderKind): void => {
    if (kind === 'pdf') {
      preview.open(renderTargetFor(a, kind))
      return
    }
    setViewState((s) => ({ ...s, [a.id]: 'busy' }))
    void window.beacon?.artifacts
      .read(a.id, a.name, a.mime, a.size)
      .then((p) => {
        if (p && p.kind === 'text') {
          preview.open(renderTargetFor(a, kind, { text: p.text, truncated: p.truncated }))
          setViewState((s) => {
            const next = { ...s }
            delete next[a.id]
            return next
          })
        } else setViewState((s) => ({ ...s, [a.id]: 'error' }))
      })
      .catch(() => setViewState((s) => ({ ...s, [a.id]: 'error' })))
  }

  return (
    <div className="artifact-chips">
      {chips.map((a) => {
        const st = state[a.id]
        // A thumbnail is opt-in by what the file actually is, and it DEGRADES: an oversized image,
        // an unrecognised payload or a failed fetch falls back to the ordinary chip rather than
        // leaving a broken-image glyph where a filename used to be. The size half of the check is
        // the manifest's own claim — refusing before a fetch is cheaper than fetching to refuse.
        const thumb = isThumbnailableImage(a.mime, a.name, a.size) && !failedThumbs[a.id] ? artifactThumbUrl(a.id) : null
        if (thumb) {
          return (
            <div key={`${a.id}:${a.name}`} className="artifact-thumb">
              <img
                className="artifact-thumb-img"
                src={thumb}
                alt={a.name}
                title={`Preview ${a.name} (${fmtSize(a.size)})`}
                onError={() => setFailedThumbs((f) => ({ ...f, [a.id]: true }))}
                onClick={() => preview.open({ kind: 'image', url: thumb, title: a.name })}
              />
              <div className="artifact-thumb-bar">
                <span className="artifact-chip-name">{a.name}</span>
                <button
                  className="artifact-thumb-dl"
                  onClick={() => download(a)}
                  disabled={st === 'busy'}
                  title={st === 'saved' ? 'Saved to Downloads — revealed in your file manager' : `Download ${a.name} (${fmtSize(a.size)})`}
                >
                  <Icon name="document" size={12} />
                  <span className="artifact-chip-meta">
                    {st === 'busy' ? 'saving…' : st === 'saved' ? 'saved ✓' : st === 'error' ? 'failed — retry' : 'download'}
                  </span>
                </button>
              </div>
            </div>
          )
        }
        const chip = (
          <button
            key={`${a.id}:${a.name}`}
            className="artifact-chip"
            onClick={() => download(a)}
            disabled={st === 'busy'}
            title={st === 'saved' ? 'Saved to Downloads — revealed in your file manager' : `Download ${a.name} (${fmtSize(a.size)})`}
          >
            <Icon name="document" size={13} />
            <span className="artifact-chip-name">{a.name}</span>
            <span className="artifact-chip-meta">
              {st === 'busy' ? 'downloading…' : st === 'saved' ? 'saved ✓' : st === 'error' ? 'failed — retry' : fmtSize(a.size)}
            </span>
          </button>
        )
        const kind = renderKindFor(a.mime, a.name)
        if (!kind) return chip
        const vs = viewState[a.id]
        return (
          <span key={`${a.id}:${a.name}`} className="artifact-chip-group">
            {chip}
            <button
              className="artifact-chip artifact-chip-view"
              onClick={() => view(a, kind)}
              disabled={vs === 'busy'}
              title={`View ${a.name} here, rendered — sandboxed, no network access`}
            >
              <Icon name="panel" size={13} />
              <span className="artifact-chip-name">{vs === 'busy' ? 'opening…' : vs === 'error' ? 'could not open — retry' : 'View'}</span>
            </button>
          </span>
        )
      })}
    </div>
  )
}
