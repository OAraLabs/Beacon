// The approval card's `A` / `D` keys.
//
// A one-key APPROVE is a loaded gun: the whole point of the card is that a person reads a command
// before it runs, and a stray keystroke that approves it defeats that. So the predicate is
// deliberately narrow and lives here, where a smoke can hold it still:
//
//   * only the card FOCUS IS ON. Several requests can be pending at once, and "A" with three
//     cards stacked has no obvious referent. The keys used to act on the first card from anywhere
//     in the window that was not a text field: a letter typed at a list, a button or the bare
//     page approved a command nobody had looked at. Now a person first puts focus on a card (a
//     click on it, Tab to one of its buttons, or "Answer on the card"), and the keys answer THAT
//     card: the act that arms them also says which request is meant.
//   * never a held key. A key held down repeats, and each repeat would answer the next card as
//     the one before it left.
//   * never while typing. The composer is a text field; `a` belongs to the sentence.
//   * never with a modifier. ⌘A is select-all, and shadowing it would be its own bug.
//   * `A` never on a request Prometheus marked critical. That one is approved with its button,
//     on its card, and by nothing else. `D` still denies it.
//
// Pure (no DOM) so the rule is testable without a keyboard.

export interface KeyContext {
  key: string
  /** Any of ⌘/⌃/⌥ held — a chord belongs to the platform, not to this card. */
  modified: boolean
  /** Focus is in a text field (input, textarea, contenteditable). */
  typing: boolean
  /** Focus is inside THIS card. */
  onThisCard: boolean
  /** The event is a repeat from a held key. */
  repeat: boolean
  /** This card's request may be approved only with its button (`isCardOnly`). */
  critical: boolean
}

export type ApprovalKeyAction = 'approve' | 'deny' | null

export function approvalKey(ctx: KeyContext): ApprovalKeyAction {
  // `=== true`, so a context built without the newer fields answers nothing, not everything.
  if (ctx.typing || ctx.modified || ctx.onThisCard !== true || ctx.repeat !== false) return null
  const k = (ctx.key ?? '').toLowerCase()
  if (k === 'a') return ctx.critical === false ? 'approve' : null
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
