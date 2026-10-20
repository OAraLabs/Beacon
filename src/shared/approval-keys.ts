// The approval card's `A` / `D` keys.
//
// A one-key APPROVE is a loaded gun: the whole point of the card is that a person reads a command
// before it runs, and a stray keystroke that approves it defeats that. So the predicate is
// deliberately narrow and lives here, where a smoke can hold it still:
//
//   * only the FIRST card. Several requests can be pending at once, and "A" with three cards
//     stacked has no obvious referent — whichever one it hit would be a coin toss the user did
//     not know they were flipping.
//   * never while typing. The composer is a text field; `a` belongs to the sentence.
//   * never with a modifier. ⌘A is select-all, and shadowing it would be its own bug.
//
// Pure (no DOM) so the rule is testable without a keyboard.

export interface KeyContext {
  key: string
  /** Any of ⌘/⌃/⌥ held — a chord belongs to the platform, not to this card. */
  modified: boolean
  /** Focus is in a text field (input, textarea, contenteditable). */
  typing: boolean
  /** This card is the first of the pending stack. */
  first: boolean
}

export type ApprovalKeyAction = 'approve' | 'deny' | null

export function approvalKey(ctx: KeyContext): ApprovalKeyAction {
  if (!ctx.first || ctx.typing || ctx.modified) return null
  const k = (ctx.key ?? '').toLowerCase()
  if (k === 'a') return 'approve'
  if (k === 'd') return 'deny'
  return null
}

/** True when the event target is somewhere text is being entered. */
export function isTypingTarget(el: { tagName?: string; isContentEditable?: boolean } | null): boolean {
  if (!el) return false
  if (el.isContentEditable) return true
  const tag = (el.tagName ?? '').toUpperCase()
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
}
