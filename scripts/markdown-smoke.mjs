// Headless markdown test (node ESM): proves react-markdown turns markdown into HTML — the
// Phase-1 goal ("renders markdown, not raw **/#"). Renders to static markup (no DOM needed) and
// asserts the produced tags. This exercises the same react-markdown pipeline TextBlock uses; the
// exact styled component overrides are display-verified.
//
//   node scripts/markdown-smoke.mjs
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import Markdown from 'react-markdown'

let failures = 0
function check(name, cond) {
  if (cond) console.log(`  ✓ ${name}`)
  else {
    console.error(`  ✗ ${name}`)
    failures++
  }
}

const md = [
  '# Heading',
  '',
  'some **bold** and *em* and `code` and a [link](https://example.test)',
  '',
  '- one',
  '- two',
  '',
  '```',
  'block',
  '```'
].join('\n')

const html = renderToStaticMarkup(createElement(Markdown, null, md))

console.log('react-markdown → HTML:')
check('heading → <h1>', html.includes('<h1>Heading</h1>'))
check('bold → <strong>', html.includes('<strong>bold</strong>'))
check('emphasis → <em>', html.includes('<em>em</em>'))
check('inline code → <code>', html.includes('<code>code</code>'))
check('link → <a href>', html.includes('href="https://example.test"'))
check('list → <li>', html.includes('<li>one</li>'))
check('code block → <pre><code>', html.includes('<pre><code'))
check('NOT raw markdown (no literal **bold**)', !html.includes('**bold**'))
check('NOT raw heading (no literal "# Heading")', !html.includes('# Heading'))

// ── Slice 3: GFM (tables/strikethrough/task lists) + syntax highlighting ──
const { default: remarkGfm } = await import('remark-gfm')
const { default: rehypeHighlight } = await import('rehype-highlight')

const gfmMd = [
  '| a | b |',
  '|---|---|',
  '| 1 | 2 |',
  '',
  '~~gone~~',
  '',
  '- [x] done item',
  '',
  '```js',
  'const x = 42',
  '```'
].join('\n')

const gfmHtml = renderToStaticMarkup(
  createElement(Markdown, { remarkPlugins: [remarkGfm], rehypePlugins: [[rehypeHighlight, { detect: true }]] }, gfmMd)
)

console.log('\nGFM + highlight (Slice 3):')
check('table → <table>/<th>', gfmHtml.includes('<table>') && gfmHtml.includes('<th>a</th>'))
check('strikethrough → <del>', gfmHtml.includes('<del>gone</del>'))
check('task list → checkbox input', gfmHtml.includes('type="checkbox"'))
check('js fence → hljs spans', gfmHtml.includes('hljs') && gfmHtml.includes('<span class="hljs-'))
check('keyword tokenized (const)', /<span class="hljs-keyword">const<\/span>/.test(gfmHtml))

// ── Structural whitespace: the ~70px list gap ────────────────────────────────
//
// The bubble (.msg-body) sets `white-space: pre-wrap`, so the "\n" text nodes mdast-util-to-hast
// inserts BETWEEN block elements are not invisible — they render as blank lines. Measured before
// the fix: `1. a\n\n2. b` produced
//     <ol>\n<li>\n<p>a</p>\n</li>\n<li>\n<p>b</p>\n</li>\n</ol>
// i.e. a break between each marker and its text, and two blank lines between items.
//
// These assertions are on the HTML STRING, which is what makes them possible here at all: the
// defect is in the emitted markup, not in a computed style, so renderToStaticMarkup is enough
// and this does not have to be an eyes-on check. The header above says the styled component
// overrides are display-verified — that still holds for the margins; this is the layer under them.
//
// The plugin is imported from the app, not restated here, so this tests what ships.
const { rehypeTrimStructuralWhitespace } = await import('../src/renderer/src/markdown-whitespace.ts')
const { readFileSync } = await import('node:fs')
const tsxSource = readFileSync('src/renderer/src/components/MessageRenderer.tsx', 'utf8')

const render = (md) =>
  renderToStaticMarkup(
    createElement(Markdown, { remarkPlugins: [remarkGfm], rehypePlugins: [rehypeTrimStructuralWhitespace] }, md)
  )

console.log('\nstructural whitespace (list spacing):')

const looseList = render('1. a\n\n2. b')
check('LOOSE list: no newline anywhere in the markup', !looseList.includes('\n'))
check('LOOSE list: item is <li><p>, marker and text on one line', looseList.includes('<li><p>a</p></li>'))

const tightList = render('1. a\n2. b')
check('TIGHT list: no newline anywhere in the markup', !tightList.includes('\n'))
check('TIGHT list: items unwrapped as before', tightList.includes('<ol><li>a</li><li>b</li></ol>'))

// ── and now the whitespace that MUST survive ────────────────────────────────
// A blunt "delete every whitespace-only text node" passes everything above and breaks all three
// of these. They are the reason the rule is "blank text NEXT TO A BLOCK ELEMENT", not "blank text".
const softBreak = render('**a**\n*b*')
check(
  'SOFT break between inlines survives (pre-wrap renders it — a multi-line message must not reflow)',
  softBreak.includes('<strong>a</strong>\n<em>b</em>')
)
// A HARD break carries a pretty-printer newline too (`<br>` then "\n"), and it is next to an
// INLINE element, so the block rule alone kept it — every hard break rendered as two. Caught in
// the running app, not here, which is why this assertion exists.
check('HARD break renders ONE break, not two', render('a  \nb') === '<p>a<br/>b</p>')
const spacedItem = render('- **a** *b*')
check('SPACE between inlines inside an <li> survives (else the words fuse)', spacedItem.includes('<strong>a</strong> <em>b</em>'))
// A fence is out of REACH of the rule, not merely spared by it: whitespace inside <pre><code>
// has no block element beside it. So this one cannot currently fail — it is kept as a canary for
// a future rule that keys on the PARENT (trimming "text inside a block") rather than on siblings,
// which is the shape that would silently eat someone's code.
check('blank lines INSIDE a code fence survive', /x\n\n\ny/.test(render('```\nx\n\n\ny\n```')))

// Highlighted code is safe for a structural reason too, and this is the assertion that pins it:
// the trim runs FIRST, on the plain tree. Whatever rehype-highlight (or any later code plugin)
// builds inside a fence, the trim has already been and gone and cannot reach it. Reverse the
// order and that guarantee is gone — so the order is asserted, not just intended.
const order = tsxSource.match(/rehypePlugins:\s*RehypePlugins\s*=\s*\[([^\]]*)\]/)
check('the trim is the FIRST rehype plugin (it must see the plain tree)', !!order && order[1].trimStart().startsWith('rehypeTrimStructuralWhitespace'))

// Multi-paragraph list item: the blank line between the paragraphs goes (it was structural), and
// the two <p> stay two <p> — spacing them is the CSS margin's job, not a stray text node's.
const twoPara = render('- one\n\n  two')
check('multi-paragraph item keeps BOTH paragraphs', /<li><p>one<\/p><p>two<\/p><\/li>/.test(twoPara))

// A plain multi-line message — no markdown at all — is the thing pre-wrap is FOR. If this one
// ever goes red, the fix has started eating content instead of layout.
check('plain multi-line text keeps its newlines', render('line one\nline two').includes('line one\nline two'))

// Block siblings at the top level, and a NESTED list — where the newline arrives glued to real
// text (`<li>a\n<ul>`) rather than as a node of its own, so dropping blank nodes cannot reach it.
check('root-level blocks sit flush', render('# H\n\ntext') === '<h1>H</h1><p>text</p>')
check('NESTED list: no blank line before the child list', render('- a\n  - b\n- c') === '<ul><li>a<ul><li>b</li></ul></li><li>c</li></ul>')
check('blockquote: no newline inside or after', !render('> quoted\n\n> more').includes('\n'))

// ── the rule has to be attached to something ────────────────────────────────
// `.md-body li > p` styles nothing unless the wrapper actually carries the class, and it is
// outranked by an inline style on <p> if one ever comes back. Both are asserted, not assumed.
const css = readFileSync('src/renderer/src/styles.css', 'utf8')
check('TextBlock wrapper carries className="md-body"', tsxSource.includes('className="md-body"'))
check('styles.css declares .md-body li > p', /\.md-body li > p\s*\{/.test(css))
check(
  'no inline margin on <p> in the components map (it would outrank the CSS)',
  !/\bp:\s*\(\{\s*children\s*\}\)\s*=>\s*<p style=/.test(tsxSource)
)
check(
  'MessageRenderer PASSES the plugin to react-markdown (importing it is not applying it)',
  /rehypePlugins[^\n]*=[^\n]*\brehypeTrimStructuralWhitespace\b/.test(tsxSource)
)

// ── Math in chat ($$…$$ via remark-math + rehype-katex) ───────────────────
// The exact pipeline TextBlock uses, same options. Single-dollar math is OFF by option — chat is
// full of prices, and "$5 and $10" typeset as math would corrupt ordinary sentences.
{
  const { default: remarkMath } = await import('remark-math')
  const { default: rehypeKatex } = await import('rehype-katex')
  const mathRender = (md) =>
    renderToStaticMarkup(
      createElement(
        Markdown,
        {
          remarkPlugins: [remarkGfm, [remarkMath, { singleDollarTextMath: false }]],
          rehypePlugins: [[rehypeKatex, { output: 'html' }]]
        },
        md
      )
    )
  console.log('\nmath (A2):')
  const math = mathRender('The area is $$\\pi r^2$$ exactly.')
  check('$$…$$ typesets via KaTeX', math.includes('class="katex"'))
  check('the math content survives (r appears in KaTeX output)', math.includes('r'))
  check('NOT raw $$ left behind', !math.includes('$$'))
  const money = mathRender('costs $5 and $10 today')
  check('single-dollar prices are NOT math', money.includes('$5 and $10') && !money.includes('katex'))
  const display = mathRender('$$\nE = mc^2\n$$')
  check('display math block typesets', display.includes('katex-display') || display.includes('class="katex"'))
  check(
    'TextBlock passes the SAME single-dollar option (the smoke must not test a different pipeline)',
    /singleDollarTextMath:\s*false/.test(tsxSource)
  )
  check('TextBlock passes rehype-katex once loaded', /katex \?\? \[\]/.test(tsxSource.replace(/\(|\)/g, '')) || /\.\.\.\(katex \?\? \[\]\)/.test(tsxSource))
}

// ── ```mermaid fences route to the diagram renderer ─────────────────────────
// mermaid itself needs a real browser (getBBox) — the DIAGRAM is display-verified over CDP. What
// is provable here: the fence routes with its language class intact, and the component contract
// exists (mermaid branch + strict security + debounce + error fallback).
{
  console.log('\nmermaid routing (A2):')
  const fenced = renderToStaticMarkup(createElement(Markdown, null, '```mermaid\ngraph TD; A-->B\n```'))
  check('```mermaid fence carries language-mermaid', fenced.includes('language-mermaid'))
  check("CodeBlock routes lang === 'mermaid' to a diagram", /lang === 'mermaid'/.test(tsxSource))
  check('mermaid runs at securityLevel strict (sanitized labels)', /securityLevel:\s*'strict'/.test(tsxSource))
  check('mermaid is lazy-loaded, never static-imported', !/^import .*mermaid/m.test(tsxSource) && /import\('mermaid'\)/.test(tsxSource))
  check('a failed parse falls back to SOURCE, visibly', /diagram error/.test(tsxSource))
  check('KaTeX CSS is bundled (imported), not fetched from a CDN', /import\('katex\/dist\/katex\.min\.css'\)/.test(tsxSource))
}

if (failures > 0) {
  console.error(`\n${failures} markdown check(s) FAILED`)
  process.exit(1)
}
console.log('\nmarkdown rendering: ALL CHECKS PASSED')
