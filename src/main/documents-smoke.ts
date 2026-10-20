/**
 * Documents Editor smoke (headless / ELECTRON_RUN_AS_NODE). Proves the PURE helpers the Documents
 * panel rides on — no display, no live socket: the /api/documents path builders are allowed daemon
 * paths, breadcrumbs/basename, and the multi-tab reducer (open/dedup, edit→dirty, save→clean, close
 * + next-active focus). These are exactly the invariants the panel's correctness depends on.
 */
import { isAllowedDaemonPath } from '@shared/daemon-api'
import {
  docBaseName,
  docBreadcrumbs,
  docsListPath,
  docsReadPath,
  DOCS_CONTENT_PATH,
  DOCS_EDIT_PATH,
  DOCS_SUGGEST_PATH,
  openDocTab,
  setTabContent,
  markTabSaved,
  closeDocTab,
  nextActiveAfterClose,
  tabDirty,
  anyDirty,
  applyOnce,
  validDocName,
  diffLineKind,
  type DocTab
} from '@shared/documents'

let failures = 0
function assert(cond: boolean, label: string): void {
  console.log(`[smoke] ${cond ? 'PASS' : 'FAIL'}  ${label}`)
  if (!cond) failures++
}

function main(): void {
  // ── 1. every /api/documents path the bridge sends is an allowed daemon path ──
  console.log('[smoke] === 1. daemon path builders ===')
  assert(isAllowedDaemonPath(docsListPath('')), 'list root is an allowed daemon path')
  assert(isAllowedDaemonPath(docsListPath('letters/2026')), 'list subdir is allowed')
  assert(isAllowedDaemonPath(docsReadPath('notes/todo.md')), 'read path is allowed')
  assert(
    isAllowedDaemonPath(DOCS_CONTENT_PATH) && isAllowedDaemonPath(DOCS_EDIT_PATH) && isAllowedDaemonPath(DOCS_SUGGEST_PATH),
    'content/edit/suggest write paths are allowed'
  )
  // A traversal attempt in the browse path is encoded → no literal '..' reaches the guard.
  assert(docsListPath('../etc') === '/api/documents?path=..%2Fetc', 'browse path is URL-encoded (no literal ..)')

  // ── 2. display helpers ──
  console.log('[smoke] === 2. path display helpers ===')
  assert(docBaseName('a/b/c.md') === 'c.md' && docBaseName('top.md') === 'top.md', 'basename = last segment')
  const crumbs = docBreadcrumbs('letters/2026/may.md')
  assert(crumbs[0].name === 'documents' && crumbs[0].path === '', 'breadcrumbs rooted at documents')
  assert(crumbs[crumbs.length - 1].path === 'letters/2026/may.md', 'breadcrumb tail = full path')
  assert(docBreadcrumbs('').length === 1, 'root has a single crumb')

  // ── 3. tab reducer — open, dedup, edit→dirty, save→clean ──
  console.log('[smoke] === 3. multi-tab open / dirty / save ===')
  let r = openDocTab([], 'a.md', 'hello')
  let tabs: DocTab[] = r.tabs
  assert(tabs.length === 1 && r.index === 0 && !tabDirty(tabs[0]), 'open → 1 clean tab')

  r = openDocTab(tabs, 'b.md', 'world')
  tabs = r.tabs
  assert(tabs.length === 2 && r.index === 1, 'open second → appended')

  // edit tab 0 → dirty
  tabs = setTabContent(tabs, 0, 'hello!')
  assert(tabDirty(tabs[0]) && anyDirty(tabs), 'edit → dirty')

  // re-open an edited file must NOT clobber the buffer
  r = openDocTab(tabs, 'a.md', 'hello')
  assert(r.index === 0 && r.tabs[0].content === 'hello!', 're-open returns existing tab, keeps edits')

  // save tab 0 → clean at the new baseline
  tabs = markTabSaved(tabs, 0, 'hello!')
  assert(!tabDirty(tabs[0]) && tabs[0].saved === 'hello!', 'save → clean baseline')

  // ── 4. close + next-active focus ──
  console.log('[smoke] === 4. close + focus ===')
  // tabs: [a,b]; close index 0 while active 1 → active shifts to 0
  assert(nextActiveAfterClose(2, 0, 1) === 0, 'closing before active shifts active down')
  // close index 1 while active 1 → falls to neighbour 0
  assert(nextActiveAfterClose(2, 1, 1) === 0, 'closing active falls to neighbour')
  // close after active → active unchanged
  assert(nextActiveAfterClose(3, 2, 0) === 0, 'closing after active leaves it')
  // close the last remaining tab → -1
  assert(nextActiveAfterClose(1, 0, 0) === -1, 'closing the last tab → none active')
  const closed = closeDocTab(tabs, 0)
  assert(closed.length === 1 && closed[0].path === 'b.md', 'closeDocTab removes the tab')

  // ── 5. Phase C — AI edit helpers (apply-to-buffer / new-name guard / diff coloring) ──
  console.log('[smoke] === 5. AI edit helpers ===')
  // applyOnce mirrors the daemon's unique-match str_replace: first occurrence only, in-place.
  assert(applyOnce('the cat sat', 'cat', 'dog') === 'the dog sat', 'applyOnce replaces the match')
  assert(applyOnce('a a a', 'a', 'X') === 'X a a', 'applyOnce replaces ONLY the first occurrence')
  assert(applyOnce('hello', 'zzz', 'X') === 'hello', 'applyOnce leaves content unchanged when absent')
  // Sequential applies keep the buffer in lock-step with disk (apply-mode invariant).
  let buf = 'one two three'
  buf = applyOnce(buf, 'one', '1')
  buf = applyOnce(buf, 'three', '3')
  assert(buf === '1 two 3', 'sequential applyOnce composes')

  assert(validDocName('notes/today.md') && validDocName('a.txt'), 'valid new-doc names accepted')
  assert(!validDocName('') && !validDocName('  ') && !validDocName('/abs') && !validDocName('../esc') && !validDocName('a\0b'), 'empty/abs/traversal/NUL names rejected')

  assert(diffLineKind('+added') === 'add' && diffLineKind('-removed') === 'del', 'diff +/- lines classified')
  assert(diffLineKind('@@ -1 +1 @@') === 'meta' && diffLineKind('+++ b/x') === 'meta' && diffLineKind('--- a/x') === 'meta', 'diff headers are meta (not add/del)')
  assert(diffLineKind(' context') === 'ctx', 'context line classified')

  console.log(failures === 0 ? '[smoke] ALL PASS' : `[smoke] ${failures} FAILURE(S)`)
  process.exit(failures > 0 ? 1 : 0)
}

main()
