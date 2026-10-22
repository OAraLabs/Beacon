import { protocol } from 'electron'
import {
  ARTIFACT_RENDER_CSP,
  ARTIFACT_RENDER_MAX_BYTES,
  ARTIFACT_RENDER_SCHEME,
  ARTIFACT_THUMB_MAX_BYTES,
  imageMimeFromBytes,
  parseArtifactRenderUrl
} from '@shared/artifacts'

// beacon-artifact:// — the surface that renders an agent-built page or SVG in chat.
//
// Why a protocol and not srcdoc/data:/blob:: those are "local scheme" documents and INHERIT the
// embedding renderer's CSP, which (correctly) forbids inline script — so an agent-built page would
// arrive with its own <script> silently dead. A protocol response carries its OWN policy: inline
// style/script allowed, network reach zero. The bytes are fetched IN MAIN by content id — the same
// rule the download path follows: the token never reaches the renderer, and a path from a listing
// is never sent back to the daemon as a path.
//
// Trust story: the page executes inside an <iframe sandbox="allow-scripts"> with NO
// allow-same-origin, so it runs under an opaque origin — it cannot script the pane, reach the
// preload bridge, or read another artifact through this protocol (its CSP has no beacon-artifact:
// source and connect-src is 'none'). What remains is a page that can compute and draw, which is
// the feature.

interface ArtifactSource {
  downloadArtifact(id: string): Promise<Buffer>
  fetchMedia(sourcePath: string): Promise<{ bytes: Buffer; contentType: string }>
}

/** Must run BEFORE app.whenReady() — Chromium refuses privileged-scheme registration after it. */
export function registerArtifactRenderScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: ARTIFACT_RENDER_SCHEME, privileges: { standard: true, secure: true } }
  ])
}

function refuse(status: number, message: string): Response {
  // Refusals are text/plain ON PURPOSE — an error string must never come back as a document the
  // iframe would render (and nosniff pins that even if a message ever looks like markup).
  return new Response(message, {
    status,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'X-Content-Type-Options': 'nosniff' }
  })
}

/** Call from app.whenReady(). The connection getter is late-bound — it comes up after pairing. */
export function registerArtifactRenderProtocol(deps: { getConnection: () => ArtifactSource | null }): void {
  protocol.handle(ARTIFACT_RENDER_SCHEME, async (request) => {
    const parsed = parseArtifactRenderUrl(request.url)
    if (!parsed) return refuse(400, 'malformed artifact render URL')
    const conn = deps.getConnection()
    if (!conn) return refuse(503, 'not connected to the daemon')
    // Stored-media thumbnails (B3): proxy GET /api/media?path= — the daemon path-confines the
    // reference; Beacon additionally PINS the served type to image/* since the only embedder is
    // an <img>, so an evicted-then-replaced file can never arrive as a document.
    if (parsed.kind === 'media') {
      try {
        const { bytes, contentType } = await conn.fetchMedia(parsed.path)
        if (!contentType.startsWith('image/')) return refuse(415, `not an image (${contentType})`)
        return new Response(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength), {
          headers: {
            'Content-Type': contentType,
            'Content-Security-Policy': "default-src 'none'",
            'X-Content-Type-Options': 'nosniff'
          }
        })
      } catch (err) {
        return refuse(502, err instanceof Error ? err.message : String(err))
      }
    }
    // Inline image thumbnails: fetch by content id and serve under a type SNIFFED FROM THE BYTES.
    // The URL carried no mime claim and the manifest's mime is only a filename guess, so the
    // payload decides — imageMimeFromBytes returns null for anything it does not recognise and a
    // null is a 415, not a guess. nosniff then pins that decision, so an artifact renamed to .png
    // but containing markup can never be served as an image. CSP is default-src 'none': an <img>
    // embeds no subresource, so nothing else may load either.
    if (parsed.kind === 'image') {
      try {
        const buf = await conn.downloadArtifact(parsed.id)
        if (buf.byteLength > ARTIFACT_THUMB_MAX_BYTES)
          return refuse(413, `too large to thumbnail (${buf.byteLength} bytes)`)
        const contentType = imageMimeFromBytes(buf)
        if (!contentType) return refuse(415, 'not a recognised raster image')
        return new Response(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength), {
          headers: {
            'Content-Type': contentType,
            'Content-Security-Policy': "default-src 'none'",
            'X-Content-Type-Options': 'nosniff'
          }
        })
      } catch (err) {
        return refuse(502, err instanceof Error ? err.message : String(err))
      }
    }
    try {
      const buf = await conn.downloadArtifact(parsed.id)
      if (buf.byteLength > ARTIFACT_RENDER_MAX_BYTES)
        return refuse(413, `too large to render (${buf.byteLength} bytes)`)
      return new Response(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength), {
        headers: {
          'Content-Type':
            parsed.kind === 'html' ? 'text/html; charset=utf-8' : parsed.kind === 'svg' ? 'image/svg+xml' : 'application/pdf',
          'Content-Security-Policy': ARTIFACT_RENDER_CSP[parsed.kind],
          'X-Content-Type-Options': 'nosniff'
        }
      })
    } catch (err) {
      return refuse(502, err instanceof Error ? err.message : String(err))
    }
  })
}
