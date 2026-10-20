// Hermes preview-pane model (Phase 7, final UI). A global right-hand pane shows ONE previewable
// thing beside whatever view is active (chat stays primary). Pure + shared so the headless smoke can
// exercise the title logic. The three kinds cover everything that's previewable: a workspace file, an
// inline image, and arbitrary text (a tool call's args / a tool result's output) — plus the
// compressed-history peek that global search opens (a summary is text, but it carries a session to
// return to and a count of what it stands in for, so it is not the plain-text kind).

import type { TimelineCall } from './timeline'

export type PreviewTarget =
  | { kind: 'file'; path: string }
  /**
   * A tool RUN — the dock's third pane (⌘1). Carries the whole batch, not just the clicked call,
   * because the Timeline tab's whole job is to show one call against the others: how long it took
   * relative to the run, and whether it overlapped its neighbours. A single-call target could
   * render Output and Args and would have nothing to draw on the third tab.
   */
  | { kind: 'run'; title: string; calls: TimelineCall[]; selected: string }
  /**
   * An inline image. `dataUrl` is a base64 payload the caller already holds (an attachment, the
   * artifact peek); `url` is a REFERENCE main resolves on demand (a beacon-artifact:// thumbnail).
   * Exactly one is set. They are separate fields rather than one `src` string because what the
   * pane holds matters: a data URL is bytes in the renderer's heap, a reference is not — and a
   * field named dataUrl silently carrying a protocol URL would hide that from a reader.
   */
  | { kind: 'image'; dataUrl?: string; url?: string; title?: string }
  | { kind: 'text'; title: string; body: string }
  | {
      kind: 'render'
      title: string
      /**
       * beacon-artifact:// URL served by main under a no-network CSP (see artifact-protocol.ts).
       * The render is the FULL file — the 512 KB peek cap applies only to the source text below.
       */
      url: string
      renderKind: 'html' | 'svg' | 'pdf'
      /** Source text for the Source toggle (possibly the truncated peek; the render never is).
       * Absent for pdf — a pdf has no useful text source, so the pane shows only the viewer. */
      source?: string
      sourceTruncated?: boolean
    }
  | {
      kind: 'summary'
      title: string
      /** The WHOLE summary text — the peek exists because 75% of the corpus is compacted. */
      body: string
      sessionId: string
      /**
       * How many messages this summary stands in for. The anchors themselves are message UUIDs and
       * Beacon's wire contract is the rowid — nothing maps one to the other — so the count is what
       * can be said honestly, and the jump opens the SESSION, not a position inside it.
       */
      anchorCount: number
      depth: number
    }

/** Header title for the preview pane (a file shows its basename). Pure. */
export function previewTitle(t: PreviewTarget): string {
  if (t.kind === 'file') {
    const i = t.path.lastIndexOf('/')
    return i >= 0 ? t.path.slice(i + 1) : t.path
  }
  if (t.kind === 'image') return t.title ?? 'image'
  return t.title
}

/**
 * The <img src> for an image preview target, or '' when it carries neither variant.
 *
 * `url` wins when both are present, which is the wrong state to be in but a defined one: a
 * reference is cheaper and fresher than a stale base64 copy, so prefer it. '' rather than
 * undefined so a caller can pass it straight to <img> and Chromium renders nothing instead of a
 * broken-image glyph.
 */
export function previewImageSrc(t: PreviewTarget): string {
  if (t.kind !== 'image') return ''
  return t.url || t.dataUrl || ''
}
