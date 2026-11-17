import type { CSSProperties } from 'react'
import { tierPresentation, type HomeTier } from '@shared/home-approval'
import { Icon } from './Icon'

// A tier is a word and a glyph first and a colour second: Ordinary is a circle, Sensitive a triangle,
// Critical a lock. Take the colour away and the chip still says which. Shared by the Home approval
// card, the "What it can touch" screen and the activity timeline, so the three agree.

const base: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 5,
  height: 18,
  padding: '0 7px',
  borderRadius: 9,
  border: '1px solid var(--c-line)',
  fontSize: 11,
  lineHeight: 1,
  whiteSpace: 'nowrap',
  flexShrink: 0
}

const tone: Record<HomeTier, CSSProperties> = {
  ordinary: { color: 'var(--c-text)', borderColor: 'var(--c-line)' },
  sensitive: { color: 'var(--c-warn-text)', borderColor: 'var(--c-warn)' },
  critical: { color: 'var(--c-err-text)', borderColor: 'var(--c-err)' }
}

export function HomeTierBadge({ tier }: { tier: HomeTier }) {
  const { word, glyph } = tierPresentation(tier)
  return (
    <span style={{ ...base, ...tone[tier] }} data-testid="home-tier" data-tier={tier}>
      {glyph === 'lock' ? (
        <Icon name="lock" size={11} />
      ) : (
        <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
          {glyph === 'circle' ? <circle cx="12" cy="12" r="8" /> : <path d="M12 3 22 21H2z" />}
        </svg>
      )}
      <span>{word}</span>
    </span>
  )
}
