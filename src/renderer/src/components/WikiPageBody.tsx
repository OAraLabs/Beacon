import { useMemo, type CSSProperties } from 'react'
import { splitFrontmatter } from '@shared/wiki'
import { TextBlock } from './MessageRenderer'

// One wiki page's text, as the reader shows it. A leading YAML frontmatter block (the Prometheus
// wiki compiler writes one on every page) is lifted off before markdown sees it — otherwise it
// renders as a rule plus a bold heading of raw YAML above the page's own title — and its fields
// are folded into a quiet properties row instead. See splitFrontmatter in src/shared/wiki.ts.
// Its own component so wiki-frontmatter-smoke can render exactly this markup.

const props: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: '4px 16px',
  margin: '0 0 18px',
  padding: '0 0 10px',
  borderBottom: '1px solid var(--c-line)',
  fontSize: 11,
  lineHeight: 1.5
}
const propKey: CSSProperties = { color: 'var(--c-text-faint)', marginRight: 5 }
const propVal: CSSProperties = { color: 'var(--c-text-dim)', margin: 0 }

export function WikiPageBody({ content }: { content: string }): React.JSX.Element {
  const { frontmatter, body } = useMemo(() => splitFrontmatter(content), [content])
  return (
    <>
      {frontmatter ? (
        <dl className="wiki-props" aria-label="Page properties" style={props}>
          {frontmatter.fields.map(([key, value], i) => (
            <div key={`${i}:${key}`} style={{ display: 'flex' }}>
              <dt style={propKey}>{key.replace(/_/g, ' ')}</dt>
              <dd style={propVal}>{value || '—'}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      <TextBlock text={body} />
    </>
  )
}
