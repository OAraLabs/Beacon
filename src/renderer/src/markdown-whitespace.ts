/**
 * markdown-whitespace — drop the STRUCTURAL newlines react-markdown puts between block elements,
 * which the chat bubble's `white-space: pre-wrap` would otherwise render as real blank lines.
 *
 * WHAT WAS SEEN. Numbered and bulleted lists in chat rendered with a ~70px gap between items,
 * and each marker sat on its own line ABOVE its text.
 *
 * WHAT IT ACTUALLY IS — measured, not inferred. mdast-util-to-hast (inside react-markdown)
 * pretty-prints: it inserts a literal "\n" TEXT NODE between block children. For `1. a\n\n2. b`
 * the emitted HTML is, exactly:
 *
 *     <ol>\n<li>\n<p>a</p>\n</li>\n<li>\n<p>b</p>\n</li>\n</ol>
 *
 * Normally invisible, because whitespace collapses. But `.msg-body` carries
 * `white-space: pre-wrap` — from before message text was markdown-rendered at all — so every one
 * of those newlines becomes a line break. The one just inside `<li>` breaks between the marker
 * and the text; the pair around each `</li>` opens two blank lines between items. Three line
 * boxes at 14px x 1.55 is ~65px: that is the gap. The `p` margin (8px) was never the cause, and
 * tightening it alone would have moved ~8px of ~70px.
 *
 * WHY NOT SIMPLY DROP pre-wrap. It is still load-bearing for SOFT breaks. A single newline inside
 * a paragraph — how people type a multi-line message — is a text node too, and markdown alone
 * would collapse it to a space. Turning whitespace handling off wholesale would silently reflow
 * every multi-line message in the thread. So the two kinds of newline are separated instead.
 *
 * THE RULE. A whitespace-only text node is structural iff a BLOCK element sits directly beside
 * it. That is precisely what the pretty-printer emits, and it spares the whitespace nodes that
 * carry meaning, all of which sit between INLINE nodes or alone:
 *   - a soft break — `<p><strong>a</strong>\n<em>b</em></p>` (a visible line break under pre-wrap)
 *   - a plain space — `<li><strong>a</strong> <em>b</em></li>` (drop it and the words fuse)
 *   - a fence's blank lines — inside `<pre><code>`, whitespace never neighbours a block element,
 *     with or without highlighting, so the rule does not reach it.
 *
 * ONE INLINE EXCEPTION, found in the running app (2026-08-25) and not by the headless checks:
 * a HARD break is emitted as `<br>` FOLLOWED BY "\n" — the pretty-printer again, but next to an
 * inline element, so the rule above kept it and every hard break rendered as TWO breaks. Measured
 * in a live thread: 25.1px between the lines around a `<br>`, one full 21.7px line more than the
 * break itself needs. A newline directly after `<br>` is never content — the break already ended
 * the line, and a soft break cannot follow a hard one — so `<br>` counts as a left neighbour.
 *
 * That last one had a `pre`/`code` early return guarding it, and text glued to a block ("a\n"
 * before a nested `<ul>`) had a trimming pass. Both were removed: A/B rendering with and without
 * each, over 19 markdown shapes and 8 fences x 3 plugin orders, produced BYTE-IDENTICAL output
 * every time. hast emits that newline as its own text node, so the rule above already had it,
 * and a fence has no block children to trigger on. A branch no test can turn red is not a
 * safeguard, and this runs on every message — so what protects highlighted code is ORDER, which
 * can be checked: this plugin goes FIRST in `rehypePlugins`, seeing the plain tree, so whatever
 * rehype-highlight builds inside a fence it has already passed. markdown-smoke asserts that.
 */

/** The parts of a hast node this walk touches. Deliberately local — hast/unified are transitive
 *  deps of react-markdown, not direct ones, so nothing here imports from them. */
interface HastNode {
  type: string
  tagName?: string
  value?: string
  children?: HastNode[]
}

/** Block-level tags markdown + GFM can produce. A tag missing here is treated as inline, which
 *  fails SAFE: the whitespace beside it is kept, i.e. the old rendering, never fused words. */
const BLOCK_TAGS = new Set([
  'address', 'article', 'aside', 'blockquote', 'dd', 'details', 'div', 'dl', 'dt', 'fieldset',
  'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr',
  'li', 'main', 'nav', 'ol', 'p', 'pre', 'section', 'summary', 'table', 'tbody', 'td', 'tfoot',
  'th', 'thead', 'tr', 'ul'
])

const isBlock = (node: HastNode | undefined): boolean =>
  !!node && node.type === 'element' && !!node.tagName && BLOCK_TAGS.has(node.tagName)

/** A hard break. Inline, but it ends the line as surely as a block does. */
const isBreak = (node: HastNode | undefined): boolean =>
  !!node && node.type === 'element' && node.tagName === 'br'

/** A text node made only of whitespace — the pretty-printer's "\n", or a lone space. */
const isBlankText = (node: HastNode): boolean =>
  node.type === 'text' && typeof node.value === 'string' && node.value.length > 0 && node.value.trim() === ''

/** Nearest sibling in `step` direction that is not itself blank whitespace. */
function neighbour(kids: HastNode[], from: number, step: -1 | 1): HastNode | undefined {
  for (let i = from + step; i >= 0 && i < kids.length; i += step) {
    if (!isBlankText(kids[i])) return kids[i]
  }
  return undefined
}

function strip(node: HastNode): void {
  const kids = node.children
  if (!kids || kids.length === 0) return
  const kept = kids.filter((kid, i) => {
    if (!isBlankText(kid)) return true
    const prev = neighbour(kids, i, -1)
    return !(isBlock(prev) || isBreak(prev) || isBlock(neighbour(kids, i, 1)))
  })
  node.children = kept
  for (const kid of kept) strip(kid)
}

/** rehype plugin: pass in `rehypePlugins`. Mutates the tree in place, like every rehype plugin. */
export function rehypeTrimStructuralWhitespace() {
  return (tree: HastNode): undefined => {
    strip(tree)
  }
}
