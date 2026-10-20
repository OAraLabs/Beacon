/**
 * Headless smoke for the context-menu CONTENT model (@shared/context-menu).
 *
 * WHAT THIS PINS, AND WHAT IT DOES NOT. The model decides WHICH items appear, in what order, enabled
 * or not — that is pure and asserted here, without a display. What it cannot prove is that main
 * actually POPS a menu built from this model, or that clicking a suggestion replaces the word: those
 * need the real app (scripts/context-menu-probe.mjs emits a context-menu event and reads back the
 * menu Electron built). Splitting them means "the menu is wrong" and "the menu never appears" are
 * caught by different gates.
 *
 *   npm run build && npm run smoke:context-menu
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildContextMenu, MAX_SPELLING_SUGGESTIONS, shouldShowMenu, type ContextMenuInput } from '@shared/context-menu'

let failures = 0
function assert(cond: boolean, what: string, detail = ''): void {
  console.log(`[smoke] ${cond ? 'PASS' : 'FAIL'}  ${what}${detail && !cond ? `\n        ${detail}` : ''}`)
  if (!cond) failures++
}
const roles = (items: ReturnType<typeof buildContextMenu>) => items.map((i) => i.type === 'separator' ? '|' : (i.role ?? i.label ?? '?'))

const editable: ContextMenuInput = { selectionText: '', isEditable: true, linkURL: '', misspelledWord: '', dictionarySuggestions: [] }

console.log('[smoke] === an editable field gets the edit actions ===')
{
  const items = buildContextMenu(editable)
  const r = roles(items)
  assert(r.includes('cut') && r.includes('copy') && r.includes('paste') && r.includes('selectAll'), `an empty editable field offers cut/copy/paste/selectAll (got ${r.join(' ')})`)
  const cut = items.find((i) => i.role === 'cut')
  assert(cut?.enabled === false, 'Cut is DISABLED with no selection — nothing to cut')
  const copy = items.find((i) => i.role === 'copy')
  assert(copy?.enabled === false, 'Copy is DISABLED with no selection')
  const paste = items.find((i) => i.role === 'paste')
  assert(paste?.enabled !== false, 'Paste is enabled with no selection — there may be clipboard content to paste')
}

console.log('\n[smoke] === a selection enables Copy everywhere, Cut only in a field ===')
{
  const inField = buildContextMenu({ ...editable, selectionText: 'hello' })
  assert(inField.find((i) => i.role === 'copy')?.enabled !== false, 'Copy is ENABLED with a selection in a field')
  assert(inField.find((i) => i.role === 'cut')?.enabled !== false, 'Cut is ENABLED with a selection in a field')

  const notField = buildContextMenu({ selectionText: 'a rendered reply', isEditable: false, linkURL: '', misspelledWord: '', dictionarySuggestions: [] })
  const r = roles(notField)
  assert(r.includes('copy') && !r.includes('cut') && !r.includes('paste'), `copying a SELECTION OUT OF A REPLY is the common case: Copy only, no Cut/Paste (got ${r.join(' ')})`)
  assert(notField.find((i) => i.role === 'copy')?.enabled !== false, 'and that Copy is enabled')
}

console.log('\n[smoke] === spelling suggestions come FIRST, and act on the flagged word ===')
{
  const flagged = buildContextMenu({ ...editable, misspelledWord: 'teh', dictionarySuggestions: ['the', 'tea', 'ten'] })
  const r = roles(flagged)
  assert(r.indexOf('the') < r.indexOf('cut'), `suggestions precede the edit actions — the click was FOR the squiggle (got ${r.join(' ')})`)
  assert(flagged[0].replacement === 'the', 'the first suggestion carries its replacement word, not just a label')
  assert(flagged.filter((i) => i.replacement).length === 3, 'all three suggestions carry replacements')

  const capped = buildContextMenu({ ...editable, misspelledWord: 'x', dictionarySuggestions: Array.from({ length: 12 }, (_, i) => `w${i}`) })
  assert(capped.filter((i) => i.replacement).length === MAX_SPELLING_SUGGESTIONS, `suggestions are capped at ${MAX_SPELLING_SUGGESTIONS} — a menu is not a dictionary`)

  const noSugg = buildContextMenu({ ...editable, misspelledWord: 'xyzzy', dictionarySuggestions: [] })
  const ns = roles(noSugg)
  assert(ns.includes('No spelling suggestions'), 'a flagged word with NO suggestion still shows a line — the squiggle is not left unresolvable, which is the defect being fixed')
  assert(noSugg.find((i) => i.label === 'No spelling suggestions')?.enabled === false, 'and that line is disabled — it is information, not an action')
}

console.log('\n[smoke] === links get open + copy, and only when a link is under the cursor ===')
{
  const linked = buildContextMenu({ selectionText: 'see this', isEditable: false, linkURL: 'https://example.com', misspelledWord: '', dictionarySuggestions: [] })
  const r = roles(linked)
  assert(r.includes('Open link') && r.includes('Copy link address'), `a link offers Open + Copy address (got ${r.join(' ')})`)
  assert(linked.find((i) => i.label === 'Open link')?.link === 'https://example.com', 'Open carries the href to main, which gates it through safeExternalUrl')
  assert(linked.find((i) => i.label === 'Copy link address')?.copyLink === 'https://example.com', 'Copy address carries the raw href')

  const noLink = buildContextMenu({ selectionText: 'plain', isEditable: false, linkURL: '', misspelledWord: '', dictionarySuggestions: [] })
  assert(!roles(noLink).includes('Open link'), 'no link under the cursor → no link actions')
}

console.log('\n[smoke] === an empty click pops nothing rather than a blank menu ===')
{
  const nothing = buildContextMenu({ selectionText: '', isEditable: false, linkURL: '', misspelledWord: '', dictionarySuggestions: [] })
  assert(nothing.length === 0, 'inert chrome with no selection builds NO items')
  assert(shouldShowMenu(nothing) === false, 'shouldShowMenu is false for it — main must not pop an empty rectangle that reads as a rendering bug')
  assert(shouldShowMenu(buildContextMenu(editable)) === true, 'and true for a real menu')
  assert(shouldShowMenu([{ type: 'separator' }]) === false, 'a menu of only separators counts as empty — separators are not actions')
}

console.log('\n[smoke] === main wires the model rather than building its own menu ===')
{
  const mainSrc = readFileSync(join(process.cwd(), 'src/main/context-menu.ts'), 'utf8')
  assert(/buildContextMenu\(/.test(mainSrc), 'main calls buildContextMenu — the content has one source, so this smoke covers what ships')
  assert(/shouldShowMenu\(/.test(mainSrc), 'main calls shouldShowMenu before popping — the empty-menu rule is enforced at the call site, not hoped for')
  assert(/menu\.popup\(/.test(mainSrc), 'main actually pops the built menu')
  assert(/replaceMisspelling\(/.test(mainSrc), 'a suggestion click calls replaceMisspelling — the squiggle is actionable, which is the whole point')
  assert(/safeExternalUrl\(/.test(mainSrc), 'opening a link goes through the SAME safeExternalUrl the rest of the shell uses — a javascript: href cannot be opened from here either')
}

console.log(`\n[smoke] outcome: ${failures === 0 ? 'PASS ✓' : `FAIL ✗ (${failures})`}`)
process.exit(failures === 0 ? 0 : 1)
