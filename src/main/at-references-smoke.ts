// Headless @-reference smoke (ELECTRON_RUN_AS_NODE electron out/main/at-references-smoke.js).
// Proves the pure composer model for Prometheus PR 382's `references`: the caret-aware token
// predicate, candidate ranking (diff / url / files-from-the-daemon-listing), choosing → chip vs
// descend, the chip ⇄ wire shape, and the slash-with-references refusal — no DOM, no daemon.

import {
  MAX_REFERENCES,
  applyAtChoice,
  atKey,
  atMatches,
  atQuery,
  chipFromToken,
  chipsNote,
  fileQueryParts,
  referencesFromChips,
  slashWithReferences
} from '@shared/at-references'

let failures = 0
function check(name: string, cond: boolean): void {
  if (cond) console.log(`  ✓ ${name}`)
  else {
    console.error(`  ✗ ${name}`)
    failures++
  }
}

console.log('atQuery (caret-aware token predicate):')
check("'@' at start opens with empty query", JSON.stringify(atQuery('@', 1)) === JSON.stringify({ start: 0, end: 1, query: '' }))
check("'look at @src/ap' → query 'src/ap'", atQuery('look at @src/ap', 15)?.query === 'src/ap')
check('token start is the @', atQuery('look at @src/ap', 15)?.start === 8)
check('caret mid-token still sees the whole token', atQuery('see @src/app.py now', 8)?.query === 'src/app.py')
check('email address does not open', atQuery('mail me@example.com', 19) === null)
check('caret outside the token → closed', atQuery('@src/app.py and more', 20) === null)
check('no @ → closed', atQuery('plain text', 5) === null)

console.log('fileQueryParts:')
check("'src/ap' → dir src, prefix ap", JSON.stringify(fileQueryParts('src/ap')) === JSON.stringify({ dir: 'src', prefix: 'ap' }))
check("'ap' → root dir", JSON.stringify(fileQueryParts('ap')) === JSON.stringify({ dir: '', prefix: 'ap' }))
check("'src/' → dir src, empty prefix", JSON.stringify(fileQueryParts('src/')) === JSON.stringify({ dir: 'src', prefix: '' }))

const entries = [
  { name: 'src', type: 'dir' as const },
  { name: 'app.py', type: 'file' as const, size: 31 },
  { name: 'README.md', type: 'file' as const, size: 2048 },
  { name: 'appendix.txt', type: 'file' as const, size: 5 }
]
console.log('atMatches:')
const empty = atMatches('', entries)
check('empty query offers diff first', empty[0].type === 'diff' && empty[0].target === '')
check('then folders before files, alphabetical (case-insensitive: app.py < appendix.txt < README.md)', empty[1].label === 'src/' && empty[1].isDir === true && empty[2].target === 'app.py' && empty[4].target === 'README.md')
const ap = atMatches('ap', entries)
check("'ap' ranks app.py and appendix.txt, no diff row", ap.every((c) => c.type === 'file') && ap.some((c) => c.target === 'app.py') && ap.some((c) => c.target === 'appendix.txt'))
check("'d' still offers diff (prefix of diff) plus files", atMatches('d', entries)[0].type === 'diff')
const sub = atMatches('src/ap', [{ name: 'app.py', type: 'file' as const, size: 31 }])
check("'src/ap' targets are dir-qualified", sub[0].target === 'src/app.py' && sub[0].label === 'src/app.py')
check("'diff:HEAD~1' is one diff candidate with the ref", JSON.stringify(atMatches('diff:HEAD~1', entries).map((c) => [c.type, c.target])) === JSON.stringify([['diff', 'HEAD~1']]))
const url = atMatches('https://example.com/doc', entries)
check('a URL query is exactly one url candidate', url.length === 1 && url[0].type === 'url' && url[0].target === 'https://example.com/doc')
check('ftp is not a url candidate', atMatches('ftp://x', entries).every((c) => c.type !== 'url'))

console.log('applyAtChoice:')
const tok = { start: 8, end: 15 }
const picked = applyAtChoice('look at @src/ap please', tok, { type: 'file', target: 'src/app.py', label: 'src/app.py', desc: '' })
check('picking a file removes the token and yields a chip', picked.draft === 'look at please' && picked.chip?.type === 'file' && picked.chip?.target === 'src/app.py')
check('caret lands where the token was', picked.caret === 8)
const desc = applyAtChoice('look at @sr', { start: 8, end: 11 }, { type: 'file', target: 'src', label: 'src/', desc: '', isDir: true })
check('picking a folder DESCENDS: draft keeps @src/ and no chip', desc.draft === 'look at @src/' && desc.chip === null && desc.caret === 13)
const solo = applyAtChoice('@diff', { start: 0, end: 5 }, { type: 'diff', target: '', label: 'diff', desc: '' })
check('a lone token leaves an empty draft', solo.draft === '' && solo.chip?.type === 'diff')

console.log('chipFromToken (typed-in, no row):')
check('url token → url chip', chipFromToken('https://a.b/c')?.type === 'url')
check('diff:main..HEAD → diff chip with ref', chipFromToken('diff:main..HEAD')?.target === 'main..HEAD')
check('a bare word is not a chip (files must come from the listing)', chipFromToken('notes') === null)

console.log('referencesFromChips / chipsNote:')
const chips = [
  { type: 'file' as const, target: 'src/app.py', label: 'src/app.py' },
  { type: 'diff' as const, target: '', label: 'diff' },
  { type: 'file' as const, target: 'src/app.py', label: 'src/app.py' }
]
check('wire shape is exactly {type, target}, deduplicated, ordered', JSON.stringify(referencesFromChips(chips)) === JSON.stringify([{ type: 'file', target: 'src/app.py' }, { type: 'diff', target: '' }]))
check('note names each chip', chipsNote(chips.slice(0, 2)) === '@src/app.py @diff')
check('no chips → empty note', chipsNote([]) === '')
check('cap mirrors the daemon (16)', MAX_REFERENCES === 16)

console.log('slashWithReferences:')
check('/status with a chip is refused client-side', slashWithReferences('/status', chips.slice(0, 1)))
check('prose with a chip is fine', !slashWithReferences('explain this', chips.slice(0, 1)))
check('/status without chips is fine', !slashWithReferences('/status', []))

console.log('atKey (same reducer as slash):')
check('down wraps', JSON.stringify(atKey('down', 2, 3)) === JSON.stringify({ kind: 'move', highlight: 0 }))
check('tab inserts', atKey('tab', 1, 3).kind === 'insert')
check('escape dismisses', atKey('escape', 0, 3).kind === 'dismiss')
check('empty list → none', atKey('enter', 0, 0).kind === 'none')

console.log(`\nat-references smoke: ${failures === 0 ? 'PASS' : `${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)
