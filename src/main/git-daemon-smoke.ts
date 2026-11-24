/**
 * git-daemon-smoke — git state from a Prometheus that advertises git/1 (@shared/git-daemon), headless.
 *
 *   1. the capability is read from `subscribed` and nothing else;
 *   2. every case captured from Prometheus 0.9.22 (scripts/fixtures/git-status-0.9.22.json) reads as
 *      the state, chip and mark Beacon draws for its own reader's answer;
 *   3. an answer that is not what the contract says is refused whole, never shown as "clean";
 *   4. a pull request link is opened only if it is github.com/owner/repo/pull/<its number>;
 *   5. the frame names a conversation and carries no state; the route is built from an id safely;
 *   6. the wiring: gated on the capability, the owner's device, a refusal falls back, frames refresh,
 *      the Activity feed leaves the frame out, the pane says what it cannot show.
 *
 * Run: npm run build && npm run smoke:git-daemon
 */
import { readFileSync } from 'node:fs'
import { GIT_CHANGED_FRAME, GIT_REMOTE_FILES_NOTE, GIT_TOO_BIG, GIT_UNSAFE_REMOTE, advertisesGitStatus, changedFrameSession, gitDaemonPath, parseDaemonGit, parseDaemonPr } from '@shared/git-daemon'
import { inActivityFeed } from '@shared/gateway-events'
import { gitChip, gitMark } from '@shared/git-view'

const MIN_CHECKS = 90
let checks = 0
let failures = 0
function check(cond: boolean, name: string, detail = ''): void {
  checks++
  if (cond) console.log(`  ✓ ${name}`)
  else {
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`)
    failures++
  }
}
process.on('exit', () => {
  console.log('===================== RESULT =====================')
  if (failures === 0 && checks < MIN_CHECKS) {
    console.error(`git-daemon smoke: FAIL ✗ (only ${checks} of at least ${MIN_CHECKS} checks ran)`)
    process.exitCode = 1
  } else if (failures > 0) {
    console.error(`git-daemon smoke: FAIL ✗ (${failures} of ${checks})`)
    process.exitCode = 1
  } else console.log(`git-daemon smoke: PASS ✓ (${checks} checks: capability, 0.9.22 answers, refusals, links, frame, wiring)`)
})

type Body = Record<string, unknown>
const fx = JSON.parse(readFileSync(new URL('../../scripts/fixtures/git-status-0.9.22.json', import.meta.url), 'utf8')) as Record<string, { body: Body; etag: string }>
const body = (name: string): Body => JSON.parse(JSON.stringify(fx[name].body)) as Body

console.log('1. capability')
check(advertisesGitStatus({ server_capabilities: ['voice_input', 'git/1'] }), 'git/1 listed: yes')
check(!advertisesGitStatus({ server_capabilities: ['voice_input', 'approval_critical'] }), 'not listed: no')
check(!advertisesGitStatus({ server_capabilities: 'git/1' }), 'a string is not a list')
check(!advertisesGitStatus({ server_capabilities: ['git/2'] }), 'another version is not this one')
check(!advertisesGitStatus({}) && !advertisesGitStatus(null) && !advertisesGitStatus(undefined) && !advertisesGitStatus(7), 'nothing said: no')

console.log('2. the 0.9.22 answers')
check(Object.keys(fx).filter((k) => !k.startsWith('_')).length === 11, 'eleven captured cases')
const clean = parseDaemonGit(body('clean_main'))
check(clean?.read.kind === 'state' && clean.read.state.branch === 'main' && clean.read.state.changed === 0 && clean.read.top === '/home/demo/work/clean', 'clean main reads clean')
check(clean?.pr.kind === 'none', 'no pull request: none')
check(clean !== null && gitMark(clean.read, clean.pr)?.kind === 'branch' && gitMark(clean.read, clean.pr)?.words.includes('nothing changed') === true, 'and its mark says nothing changed', JSON.stringify(clean && gitMark(clean.read, clean.pr)))
const dirty = parseDaemonGit(body('changed_ahead_behind_no_gh'))
check(dirty?.read.kind === 'state' && dirty.read.state.ahead === 2 && dirty.read.state.behind === 1 && dirty.read.state.staged === 1 && dirty.read.state.unstaged === 1 && dirty.read.state.untracked === 1 && dirty.read.state.changed === 3, 'ahead 2, behind 1, three changed')
check(dirty?.read.kind === 'state' && dirty.read.state.upstream === 'origin/fix/gym-promote-rollback' && dirty.read.state.commit === 'b5f7fe7', 'upstream and commit kept')
check(dirty !== null && gitChip(dirty.read, dirty.pr) !== null, 'it has a chip')
const open = parseDaemonGit(body('changed_ahead_behind_open_pr'))
check(open?.pr.kind === 'pr' && open.pr.pr.number === 71 && open.pr.pr.state === 'open' && open.pr.pr.conflicts === true && open.pr.pr.checks === 'none', 'open pull request 71, conflicting, no checks')
check(open?.pr.kind === 'pr' && open.pr.pr.url === 'https://github.com/OAraLabs/Beacon/pull/71', 'its link')
const draft = parseDaemonGit(body('draft_pr'))
check(draft?.pr.kind === 'pr' && draft.pr.pr.state === 'draft' && draft.pr.pr.number === 46 && draft.pr.pr.checks === 'passing', 'an open draft reads as draft')
const merged = parseDaemonGit(body('merged_pr'))
check(merged?.pr.kind === 'pr' && merged.pr.pr.state === 'merged' && merged.pr.pr.conflicts === false, 'merged is merged, and "unknown" mergeability is not a conflict')
check(merged !== null && gitMark(merged.read, merged.pr) !== null, 'the merged one has a mark')
const detached = parseDaemonGit(body('detached_head'))
check(detached?.read.kind === 'state' && detached.read.state.branch === null && detached.read.state.commit === '1d94c3f', 'detached HEAD: no branch, a commit')
const conflict = parseDaemonGit(body('merge_conflict'))
check(conflict?.read.kind === 'state' && conflict.read.state.operation === 'merge' && conflict.read.state.conflicted === 1, 'a merge stopped on a conflict')
check(conflict !== null && gitMark(conflict.read, conflict.pr)?.kind === 'alert', 'and its mark is the alert one', JSON.stringify(conflict && gitMark(conflict.read, conflict.pr)))
const fresh = parseDaemonGit(body('no_commit_yet'))
check(fresh?.read.kind === 'state' && fresh.read.state.commit === null && fresh.read.state.branch === 'main', 'no commit yet: no commit')
check(parseDaemonGit(body('no_work_folder'))?.read.kind === 'none', 'no work folder: nothing')
check(parseDaemonGit(body('not_a_repository'))?.read.kind === 'none', 'not a repository: nothing')
const borrowed = parseDaemonGit(body('borrowed_store'))
check(borrowed?.read.kind === 'unreadable' && borrowed.read.why.length > 0, 'a borrowed store: unreadable, with words')
check(borrowed !== null && gitMark(borrowed.read, borrowed.pr) === null, 'nothing is drawn for it')
for (const name of Object.keys(fx).filter((k) => !k.startsWith('_'))) {
  const r = parseDaemonGit(body(name))
  check(r !== null, `${name}: accepted`)
  check(!/file|diff|message|remote/i.test(Object.keys(fx[name].body).join(' ')), `${name}: no file names, diff, message or remote in the answer`)
}
const why = (w: string): string | null => {
  const r = parseDaemonGit({ v: 1, kind: 'unreadable', why: w, read_at: 1 })
  return r?.read.kind === 'unreadable' ? r.read.why : null
}
check(why('unsafe_here') === GIT_UNSAFE_REMOTE, 'unsafe_here has its words')
check(why('too_big') === GIT_TOO_BIG, 'too_big has its words')
check(why('too_slow') !== null && why('too_slow') !== why('not_read'), 'too_slow has its own words')
check(why('a made-up reason') === why('not_read'), 'an unknown reason reads as "not read"')
check(why('<script>') === why('not_read'), 'and the daemon\'s own text is never shown')

console.log('3. refused whole')
const bad = (name: string, mut: (b: Body) => void): void => {
  const b = body('changed_ahead_behind_open_pr')
  mut(b)
  check(parseDaemonGit(b) === null, name)
}
const st = (b: Body): Record<string, unknown> => b.state as Record<string, unknown>
check(parseDaemonGit(null) === null && parseDaemonGit('x') === null && parseDaemonGit(7) === null && parseDaemonGit([]) === null && parseDaemonGit({}) === null, 'not an object, or empty')
bad('another version', (b) => (b.v = 2))
bad('no version', (b) => delete b.v)
bad('an unknown kind', (b) => (b.kind = 'dirty'))
bad('no state', (b) => delete b.state)
bad('state not an object', (b) => (b.state = 'clean'))
bad('no top', (b) => delete b.top)
bad('an empty top', (b) => (b.top = ''))
bad('a top that is not text', (b) => (b.top = 4))
bad('a huge top', (b) => (b.top = 'x'.repeat(5000)))
bad('truncated missing', (b) => delete b.truncated)
bad('truncated not boolean', (b) => (b.truncated = 'no'))
bad('a negative count', (b) => (st(b).staged = -1))
bad('a fractional count', (b) => (st(b).unstaged = 1.5))
bad('a count as text', (b) => (st(b).untracked = '2'))
bad('an absurd count', (b) => (st(b).changed = 1e12))
bad('NaN-like count', (b) => (st(b).conflicted = null))
bad('ahead as text', (b) => (st(b).ahead = 'two'))
bad('behind negative', (b) => (st(b).behind = -3))
bad('branch not text', (b) => (st(b).branch = 5))
bad('a huge branch', (b) => (st(b).branch = 'b'.repeat(2000)))
bad('commit not text', (b) => (st(b).commit = {}))
bad('upstream not text', (b) => (st(b).upstream = []))
bad('changed fewer than staged', (b) => (st(b).changed = 0))
bad('an unknown operation', (b) => (st(b).operation = 'format'))
bad('operation missing', (b) => delete st(b).operation)
check(parseDaemonGit({ v: 1, kind: 'unreadable', why: 'not_read' })?.read.kind === 'unreadable', 'unreadable needs no state')
check(parseDaemonGit({ v: 1, kind: 'none' })?.read.kind === 'none', 'none needs no state')
check(parseDaemonGit({ v: 1, kind: 'state', top: '/x', truncated: false })?.read.kind !== 'state', 'a state with no state is not a state')
const trunc = body('clean_main')
trunc.truncated = true
check(parseDaemonGit(trunc)?.read.kind === 'state' && (parseDaemonGit(trunc)?.read as { truncated?: boolean }).truncated === true, 'truncated is carried')
const hostile = body('clean_main')
hostile.extra = '<img src=x onerror=alert(1)>'
check(parseDaemonGit(hostile) !== null && !JSON.stringify(parseDaemonGit(hostile)).includes('onerror'), 'unknown extra fields are dropped, not carried')

console.log('4. pull request links')
const pr = (over: Body = {}): unknown => ({ number: 5, state: 'open', draft: false, mergeable: 'mergeable', checks: 'passing', url: 'https://github.com/acme/site/pull/5', ...over })
check(parseDaemonPr(pr()) !== null, 'github.com/owner/repo/pull/N is fine')
check(parseDaemonPr(pr({ url: 'http://github.com/acme/site/pull/5' })) === null, 'not https')
check(parseDaemonPr(pr({ url: 'https://evil.example/acme/site/pull/5' })) === null, 'not github.com')
check(parseDaemonPr(pr({ url: 'https://github.com.evil.example/acme/site/pull/5' })) === null, 'github.com as a prefix of another host')
check(parseDaemonPr(pr({ url: 'https://evil.example/https://github.com/acme/site/pull/5' })) === null, 'a link inside a link')
check(parseDaemonPr(pr({ url: 'https://github.com/acme/site/pull/6' })) === null, 'a link to another number')
check(parseDaemonPr(pr({ url: 'https://github.com/acme/site/pull/5?x=1' })) === null, 'a query')
check(parseDaemonPr(pr({ url: 'https://github.com/acme/site/pull/5#x' })) === null, 'a fragment')
check(parseDaemonPr(pr({ url: 'https://user@github.com/acme/site/pull/5' })) === null, 'credentials in the link')
check(parseDaemonPr(pr({ url: 'https://github.com/acme/site/issues/5' })) === null, 'an issue is not a pull request')
check(parseDaemonPr(pr({ url: 'javascript:alert(1)' })) === null, 'a script')
check(parseDaemonPr(pr({ url: 'https://github.com/acme/site/pull/5/../../x' })) === null, 'a path that climbs')
check(parseDaemonPr(pr({ url: 'https://github.com/a/../pull/5' })) === null && parseDaemonPr(pr({ url: 'https://github.com/../x/pull/5' })) === null && parseDaemonPr(pr({ url: 'https://github.com/./././pull/5' })) === null, 'owner or repo made only of dots')
check(parseDaemonPr(pr({ url: 'https://github.com/a.b/c-d_e.f/pull/5' })) !== null, 'but dots inside names are fine')
check(parseDaemonPr(pr({ url: 5 })) === null, 'a link that is not text')
check(parseDaemonPr(pr({ number: 0 })) === null && parseDaemonPr(pr({ number: -1 })) === null && parseDaemonPr(pr({ number: 1.5 })) === null && parseDaemonPr(pr({ number: '5' })) === null, 'a number that is not a pull request number')
check(parseDaemonPr(pr({ state: 'weird' })) === null, 'an unknown state')
check(parseDaemonPr(pr({ checks: 'maybe' })) === null, 'unknown checks')
check(parseDaemonPr(pr({ state: 'merged', draft: true }))?.state === 'merged', 'draft only means something while open')
check(parseDaemonPr(pr({ mergeable: 'conflicting' }))?.conflicts === true && parseDaemonPr(pr({ mergeable: 'unknown' }))?.conflicts === false, 'only "conflicting" is a conflict')
check(parseDaemonPr(null) === null && parseDaemonPr('x') === null && parseDaemonPr([]) === null, 'not an object')
const badPr = body('changed_ahead_behind_open_pr')
;(badPr.pr as Body).url = 'https://evil.example/x'
const withBadPr = parseDaemonGit(badPr)
check(withBadPr?.read.kind === 'state' && withBadPr.pr.kind === 'none', 'a bad link drops the pull request, not the state')

console.log('5. frame and route')
check(changedFrameSession({ type: GIT_CHANGED_FRAME, payload: { session_id: 'beacon:abc', read_at: 1 } }) === 'beacon:abc', 'the frame names its conversation')
check(changedFrameSession({ type: 'workspace_changed', payload: { session_id: 'x' } }) === null, 'another frame: no')
check(changedFrameSession({ type: GIT_CHANGED_FRAME, payload: {} }) === null && changedFrameSession({ type: GIT_CHANGED_FRAME }) === null && changedFrameSession(null) === null, 'no conversation: no')
check(changedFrameSession({ type: GIT_CHANGED_FRAME, payload: { session_id: 7 } }) === null, 'an id that is not text')
check(changedFrameSession({ type: GIT_CHANGED_FRAME, payload: { session_id: 'x'.repeat(300) } }) === null, 'a huge id')
check(gitDaemonPath('beacon:abc') === '/api/sessions/beacon%3Aabc/git', 'the route for a conversation')
check(gitDaemonPath('a/b') === '/api/sessions/a%2Fb/git', 'a slash is part of the id, not the path')
check(gitDaemonPath('..') === null && gitDaemonPath('a..b') === null, 'no climbing')
check(gitDaemonPath('') === null && gitDaemonPath(7) === null && gitDaemonPath(null) === null, 'no id: no route')
check(gitDaemonPath('?x=1') === '/api/sessions/%3Fx%3D1/git', 'a query character is encoded')

console.log('6. wiring')
const src = (rel: string): string => readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8')
const store = src('src/renderer/src/git-store.ts')
const conn = src('src/main/connection/index.ts')
const panel = src('src/renderer/src/components/GitPanel.tsx')
const ipc = src('src/shared/ipc.ts')
check(/advertisesGitStatus\(ev\.payload\)/.test(conn), 'the connection reads the capability from each subscribed reply')
check((conn.match(/gitStatus: this\.gitStatus/g) ?? []).length >= 2, 'and puts it in every status it builds')
check(/this\.gitStatus = null/.test(conn), 'and forgets it when the connection drops')
check(/gitStatus\?: boolean/.test(ipc), 'ConnectionStatus carries it')
check(/s\.gitStatus && s\.role !== 'limited'/.test(store), 'the store asks the daemon only for an owner device that was told it may')
check(/daemon\.get\(path\)/.test(store) && !/daemon\.write/.test(store), 'one read, no write')
check(/HTTP 403/.test(store) && !/403\|404/.test(store) && /daemonDenied = true/.test(store), 'a refusal (403) sends this connection back to reading itself; one unknown conversation (404) does not')
check(/asked === epoch && \/HTTP 403/.test(store), 'and only if it was asked on this connection')
check(/frameTimers\.has\(id\)/.test(store) && /!showing\(\) && !openIds\.has\(id\)/.test(store), 'frames are coalesced per conversation and ignored while the window is hidden')
check(/clearTimeout\(daemonTimer\)/.test(store), 'a change of Prometheus clears the wait timer')
check(/viaDaemon \? readDaemon\(sessionId\) : b\.git\.read\(sessionId\)/.test(store), 'with a daemon, the folder is not read here; without one it is')
check(/changedFrameSession\(ev\)/.test(store) && /onGateway/.test(store), 'frames are heard')
check(/daemon !== true \|\| !\(entries\.has\(id\) \|\| openIds\.has\(id\)\)/.test(store), 'and only for a conversation being watched')
check(/DAEMON_WAIT_MS/.test(store), 'a Prometheus that never says is read as one without git/1')
check(!inActivityFeed(GIT_CHANGED_FRAME), 'the Activity feed leaves the frame out')
check(inActivityFeed('tool_call_start'), 'and still has the others')
check(/useGitFilesHere\(\)/.test(panel) && /filesHereRef\.current !== true/.test(panel), 'the pane asks main for files only where Prometheus shares the disk')
check(/GIT_REMOTE_FILES_NOTE/.test(panel) && GIT_REMOTE_FILES_NOTE.length > 20, 'and otherwise says why there are none')
check(!/\bb\.(git|workFolder)\.[a-z]+\([^)]*\)[^;]*top\b/.test(store), 'the daemon\'s top folder is shown, never opened')
