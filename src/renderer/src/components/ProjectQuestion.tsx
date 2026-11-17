import { useRef, type CSSProperties } from 'react'
import type { questionWords } from '@shared/chat-projects-view'
import { useDialogFocus } from './useDialogFocus'

// A question the Prometheus asked back about filing a conversation in a project (a folder was already chosen for it). The person
// answers; nothing is decided for them. Escape or Cancel sends nothing.

const backdrop: CSSProperties = { position: 'fixed', inset: 0, zIndex: 72, background: 'var(--c-scrim)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }
const modal: CSSProperties = { width: 'min(420px, 94vw)', background: 'var(--c-raise)', border: '1px solid var(--c-line)', borderRadius: 12, padding: 18, display: 'flex', flexDirection: 'column', gap: 14 }
const btn: CSSProperties = { fontSize: 13, padding: '8px 14px', borderRadius: 6, border: '1px solid var(--c-line)', background: 'var(--c-inset)', color: 'var(--c-text)', cursor: 'pointer', font: 'inherit' }

export function ProjectQuestion({ words, onAnswer }: { words: ReturnType<typeof questionWords>; onAnswer: (choice: number | null) => void }) {
  const sheet = useRef<HTMLDivElement>(null)
  useDialogFocus(sheet, () => onAnswer(null))
  return (
    <div style={backdrop} onClick={() => onAnswer(null)}>
      <div ref={sheet} style={modal} onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="File this conversation" data-testid="project-question">
        <div style={{ fontSize: 13.5, lineHeight: 1.5, color: 'var(--c-text)' }}>{words.text}</div>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
          <button style={btn} onClick={() => onAnswer(null)} data-testid="project-question-cancel">
            Cancel
          </button>
          {words.choices.map((c, i) => (
            <button key={c.label} style={{ ...btn, ...(c.primary ? { borderColor: 'var(--c-accent, var(--c-line))' } : {}) }} onClick={() => onAnswer(i)} data-testid={`project-question-${i}`}>
              {c.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
