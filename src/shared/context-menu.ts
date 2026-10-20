// The right-click menu's CONTENT: a pure function from Electron's `context-menu` params to a list of
// menu items.
//
// WHY THIS EXISTS AT ALL. There was no `context-menu` handler anywhere in the renderer or main
// (verified: zero hits across src/, the only `popUpContextMenu` being the tray's). Electron supplies
// no default menu on right-click, so the app had: no Copy/Paste/Cut on a selection, no link actions,
// no "Copy message" — and, the compounding part, the composer textarea runs with Chromium's
// default-ON spellchecker (no `spellCheck` attribute), which paints red squiggles whose suggestions
// were unreachable. Beacon marked your typing wrong and offered no way to act on it. A desktop app
// without right-click reads as broken beside any other native client.
//
// WHY PURE. The decision of WHICH items belong, in what order, enabled or not, is a function of the
// params — so it is assertable headless (smoke:context-menu) instead of only observable by
// right-clicking a launched app. The probe then proves the smaller, separate claim: that main really
// builds from this function and really pops the result. Splitting them means a menu that is wrong in
// content and a menu that never appears are caught by different gates, and neither can hide behind
// the other.
//
// The module has no Electron import on purpose: it describes items with a `role` string and Electron
// builds them. That is what makes the smoke able to run without a display.

/** A menu item, expressed without Electron types so this file stays loadable headless. */
export interface ContextMenuItem {
  /** An Electron Menu role, or 'separator'. Roles give free localisation and standard behaviour. */
  role?: string
  label?: string
  type?: 'separator'
  enabled?: boolean
  /** Spelling suggestions carry the word to insert; main turns this into a click handler. */
  replacement?: string
  /** Link actions carry their target: `link` to open it, `copyLink` to put it on the clipboard. */
  link?: string
  copyLink?: string
  visible?: boolean
}

/** The subset of Electron's ContextMenuParams this model reads. Named here so the contract with
 *  Electron is explicit rather than implicit in a `params.whatever` somewhere. */
export interface ContextMenuInput {
  /** The selected text, or '' when nothing is selected. */
  selectionText: string
  /** True in an editable field — the only place Cut/Paste/Select-all/Spelling belong. */
  isEditable: boolean
  /** The href under the cursor, or '' when there is no link. */
  linkURL: string
  /** The word Chromium thinks is misspelled, or '' when it does not. */
  misspelledWord: string
  /** Suggested replacements for that word (Electron's `dictionarySuggestions`), possibly empty even
   *  when it flagged one. */
  dictionarySuggestions: readonly string[]
}
// NOTE: there is deliberately no `isComposer` flag. Electron's context-menu params carry no element
// attributes, so main cannot tell WHICH editable field was right-clicked; a flag it can never set
// would be an unreachable control naming itself as the mechanism. Select All is valid in any editable
// field, so it is simply always enabled here and the distinction is not needed.

/** How many spelling suggestions to offer. More than this and the menu is a dictionary, not a menu. */
export const MAX_SPELLING_SUGGESTIONS = 5

/**
 * Build the menu for a right-click.
 *
 * ORDER IS THE DESIGN, and it is deliberate rather than incidental:
 *   1. spelling suggestions first — when Chromium has flagged a word, that is what the click was FOR;
 *      burying it under Copy makes the person hunt for it
 *   2. the edit actions (cut/copy/paste/select-all) — what right-click means everywhere else
 *   3. link actions — separate context, only when a link is under the cursor
 *
 * An empty array is a valid answer and means "do not pop a menu": right-clicking inert chrome should
 * not produce a menu of disabled items, which is worse than nothing because it looks broken.
 */
export function buildContextMenu(input: ContextMenuInput): ContextMenuItem[] {
  const items: ContextMenuItem[] = []
  const hasSelection = input.selectionText.length > 0

  // ── spelling, first ────────────────────────────────────────────────────────
  if (input.isEditable && input.misspelledWord.length > 0) {
    const suggestions = input.dictionarySuggestions
      .filter((w): w is string => typeof w === 'string' && w.length > 0)
      .slice(0, MAX_SPELLING_SUGGESTIONS)

    if (suggestions.length > 0) {
      for (const word of suggestions) {
        items.push({ label: word, replacement: word })
      }
      items.push({ type: 'separator' })
    } else {
      // Chromium flagged a word but has no suggestion. Say so rather than showing nothing: the
      // alternative is a squiggle the user cannot resolve OR dismiss, which is the defect this fixes.
      items.push({ label: 'No spelling suggestions', enabled: false }, { type: 'separator' })
    }
  }

  // ── the edit actions ───────────────────────────────────────────────────────
  if (input.isEditable) {
    // Cut/Paste/Select-all only mean something in a field. Copy is offered on ANY selection, editable
    // or not, because copying text out of a rendered reply is the most common right-click there is.
    items.push({ role: 'cut', enabled: hasSelection })
    items.push({ role: 'copy', enabled: hasSelection })
    items.push({ role: 'paste' })
    // Always enabled in an editable field: there is always a field to select all of.
    items.push({ role: 'selectAll' })
    items.push({ type: 'separator' })
  } else if (hasSelection) {
    // A selection in non-editable content (a reply, a panel): Copy is the whole menu. No Cut, no
    // Paste, no Select-all — none of them apply, and disabled items are noise.
    items.push({ role: 'copy' })
    items.push({ type: 'separator' })
  }

  // ── link actions ───────────────────────────────────────────────────────────
  if (input.linkURL.length > 0) {
    // Open/copy are offered for any http(s) link. Other schemes are main's problem to gate (it runs
    // them through safeExternalUrl before doing anything), so this model does not second-guess the
    // scheme — but it does not invent actions for one either.
    items.push({ label: 'Open link', link: input.linkURL })
    items.push({ label: 'Copy link address', copyLink: input.linkURL })
  }

  return items
}

/**
 * Whether a menu should be popped at all.
 *
 * Separated from buildContextMenu so main can ask one question rather than inspecting an array's
 * length: an empty menu must NOT be shown, because an empty popup is a small blank rectangle that
 * looks like a rendering bug. This is the difference between "no actions apply here" (do nothing)
 * and "actions apply" (show them).
 */
export function shouldShowMenu(items: readonly ContextMenuItem[]): boolean {
  // A menu of nothing but separators is still nothing.
  return items.some((i) => i.type !== 'separator')
}
