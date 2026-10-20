/**
 * Headless smoke for the Checkpoints view (Prometheus #381, the Beacon half). Pure model only —
 * ordering, formatting, the restore-plan sentence, the confirm body and the failure taxonomy — plus
 * the nav registration. Fetching and rendering are hands-on against a live daemon; what this pins
 * is the CONTRACT with the daemon's routes.
 *
 * Run: npm run smoke:checkpoints
 */
import {
  bindBody,
  bindConfirmText,
  bindOutcomeText,
  boundWorkspacePath,
  boundaryEffect,
  boundaryEffectLabel,
  clearConfirmText,
  clearOutcomeText,
  workspaceCandidates,
  forkSuggestion,
  currentBoundary,
  NEXT_TURN_CLAUSE,
  checkpointsUnavailableReason,
  createdAtMs,
  emptyStateText,
  fmtCheckpointLabel,
  fmtCheckpointStats,
  fmtCheckpointTime,
  hasBoundWorkspace,
  restoreBody,
  restorePlan,
  restorePlanSentence,
  sortCheckpoints
} from '@shared/checkpoints'
import { daemonErrorSentence } from '@shared/daemon-api'
import { SLASH_COMMANDS } from '@shared/slash-commands'
import { NAV_VIEWS, NAV_TREE, flattenNavTree, groupForView } from '@shared/views'

let failures = 0
function assert(cond: boolean, what: string): void {
  console.log(`[smoke] ${cond ? 'PASS' : 'FAIL'}  ${what}`)
  if (!cond) failures++
}

// ── FIXTURE ─────────────────────────────────────────────────────────────────────────────────
// SHAPE from the daemon's FileCheckpointStore.list() / summary() (src/prometheus/checkpoints/store.py,
// deployed 8c1e7c5): id, session_id, workspace, label, created_at, files, bytes, skipped. Labels are
// the human message of the turn (provenance user), hence prose.
const rows = [
  { id: 'ckpt-b', session_id: 'desktop:1', label: 'Rename the helper and update its callers', created_at: '2026-09-02T03:10:00Z', files: 12, bytes: 49357, skipped: 0 },
  { id: 'ckpt-c', session_id: 'desktop:1', label: '', created_at: 1788322400, files: 12, bytes: 49400, skipped: 1 },
  { id: 'ckpt-a', session_id: 'desktop:1', label: '   add   a   test  ', created_at: '2026-09-02T03:00:00Z', files: 11, bytes: 40000, skipped: 0 }
]

// ── A. ordering — newest first, tolerant of ISO and epoch-seconds ─────────────────────────────
const sorted = sortCheckpoints(rows)
assert(sorted.map((r) => r.id).join(',') === 'ckpt-c,ckpt-b,ckpt-a', `newest first across ISO + epoch (${sorted.map((r) => r.id).join(',')})`)
assert(createdAtMs({ created_at: '2026-09-02T03:00:00Z' }) === Date.UTC(2026, 8, 2, 3, 0, 0), 'ISO Z parses as UTC')
assert(createdAtMs({ created_at: '2026-09-02T03:00:00' }) === Date.UTC(2026, 8, 2, 3, 0, 0), 'naive ISO is read as UTC, not local')
assert(createdAtMs({ created_at: 1788322400 }) === 1788322400_000, 'epoch seconds → ms')
assert(createdAtMs({ created_at: undefined }) === 0, 'missing created_at → 0, never NaN')

// ── B. formatting — what a row says ─────────────────────────────────────────────────────────
assert(fmtCheckpointLabel(rows[2]) === 'add a test', 'label whitespace is collapsed')
assert(fmtCheckpointLabel(rows[1]) === 'checkpoint ckpt-c', 'empty label falls back to the id, not to a blank row')
assert(fmtCheckpointLabel({ id: 'x', label: 'y'.repeat(200) }).length === 72, 'long label is capped with an ellipsis')
assert(fmtCheckpointStats(rows[0]) === '12 files · 48.2 KB', `stats: ${fmtCheckpointStats(rows[0])}`)
assert(fmtCheckpointStats(rows[1]) === '12 files · 48.2 KB · 1 skipped', 'a skipped count is PART of the stats, never hidden')
assert(fmtCheckpointStats({ files: 1, bytes: 10 }) === '1 file · 10 B', 'singular file')
const now = Date.UTC(2026, 8, 2, 4, 0, 0)
assert(fmtCheckpointTime({ created_at: '2026-09-02T03:59:30Z' }, now) === '30s ago', 'seconds')
assert(fmtCheckpointTime({ created_at: '2026-09-02T03:10:00Z' }, now) === '50m ago', 'minutes')
assert(fmtCheckpointTime({ created_at: '2026-09-01T20:00:00Z' }, now) === '8h ago', 'hours')
assert(fmtCheckpointTime({ created_at: undefined }, now) === '—', 'unknown time is a dash, not "56 years ago"')

// ── C. the restore contract — naming the checkpoint twice is the confirmation ────────────────
assert(JSON.stringify(restoreBody('ckpt-b', true)) === JSON.stringify({ dry_run: true }), 'dry run carries no confirm')
assert(JSON.stringify(restoreBody('ckpt-b', false)) === JSON.stringify({ confirm: 'ckpt-b', dry_run: false }), 'real restore confirms with the id itself')

const dry = { checkpoint: 'ckpt-b', dry_run: true, restored: ['src/a.py', 'src/b.py'], deleted: ['tmp.txt'], unchanged: ['README.md'], uncaptured: ['big.bin'], errors: [] }
const p = restorePlan(dry)
assert(p.rewrite === 2 && p.remove === 1 && p.unchanged === 1 && p.uncaptured === 1 && p.errors === 0 && !p.noop, 'plan counts every list')
assert(
  restorePlanSentence(p, true) === 'Restore would rewrite 2 files and would remove 1 created since; 1 file was too large to capture and is left as it is.',
  `dry-run sentence uses the conditional: ${restorePlanSentence(p, true)}`
)
assert(restorePlanSentence(p, false).startsWith('Restore rewrote 2 files and removed 1 created since'), `real sentence uses the past tense: ${restorePlanSentence(p, false)}`)
const noop = restorePlan({ restored: [], deleted: [], unchanged: ['a'], uncaptured: [], errors: [] })
assert(noop.noop, 'nothing to rewrite or remove → noop')
assert(restorePlanSentence(noop, true) === 'Nothing would change — the workspace already matches this checkpoint.', 'noop dry-run says so plainly')
const withErr = restorePlan({ restored: ['a'], deleted: [], unchanged: [], uncaptured: [], errors: [{ path: 'b', error: 'blob missing from the store' }] })
assert(!withErr.noop && withErr.errors === 1 && restorePlanSentence(withErr, false).endsWith('; 1 error.'), 'an error is counted and named in the sentence, not swallowed')
assert(restorePlan(null).noop && restorePlan(undefined).noop, 'no result → noop, never a crash')

// ── D. failure taxonomy — typed, from the HTTP status the connection layer embeds ─────────────
assert(checkpointsUnavailableReason(new Error('HTTP 401: GET /api/sessions/x/checkpoints — unauthorized')) === 'auth', '401 → auth')
assert(checkpointsUnavailableReason(new Error('HTTP 503: GET … — file checkpoints are not enabled on this daemon')) === 'disabled', '503 → disabled (the daemon has checkpoints off)')
assert(checkpointsUnavailableReason(new Error('HTTP 404: GET … — no such session')) === 'no-session', '404 → no-session')
assert(checkpointsUnavailableReason(new Error('fetch failed')) === 'error', 'anything else → error')

// ── E. workspace → empty-state honesty ───────────────────────────────────────────────────────
assert(hasBoundWorkspace({ source: 'session', workspace: '/home/u/repo' }), 'source=session with a path → bound')
assert(!hasBoundWorkspace({ source: 'daemon', workspace: '/home/u/.prometheus/workspace' }), 'source=daemon → NOT bound (daemon-wide default is not a session workspace)')
assert(!hasBoundWorkspace(null) && !hasBoundWorkspace(undefined), 'unknown workspace info → not bound (never claims one)')
assert(boundWorkspacePath({ source: 'session', path: '/x' }) === '/x', 'path key accepted as well as workspace')
assert(emptyStateText(false).includes('/workspace'), 'the no-workspace empty state tells the user how to bind one')
// The old copy named ONLY the chat command — for a command Beacon's own composer did not list.
// This pins that the in-app control is named too, so the copy cannot regress to command-only advice.
assert(emptyStateText(false).includes('Bind'), 'the no-workspace empty state names the in-app control, not only the chat command')
assert(emptyStateText(true).includes('each turn'), 'the bound empty state explains when a checkpoint appears')
assert(emptyStateText(true) !== emptyStateText(false), 'two causes, two sentences')

// ── F. nav registration ──────────────────────────────────────────────────────────────────────
assert(NAV_VIEWS.some((v) => v.id === 'checkpoints' && v.label === 'Checkpoints'), 'Checkpoints is a registered view')
assert(groupForView('checkpoints')?.id === 'grp:workspace', 'Checkpoints lives under Workspace, beside Files')
assert(flattenNavTree(NAV_TREE).filter((id) => id === 'checkpoints').length === 1, 'reachable exactly once')

// ── G. the bind control — the write side of item W ───────────────────────────────────────────
//
// WHAT THIS SECTION IS FOR. Binding REPLACES the gate's roots for a conversation (agent_loop.py:
// `run_workspace_roots = (session_workspace,)`). Two statements the UI is not allowed to get
// wrong — that it replaces the boundary, and that it lands on the NEXT turn — are pinned here as
// containment checks, so deleting either clause from the copy fails the build.

// ── G1. boundaryEffect: the claim "every candidate is a reduction in privilege" is FALSE ──────
const THREE = ['/srv/app', '/srv/data', '/home/u/projects']
assert(boundaryEffect('/srv/app', THREE) === 'narrows', 'binding to one of three roots NARROWS (three become one)')
assert(boundaryEffect('/srv/app/web', THREE) === 'narrows', 'a directory under a root narrows')
assert(boundaryEffect('/srv/app', ['/srv/app']) === 'same', 'the only root, bound as itself, is no change')
// THE FINDING. daemon_cwd is Path.cwd(); it has no relationship to security.workspace_root. A cwd
// outside every root GRANTS write access the gate refuses today. If this ever returns 'narrows',
// the UI is reassuring someone through a privilege increase.
assert(boundaryEffect('/var/tmp', THREE) === 'widens', 'a path outside every root WIDENS — it is not a reduction in privilege')
assert(boundaryEffect('/srv', THREE) === 'widens', 'a PARENT of a root widens (the new set is a superset)')
// The prefix bug this guard exists for: /srv/ap must not swallow /srv/app.
assert(boundaryEffect('/srv/application', ['/srv/app']) === 'widens', '/srv/application is NOT inside /srv/app (string-prefix guard)')
assert(boundaryEffect('/srv/app/', THREE) === 'narrows', 'a trailing slash is the same directory')
assert(boundaryEffect('/srv/app', undefined) === 'unknown' && boundaryEffect('/srv/app', []) === 'unknown', 'no roots reported → unknown, never a guess')
assert(boundaryEffect('~/projects', THREE) === 'unknown', 'a ~ path is unknown here — only the daemon expands it')
assert(boundaryEffect('relative/path', THREE) === 'unknown', 'a non-absolute path is unknown, not widens')
assert(boundaryEffectLabel('widens') === 'widens' && boundaryEffectLabel('same') === 'no change', 'badge words')

// ── G2. candidates: the list the GET already carries, and nothing pre-selected ────────────────
const WS = { source: 'daemon', workspace: null, daemon_workspace_roots: THREE, daemon_cwd: '/var/run/prometheus' }
const cands = workspaceCandidates(WS)
assert(cands.length === 4, 'three roots plus the daemon cwd are all offered')
assert(cands.filter((c) => c.kind === 'root').length === 3 && cands.filter((c) => c.kind === 'cwd').length === 1, 'each candidate says where it came from')
assert(cands[3].effect === 'widens', 'the daemon cwd, outside every root, is labelled widens')
assert(cands.slice(0, 3).every((c) => c.effect === 'narrows'), 'the three roots narrow')
// Pre-selection is a decision made for the operator, so the model must carry no way to express
// one. The previous form of this asserted the ABSENCE of the names `default` and `selected` — two
// keys `WorkspaceCandidate` does not declare, which TypeScript's excess-property check already
// refuses. It could only ever have failed if someone widened the interface AND picked one of those
// two exact words. Assert the KEY SET instead: any added field fails this, whatever it is called.
assert(
  cands.every((c) => Object.keys(c).sort().join(',') === 'effect,kind,path'),
  'a candidate carries exactly path/kind/effect — no field of any name through which a selection could arrive'
)
assert(workspaceCandidates({ daemon_workspace_roots: ['/srv/app'], daemon_cwd: '/srv/app' }).length === 1, 'a cwd that IS a root is offered once, not twice')
assert(workspaceCandidates({ daemon_workspace_roots: ['/srv/app'], daemon_cwd: '/srv/app/' }).length === 1, 'deduped on the normalized path, so a trailing slash is not a second row')
assert(workspaceCandidates(null).length === 0 && workspaceCandidates({}).length === 0, 'no daemon fields → no candidates (the panel falls back to free text)')

// ── G3. the two statements the confirmation may not misstate ─────────────────────────────────
// The next-turn clause is asserted as LITERAL TEXT, not as `t.includes(NEXT_TURN_CLAUSE)`. That
// comparison comes out of the same constant the code emits, so it holds however the constant is
// reworded — including into a sentence that no longer says "next turn" at all. A test that moves
// with the thing it is testing is not a test. The constant is pinned once, here.
const NEXT_TURN_LITERAL =
  'This takes effect on the conversation’s NEXT turn — a turn already in flight keeps the boundary it started with.'
assert(NEXT_TURN_CLAUSE === NEXT_TURN_LITERAL, 'the next-turn clause still says NEXT turn, and says a turn in flight is unaffected')
assert(/NEXT turn/.test(NEXT_TURN_CLAUSE) && /in flight/.test(NEXT_TURN_CLAUSE), 'both halves of the next-turn fact are present')

for (const p of ['/srv/app', '/var/tmp', '~/x']) {
  const t = bindConfirmText(p, THREE)
  assert(t.includes('REPLACES'), `bind confirm for ${p} says the boundary is REPLACED, not added to`)
  assert(t.includes(NEXT_TURN_LITERAL), `bind confirm for ${p} carries the next-turn clause verbatim`)
}
assert(bindConfirmText('/var/tmp', THREE).includes('GRANTS'), 'a widening bind says it GRANTS access the gate refuses today')
assert(!bindConfirmText('/srv/app', THREE).includes('GRANTS'), 'a narrowing bind does not claim to grant anything')
assert(bindConfirmText('~/x', THREE).includes('cannot be told from here'), 'an unknown effect is admitted, not guessed')
// THE LIVE COUNT. The number in the copy must come from the roots that were read, never a literal.
assert(bindConfirmText('/srv/app', THREE).includes('3 configured roots'), 'the confirmation quotes the root count it was given')
assert(bindConfirmText('/srv/app', ['/srv/app']).includes('1 configured root'), 'one root reads "1 configured root", singular')
assert(bindConfirmText('/srv/app', ['/a', '/b']).includes('2 configured roots'), 'two roots read "2" — the number tracks the input')
assert(!bindConfirmText('/srv/app', THREE).includes('five'), 'no literal count survives in the copy')

// ── G4. clearing is a WIDENING, and it stops the undo ────────────────────────────────────────
const clr = clearConfirmText(THREE, '/srv/app/web')
assert(clr.includes('WIDENS'), 'clearing a boundary that sits INSIDE the roots widens it — not the safe half of this control')
assert(clr.includes('3 configured roots'), 'clear confirm quotes the live root count too')
assert(clr.includes('checkpoints') || clr.includes('Checkpoints'), 'clear confirm says checkpoints stop — the undo this panel exists to show')
assert(clr.includes(NEXT_TURN_LITERAL), 'clear confirm carries the next-turn clause verbatim')
assert(clearOutcomeText(THREE).includes('widens') && clearOutcomeText(THREE).includes(NEXT_TURN_LITERAL), 'the clear outcome restates both facts')

// ── G5. bindOutcomeText reads WHATEVER path it is handed ──────────────────────
// NOTE THE LIMIT, because this heading used to overclaim. That the PANEL hands it the daemon's
// resolved `r?.workspace` rather than the typed `chosenPath` is a CALL-SITE property, and this
// smoke never imports the panel — it cannot see it. What is pinned here is that the function
// reports honestly about whichever path it is given. The call site is covered by the CDP render
// probe ("the outcome names the RESOLVED path the daemon returned"), which is not in `verify`.
assert(bindOutcomeText('/var/tmp', THREE).includes('outside'), 'an outcome outside the roots says so, even if the picker predicted otherwise')
assert(bindOutcomeText('/srv/app/web', THREE).includes('narrower'), 'an outcome inside the roots says so')
assert(bindOutcomeText('', THREE).includes('nothing is bound'), 'a PUT that returned no workspace is not reported as a success')
assert(bindOutcomeText('/srv/app', THREE).includes(NEXT_TURN_LITERAL), 'the bind outcome repeats the next-turn clause')

// ── G6. the request/response asymmetry ───────────────────────────────────────────────────────
assert(Object.keys(bindBody('/srv/app')).join() === 'path', 'the PUT body names the field `path` (the response names it `workspace`)')
assert(bindBody('  /srv/app  ').path === '/srv/app', 'the path is trimmed before it goes on the wire')

// ── G7. the daemon's refusals are rendered VERBATIM, and a truncated one is not faked ─────────
const refusals = [
  'workspace must be an absolute path (or start with ~)',
  '/nope is not an existing directory',
  'the filesystem root cannot be a workspace',
  '/home/u/.ssh is under denied path /*/.ssh'
]
for (const r of refusals) {
  const thrown = new Error(`HTTP 400: PUT /api/sessions/x/workspace — ${JSON.stringify({ error: r })}`)
  assert(daemonErrorSentence(thrown) === r, `the daemon's own sentence is recovered verbatim: ${r.slice(0, 40)}…`)
}
// `safeText` slices the body to 200 chars, so a long denied-path sentence can arrive as invalid
// JSON. Half a sentence presented as the daemon's refusal reads COMPLETE and is worse than the raw
// text — so a truncated body must yield null and let the caller fall back.
const long = `{"error":"${'/very/long/path'.repeat(20)} is under denied path /x"}`
assert(long.length > 200, 'the fixture is genuinely longer than the 200-char slice')
assert(daemonErrorSentence(new Error(`HTTP 400: PUT /p — ${long.slice(0, 200)}`)) === null, 'a TRUNCATED body yields null, so the caller shows the raw error instead of half a sentence')
assert(daemonErrorSentence(new Error('HTTP 503: PUT /p — no durable store')) === null, 'a non-JSON body yields null')
assert(daemonErrorSentence(new Error('HTTP 400: PUT /p — {"detail":"x"}')) === null, 'JSON without a string `error` yields null')
assert(daemonErrorSentence(new Error('fetch failed')) === null, 'an error with no body at all yields null')
// UNREACHABLE OVER REST, so no UI copy or assertion may depend on it: the PUT handler treats a
// blank path as a CLEAR before the validator runs, so validate_workspace_path is never called with
// an empty string and "a path is required" cannot be produced by this endpoint.
assert(!bindConfirmText('/srv/app', THREE).includes('a path is required'), 'no copy quotes the validator sentence that REST can never produce')

// ── G6b. a fork is pre-FILLED, never pre-SELECTED ─────────────────────────
// This guarantee lived in a component handler and therefore had NO assertion anywhere in the gate:
// this smoke has no DOM, and the probe's scratch session was never forked. Flipping that handler
// to select the suggestion would have gone unnoticed. As a pure decision it is pinnable.
const sug = forkSuggestion('/parent/ws', '')
assert(sug?.fill === '/parent/ws', 'a forked session is offered its parent’s path')
assert(sug?.select === false, 'and it is NEVER selected — a fork must not arrive with a choice already made')
assert(forkSuggestion('/parent/ws', '/typed/by/hand') === null, 'text the operator already typed outranks the suggestion')
assert(forkSuggestion('/parent/ws', '   ') !== null, 'whitespace is not text they typed')
assert(forkSuggestion(null, '') === null && forkSuggestion('', '') === null, 'an unforked session, or a parent with no workspace, is offered nothing')
// `select` is the literal type `false`, so a mutation to `true` fails the BUILD as well as this.

// ── G7b. the no-roots branches, and subject/verb agreement ─────────────────────────
// These branches run whenever the daemon reports no roots, and nothing exercised them — so they
// could rot into ungrammatical or false copy with every test still green.
assert(bindConfirmText('/srv/app', []).includes('own configuration becomes'), 'the no-roots bind confirm is grammatical and singular')
assert(bindConfirmText('/srv/app', ['/only']).includes('1 configured root becomes'), 'one root takes a singular verb')
assert(bindConfirmText('/srv/app', THREE).includes('3 configured roots become'), 'three roots take a plural verb')
assert(bindConfirmText('/srv/app', ['/a', '/b'], '/bound/dir').includes('/bound/dir (this conversation\u2019s current boundary) becomes'), 'a bound baseline is a singular subject and is named')
assert(bindConfirmText('/srv/app', []).includes('REPLACES'), 'the no-roots branch still states the replacement')
assert(clearConfirmText([]).includes('own configuration'), 'the no-roots clear confirm names the daemon configuration')
assert(clearConfirmText([]).includes('checkpoints'), 'and still says checkpoints stop')

// ── G8b. the empty state must not name a control that is not on screen ────────────────
// When the workspace GET does not answer, the panel renders no Bind button — and two claims have
// to go with it: that nothing is bound (unknown), and that there is a control to fix it (there is
// not). Telling someone to use a button that is not there is the worse half of that pair.
assert(!emptyStateText(false, false).includes('Bind'), 'with no bind control available, the empty state does not name one')
assert(emptyStateText(false, false).includes('unknown'), 'and it says the state is unknown rather than claiming nothing is bound')
assert(!emptyStateText(false, false).includes('no workspace bound'), 'it does not assert the one thing the failed GET cannot support')
assert(emptyStateText(false, true).includes('Bind'), 'when the control IS there, the empty state still points at it')

// ── G9. the roots the daemon ACTUALLY sends — tilde-prefixed by default ────────────────
// SHIPPED_WORKSPACE_ROOT is "~/.prometheus/workspace" and resolve_workspace_root returns the config
// string VERBATIM — it never expands it, and cli/init.py writes that tilde into every fresh config.
// So the common case is a root this client cannot resolve, and a confident label against it is a
// wrong label. Comparing '/Users/w/.prometheus/workspace' to '~/.prometheus/workspace' finds no
// match, which before this guard announced 'widens' for a directory plainly inside the root.
const TILDE = ['~/.prometheus/workspace']
assert(boundaryEffect('/Users/w/.prometheus/workspace', TILDE) === 'unknown', 'a tilde root alone makes the answer unknown, not a confident wrong one')
assert(boundaryEffect('/var/tmp', TILDE) === 'unknown', 'with nothing readable, no candidate is labelled')
assert(bindConfirmText('/var/tmp', TILDE).includes('cannot be told from here'), 'and the confirmation admits it rather than guessing')

// THE ASYMMETRY, on the shape a real box has: some roots readable, some not. The boundary before
// binding is the UNION, so an unreadable root can only make it LARGER. That makes the two
// directions genuinely different, and a global "one unreadable root disables labelling" rule
// turned the signal off for every row on an ordinary five-root daemon.
const MIXED = ['/tmp', '/home/demo/Prometheus', '/home/demo/prometheus-deploy', '~/.prometheus/workspace', '~/projects']
// Sound: inside a root we CAN read ⇒ inside the union, whatever the unreadable ones expand to.
assert(boundaryEffect('/tmp/scratch', MIXED) === 'narrows', 'inside a READABLE root is narrows, even with unreadable roots present')
assert(boundaryEffect('/home/demo/Prometheus', MIXED) === 'narrows', 'a readable root bound as itself, alongside others, still narrows')
// NOT sound: it may be inside the unreadable one. ~/.prometheus/workspace could contain it.
assert(boundaryEffect('/var/run/somewhere', MIXED) === 'unknown', 'outside every READABLE root is NOT widens while an unreadable root exists — it may be inside that one')
assert(boundaryEffect('/home/demo/.prometheus/workspace/x', MIXED) === 'unknown', 'and this is the concrete case: that path IS inside the tilde root, so claiming a grant would be a fabrication')
// This line also records why one mutation in the sweep is EQUIVALENT rather than a hole: matching
// against unreadable roots as well as readable ones changes nothing, because an unreadable root is
// non-absolute by definition and a non-absolute string can never be a prefix-with-separator of an
// absolute path. `readable.some(...)` states intent; it is not what makes the answer correct. If
// `comparable` ever loosens, this assertion is the one that goes red first.
assert(boundaryEffect('/home/demo/.prometheus/workspace/deep', ['~/.prometheus/workspace']) === 'unknown', 'a path that LOOKS inside a tilde root still does not match it — the client cannot expand ~')
// Only with nothing unreadable is a GRANT provable.
assert(boundaryEffect('/var/run/somewhere', ['/tmp', '/home/demo/Prometheus']) === 'widens', 'with every root readable, outside them all IS widens')
// `same` needs every root to be this directory — unprovable while one is unreadable, so narrows.
assert(boundaryEffect('/tmp', ['/tmp', '~/x']) === 'narrows', "`same` is not claimed while a root is unreadable — narrows can only overstate a restriction, never hide a grant")
assert(boundaryEffect('/tmp', ['/tmp']) === 'same', 'with the single root readable and equal, same is provable')
// A BOUND session's baseline is one absolute path, so labelling is fully determined for it.
assert(boundaryEffect('/anywhere/else', currentBoundary('/tmp/bound', MIXED)) === 'widens', 'once a session is bound, its baseline is readable and widens becomes provable again')

// ── G10. `..` resolves, because the daemon resolves it before it becomes the boundary ──────
// This is the error direction that REASSURES: the raw string sits under the root, the resolved path
// does not, so the badge would have read 'narrows' for an escape out of the boundary entirely.
assert(boundaryEffect('/srv/app/../../etc', THREE) === 'widens', "a '..' escape out of every root widens, not narrows")
assert(boundaryEffect('/srv/app/sub/..', THREE) === 'narrows', "a '..' that stays inside the root still narrows")
assert(boundaryEffect('/srv/./app', THREE) === 'narrows', "a '.' segment is collapsed")
assert(boundaryEffect('/srv//app', THREE) === 'narrows', 'a doubled slash is collapsed')

// ── G11. the baseline is the CURRENT boundary, which for a bound session is its directory ───
// Measuring a re-bind against the daemon's roots called a widening a narrowing: /srv/app/web is
// already the whole boundary, so moving to /srv/app grants access to everything else under it.
assert(currentBoundary('/srv/app/web', THREE).join() === '/srv/app/web', 'a bound session\u2019s boundary is its bound directory')
assert(currentBoundary(null, THREE).length === 3, 'an unbound session follows the daemon roots')
assert(currentBoundary('', THREE).length === 3, 'a blank bound path is not a boundary')
assert(boundaryEffect('/srv/app', currentBoundary('/srv/app/web', THREE)) === 'widens', 'RE-binding upward from the bound directory WIDENS')
assert(boundaryEffect('/srv/app', currentBoundary(null, THREE)) === 'narrows', 'the same path from UNBOUND narrows — same target, opposite answer, and the baseline is why')
assert(bindConfirmText('/srv/app', THREE, '/srv/app/web').includes('GRANTS'), 'the confirmation for that re-bind names the grant')
assert(bindConfirmText('/srv/app', THREE, '/srv/app/web').includes('/srv/app/web'), 'and names the boundary being replaced, not the roots')

// ── G12. clearing is not ALWAYS a widening ───────────────────────────────────
// When the bound directory sits OUTSIDE the roots — the case the ▲ badge exists for — clearing
// revokes that access. Saying "widens" there would be exactly backwards.
const clrOutside = clearConfirmText(THREE, '/var/tmp')
assert(clrOutside.includes('REVOKES'), 'clearing a boundary outside the roots REVOKES rather than widens')
assert(!clrOutside.includes('WIDENS'), 'and does not also claim to widen')
assert(clearConfirmText(THREE, '/srv/app/web').includes('WIDENS'), 'clearing a boundary inside the roots still widens')
assert(clearConfirmText(THREE, '/var/tmp').includes('checkpoints') || clearConfirmText(THREE, '/var/tmp').includes('Checkpoints'), 'either way it says checkpoints stop')

// ── G13. 'same' is coverage, not a count ─────────────────────────────────
assert(boundaryEffect('/srv/app', ['/srv/app', '/srv/app/']) === 'same', 'duplicate spellings of ONE root are still that one root')
assert(boundaryEffect('/srv/app', ['/srv/app', '/other']) === 'narrows', 'two genuinely different roots becoming one narrows')

// ── G8. /workspace is in the slash catalog ───────────────────────────────────────────────────
// It is a real daemon command, absent from WEB_NATIVE_ONLY, so the daemon accepts it on web — and
// it was missing from Beacon's catalog entirely while the panel's own empty state told people to
// type it. NOTE: slash-smoke's parity pin compares the two web:false sets in both directions, so a
// command missing OUTRIGHT is invisible to it. An absence no assertion can see. Not fixed here.
const wsCmd = SLASH_COMMANDS.find((c) => c.name === 'workspace')
assert(Boolean(wsCmd), '/workspace is in the slash catalog')
assert(wsCmd?.web === true, '/workspace is web:true — the daemon handles it on this surface')
assert(!wsCmd?.destructive, '/workspace is not destructive: it changes a boundary, it does not wipe state')

console.log(`\n[smoke] checkpoints: ${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)
