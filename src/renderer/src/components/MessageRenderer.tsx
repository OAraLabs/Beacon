import { memo, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import Markdown, { type Options as MarkdownOptions } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import type { ContentPart } from '@shared/parts'
import { callsFromParts, type TimelineCall } from '@shared/timeline'
import { mediaRenderUrl } from '@shared/artifacts'
import { markdownUrlTransform } from '@shared/markdown-urls'
import { shouldOpenInPane } from '@shared/pane-link'
import { requestPaneLink } from '../link-open'
import { rehypeTrimStructuralWhitespace } from '../markdown-whitespace'
import { usePreview } from '../preview-store'
import { Icon } from './Icon'
import { ToolTimeline } from './ToolTimeline'

/**
 * Message-body renderer. Ported from prometheus-beacon's MessageRenderer/TextBlock, upgraded in
 * Makeover Slice 3:
 *   - text → markdown via react-markdown + remark-gfm (tables/strikethrough/task lists) with
 *     syntax highlighting (rehype-highlight, lazy-loaded as its own chunk — see below);
 *   - fenced code → CodeBlock: language chip + copy button + collapse past 40 lines;
 *   - toolCall / toolResult → COLLAPSIBLE cards: tool name + expandable JSON args;
 *     success/error + expandable output (10K truncate).
 */

const MONO = 'var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)'

// ── Lazy syntax highlighting ───────────────────────────────────────────────────
// rehype-highlight (+ lowlight/highlight.js) loads as a SEPARATE vite chunk after first paint, so
// startup stays lean. Until it lands, code renders unstyled; components re-render once it arrives.
type RehypePlugins = NonNullable<MarkdownOptions['rehypePlugins']>
let rehypeHighlightPlugins: RehypePlugins | null = null
const highlightWaiters = new Set<() => void>()
void import('rehype-highlight').then(
  (m) => {
    // detect:true classifies no-language fences too (adds hljs/language-* classes), which is also
    // what routes them into CodeBlock instead of the inline-code pill.
    rehypeHighlightPlugins = [[m.default, { detect: true }]]
    highlightWaiters.forEach((w) => w())
    highlightWaiters.clear()
  },
  () => undefined // offline/chunk-load failure → code simply stays unhighlighted
)

function useRehypeHighlight(): RehypePlugins | undefined {
  const [, force] = useState(0)
  useEffect(() => {
    if (rehypeHighlightPlugins) return
    const w = (): void => force((n) => n + 1)
    highlightWaiters.add(w)
    return () => {
      highlightWaiters.delete(w)
    }
  }, [])
  return rehypeHighlightPlugins ?? undefined
}

// ── Lazy math (PARITY-PLAN A2) ────────────────────────────────────────────────
// remark-math is tiny and parses $$…$$ into math nodes up front; rehype-katex + KaTeX's CSS
// (fonts and all, BUNDLED — no CDN, per the no-runtime-fetch rule) land later as their own chunk,
// same pattern as highlighting. Until the chunk arrives math shows as its raw $$ source, which is
// honest rather than blank. Single-dollar math is OFF on purpose: chat is full of prices, and
// "$5 and $10" must never typeset as math.
let rehypeKatexPlugins: RehypePlugins | null = null
const katexWaiters = new Set<() => void>()
void Promise.all([import('rehype-katex'), import('katex/dist/katex.min.css')]).then(
  ([m]) => {
    rehypeKatexPlugins = [[m.default, { output: 'html' }]]
    katexWaiters.forEach((w) => w())
    katexWaiters.clear()
  },
  () => undefined // chunk-load failure → math stays as $$ source
)

function useRehypeKatex(): RehypePlugins | undefined {
  const [, force] = useState(0)
  useEffect(() => {
    if (rehypeKatexPlugins) return
    const w = (): void => force((n) => n + 1)
    katexWaiters.add(w)
    return () => {
      katexWaiters.delete(w)
    }
  }, [])
  return rehypeKatexPlugins ?? undefined
}

// ── Lazy mermaid (PARITY-PLAN A2) ─────────────────────────────────────────────
// mermaid is the heaviest chunk in the app, so it loads only when a ```mermaid fence actually
// appears. securityLevel 'strict' sanitizes labels; the diagram is themed from the live Codex
// tokens at render time so all eight plates hold without a hardcoded color here.
let mermaidLoader: Promise<typeof import('mermaid')> | null = null
const loadMermaid = (): Promise<typeof import('mermaid')> => (mermaidLoader ??= import('mermaid'))
let mermaidSeq = 0

function mermaidThemeVars(): Record<string, string> {
  const cs = getComputedStyle(document.documentElement)
  const v = (name: string): string => cs.getPropertyValue(name).trim()
  return {
    background: v('--node'),
    primaryColor: v('--node'),
    primaryTextColor: v('--ink'),
    primaryBorderColor: v('--geo'),
    secondaryColor: v('--paper'),
    tertiaryColor: v('--paper'),
    lineColor: v('--geo'),
    textColor: v('--ink'),
    fontFamily: v('--font-body') || 'serif'
  }
}

/** Flatten react-markdown code children to the raw fence text (highlight spans included). */
function flattenText(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(flattenText).join('')
  if (node && typeof node === 'object' && 'props' in node)
    return flattenText((node as { props: { children?: ReactNode } }).props.children)
  return ''
}

function MermaidDiagram({ code }: { code: string }) {
  const [svg, setSvg] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    // Debounced: while a reply streams, the fence grows character by character and every prefix
    // is an invalid diagram — rendering only after a 250ms quiet beat keeps the error state from
    // strobing and the parser from running per keystroke.
    const t = setTimeout(() => {
      loadMermaid()
        .then(async (m) => {
          const mermaid = m.default
          mermaid.initialize({
            startOnLoad: false,
            securityLevel: 'strict',
            theme: 'base',
            themeVariables: mermaidThemeVars()
          })
          const id = `beacon-mmd-${++mermaidSeq}`
          try {
            const out = await mermaid.render(id, code)
            if (alive) {
              setSvg(out.svg)
              setErr(null)
            }
          } catch (e) {
            // mermaid can leave its temp error element behind on a failed parse — remove it.
            document.getElementById(id)?.remove()
            document.getElementById(`d${id}`)?.remove()
            if (alive) {
              setSvg(null)
              setErr(e instanceof Error ? e.message.split('\n')[0] : String(e))
            }
          }
        })
        .catch(() => {
          if (alive) setErr('diagram renderer failed to load')
        })
    }, 250)
    return () => {
      alive = false
      clearTimeout(t)
    }
  }, [code])

  if (err) {
    return (
      <div>
        <div style={{ padding: '4px 10px', fontSize: 11, color: 'var(--c-err)', borderBottom: '1px solid var(--c-line)' }} role="status">
          diagram error: {err} — showing source
        </div>
        <pre style={codePre}>
          <code style={{ color: 'var(--c-text)' }}>{code}</code>
        </pre>
      </div>
    )
  }
  if (!svg) return <div style={{ padding: 12, fontSize: 12, color: 'var(--c-text-faint)' }}>rendering diagram…</div>
  // securityLevel 'strict' sanitized this; it is mermaid's own output, not model-authored markup.
  return <div style={{ padding: 12, overflowX: 'auto' }} dangerouslySetInnerHTML={{ __html: svg }} />
}

// ── CodeBlock: language chip + copy + collapse (Slice 3) ──────────────────────
const COLLAPSE_LINES = 40
const codeWrap: CSSProperties = {
  margin: '8px 0',
  border: '1px solid var(--c-line)',
  borderRadius: 8,
  overflow: 'hidden',
  background: 'var(--c-void)'
}
const codeHead: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  padding: '3px 6px 3px 10px',
  borderBottom: '1px solid var(--c-line)',
  background: 'var(--c-raise)'
}
const codeLang: CSSProperties = {
  fontFamily: MONO,
  fontSize: 10,
  textTransform: 'uppercase',
  letterSpacing: 'var(--track-caps)',
  color: 'var(--c-text-faint)'
}
const codeCopyBtn: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
  fontSize: 11,
  padding: '2px 7px',
  borderRadius: 4,
  border: 'none',
  background: 'transparent',
  color: 'var(--c-text-dim)',
  cursor: 'pointer',
  font: 'inherit'
}
const codePre: CSSProperties = {
  fontSize: 12,
  fontFamily: MONO,
  lineHeight: 1.5,
  padding: 12,
  margin: 0,
  overflow: 'auto'
}
const codeExpand: CSSProperties = {
  display: 'block',
  width: '100%',
  padding: '5px 10px',
  border: 'none',
  borderTop: '1px solid var(--c-line)',
  background: 'var(--c-raise)',
  color: 'var(--c-arc)',
  fontSize: 11,
  cursor: 'pointer',
  font: 'inherit',
  textAlign: 'center'
}

function CodeBlock({ className, children }: { className?: string; children?: ReactNode }) {
  const preRef = useRef<HTMLPreElement>(null)
  const [copied, setCopied] = useState(false)
  const [lines, setLines] = useState(0)
  const [expanded, setExpanded] = useState(false)
  const lang = (className ?? '').match(/language-([\w+#-]+)/)?.[1] ?? ''
  // ```mermaid fences default to the DIAGRAM view with a source toggle (PARITY-PLAN A2).
  const isMermaid = lang === 'mermaid'
  const [showSource, setShowSource] = useState(false)

  // Count rendered lines from the DOM (robust against highlight spans); re-count as streaming grows.
  useEffect(() => {
    const t = preRef.current?.textContent ?? ''
    setLines(t ? t.split('\n').length : 0)
  }, [children])

  const collapsed = lines > COLLAPSE_LINES && !expanded
  const copy = (): void => {
    const t = preRef.current?.textContent ?? ''
    void navigator.clipboard?.writeText(t).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1200)
    })
  }

  const showDiagram = isMermaid && !showSource
  return (
    <div style={codeWrap}>
      <div style={codeHead}>
        <span style={codeLang}>{lang || 'code'}</span>
        <span style={{ display: 'inline-flex', gap: 2 }}>
          {isMermaid ? (
            <button
              style={codeCopyBtn}
              onClick={() => setShowSource((s) => !s)}
              aria-pressed={showSource}
              title={showSource ? 'Show diagram' : 'Show source'}
            >
              {showSource ? '▶ diagram' : '⌗ source'}
            </button>
          ) : null}
          <button style={codeCopyBtn} onClick={copy} title="Copy code" aria-label="Copy code">
            <Icon name={copied ? 'check' : 'copy'} size={12} />
            {copied ? 'copied' : 'copy'}
          </button>
        </span>
      </div>
      {showDiagram ? (
        <MermaidDiagram code={flattenText(children)} />
      ) : (
        <pre ref={preRef} style={{ ...codePre, ...(collapsed ? { maxHeight: 420, overflowY: 'hidden' } : {}) }}>
          <code className={className} style={{ color: 'var(--c-text)' }}>
            {children}
          </code>
        </pre>
      )}
      {collapsed && !showDiagram ? (
        <button style={codeExpand} onClick={() => setExpanded(true)}>
          Show all {lines} lines
        </button>
      ) : null}
    </div>
  )
}

export function TextBlock({ text }: { text: string }) {
  const highlight = useRehypeHighlight()
  const katex = useRehypeKatex()
  // rehypeTrimStructuralWhitespace runs ALWAYS, highlighting/math only once their chunks land. It
  // is first so the tree it prunes is the plain one — see markdown-whitespace.ts for what
  // pre-wrap was doing to lists.
  const rehypePlugins: RehypePlugins = [rehypeTrimStructuralWhitespace, ...(highlight ?? []), ...(katex ?? [])]
  // `md-body` exists so styles.css can reach INSIDE the markdown: an inline style cannot express
  // a descendant selector, and react-markdown's `components` map is keyed by tag name, so a `p`
  // override there cannot know it is inside an `li`. Paragraph margins therefore live in CSS —
  // an inline `style` on `p` would win over `.md-body li > p` no matter how specific that got.
  return (
    <div className="md-body" style={{ fontSize: 14, lineHeight: 1.55, color: 'var(--c-text)', overflowWrap: 'anywhere' }}>
      <Markdown
        remarkPlugins={[remarkGfm, [remarkMath, { singleDollarTextMath: false }]]}
        rehypePlugins={rehypePlugins}
        // Model-authored markdown: refuse relative and non-web hrefs. react-markdown's default
        // transform blanks unknown SCHEMES but passes a colon-free href through as "relative",
        // which in a packaged build resolves against this window's file:// base — a
        // `[report](/Users/me/Downloads/r.bat)` link becomes a file:// URL the shell window would
        // hand to the OS. See src/shared/markdown-urls.ts for the full contract.
        urlTransform={markdownUrlTransform}
        components={{
          strong: ({ children }) => <strong style={{ color: 'var(--c-text)', fontWeight: 600 }}>{children}</strong>,
          em: ({ children }) => <em style={{ color: 'var(--c-text-dim)' }}>{children}</em>,
          h2: ({ children }) => <h2 style={{ fontSize: 16, fontWeight: 600, margin: '12px 0 4px' }}>{children}</h2>,
          h3: ({ children }) => <h3 style={{ fontSize: 14, fontWeight: 600, margin: '12px 0 4px' }}>{children}</h3>,
          // className passes through: a task list (- [ ] / - [x]) is `ul.contains-task-list > li.task-list-item`, and styles.css takes
          // its bullet off there, so an item shows its checkbox only. Dropping the class drew a bullet AND a checkbox on every item
          // (the Path B film's first reply). A plain list keeps its bullets.
          ul: ({ className, children }) => (
            <ul className={className} style={{ margin: '0 0 8px', paddingLeft: className?.includes('contains-task-list') ? 2 : 18 }}>
              {children}
            </ul>
          ),
          ol: ({ children }) => <ol style={{ margin: '0 0 8px', paddingLeft: 18 }}>{children}</ol>,
          li: ({ className, children }) => (
            <li className={className} style={{ margin: '2px 0' }}>
              {children}
            </li>
          ),
          a: ({ href, children }) => (
            <a
              href={href}
              target="_blank"
              rel="noreferrer"
              style={{ color: 'var(--c-arc)' }}
              // A person's plain click on a LOCAL link (this machine, a private network, a tailnet)
              // opens the browser pane instead of the system browser: an agent that serves a page
              // for you hands you a URL, and retyping it into the pane was the bug. The ONE place a
              // chat message can reach the pane, and only through this click — see
              // src/shared/pane-link.ts for the rule and browser-invariant.ts R9 for what pins it.
              // Declined (public site, modifier held, untrusted click, no pane here) → untouched,
              // so it opens the system browser exactly as before.
              onClick={(e) => {
                if (shouldOpenInPane(e.nativeEvent, href) && requestPaneLink(href as string)) e.preventDefault()
              }}
            >
              {children}
            </a>
          ),
          // CodeBlock renders its own <pre>; the markdown-level <pre> becomes a passthrough.
          pre: ({ children }) => <>{children}</>,
          code: ({ className, children }) => {
            // Block iff highlighted (language-*/hljs class) or visibly multi-line (covers
            // no-language fences before the highlight chunk loads).
            const cls = className ?? ''
            const isBlock =
              cls.includes('language-') || cls.includes('hljs') || (typeof children === 'string' && children.includes('\n'))
            if (isBlock) return <CodeBlock className={className}>{children}</CodeBlock>
            return (
              <code
                style={{
                  fontSize: 12,
                  fontFamily: MONO,
                  padding: '1px 5px',
                  borderRadius: 4,
                  background: 'var(--c-inset)',
                  // --c-arc-hi is --sang-deep: a hover/pressed FILL. As inline-code TEXT on a
                  // near-black plate it measured 2.41:1 (NIGREDO). The -text variant is the one
                  // measured against --node in every plate — see scripts/check-contrast.mjs.
                  color: 'var(--c-arc-text)'
                }}
              >
                {children}
              </code>
            )
          },
          blockquote: ({ children }) => (
            <blockquote
              style={{
                margin: '8px 0',
                padding: '2px 12px',
                borderLeft: '3px solid var(--c-arc)',
                color: 'var(--c-text-dim)',
                background: 'var(--c-arc-soft)',
                borderRadius: '0 6px 6px 0'
              }}
            >
              {children}
            </blockquote>
          ),
          del: ({ children }) => <del style={{ color: 'var(--c-text-faint)' }}>{children}</del>,
          hr: () => <hr style={{ border: 'none', borderTop: '1px solid var(--c-line)', margin: '12px 0' }} />,
          table: ({ children }) => (
            <table
              style={{ fontSize: 12, borderCollapse: 'collapse', margin: '8px 0', width: '100%', border: '1px solid var(--c-line)' }}
            >
              {children}
            </table>
          ),
          th: ({ children }) => (
            <th
              style={{
                padding: '4px 8px',
                textAlign: 'left',
                fontWeight: 600,
                background: 'var(--c-raise)',
                borderBottom: '1px solid var(--c-line)',
                color: 'var(--c-text-dim)'
              }}
            >
              {children}
            </th>
          ),
          td: ({ children }) => <td style={{ padding: '4px 8px', borderBottom: '1px solid var(--c-line)' }}>{children}</td>
        }}
      >
        {text}
      </Markdown>
    </div>
  )
}


/**
 * Thinking disclosure (PARITY-PLAN B2) — the model's reasoning, collapsed by default and styled
 * APART from prose: the reply is what the agent says, this is how it got there, and the two must
 * not read as one voice. A redacted block says the provider withheld it instead of opening onto
 * nothing. Rendered as plain pre-wrap text, deliberately NOT through markdown — reasoning is a
 * transcript, not a document, and headings inside it should not typeset as headings.
 */
function ThinkingBlock({ text, redacted }: { text?: string; redacted?: boolean }) {
  const [open, setOpen] = useState(false)
  const words = (text ?? '').split(/\s+/).filter(Boolean).length
  return (
    <div style={{ margin: '6px 0', borderLeft: '2px solid var(--c-line)', paddingLeft: 10 }}>
      <button
        onClick={() => !redacted && setOpen((o) => !o)}
        aria-expanded={open}
        disabled={!!redacted}
        style={{
          display: 'inline-flex',
          alignItems: 'baseline',
          gap: 6,
          background: 'transparent',
          border: 'none',
          padding: 0,
          font: 'inherit',
          fontSize: 11,
          fontFamily: MONO,
          textTransform: 'uppercase',
          letterSpacing: 'var(--track-caps)',
          color: 'var(--c-text-faint)',
          cursor: redacted ? 'default' : 'pointer'
        }}
        title={redacted ? 'The provider withheld this reasoning' : open ? 'Hide the reasoning' : 'Show the reasoning'}
      >
        {redacted ? '◈ thinking — redacted by the provider' : `${open ? '▾' : '▸'} ◈ thinking · ${words} words`}
      </button>
      {open && !redacted ? (
        <pre
          style={{
            margin: '6px 0 0',
            fontSize: 12,
            fontFamily: 'inherit',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            color: 'var(--c-text-dim)',
            fontStyle: 'italic'
          }}
        >
          {text}
        </pre>
      ) : null}
    </div>
  )
}

/** Inline image (Phase 4 + B3). With `dataUrl` (composer-optimistic, or a stored block that kept
 * its bytes) → a thumbnail, click to open in the preview pane. Without it (a stored REFERENCE,
 * Prometheus 278 — bytes on the daemon, no media endpoint yet) → an honest placeholder carrying
 * the daemon's description, upgraded to a real thumbnail when Phase 3b lands. */
function ImageBlock({ dataUrl, sourcePath, description }: { dataUrl?: string; sourcePath?: string; description?: string }) {
  const { open } = usePreview()
  // Media-endpoint fetch failed (evicted, offline, or a pre-343 daemon) → the placeholder.
  const [refFailed, setRefFailed] = useState(false)
  if (!dataUrl) {
    if (sourcePath && !refFailed) {
      // Prometheus 343: the bytes come back by reference through beacon-artifact://media. A load
      // failure degrades to the description placeholder — the same order rehydrate() documents.
      return (
        <img
          src={mediaRenderUrl(sourcePath)}
          alt={description ?? 'stored image'}
          title={description}
          onError={() => setRefFailed(true)}
          style={{ display: 'block', maxHeight: 200, maxWidth: 320, margin: '4px 0', borderRadius: 8, border: '1px solid var(--c-line)' }}
        />
      )
    }
    if (!sourcePath && !description) return null
    return (
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 3,
          margin: '4px 0',
          padding: '8px 11px',
          borderRadius: 8,
          border: '1px dashed var(--c-line)',
          background: 'var(--c-inset)',
          maxWidth: 420
        }}
        title={sourcePath ? `Stored on the daemon at ${sourcePath}` : undefined}
      >
        <span style={{ fontSize: 12, color: 'var(--c-text-dim)' }}>
          🖼 image — {refFailed ? 'unavailable (evicted or unreachable)' : 'stored on the daemon'}
        </span>
        {description ? <span style={{ fontSize: 11, color: 'var(--c-text-faint)', fontStyle: 'italic' }}>{description}</span> : null}
      </div>
    )
  }
  return (
    <img
      src={dataUrl}
      alt={description ?? 'attachment'}
      title="Open in preview"
      onClick={() => open({ kind: 'image', dataUrl })}
      style={{ display: 'block', maxHeight: 200, maxWidth: 320, margin: '4px 0', borderRadius: 8, border: '1px solid var(--c-line)', cursor: 'pointer' }}
    />
  )
}

/** Optimistic file chip (Phase 4): 📎 name (size). Same non-persistence caveat as ImageBlock. */
function FileBlock({ fileName, fileSize }: { fileName?: string; fileSize?: number }) {
  return (
    <div
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        margin: '4px 0',
        padding: '4px 9px',
        borderRadius: 6,
        background: 'var(--c-raise)',
        border: '1px solid var(--c-line)'
      }}
    >
      <span style={{ fontSize: 12, color: 'var(--c-arc)' }}>📎</span>
      <span style={{ fontSize: 12, fontWeight: 500, color: 'var(--c-text)' }}>{fileName ?? 'file'}</span>
      {fileSize ? <span style={{ fontSize: 11, color: 'var(--c-text-dim)' }}>({Math.max(1, Math.round(fileSize / 1024))} KB)</span> : null}
    </div>
  )
}

/** A render segment: a plain part, or a run of consecutive tool parts merged into ONE timeline
 * strip (Slice 4 — history rows carry no timestamps, so durations are blank and order is kept). */
type BodySegment = { kind: 'part'; part: ContentPart } | { kind: 'timeline'; calls: TimelineCall[] }

function segmentParts(parts: ContentPart[]): BodySegment[] {
  const segs: BodySegment[] = []
  let run: ContentPart[] = []
  const flush = (): void => {
    if (run.length > 0) {
      segs.push({ kind: 'timeline', calls: callsFromParts(run) })
      run = []
    }
  }
  for (const part of parts) {
    if (part.type === 'toolCall' || part.type === 'toolResult') run.push(part)
    else {
      flush()
      segs.push({ kind: 'part', part })
    }
  }
  flush()
  return segs
}

/** Render a message body: string | ContentPart[] → markdown text + tool timeline + attachments.
 *
 * MEMOIZED. ChatShell re-renders on every composer keystroke (draft state lives there); without
 * memo, up to RENDER_WINDOW MessageBodies each re-run the full react-markdown pipeline
 * (remark-gfm parse + rehype tree walk + highlight lookup) per character typed. Props are
 * stable across keystrokes — row objects come from the messages array, which a keystroke does
 * not touch — so memo skips all of them. This is the typing-lag fix. */
export const MessageBody = memo(function MessageBody({ content, streaming }: { content: string | ContentPart[]; streaming?: boolean }) {
  const parts: ContentPart[] = typeof content === 'string' ? [{ type: 'text', text: content }] : content
  return (
    <>
      {segmentParts(parts).map((seg, i) => {
        if (seg.kind === 'timeline') return <ToolTimeline key={i} calls={seg.calls} />
        const part = seg.part
        if (part.type === 'text') return <TextBlock key={i} text={part.text ?? ''} />
        if (part.type === 'thinking') return <ThinkingBlock key={i} text={part.text} redacted={part.redacted} />
        if (part.type === 'image') return <ImageBlock key={i} dataUrl={part.dataUrl} sourcePath={part.sourcePath} description={part.description} />
        if (part.type === 'file') return <FileBlock key={i} fileName={part.fileName} fileSize={part.fileSize} />
        return null
      })}
      {streaming ? <span className="caret" /> : null}
    </>
  )
})
