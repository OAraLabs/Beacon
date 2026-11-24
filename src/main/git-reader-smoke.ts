/**
 * git-reader-smoke — reading git in a folder the assistant controls (@shared/git-state,
 * src/main/git-reader.ts), headless, against REAL git on throwaway repositories.
 *
 *   1. the parser: what each kind of status line counts as, and that garbage is never "clean";
 *   2. the commands and the environment are fixed: nothing the folder says is an argument;
 *   3. ordinary repositories read right: clean, changed, staged, untracked, detached, ahead and
 *      behind, a merge in conflict, no repository at all;
 *   4. HOSTILE repositories: config that makes plain `git status` run a program does not make
 *      Beacon's reading run it (each with a control showing plain git does);
 *   5. the wiring: main reads only a folder Prometheus named, only when it shares this disk.
 *
 * Run: npm run build && npm run smoke:git-reader
 */
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  GIT_MAX_ENTRIES,
  GIT_STATUS_ARGS,
  GIT_UNSAFE_HERE,
  GIT_WHERE_ARGS,
  GIT_PATH,
  GIT_DIFF_SHOW_MAX,
  GIT_ENTRIES_MAX,
  GIT_LOG_ARGS,
  NO_FORK_SCRIPT,
  GIT_BORROWED,
  GIT_COMMON_ARGS,
  GIT_DIFF_LINES_MAX,
  clipDiff,
  diffLineShown,
  entryHasDiff,
  storeIsOwn,
  storeLinkArgs,
  worktreeNamesBack,
  gitDiffArgs,
  gitOperation,
  gitPathOk,
  parseGitEntries,
  parseGitLog,
  gitReadEnv,
  gitText,
  parseGitStatus,
  parseGitWhere
} from '@shared/git-state'
import { GIT_OPEN_FRESH_MS, GIT_ROW_FRESH_MS, gitChip, gitEmptyWords, gitGroups, gitMark, gitMoreWords, gitStale, prTrouble, prWords } from '@shared/git-view'
import type { GitRead, GitState } from '@shared/git-state'
import { forgetGitReads, forkLimitEnforced, readGit, readGitDetail, readGitDiff } from './git-reader'
import { UNTRACKED_MAX_BYTES, readUntracked } from './git-untracked'
import { readGitPr, resetGitPr } from './git-pr'
import { GH_PLACES, branchOk, ghEnv, ghPrArgs, githubRepo, parseGhPrs, remoteUrl, upstreamOf, type GitPr, type GitPrRead } from '@shared/git-pr'

const MIN_CHECKS = 292
let checks = 0
let failures = 0
/** Said again at the very end: a run's output is long, and CI shows only its last lines. */
const failed: string[] = []
let skipped = false
function check(cond: boolean, name: string, detail = ''): void {
  checks++
  if (cond) console.log(`  ✓ ${name}`)
  else {
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`)
    failed.push(`${name}${detail ? ` — ${detail.slice(0, 240)}` : ''}`)
    failures++
  }
}
process.on('exit', () => {
  console.log('===================== RESULT =====================')
  if (failures === 0 && checks < MIN_CHECKS && !skipped) {
    console.error(`git-reader smoke: FAIL ✗ (only ${checks} of at least ${MIN_CHECKS} checks ran)`)
    process.exitCode = 1
  } else if (failures > 0) {
    for (const f of failed.slice(0, 40)) console.error(`  failed: ${f}`)
    console.error(`git-reader smoke: FAIL ✗ (${failures} of ${checks})`)
    process.exitCode = 1
  } else console.log(`git-reader smoke: PASS ✓ (${checks} checks: parser, how it is shown, fixed commands, real repositories, hostile repositories, wiring)`)
})

const Z = String.fromCharCode(0)
const rec = (...lines: string[]): string => lines.join(Z) + Z

console.log('1. the parser')
{
  const head = ['# branch.oid 0a0dc05b3846652a51c9c81c98470216165089cc', '# branch.head main']
  const clean = parseGitStatus(rec(...head))
  check(!!clean && clean.branch === 'main' && clean.commit === '0a0dc05' && clean.changed === 0 && clean.upstream === null && clean.ahead === null, 'a clean repository with no upstream: the branch, the short commit, nothing changed')
  const tracked = parseGitStatus(rec(...head, '# branch.upstream origin/main', '# branch.ab +3 -2'))
  check(!!tracked && tracked.upstream === 'origin/main' && tracked.ahead === 3 && tracked.behind === 2, 'an upstream, with commits ahead and behind')
  const gone = parseGitStatus(rec(...head, '# branch.upstream origin/gone'))
  check(!!gone && gone.upstream === 'origin/gone' && gone.ahead === null && gone.behind === null, 'an upstream that is gone has no ahead or behind')
  const one = (xy: string): string => `1 ${xy} N... 100644 100644 100644 ${'a'.repeat(40)} ${'b'.repeat(40)} file.txt`
  const mixed = parseGitStatus(rec(...head, one('.M'), one('M.'), one('MM'), one('A.'), one('.D'), '? new file.txt', '? dir/', `u UU N... 100644 100644 100644 100644 ${'a'.repeat(40)} ${'b'.repeat(40)} ${'c'.repeat(40)} both.txt`, '! ignored.log'))
  check(!!mixed && mixed.staged === 3 && mixed.unstaged === 3 && mixed.untracked === 2 && mixed.conflicted === 1 && mixed.changed === 8, 'staged, unstaged, untracked and conflicted are counted; a file changed in both places is one changed file; ignored files are not counted', JSON.stringify(mixed))
  check(parseGitStatus(rec('# branch.oid (initial)', '# branch.head main'))?.commit === null, 'before the first commit there is no commit')
  const det = parseGitStatus(rec(head[0], '# branch.head (detached)'))
  check(!!det && det.branch === null && det.commit === '0a0dc05', 'a detached HEAD has no branch, only its commit')
  const odd = parseGitStatus(rec(head[0], '# branch.head feat/a b\tc'))
  check(odd?.branch === 'feat/a b\tc', 'a branch name is kept as git wrote it (showing it safely is gitText)')
  const withNewline = parseGitStatus(rec(...head, '? a\nb.txt', '? c.txt'))
  check(withNewline?.untracked === 2, 'a file name with a line break in it is one file (records end at NUL, not at a line)')
  // Not this format: never read as "clean".
  for (const bad of ['', 'fatal: not a git repository', 'On branch main\nnothing to commit', rec(...head, 'X weird'), rec(...head, '1 M'), rec(...head, '1'), rec(...head, `2 R. N... 100644 100644 100644 ${'a'.repeat(40)} ${'b'.repeat(40)} R100 new.txt`, 'old.txt')]) {
    check(parseGitStatus(bad) === null, `not status output, so not a state: ${JSON.stringify(bad.slice(0, 30))}`)
  }
  check(parseGitStatus(undefined as unknown as string) === null, 'nothing is not a state')
  const many = parseGitStatus(rec(...head, ...Array.from({ length: GIT_MAX_ENTRIES + 50 }, (_, i) => `? f${i}`)))
  check(!!many && many.truncated && many.untracked === GIT_MAX_ENTRIES, 'past the most entries read, the count stops and says it did')
  check(parseGitStatus(rec(...head, '# branch.ab +x -1'))?.ahead === null && parseGitStatus(rec('# branch.oid zzzz', head[1]))?.commit === null, 'a number or a commit that is not one is left out, not guessed')
  check(gitOperation(['HEAD', 'MERGE_HEAD']) === 'merge' && gitOperation(['rebase-merge', 'MERGE_HEAD']) === 'rebase' && gitOperation(['rebase-apply']) === 'rebase' && gitOperation(['CHERRY_PICK_HEAD']) === 'cherry-pick' && gitOperation(['REVERT_HEAD']) === 'revert' && gitOperation(['BISECT_LOG']) === 'bisect' && gitOperation(['sequencer', 'HEAD']) === 'cherry-pick' && gitOperation(['HEAD', 'config']) === null, 'what is under way is read from the names in the git folder')
  check(parseGitWhere('true\n/a/b\n/a/b/.git\n')?.gitDir === '/a/b/.git' && parseGitWhere('true\n/a/b\n') === null && parseGitWhere('true\nrelative\n/a') === null && parseGitWhere('') === null && parseGitWhere('/a/b\n/a/b/.git\n') === null, 'where the repository is: inside the work tree, with two absolute paths, or nothing')
  check(parseGitWhere('false\n/a/b\n/a/b/.git\n') === null, 'a folder that is not inside the work tree git found is not read')
  check(parseGitWhere('true\n/home/demo\n/home/demo/proj/.git\n') === null && parseGitWhere('true\n/etc\n/home/demo/proj/.git\n') === null, "a repository whose settings point its work tree somewhere else (core.worktree) is not read: the top is not the folder that holds .git")
  check(parseGitWhere('true\n/a/wt\n/a/main/.git/worktrees/wt\n') !== null && parseGitWhere('true\n/a/main/sub\n/a/main/.git/modules/sub\n') !== null && parseGitWhere('true\n/\n/.git\n') !== null, 'a linked worktree, a submodule and a repository at the top of the disk are read')
  check(parseGitWhere('true\n/a/b\n/somewhere/else\n') === null && parseGitWhere('true\n/a/b\n/a/b/.git/../../c\n') === null, 'a git folder that is neither is not')
  const forged = parseGitStatus(rec(...head, '? note.txt', '# branch.head evil', '# branch.ab +9 -9'))
  check(forged === null || (forged.branch === 'main' && forged.ahead === null), 'a record after the first entry that looks like a header does not restate the branch')
  check(parseGitStatus(rec(head[0], '# branch.head (unknown)'))?.branch === null, 'a HEAD git cannot name is no branch, not a branch called "(unknown)"')
  const RLO = String.fromCharCode(0x202e)
  const ZW = String.fromCharCode(0x200b)
  check(gitText(`main${RLO}${ZW}\n`) === 'main' && gitText('x'.repeat(200)).length === 60 && gitText(null) === '', 'a name is shown without invisible characters, and a long one is cut')
}

console.log('1b. how it is shown')
{
  const st = (over: Partial<GitState> = {}): GitState => ({ branch: 'main', commit: '0a0dc05', upstream: null, ahead: null, behind: null, staged: 0, unstaged: 0, untracked: 0, conflicted: 0, changed: 0, operation: null, ...over })
  const rd = (over: Partial<GitState> = {}, truncated = false): GitRead => ({ kind: 'state', state: st(over), top: '/home/demo/site', truncated })
  check(gitMark(null) === null && gitMark(undefined) === null && gitMark({ kind: 'none' }) === null && gitMark({ kind: 'unreadable', why: 'x' }) === null, 'no repository, or one that could not be read, has no mark')
  const clean = gitMark(rd())
  check(clean?.kind === 'branch' && clean.count === '' && clean.words === 'Git: main · nothing changed', 'a clean repository: the plain branch mark, no number', clean?.words)
  const dirty = gitMark(rd({ unstaged: 2, untracked: 1, changed: 3 }))
  check(dirty?.kind === 'changes' && dirty.count === '3' && dirty.words === 'Git: main · 3 changed files', 'changed files: the mark with their number')
  check(gitMark(rd({ unstaged: 1, changed: 1 }))?.words === 'Git: main · 1 changed file', 'one file is "1 changed file"')
  const moved = gitMark(rd({ upstream: 'origin/main', ahead: 2, behind: 1 }))
  check(moved?.kind === 'moved' && moved.count === '' && moved.words === 'Git: main · nothing changed · 2 ahead and 1 behind origin/main' && gitMark(rd({ upstream: 'origin/main', ahead: 0, behind: 4 }))?.words === 'Git: main · nothing changed · 4 behind origin/main', 'nothing changed but ahead or behind: the moved mark, and how far in words', moved?.words)
  check(gitMark(rd({ upstream: 'origin/main', ahead: 0, behind: 0 }))?.kind === 'branch' && gitMark(rd({ upstream: 'origin/gone' }))?.kind === 'branch', 'in step with its upstream, or an upstream that is gone, is the plain mark')
  const both = gitMark(rd({ unstaged: 1, changed: 1, upstream: 'origin/main', ahead: 3, behind: 0 }))
  check(both?.kind === 'changes' && /1 changed file · 3 ahead of origin\/main$/.test(both.words), 'changes win over distance for the mark; the words say both')
  const merging = gitMark(rd({ operation: 'merge', conflicted: 2, changed: 2 }))
  check(merging?.kind === 'alert' && merging.count === '2' && /a merge is under way, 2 in conflict/.test(merging.words), 'something under way, or files in conflict: the warning mark')
  check(gitMark(rd({ operation: 'rebase' }))?.kind === 'alert' && gitMark(rd({ conflicted: 1, changed: 1 }))?.kind === 'alert', 'either alone is enough for it')
  check(gitMark(rd({ branch: null }))?.words === 'Git: detached at 0a0dc05 · nothing changed' && gitMark(rd({ branch: null, commit: null }))?.words === 'Git: no commits yet · nothing changed', 'a detached HEAD and an empty repository are said as such')
  check(gitMark(rd({ untracked: 5000, changed: 5000 }))?.count === '5000' && gitMark(rd({ untracked: 5000, changed: 5000 }, true))?.count === '5000+' && /more than 5000 changed files/.test(gitMark(rd({ untracked: 5000, changed: 5000 }, true))?.words ?? ''), 'where the reader stopped counting, the number says "at least"')
  const RLO2 = String.fromCharCode(0x202e)
  const nasty = gitMark(rd({ branch: `main${RLO2}evil\n`, upstream: `origin/x${RLO2}` , ahead: 1, behind: 0 }))
  check(!!nasty && !nasty.words.includes(RLO2) && !nasty.words.includes('\n'), 'a branch or upstream name is shown without invisible characters')
  const chip = gitChip(rd({ branch: 'feat/a-very-long-branch-name-that-goes-on-and-on', unstaged: 1, changed: 1, upstream: 'origin/x', ahead: 2, behind: 4 }))
  check(!!chip && chip.kind === 'changes' && Array.from(chip.head).length <= 28 && chip.head.endsWith('…') && chip.count === '1' && chip.ahead === 2 && chip.behind === 4, 'the header chip: the branch cut to fit, the count, and the distance')
  check(gitChip(rd({ ahead: 5, behind: 5 }))?.ahead === 0 && gitChip({ kind: 'none' }) === null && gitChip(rd({ branch: null }))?.head === 'detached 0a0dc05', 'no upstream means no distance; no repository means no chip; detached shows the commit')
  check(GIT_OPEN_FRESH_MS < GIT_ROW_FRESH_MS && gitStale(GIT_OPEN_FRESH_MS, true) && !gitStale(GIT_OPEN_FRESH_MS - 1, true) && !gitStale(GIT_OPEN_FRESH_MS, false) && gitStale(GIT_ROW_FRESH_MS, false) && gitStale(NaN, false), 'the open conversation is read again sooner than a row; a time that makes no sense counts as stale')
}

console.log('1c. the panel: entries, the arguments of a diff, the log')
{
  const head = ['# branch.oid 0a0dc05b3846652a51c9c81c98470216165089cc', '# branch.head main']
  const one = (xy: string, path: string): string => `1 ${xy} N... 100644 100644 100644 ${'a'.repeat(40)} ${'b'.repeat(40)} ${path}`
  const listed = parseGitEntries(rec(...head, one('.M', 'src/a file.txt'), one('MM', 'both.txt'), one('A.', 'added.txt'), '? new.txt', '? dir/', `u UU N... 100644 100644 100644 100644 ${'a'.repeat(40)} ${'b'.repeat(40)} ${'c'.repeat(40)} clash.txt`, '! ignored.log'))
  check(!!listed && listed.more === 0 && listed.entries.map((e) => `${e.kind}:${e.index}${e.tree}:${e.path}`).join('|') === 'changed:.M:src/a file.txt|changed:MM:both.txt|changed:A.:added.txt|untracked:.?:new.txt|untracked:.?:dir/|conflicted:UU:clash.txt', 'each entry: its path (spaces and all), its two states, its kind; ignored files are left out', JSON.stringify(listed))
  check(parseGitEntries(rec(...head, '? a\nb.txt'))?.entries[0].path === 'a\nb.txt', 'a name with a line break is one path')
  check(parseGitEntries('nope') === null && parseGitEntries(rec(...head, 'X y')) === null && parseGitEntries(rec(...head, '1 .M')) === null && parseGitEntries(rec(...head, '? ')) === null, 'what is not status output is not a list')
  const many = parseGitEntries(rec(...head, ...Array.from({ length: GIT_ENTRIES_MAX + 7 }, (_, i) => `? f${i}`)))
  check(many?.entries.length === GIT_ENTRIES_MAX && many.more === 7, 'past the most entries listed, the rest are counted')
  const forgedList = parseGitEntries(rec(...head, '? x', '# branch.head evil'))
  check(forgedList === null, 'a header-looking record after the first entry is not skipped as a header')
  const E = listed?.entries ?? []
  check(entryHasDiff(E[0], 'unstaged') && !entryHasDiff(E[0], 'staged') && entryHasDiff(E[1], 'staged') && entryHasDiff(E[1], 'unstaged') && entryHasDiff(E[2], 'staged') && !entryHasDiff(E[2], 'unstaged') && entryHasDiff(E[3], 'untracked') && !entryHasDiff(E[3], 'unstaged') && !entryHasDiff(E[4], 'untracked') && !entryHasDiff(E[0], 'untracked'), 'which diff an entry has: staged, not staged, or (for a new file, never a new folder) against nothing')
  for (const bad of ['', '/etc/passwd', '../outside.txt', 'a/../../b', '-rf', '--output=/tmp/x', `a${Z}b`, 'x'.repeat(5000), 7, null, undefined]) {
    check(!gitPathOk(bad) && gitDiffArgs('unstaged', bad as unknown as string) === null, `not a path a diff is run for: ${JSON.stringify(typeof bad === 'string' ? bad.slice(0, 24) : bad)}`)
  }
  check(gitPathOk('src/a file.txt') && gitPathOk(':(top)weird') && gitPathOk('*.txt') && gitPathOk('a..b/c'), 'an ordinary name, and one that only looks like a pattern, is a path (it is read as a name)')
  const d = gitDiffArgs('unstaged', 'src/a file.txt') ?? []
  const dc = gitDiffArgs('staged', 'x.txt') ?? []
  for (const [name, a] of [['not staged', d], ['staged', dc]] as const) {
    check(a.includes('--no-ext-diff') && a.includes('--no-textconv') && a.includes('--literal-pathspecs') && a.indexOf('--literal-pathspecs') < a.indexOf('diff') && a.includes('core.fsmonitor=false') && a.lastIndexOf('--') === a.length - 2, `the ${name} diff: no external tool, no textconv, the path read as a name, and last, after --`)
  }
  check(dc.includes('--cached') && !d.includes('--cached') && gitDiffArgs('untracked', 'new.txt') === null && !d.includes('--no-index') && !dc.includes('--no-index'), 'staged compares the index; a file git does not track is never handed to git to diff')
  // Whose store it is.
  const la = storeLinkArgs('/r/.git', '/r/.git')
  check(GIT_COMMON_ARGS.includes('--git-common-dir') && GIT_COMMON_ARGS.includes('--path-format=absolute') && la.top.join(' ') === '-P /r/.git -maxdepth 1 -type l' && la.deep.join(' ') === '-P /r/.git/refs /r/.git/objects -type l' && storeLinkArgs('/r/.git/worktrees/w', '/r/.git').top.join(' ') === '-P /r/.git /r/.git/worktrees/w -maxdepth 1 -type l', 'the store is checked by asking git for its common folder, and by listing links at the top of each git folder and anywhere under refs and objects')
  check(storeIsOwn('/r/.git', '/r/.git', ['packs', ''], [''], ['']) && storeIsOwn('/r/.git/worktrees/w', '/r/.git', [], [], []) && storeIsOwn('/r/.git', '/r/.git', [], ['/r/.git/hooks', '/r/.git/description'], []), 'an ordinary repository, a linked worktree, and one with a linked hooks folder own their store')
  check(!storeIsOwn('/b/.git', '/victim/.git', [], [], []) && !storeIsOwn('/b/.git/worktrees/a/b', '/b/.git', [], [], []) && !storeIsOwn('/x/worktrees/w', '/b/.git', [], [], []), 'a common folder that is somewhere else (a commondir file) is not its own')
  check(!storeIsOwn('/r/.git', '/r/.git', ['alternates'], [], []) && !storeIsOwn('/r/.git', '/r/.git', ['http-alternates'], [], []), 'nor is one with a list of other object stores')
  for (const link of ['/r/.git/index', '/r/.git/HEAD', '/r/.git/objects', '/r/.git/refs', '/r/.git/packed-refs', '/r/.git/config']) {
    check(!storeIsOwn('/r/.git', '/r/.git', [], [link], []), `nor one where ${link.replace('/r/.git/', '')} is a link`)
  }
  for (const link of ['/r/.git/refs/heads', '/r/.git/refs/heads/main', '/r/.git/objects/ab', '/r/.git/objects/ab/cdef0123', '/r/.git/objects/pack/pack-1.pack', '/r/.git/objects/info']) {
    check(!storeIsOwn('/r/.git', '/r/.git', [], [], [link]), `nor one with a link under refs or objects (${link.replace('/r/.git/', '')}), at any depth`)
  }
  // A linked worktree's store must name the folder back.
  check(worktreeNamesBack('/w/tree', '/main/.git/worktrees/tree', '/w/tree/.git\n') && worktreeNamesBack('/private/tmp/w', '/m/.git/worktrees/w', '/tmp/w/.git\n') && worktreeNamesBack('/tmp/w', '/m/.git/worktrees/w', '/private/tmp/w/.git') && worktreeNamesBack('/m/trees/w', '/m/.git/worktrees/w', '../../../trees/w/.git\n'), 'a real linked worktree: its store names the folder back (written in full, by the other spelling of a Mac temp folder, or relative)')
  check(!worktreeNamesBack('/home/demo/mine', '/victim/.git/worktrees/theirs', '/victim-trees/theirs/.git\n') && !worktreeNamesBack('/a', '/m/.git/worktrees/w', '') && !worktreeNamesBack('/a', '/m/.git/worktrees/w', '/a\n') && !worktreeNamesBack('/a/b', '/m/.git/worktrees/w', '/a/.git\n'), "a folder whose .git file points at another repository's worktree store is not named back by it")
  check(parseGitWhere('true\n/a/wt\n/a/main/.git/worktrees/wt\n')?.linked === true && parseGitWhere('true\n/a/b\n/a/b/.git\n')?.linked === false && parseGitWhere('true\n/a/main/sub\n/a/main/.git/modules/sub\n')?.linked === false, 'which repositories that check applies to')
  check(parseGitWhere('true\n/home/demo/mine\n/victim/.git/modules/x\n') === null && parseGitWhere('true\n/a/main/deep/sub\n/a/main/.git/modules/deep/sub\n') !== null && parseGitWhere('true\n/a/mainly/sub\n/a/main/.git/modules/sub\n') === null, "a submodule's git folder must be inside the repository that holds it, a folder above the top")
  const TAGGED = `+ok${String.fromCharCode(0x202e)}reversed${String.fromCharCode(0x2066)}x`
  check(diffLineShown(TAGGED) === '+okreversedx' && diffLineShown('+plain text') === '+plain text', 'a diff line is drawn without the characters that reorder text on screen, and otherwise as it is')
  const manyLines = clipDiff('+\n'.repeat(GIT_DIFF_LINES_MAX + 100))
  check(manyLines.truncated && manyLines.text.split('\n').length === GIT_DIFF_LINES_MAX && !clipDiff('+\n'.repeat(GIT_DIFF_LINES_MAX)).truncated, 'a change of very many short lines is cut at the most lines drawn')
  check(GIT_LOG_ARGS.includes('--no-show-signature') && GIT_LOG_ARGS.includes('log.showSignature=false') && GIT_LOG_ARGS[GIT_LOG_ARGS.length - 1] === '@{upstream}..HEAD' && GIT_LOG_ARGS.includes('--format=%h%x09%s'), 'the log: fixed format, no signature check (which would start a program), only what the upstream lacks')
  const TAB = String.fromCharCode(9)
  check(parseGitLog(`0a0dc05${TAB}first line${Z}\n1b2c3d4${TAB}second${TAB}with a tab${Z}`).map((c) => `${c.hash}=${c.subject}`).join('|') === `0a0dc05=first line|1b2c3d4=second${TAB}with a tab` && parseGitLog('').length === 0 && parseGitLog(`zzzz${TAB}x${Z}`).length === 0, 'each commit: a short hash and its subject; anything else is skipped')
  const big = clipDiff(`${'+line\n'.repeat(GIT_DIFF_SHOW_MAX / 4)}`)
  check(big.truncated && big.text.length <= GIT_DIFF_SHOW_MAX && big.text.endsWith('+line') && !clipDiff('small\n').truncated, 'a long diff is cut at the limit, on a line')
  const groups = gitGroups(E)
  check(groups.map((g) => `${g.title}:${g.rows.length}`).join() === 'In conflict:1,Staged:2,Not staged:2,Untracked:2', 'the panel groups them: in conflict, staged, not staged, untracked; a file changed in both places is in both', groups.map((g) => `${g.title}:${g.rows.length}`).join())
  check(groups[1].rows.map((r) => `${r.shown}=${r.what}/${r.mode}`).join('|') === 'both.txt=modified/staged|added.txt=added/staged' && groups[3].rows.map((r) => `${r.what}/${r.mode}`).join() === 'new file/untracked,new folder/null', 'each row says what happened and which diff it opens; a new folder opens none')
  check(gitGroups([]).length === 0 && gitMoreWords(0) === '' && gitMoreWords(1) === '1 more changed file is not listed.' && gitMoreWords(7) === '7 more changed files are not listed.', 'nothing changed is no groups; more than fit are counted in words')
  check(gitEmptyWords({ kind: 'detail', entries: [], more: 0, commits: [] }) === 'Nothing is changed.' && gitEmptyWords({ kind: 'unreadable', why: 'Git did not answer in time.' }) === 'Git did not answer in time.' && gitEmptyWords({ kind: 'detail', entries: E, more: 0, commits: [] }) === '' && gitChip({ kind: 'unreadable', why: 'Git did not answer in time.' })?.head === 'git not read', 'an empty list, and a repository that could not be read, say so')
}

console.log('1d. pull requests')
{
  const Z0 = String.fromCharCode(0)
  const branches = [`refs/heads/main${Z0}origin${Z0}refs/heads/main`, `refs/heads/feat/x${Z0}origin${Z0}refs/heads/feat/x-remote`, `refs/heads/local-only${Z0}${Z0}`, `refs/heads/odd${Z0}origin${Z0}refs/tags/v1`].join('\n')
  check(JSON.stringify(upstreamOf('refs/heads/feat/x\n', branches)) === '{"remote":"origin","branch":"feat/x-remote"}', 'where the current branch is pushed: the remote, and its name there')
  check(upstreamOf('refs/heads/local-only', branches) === null && upstreamOf('HEAD', branches) === null && upstreamOf('refs/heads/missing', branches) === null && upstreamOf('refs/heads/odd', branches) === null, 'a branch with no upstream, a detached HEAD, and an upstream that is not a branch have none')
  const remotes = `remote.origin.url\nhttps://github.com/acme/site.git${Z0}remote.fork.url\ngit@github.com:someone/site.git${Z0}`
  check(remoteUrl(remotes, 'origin') === 'https://github.com/acme/site.git' && remoteUrl(remotes, 'fork') === 'git@github.com:someone/site.git' && remoteUrl(remotes, 'nope') === null && remoteUrl(remotes, 'origi') === null, "a remote's address is the one under exactly its name")
  for (const [url, want] of [['https://github.com/acme/site.git', 'acme/site'], ['https://github.com/acme/site', 'acme/site'], ['https://github.com/acme/site/', 'acme/site'], ['git@github.com:acme/site.git', 'acme/site'], ['ssh://git@github.com/acme/my.repo-name_1.git', 'acme/my.repo-name_1']] as const) {
    check(githubRepo(url) === want, `${url} is ${want}`, String(githubRepo(url)))
  }
  for (const url of ['https://gitlab.com/acme/site.git', 'https://github.com.evil.example/acme/site', 'https://user:secret@github.com/acme/site.git', 'https://github.com:8443/acme/site', 'https://github.com/acme/site/extra', 'https://github.com/acme', 'https://github.com/acme/..', 'https://github.com/-flag/site', 'https://github.com/acme/site?x=1', 'https://github.com/ac me/site', '/home/demo/repos/site.git', 'file:///home/demo/site', '--upload-pack=x', 'ext::sh -c x', 'http://github.com/acme/site', '', null] as const) {
    check(githubRepo(url) === null, `not a github.com repository: ${JSON.stringify(url)}`, String(githubRepo(url)))
  }
  for (const b of ['main', 'feat/x', 'release-1.2', 'user@thing', 'a+b', '_x']) check(branchOk(b), `${b} is a branch name to ask about`)
  for (const b of ['-x', '--repo=evil/x', 'a b', 'a..b', 'a//b', 'x/', 'x.lock', 'a\nb', 'a;b', 'a$b', '', 'x'.repeat(201), null, 7]) check(!branchOk(b), `not one: ${JSON.stringify(typeof b === 'string' ? b.slice(0, 20) : b)}`)
  const args = ghPrArgs('acme/site', 'feat/x') ?? []
  check(args.join(' ') === 'pr list --repo acme/site --head feat/x --state all --limit 5 --json number,state,isDraft,mergeable,url,statusCheckRollup,headRefName,isCrossRepository', 'gh is asked about that branch of that repository, by name, and nothing else', args.join(' '))
  check(ghPrArgs(null, 'x') === null && ghPrArgs('acme/site', '-x') === null && ghPrArgs('acme', 'x') === null && ghPrArgs('acme/site/extra', 'x') === null && ghPrArgs('--flag/x', 'x') === null, 'no repository, or a branch that is not one, is not asked about')
  const env = ghEnv({ HOME: '/home/demo', PATH: '.:/evil', GH_TOKEN: 'never', GITHUB_TOKEN: 'never', GH_HOST: 'evil.example', GH_ENTERPRISE_TOKEN: 'never', GIT_DIR: '/evil', GH_CONFIG_DIR: 'relative/evil' })
  check(Object.keys(env).sort().join() === 'GH_HOST,GH_NO_UPDATE_NOTIFIER,GH_PAGER,GH_PROMPT_DISABLED,HOME,LANG,NO_COLOR,PATH' && env.GH_HOST === 'github.com' && !env.PATH.includes('.:') && env.PATH.split(':').every((d) => d.startsWith('/')), "gh's environment is a short fixed list: no token from Beacon's own environment reaches it, and the host is github.com whatever was set", Object.keys(env).join())
  check(ghEnv({ XDG_CONFIG_HOME: '/home/demo/.config-elsewhere', GH_CONFIG_DIR: '/home/demo/gh' }).XDG_CONFIG_HOME === '/home/demo/.config-elsewhere' && ghEnv({ GH_CONFIG_DIR: '/home/demo/gh' }).GH_CONFIG_DIR === '/home/demo/gh', "where the person keeps gh's own settings, if they moved them, is passed on")
  check(GH_PLACES.every((p) => p.startsWith('/') && p.endsWith('/gh')) && Object.isFrozen(GH_PLACES), 'gh is looked for in fixed places only, and the list cannot be changed')
  // The real answers, captured from gh.
  const fx = JSON.parse(readFileSync(new URL('../../scripts/fixtures/gh-pr-list.json', import.meta.url), 'utf8')) as Record<string, unknown[]>
  const draft = parseGhPrs(JSON.stringify(fx.draft), 'OAraLabs/Beacon', 'ha/approval-card')
  check(!!draft && draft.number === 46 && draft.state === 'draft' && !draft.conflicts && draft.url === 'https://github.com/OAraLabs/Beacon/pull/46' && ['passing', 'failing', 'pending', 'none'].includes(draft.checks), 'a real answer for a draft pull request: its number, state and checks', JSON.stringify(draft))
  const merged = parseGhPrs(JSON.stringify(fx.merged), 'OAraLabs/Beacon', 'feat/git-panel')
  check(!!merged && merged.number === 65 && merged.state === 'merged' && merged.checks === 'passing', 'a real answer for a merged one', JSON.stringify(merged))
  check(parseGhPrs(JSON.stringify(fx.none), 'acme/site', 'x') === null && parseGhPrs('', 'acme/site', 'x') === null && parseGhPrs('{"number":1}', 'acme/site', 'x') === null && parseGhPrs('not json', 'acme/site', 'x') === null, 'no pull request, and an answer that is not a list, are none')
  const pr = (over: Record<string, unknown>): string => JSON.stringify([{ number: 7, state: 'OPEN', isDraft: false, mergeable: 'MERGEABLE', headRefName: 'feat/x', isCrossRepository: false, url: 'https://evil.example/phish', statusCheckRollup: [], ...over }])
  check(parseGhPrs(pr({}), 'acme/site', 'feat/x')?.url === 'https://github.com/acme/site/pull/7', "the link is built from the repository and the number: the answer's own url is not used")
  check(parseGhPrs(pr({ headRefName: 'other' }), 'acme/site', 'feat/x') === null && parseGhPrs(pr({ number: '7' }), 'acme/site', 'feat/x') === null && parseGhPrs(pr({ number: -1 }), 'acme/site', 'feat/x') === null && parseGhPrs(pr({ state: 'WEIRD' }), 'acme/site', 'feat/x') === null && parseGhPrs(pr({ number: 1e21 }), 'acme/site', 'feat/x') === null && parseGhPrs(pr({ number: 7.5 }), 'acme/site', 'feat/x') === null, "another branch's pull request, a number that is not one, or a state that is not one, is none")
  check(parseGhPrs(pr({ isCrossRepository: true }), 'acme/site', 'feat/x') === null && parseGhPrs(pr({ isCrossRepository: undefined }), 'acme/site', 'feat/x') === null, "a pull request from someone's fork, from a branch of the same name, is not this branch's (nor is one that does not say)")
  check(parseGhPrs(pr({ isDraft: true }), 'acme/site', 'feat/x')?.state === 'draft' && parseGhPrs(pr({ state: 'CLOSED' }), 'acme/site', 'feat/x')?.state === 'closed' && parseGhPrs(pr({ mergeable: 'CONFLICTING' }), 'acme/site', 'feat/x')?.conflicts === true, 'a draft, a closed one, and one with conflicts are told apart')
  const roll = (...cs: Record<string, string>[]): string | undefined => parseGhPrs(pr({ statusCheckRollup: cs }), 'acme/site', 'feat/x')?.checks
  check(roll() === 'none' && roll({ status: 'COMPLETED', conclusion: 'SUCCESS' }, { status: 'COMPLETED', conclusion: 'SKIPPED' }) === 'passing' && roll({ status: 'COMPLETED', conclusion: 'SUCCESS' }, { status: 'IN_PROGRESS', conclusion: '' }) === 'pending' && roll({ status: 'COMPLETED', conclusion: 'FAILURE' }, { status: 'IN_PROGRESS', conclusion: '' }) === 'failing' && roll({ state: 'SUCCESS' }) === 'passing' && roll({ state: 'PENDING' }) === 'pending' && roll({ state: 'ERROR' }) === 'failing' && roll({ status: 'COMPLETED', conclusion: 'SOMETHING_NEW' }) === 'pending', 'checks: all passed, some running, any failed, none; a verdict nobody knows counts as not passed yet')
  const two = JSON.stringify([{ number: 3, state: 'CLOSED', headRefName: 'feat/x', isCrossRepository: false }, { number: 9, state: 'OPEN', headRefName: 'feat/x', isDraft: false, isCrossRepository: false }])
  check(parseGhPrs(two, 'acme/site', 'feat/x')?.number === 9, 'with several for one branch, the open one is the one shown')
  // How it is shown.
  const st: GitState = { branch: 'feat/x', commit: '0a0dc05', upstream: 'origin/feat/x', ahead: 0, behind: 0, staged: 0, unstaged: 2, untracked: 0, conflicted: 0, changed: 2, operation: null }
  const rd: GitRead = { kind: 'state', state: st, top: '/home/demo/site', truncated: false }
  const P = (over: Partial<GitPr> = {}): GitPrRead => ({ kind: 'pr', pr: { number: 65, state: 'open', conflicts: false, checks: 'passing', url: 'https://github.com/acme/site/pull/65', ...over } })
  const m1 = gitMark(rd, P())
  check(m1?.kind === 'pr-open' && m1.count === '#65' && m1.words === 'Git: feat/x · 2 changed files · pull request #65 is open, checks passed', 'with a pull request, the row shows its mark and its number; the words still say how many files are changed', JSON.stringify(m1))
  check(gitMark(rd, P({ state: 'draft' }))?.kind === 'pr-draft' && gitMark(rd, P({ state: 'merged' }))?.kind === 'pr-merged' && gitMark(rd, P({ state: 'closed' }))?.kind === 'pr-closed' && gitMark(rd, P({ state: 'merged', checks: 'failing', conflicts: true }))?.count === '#65', 'each state has its own mark; a merged or closed one is never flagged')
  check(gitMark(rd, P({ conflicts: true }))?.count === '#65!' && /it has conflicts/.test(gitMark(rd, P({ conflicts: true }))?.words ?? '') && gitMark(rd, P({ checks: 'failing' }))?.count === '#65!' && /checks are failing/.test(gitMark(rd, P({ checks: 'failing' }))?.words ?? '') && gitMark(rd, P({ checks: 'pending' }))?.count === '#65', 'an open one that needs attention carries a ! after its number, and says why')
  check(gitMark(rd, { kind: 'none' })?.kind === 'changes' && gitMark(rd, { kind: 'unknown' })?.kind === 'changes' && gitMark(rd, null)?.count === '2' && gitMark({ kind: 'none' }, P()) === null, 'without a pull request the row is as before; with no repository there is no mark at all')
  const busy = gitMark({ ...rd, state: { ...st, operation: 'rebase' } }, P())
  check(busy?.kind === 'alert' && /a rebase is under way/.test(busy.words) && /pull request #65/.test(busy.words), 'something under way in the folder itself still wins the mark; the pull request is in the words')
  const chip = gitChip(rd, P({ checks: 'failing' }))
  check(chip?.kind === 'pr-open' && chip.count === '2' && chip.pr === '#65!' && gitChip(rd)?.pr === '', 'the header chip keeps the changed-file count and adds the pull request number')
  check(prWords({ number: 1, state: 'merged', conflicts: true, checks: 'failing', url: '' }) === 'pull request #1 is merged' && prTrouble({ number: 1, state: 'draft', conflicts: true, checks: 'none', url: '' }), 'a finished pull request is just said to be finished; a draft with conflicts needs attention')
}

console.log('2. the commands and the environment')
{
  const all = [...GIT_WHERE_ARGS, ...GIT_STATUS_ARGS]
  for (const key of ['core.fsmonitor=false', 'core.hooksPath=/dev/null', 'core.preloadIndex=false', 'index.threads=1', 'safe.bareRepository=explicit']) {
    check(GIT_WHERE_ARGS.includes(key) && GIT_STATUS_ARGS.includes(key) && GIT_STATUS_ARGS[GIT_STATUS_ARGS.indexOf(key) - 1] === '-c', `both commands carry -c ${key}`)
  }
  check(GIT_STATUS_ARGS.includes('--no-optional-locks') && GIT_STATUS_ARGS.includes('--ignore-submodules=all') && GIT_STATUS_ARGS.includes('-z') && GIT_STATUS_ARGS.includes('--porcelain=v2'), 'status takes no lock, enters no submodule, and answers in the machine format')
  const verbs = all.filter((a) => !a.startsWith('-') && !a.includes('='))
  check(verbs.join() === 'rev-parse,status', 'the two commands behind the marks are rev-parse and status', verbs.join())
  {
    const every = [...all, ...GIT_LOG_ARGS, ...GIT_COMMON_ARGS, ...(gitDiffArgs('staged', 'x') ?? []), ...(gitDiffArgs('unstaged', 'x') ?? [])].filter((a) => !a.startsWith('-') && !a.includes('=') && !a.includes('/') && a !== 'x' && !a.includes('{'))
    check([...new Set(every)].sort().join() === '30,diff,log,rev-parse,status', 'with the panel: diff and log as well. Nothing that writes, fetches or pushes', [...new Set(every)].sort().join())
  }
  check(/^ulimit -u 0 2>\/dev\/null \|\| ulimit -p 0 2>\/dev\/null \|\| exit 97; exec "\$@"$/.test(NO_FORK_SCRIPT), 'the script sets the process limit to zero, stops if it cannot, and then IS the command (its arguments are never part of the script)')
  const env = gitReadEnv({ PATH: '/usr/bin:/bin', HOME: '/home/demo', GIT_DIR: '/evil', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.fsmonitor', GIT_CONFIG_VALUE_0: '/evil', GIT_EXEC_PATH: '/evil', GIT_SSH: '/evil', LD_PRELOAD: '/evil.so', DYLD_INSERT_LIBRARIES: '/evil.dylib', EDITOR: 'vi' })
  check(Object.keys(env).sort().join() === 'GIT_CEILING_DIRECTORIES,GIT_OPTIONAL_LOCKS,GIT_PAGER,GIT_TERMINAL_PROMPT,HOME,LANG,LC_ALL,PATH' && env.PATH === GIT_PATH && env.HOME === '/home/demo' && env.GIT_CEILING_DIRECTORIES === '/home/demo', "git's environment is a short fixed list: no GIT_* setting, loader variable or editor from Beacon's own environment reaches it", Object.keys(env).join())
  for (const p of ['.:/usr/bin', ':/usr/bin:/bin', '/nonexistent::/usr/bin', './node_modules/.bin:/usr/bin', 'node_modules/.bin:/usr/bin', '/home/demo/project/node_modules/.bin:/usr/bin']) {
    check(gitReadEnv({ PATH: p }).PATH === GIT_PATH, `Beacon's own PATH (${JSON.stringify(p)}) is never the one git is found by`)
  }
  check(GIT_PATH.split(':').every((d) => d.startsWith('/') && d.length > 1) && GIT_PATH.startsWith('/usr/bin:/bin:') && !('HOME' in gitReadEnv({})) && !('HOME' in gitReadEnv({ HOME: 'relative/home' })), 'git is looked for in a fixed list of absolute system folders, system ones first; a home that is not an absolute path is left out')
}

void (async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'beacon-git-')))
  const home = join(root, 'home')
  mkdirSync(home)
  // The person's own environment for these repositories: an empty home, so nothing of this
  // computer's git settings is in play, and plain C messages.
  const ENV = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, LANG: 'C', LC_ALL: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' }
  const g = (cwd: string, ...args: string[]): string => execFileSync('git', ['-c', 'user.name=Smoke', '-c', 'user.email=smoke@example.invalid', '-c', 'init.defaultBranch=main', '-c', 'commit.gpgsign=false', ...args], { cwd, env: ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20000 })
  const make = (name: string): string => {
    const dir = join(root, name)
    mkdirSync(dir)
    g(dir, 'init', '-q', '.')
    writeFileSync(join(dir, 'a.txt'), 'one\n')
    writeFileSync(join(dir, 'b.txt'), 'two\n')
    g(dir, 'add', '-A')
    g(dir, 'commit', '-q', '-m', 'first')
    return dir
  }
  let haveGit = true
  try {
    execFileSync('git', ['--version'], { env: ENV, stdio: 'ignore' })
  } catch {
    haveGit = false
  }
  try {
    console.log('3. ordinary repositories')
    check(haveGit, 'git is installed here (without it, sections 3 and 4 cannot run and this smoke fails)')
    if (!haveGit) return
    const enforcedHere = await forkLimitEnforced(gitReadEnv(ENV))
    if (!enforcedHere) {
      // Root, or a system that does not count processes per user: Beacon reads nothing here, and says so.
      const r = await readGit(make('unenforced'), ENV)
      check(r.kind === 'unreadable' && r.why === GIT_UNSAFE_HERE, 'where a process limit does not bind (root, some containers), git is not read at all, and Beacon says why')
      console.log('  note: the process limit is not enforced for this user; the repository sections cannot run here')
      skipped = true
      return
    }
    check(enforcedHere, 'a process limit of zero really stops a program being started on this computer')
    {
      // The folder-read cap and the short memory: many reads at once, few processes; a second read within a moment is the first one's answer.
      const d = make('memory')
      forgetGitReads()
      const first = await readGit(d, ENV)
      writeFileSync(join(d, 'later.txt'), 'x\n')
      const again = await readGit(d, ENV)
      forgetGitReads()
      const fresh = await readGit(d, ENV)
      check(first.kind === 'state' && again === first && fresh.kind === 'state' && fresh.state.untracked === 1, 'a second read within a moment is the first answer; a later one is read afresh')
    }
    const read = (dir: string): ReturnType<typeof readGit> => (forgetGitReads(), readGit(dir, ENV))
    const clean = make('clean')
    const r1 = await read(clean)
    check(r1.kind === 'state' && r1.state.branch === 'main' && r1.state.changed === 0 && r1.state.operation === null && r1.top === clean && /^[0-9a-f]{7}$/.test(r1.state.commit ?? ''), 'a clean repository: its branch, its commit, nothing changed', JSON.stringify(r1))
    writeFileSync(join(clean, 'a.txt'), 'one, changed\n')
    writeFileSync(join(clean, 'new.txt'), 'new\n')
    writeFileSync(join(clean, 'staged.txt'), 'staged\n')
    g(clean, 'add', 'staged.txt')
    mkdirSync(join(clean, 'sub'))
    writeFileSync(join(clean, 'sub', 'deep.txt'), 'deep\n')
    const r2 = await read(clean)
    check(r2.kind === 'state' && r2.state.unstaged === 1 && r2.state.staged === 1 && r2.state.untracked === 2 && r2.state.changed === 4, 'a changed file, a staged one, an untracked file and an untracked folder: four changed', JSON.stringify(r2))
    const r3 = await read(join(clean, 'sub'))
    check(r3.kind === 'state' && r3.top === clean && r3.state.changed === 4, 'read from a folder inside the repository, it is the same repository')
    check((await read(root)).kind === 'none' && (await read(join(root, 'no-such-folder'))).kind === 'none', 'a folder that is not in a repository, or is not there, has nothing to show')
    check((await readGit('relative/path', ENV)).kind === 'none' && (await readGit(`${clean}${Z}x`, ENV)).kind === 'none' && (await readGit('' as string, ENV)).kind === 'none', 'something that is not an absolute path is not read at all')
    const branchy = make('branchy')
    g(branchy, 'checkout', '-q', '-b', 'feat/thing')
    const r4 = await read(branchy)
    check(r4.kind === 'state' && r4.state.branch === 'feat/thing' && r4.state.upstream === null, 'another branch is named')
    g(branchy, 'checkout', '-q', '--detach')
    const r5 = await read(branchy)
    check(r5.kind === 'state' && r5.state.branch === null && r5.state.commit !== null, 'a detached HEAD has a commit and no branch')
    // Ahead and behind, against a real upstream.
    const up = join(root, 'upstream.git')
    g(root, 'clone', '-q', '--bare', clean, up)
    const local = join(root, 'local')
    g(root, 'clone', '-q', up, local)
    writeFileSync(join(local, 'c.txt'), 'c\n')
    g(local, 'add', '-A')
    g(local, 'commit', '-q', '-m', 'local one')
    g(local, 'commit', '-q', '--allow-empty', '-m', 'local two')
    const r6 = await read(local)
    check(r6.kind === 'state' && r6.state.upstream === 'origin/main' && r6.state.ahead === 2 && r6.state.behind === 0, 'two commits ahead of its upstream', JSON.stringify(r6))
    // A merge that conflicts.
    const m = make('merging')
    g(m, 'checkout', '-q', '-b', 'other')
    writeFileSync(join(m, 'a.txt'), 'theirs\n')
    g(m, 'commit', '-q', '-am', 'theirs')
    g(m, 'checkout', '-q', 'main')
    writeFileSync(join(m, 'a.txt'), 'ours\n')
    g(m, 'commit', '-q', '-am', 'ours')
    try {
      g(m, 'merge', '-q', 'other')
    } catch {
      /* the conflict is the point */
    }
    const r7 = await read(m)
    check(r7.kind === 'state' && r7.state.operation === 'merge' && r7.state.conflicted === 1 && r7.state.branch === 'main', 'a merge stopped on a conflict: said to be under way, with its conflicted file', JSON.stringify(r7))
    const fresh = join(root, 'fresh')
    mkdirSync(fresh)
    g(fresh, 'init', '-q', '.')
    const r8 = await read(fresh)
    check(r8.kind === 'state' && r8.state.commit === null && r8.state.branch === 'main', 'a repository with no commit yet reads as that')
    const both = await Promise.all([read(clean), read(clean), read(clean)])
    check(both.every((x) => x.kind === 'state' && x.state.changed === 4), 'three reads of one folder at once all answer')

    console.log('4. hostile repositories')
    // Each hostile repository names a program in its config. The program leaves a mark if it runs.
    let n = 0
    const hostile = async (label: string, setup: (dir: string, prog: string) => void, opts: { expectPlainRuns?: boolean; baseEnv?: Record<string, string> } = {}): Promise<void> => {
      const dir = make(`hostile-${++n}`)
      const mark = join(root, `mark-${n}`)
      const prog = join(root, `prog-${n}.sh`)
      writeFileSync(prog, `#!/bin/sh\necho ran >> ${JSON.stringify(mark)}\nexit 0\n`)
      chmodSync(prog, 0o755)
      setup(dir, prog)
      const t0 = Date.now()
      forgetGitReads()
      const r = await readGit(dir, { ...ENV, ...(opts.baseEnv ?? {}) })
      const took = Date.now() - t0
      check(!existsSync(mark), `${label}: Beacon's reading did not run the program`, existsSync(mark) ? readFileSync(mark, 'utf8') : '')
      check((r.kind === 'state' || r.kind === 'unreadable' || r.kind === 'none') && took < 9000, `${label}: and it answered (${r.kind}${r.kind === 'unreadable' ? `: ${r.why}` : ''}, ${took} ms)`)
      if (opts.expectPlainRuns !== false) {
        // The control: plain git, with the same environment, DOES run it. Without this the check above proves nothing.
        try {
          execFileSync('git', ['status', '--porcelain=v2'], { cwd: dir, env: { ...ENV, ...(opts.baseEnv ?? {}) }, stdio: 'ignore', timeout: 20000 })
        } catch {
          /* its exit code does not matter */
        }
        check(existsSync(mark), `${label}: (control) plain git status in the same folder does run it`)
      }
    }
    await hostile('core.fsmonitor', (dir, prog) => void g(dir, 'config', 'core.fsmonitor', prog))
    await hostile('a clean filter chosen by .gitattributes', (dir, prog) => {
      writeFileSync(join(dir, '.gitattributes'), '*.txt filter=evil\n')
      g(dir, 'config', 'filter.evil.clean', prog)
      // The same size as what is committed, and a newer time: git must hash it to know, and hashing runs the filter.
      writeFileSync(join(dir, 'a.txt'), 'ONE\n')
      const later = new Date(Date.now() + 5000)
      utimesSync(join(dir, 'a.txt'), later, later)
    })
    await hostile('a filter named in .git/info/attributes', (dir, prog) => {
      mkdirSync(join(dir, '.git', 'info'), { recursive: true })
      writeFileSync(join(dir, '.git', 'info', 'attributes'), '* filter=sneaky\n')
      g(dir, 'config', 'filter.sneaky.clean', prog)
      writeFileSync(join(dir, 'b.txt'), 'TWO\n')
      const later = new Date(Date.now() + 5000)
      utimesSync(join(dir, 'b.txt'), later, later)
    })
    await hostile('a long-running filter process', (dir, prog) => {
      writeFileSync(join(dir, '.gitattributes'), '* filter=proc\n')
      g(dir, 'config', 'filter.proc.process', prog)
      writeFileSync(join(dir, 'a.txt'), 'ONE\n')
      const later = new Date(Date.now() + 5000)
      utimesSync(join(dir, 'a.txt'), later, later)
    })
    await hostile('config included from another file', (dir, prog) => {
      writeFileSync(join(dir, 'extra.config'), `[core]\n\tfsmonitor = ${prog}\n`)
      g(dir, 'config', 'include.path', join(dir, 'extra.config'))
    })
    await hostile('a program that never returns', (dir, prog) => {
      writeFileSync(prog, `#!/bin/sh\necho ran >> ${JSON.stringify(join(root, `mark-${n}`))}\nsleep 600\n`)
      g(dir, 'config', 'core.fsmonitor', prog)
    }, { expectPlainRuns: false })
    await hostile('a program named git in the folder, and a PATH that would find it there', (dir, prog) => {
      writeFileSync(join(dir, 'git'), readFileSync(prog, 'utf8'))
      chmodSync(join(dir, 'git'), 0o755)
      mkdirSync(join(dir, 'node_modules', '.bin'), { recursive: true })
      writeFileSync(join(dir, 'node_modules', '.bin', 'git'), readFileSync(prog, 'utf8'))
      chmodSync(join(dir, 'node_modules', '.bin', 'git'), 0o755)
    }, { expectPlainRuns: false, baseEnv: { PATH: `.:node_modules/.bin::${process.env.PATH ?? '/usr/bin:/bin'}` } })
    {
      // The control for that one: a shell given that PATH, in that folder, does run the folder's "git".
      const dir = join(root, `hostile-${n}`)
      const mark = join(root, `mark-${n}`)
      try {
        execFileSync('/bin/sh', ['-c', 'exec "$@"', 'sh', 'git', 'status'], { cwd: dir, env: { ...ENV, PATH: `.:${ENV.PATH}` }, stdio: 'ignore', timeout: 20000 })
      } catch {
        /* its exit code does not matter */
      }
      check(existsSync(mark), '(control) a shell with "." on its PATH, in that folder, does run the file named git')
    }
    {
      // core.worktree pointing at another folder: that folder is not read.
      const dir = make('points-elsewhere')
      const other = join(root, 'other-folder')
      mkdirSync(other)
      for (let i = 0; i < 5; i++) writeFileSync(join(other, `secret-${i}.txt`), 'x\n')
      g(dir, 'config', 'core.worktree', other)
      const r = await read(dir)
      check(r.kind === 'none', `a repository whose settings point git at another folder is not read (${r.kind})`, JSON.stringify(r))
      const plain = execFileSync('git', ['status', '--porcelain=v2'], { cwd: dir, env: ENV, encoding: 'utf8', timeout: 20000 })
      check(/secret-0\.txt/.test(plain), '(control) plain git status there does list the other folder\'s files')
    }
    {
      // What a review found: a submodule-shaped git folder whose settings name a folder ABOVE the work folder as its work tree.
      const outer = join(root, 'outer')
      const inner = join(outer, 's')
      mkdirSync(inner, { recursive: true })
      for (let i = 0; i < 4; i++) writeFileSync(join(outer, `private-${i}.txt`), 'x\n')
      g(outer, 'init', '-q', '.')
      mkdirSync(join(outer, '.git', 'modules'), { recursive: true })
      g(root, 'clone', '-q', '--bare', clean, join(outer, '.git', 'modules', 'm'))
      g(join(outer, '.git', 'modules', 'm'), 'config', 'core.bare', 'false')
      g(join(outer, '.git', 'modules', 'm'), 'config', 'core.worktree', outer)
      writeFileSync(join(inner, '.git'), 'gitdir: ../.git/modules/m\n')
      forgetGitReads()
      const open = await readGit(inner, ENV)
      forgetGitReads()
      const held = await readGit(inner, ENV, (top) => top === inner)
      check(open.kind === 'none' && held.kind === 'none', "a submodule-shaped git folder whose settings name the folder above as its work tree is not read, with or without the caller's rule for tops: a submodule's store belongs to a folder above it, not to itself", JSON.stringify(open).slice(0, 160))
    }
    {
      // The panel's reads, on a real repository, and on one whose settings name programs for diff and log.
      const dir = make('panel')
      writeFileSync(join(dir, 'a.txt'), 'one, edited\n')
      writeFileSync(join(dir, 'staged.txt'), 'staged content\n')
      g(dir, 'add', 'staged.txt')
      writeFileSync(join(dir, 'new file.txt'), 'brand new\n')
      mkdirSync(join(dir, 'newdir'))
      writeFileSync(join(dir, 'newdir', 'x.txt'), 'x\n')
      const mark = join(root, 'mark-diff')
      const prog = join(root, 'prog-diff.sh')
      writeFileSync(prog, `#!/bin/sh\necho ran >> ${JSON.stringify(mark)}\ncat "$2" 2>/dev/null\nexit 0\n`)
      chmodSync(prog, 0o755)
      g(dir, 'config', 'diff.external', prog)
      writeFileSync(join(dir, '.gitattributes'), '*.txt diff=evil\n')
      g(dir, 'config', 'diff.evil.textconv', prog)
      g(dir, 'config', 'diff.evil.command', prog)
      g(dir, 'config', 'log.showSignature', 'true')
      g(dir, 'config', 'gpg.program', prog)
      const detail = await readGitDetail(dir, ENV)
      check(detail.kind === 'detail' && detail.entries.map((e) => e.path).sort().join('|') === '.gitattributes|a.txt|new file.txt|newdir/|staged.txt' && detail.commits.length === 0, 'the panel lists the changed files (no upstream, so no commits ahead)', JSON.stringify(detail).slice(0, 300))
      const un = await readGitDiff(dir, 'a.txt', 'unstaged', ENV)
      check(un.kind === 'diff' && /^-one$/m.test(un.text) && /^\+one, edited$/m.test(un.text) && !un.truncated, "a changed file's diff is the real one", JSON.stringify(un).slice(0, 200))
      const st = await readGitDiff(dir, 'staged.txt', 'staged', ENV)
      check(st.kind === 'diff' && /^\+staged content$/m.test(st.text), "a staged file's diff compares the index")
      const nw = await readGitDiff(dir, 'new file.txt', 'untracked', ENV)
      check(nw.kind === 'diff' && /^\+brand new$/m.test(nw.text), "a new file's diff is the whole file, added")
      check(!existsSync(mark), "none of that ran the repository's diff tool or textconv filter")
      try {
        execFileSync('git', ['diff', '--', 'a.txt'], { cwd: dir, env: ENV, stdio: 'ignore', timeout: 20000 })
      } catch {
        /* its exit code does not matter */
      }
      check(existsSync(mark), '(control) plain git diff in that folder does run the program')
      // The path is the page's word: it is used only if git lists it, that way.
      for (const [p, mode] of [['b.txt', 'unstaged'], ['a.txt', 'staged'], ['a.txt', 'untracked'], ['newdir/', 'untracked'], ['newdir/x.txt', 'untracked'], ['staged.txt', 'untracked'], ['../clean/a.txt', 'unstaged'], ['/etc/hosts', 'untracked'], ['.git/config', 'untracked'], ['--output=x', 'unstaged'], ['a.txt', 'everything']] as const) {
        const r = await readGitDiff(dir, p, mode, ENV)
        check(r.kind === 'none', `no diff for ${JSON.stringify(p)} as ${mode}: git does not list it that way`, JSON.stringify(r).slice(0, 120))
      }
      check((await readGitDiff(dir, 'a.txt', 'unstaged', ENV, () => false)).kind === 'none' && (await readGitDetail(dir, ENV, () => false)).kind === 'none', "and the caller's rule for repository tops holds for the panel's reads too")
      // Commits ahead, against a real upstream.
      const localDetail = await readGitDetail(local, ENV)
      check(localDetail.kind === 'detail' && localDetail.commits.map((c) => c.subject).join('|') === 'local two|local one' && localDetail.commits.every((c) => /^[0-9a-f]{7,}$/.test(c.hash)), 'the commits the upstream lacks are listed, newest first', JSON.stringify(localDetail).slice(0, 200))
    }
    {
      // What a review found: three ways to make a diff or a log print ANOTHER repository's committed
      // files, and two ways to make an untracked "file" be something outside the folder.
      const victim = make('victim')
      writeFileSync(join(victim, 'private.env'), 'TOP-SECRET-OF-ANOTHER-REPOSITORY\n')
      g(victim, 'add', '-A')
      g(victim, 'commit', '-q', '-m', 'the victim keeps a secret subject')
      const leaks = (r: unknown): boolean => /TOP-SECRET|secret subject/.test(JSON.stringify(r))
      // 1. a commondir file
      const b1 = join(root, 'borrow-commondir')
      mkdirSync(b1)
      g(b1, 'init', '-q', '.')
      writeFileSync(join(b1, '.git', 'commondir'), `${join(victim, '.git')}\n`)
      const d1 = await readGitDetail(b1, ENV)
      const r1 = await readGitDiff(b1, 'private.env', 'staged', ENV)
      const plainStatus = execFileSync('git', ['status', '--porcelain=v2'], { cwd: b1, env: ENV, encoding: 'utf8', timeout: 20000 })
      check(/private\.env/.test(plainStatus), "(control) a repository given a commondir file does list the other repository's file as its own")
      check(!leaks(r1) && r1.kind === 'unreadable' && r1.why === GIT_BORROWED && d1.kind === 'unreadable' && d1.why === GIT_BORROWED && !/private\.env/.test(JSON.stringify(d1)), "its list and its diff are refused, with why: not even the other repository's file names are shown", JSON.stringify([d1, r1]).slice(0, 200))
      let plainLeak = ''
      try {
        plainLeak = execFileSync('git', ['diff', '--cached', '--', 'private.env'], { cwd: b1, env: ENV, encoding: 'utf8', timeout: 20000 })
      } catch {
        /* its exit code does not matter */
      }
      check(/TOP-SECRET/.test(plainLeak), "(control) plain git diff there does print the other repository's file")
      // 2. alternates, with a ref that is a link
      const b2 = make('borrow-alternates')
      mkdirSync(join(b2, '.git', 'objects', 'info'), { recursive: true })
      writeFileSync(join(b2, '.git', 'objects', 'info', 'alternates'), `${join(victim, '.git', 'objects')}\n`)
      rmSync(join(b2, '.git', 'refs', 'heads', 'main'), { force: true })
      symlinkSync(join(victim, '.git', 'refs', 'heads', 'main'), join(b2, '.git', 'refs', 'heads', 'main'))
      const d2 = await readGitDetail(b2, ENV)
      const some2 = d2.kind === 'detail' ? d2.entries.find((e) => e.kind === 'changed') : undefined
      const r2 = some2 ? await readGitDiff(b2, some2.path, some2.index !== '.' ? 'staged' : 'unstaged', ENV) : null
      check(d2.kind === 'unreadable' && d2.why === GIT_BORROWED && !leaks(d2) && !leaks(r2), 'a repository with a list of other object stores shows no list, no diff and no commit subjects', JSON.stringify([d2.kind, r2]).slice(0, 200))
      // 3. an index that is a link
      const b3 = make('borrow-index')
      rmSync(join(b3, '.git', 'index'))
      symlinkSync(join(victim, '.git', 'index'), join(b3, '.git', 'index'))
      const d3 = await readGitDetail(b3, ENV)
      const any3 = d3.kind === 'detail' ? d3.entries.find((e) => e.kind === 'changed') : undefined
      const r3 = any3 ? await readGitDiff(b3, any3.path, any3.index !== '.' ? 'staged' : 'unstaged', ENV) : null
      check(d3.kind === 'unreadable' && d3.why === GIT_BORROWED && !leaks(r3), "nor does one whose index is a link to another repository's", JSON.stringify([d3.kind, r3]).slice(0, 160))
      // 4. a .git file pointing at ANOTHER repository's existing worktree store (nothing of the victim is written)
      const vTree = join(root, 'victim-tree')
      g(victim, 'worktree', 'add', '-q', vTree, '-b', 'side')
      const b4 = join(root, 'borrow-worktree')
      mkdirSync(b4)
      writeFileSync(join(b4, '.git'), `gitdir: ${join(victim, '.git', 'worktrees', 'victim-tree')}\n`)
      const s4 = await read(b4)
      const d4 = await readGitDetail(b4, ENV)
      const r4 = await readGitDiff(b4, 'private.env', 'unstaged', ENV)
      check(s4.kind === 'none' && d4.kind === 'none' && r4.kind === 'none' && !leaks([s4, d4, r4]), "a folder whose .git file points at another repository's worktree store is not read at all: that store does not name this folder back", JSON.stringify([s4.kind, d4.kind, r4.kind]))
      let plain4 = ''
      try {
        plain4 = execFileSync('git', ['diff', 'HEAD', '--', 'private.env'], { cwd: b4, env: ENV, encoding: 'utf8', timeout: 20000 })
      } catch {
        /* its exit code does not matter */
      }
      check(/TOP-SECRET/.test(plain4), "(control) plain git diff there does print the other repository's file")
      // And a real linked worktree of this repository still reads.
      writeFileSync(join(vTree, 'a.txt'), 'changed in the worktree\n')
      const realTree = await readGitDetail(vTree, ENV)
      const realDiff = await readGitDiff(vTree, 'a.txt', 'unstaged', ENV)
      check(realTree.kind === 'detail' && realTree.entries.some((e) => e.path === 'a.txt') && realDiff.kind === 'diff' && /^\+changed in the worktree$/m.test(realDiff.text), 'a real linked worktree is listed and its diffs are shown', JSON.stringify([realTree.kind, realDiff.kind]))
      // Untracked "files" that are not files of this folder.
      const outside = join(root, 'outside-folder')
      mkdirSync(outside)
      writeFileSync(join(outside, 'null'), 'OUTSIDE-NULL-CONTENT\n')
      writeFileSync(join(outside, 'secret.txt'), 'OUTSIDE-SECRET-CONTENT\n')
      const u = make('untracked-tricks')
      symlinkSync(outside, join(u, 'x'))
      symlinkSync(join(outside, 'secret.txt'), join(u, 'leaf.txt'))
      const dirLink = await readGitDiff(u, 'x', 'untracked', ENV)
      check(dirLink.kind === 'diff' && !/OUTSIDE/.test(dirLink.text) && /a link to /.test(dirLink.text), 'an untracked link to a folder is shown as a link (git, asked to diff it, printed a file from inside that folder)', JSON.stringify(dirLink).slice(0, 200))
      const leafLink = await readGitDiff(u, 'leaf.txt', 'untracked', ENV)
      check(leafLink.kind === 'diff' && !/OUTSIDE/.test(leafLink.text) && /a link to /.test(leafLink.text), 'an untracked link to a file is shown as a link, not followed')
      // A folder on the way, swapped for a link to outside after git listed the file.
      mkdirSync(join(u, 'sub'))
      writeFileSync(join(u, 'sub', 'tracked.txt'), 't\n')
      g(u, 'add', 'sub/tracked.txt')
      g(u, 'commit', '-q', '-m', 'sub')
      writeFileSync(join(u, 'sub', 'secret.txt'), 'inside, harmless\n')
      const inside = await readGitDiff(u, 'sub/secret.txt', 'untracked', ENV)
      check(inside.kind === 'diff' && /^\+inside, harmless$/m.test(inside.text), '(control) an ordinary untracked file in a subfolder is shown')
      renameSync(join(u, 'sub'), join(u, 'sub-real'))
      symlinkSync(outside, join(u, 'sub'))
      const swapped = await readUntracked(u, 'sub/secret.txt')
      check(!/OUTSIDE/.test(JSON.stringify(swapped)) && swapped.kind === 'unreadable' && /link to outside this folder/.test(swapped.why), "the same path, once a folder on the way has become a link to outside, is refused: its file is not this folder's", JSON.stringify(swapped).slice(0, 200))
      rmSync(join(u, 'sub'))
      renameSync(join(u, 'sub-real'), join(u, 'sub'))
      // Other things an untracked path can be.
      writeFileSync(join(u, 'big.bin'), Buffer.alloc(UNTRACKED_MAX_BYTES + 1, 65))
      writeFileSync(join(u, 'image.dat'), Buffer.from([1, 2, 0, 3, 4]))
      let fifo = true
      try {
        execFileSync('mkfifo', [join(u, 'pipe')])
      } catch {
        fifo = false
      }
      const tBig = await readUntracked(u, 'big.bin')
      const tBin = await readUntracked(u, 'image.dat')
      const t0 = Date.now()
      const tPipe = fifo ? await readUntracked(u, 'pipe') : { kind: 'none' as const }
      check(tBig.kind === 'unreadable' && /too large/.test(tBig.why) && tBin.kind === 'diff' && tBin.text === 'Binary file, 5 bytes.\n' && tPipe.kind === 'none' && Date.now() - t0 < 1500, 'a very large file is not read, a binary one is named as such, and a pipe is not opened (and not waited on)')
      check((await readUntracked(u, '../victim/private.env')).kind === 'none' && (await readUntracked(u, '/etc/hosts')).kind === 'none' && (await readUntracked('relative', 'a.txt')).kind === 'none' && (await readUntracked(u, 'no-such-file.txt')).kind === 'unreadable', 'a path that climbs out, an absolute path, and a file that is not there are not read')
    }
    {
      // From a subfolder of the repository, a conflicted file, and a signed commit in the log.
      const sub = join(clean, 'sub')
      forgetGitReads()
      const fromSub = await readGitDetail(sub, ENV)
      const subDiff = await readGitDiff(sub, 'a.txt', 'unstaged', ENV)
      check(fromSub.kind === 'detail' && fromSub.entries.some((e) => e.path === 'a.txt') && subDiff.kind === 'diff' && /^\+one, changed$/m.test(subDiff.text), 'asked from a folder inside the repository, the files are listed from its top and a diff is of the right file')
      const conflict = await readGitDetail(m, ENV)
      const clash = conflict.kind === 'detail' ? conflict.entries.find((e) => e.kind === 'conflicted') : undefined
      const clashDiff = clash ? await readGitDiff(m, clash.path, 'unstaged', ENV) : null
      check(!!clash && entryHasDiff(clash, 'unstaged') && clashDiff?.kind === 'diff' && /^diff --cc /m.test(clashDiff.text) && /^\+\+<<<<<<< /m.test(clashDiff.text), "a conflicted file's diff is git's combined one, with both sides", JSON.stringify(clashDiff).slice(0, 200))
      // A commit that claims a signature: showing it would start the signature checker.
      const mark = join(root, 'mark-gpg')
      const prog = join(root, 'prog-gpg.sh')
      writeFileSync(prog, `#!/bin/sh\necho ran >> ${JSON.stringify(mark)}\nexit 1\n`)
      chmodSync(prog, 0o755)
      const raw = g(local, 'cat-file', '-p', 'HEAD')
      const cut = raw.indexOf('\n\n')
      const signed = `${raw.slice(0, cut)}\ngpgsig -----BEGIN PGP SIGNATURE-----\n \n iQEzBAABCAAdFiEE\n -----END PGP SIGNATURE-----${raw.slice(cut)}`
      const oid = execFileSync('git', ['hash-object', '-t', 'commit', '-w', '--stdin'], { cwd: local, env: ENV, input: signed, encoding: 'utf8' }).trim()
      g(local, 'update-ref', 'HEAD', oid)
      g(local, 'config', 'log.showSignature', 'true')
      g(local, 'config', 'gpg.program', prog)
      const signedDetail = await readGitDetail(local, ENV)
      check(signedDetail.kind === 'detail' && signedDetail.commits.length === 2 && !existsSync(mark), 'the commits not yet upstream are listed without the signature checker being started, even when the repository asks for it', JSON.stringify(signedDetail).slice(0, 160))
      try {
        execFileSync('git', ['log', '-n', '1'], { cwd: local, env: ENV, stdio: 'ignore', timeout: 20000 })
      } catch {
        /* its exit code does not matter */
      }
      check(existsSync(mark), '(control) plain git log there does start it')
    }
    {
      // The pull request, against a real repository with a GitHub remote and a stand-in gh.
      const repo = make('with-remote')
      g(repo, 'checkout', '-q', '-b', 'feat/git-panel')
      g(repo, 'remote', 'add', 'origin', 'https://github.com/OAraLabs/Beacon.git')
      g(repo, 'update-ref', 'refs/remotes/origin/feat/git-panel', 'HEAD')
      g(repo, 'branch', '-q', '--set-upstream-to=origin/feat/git-panel')
      const fakeDir = join(root, 'fake-bin')
      mkdirSync(fakeDir)
      const fake = join(fakeDir, 'gh')
      const callLog = join(root, 'gh-calls.log')
      // The real answer gh gave for this repository's merged pull request, as the stand-in's answer.
      const answer = join(root, 'gh-answer.json')
      writeFileSync(answer, JSON.stringify((JSON.parse(readFileSync(join(process.cwd(), 'scripts', 'fixtures', 'gh-pr-list.json'), 'utf8')) as { merged: unknown }).merged))
      // A stand-in gh: records where it was run and with what, and gives that answer.
      writeFileSync(fake, `#!/bin/sh\necho "cwd=$(pwd) args=$*" >> ${JSON.stringify(callLog)}\necho "env=$(env | sort | tr '\\n' ' ')" >> ${JSON.stringify(callLog)}\ncat ${JSON.stringify(answer)}\n`)
      chmodSync(fake, 0o755)
      const calls = (): number => (existsSync(callLog) ? (readFileSync(callLog, 'utf8').match(/^cwd=/gm) ?? []).length : 0)
      resetGitPr([fake])
      const pr1 = await readGitPr(repo, ENV)
      const log1 = existsSync(callLog) ? readFileSync(callLog, 'utf8') : ''
      check(pr1.kind === 'pr' && pr1.pr.number === 65 && pr1.pr.state === 'merged' && pr1.pr.url === 'https://github.com/OAraLabs/Beacon/pull/65', "a branch pushed to a GitHub remote: its pull request, read from gh's answer", JSON.stringify(pr1))
      check(/^cwd=\/ args=pr list --repo OAraLabs\/Beacon --head feat\/git-panel --state all --limit 5 --json /m.test(log1), 'gh was run at the top of the disk, not in the repository, and told the repository and branch by name', log1.slice(0, 200))
      const envLine = log1.split('\n').find((l) => l.startsWith('env=')) ?? 'GIT_'
      check(!/GIT_|GH_TOKEN|GITHUB_TOKEN/.test(envLine) && /GH_HOST=github\.com/.test(envLine), 'with no git or token variable in its environment, and the host fixed')
      await readGitPr(repo, ENV)
      await readGitPr(repo, ENV)
      check(calls() === 1, 'asked again within the minute, GitHub is not asked again')
      // Nothing to ask about.
      resetGitPr([fake])
      rmSync(callLog)
      check((await readGitPr(clean, ENV)).kind === 'none' && (await readGitPr(root, ENV)).kind === 'none' && calls() === 0, 'a branch with no upstream, and a folder that is not a repository, ask gh nothing')
      const lab = make('other-host')
      g(lab, 'remote', 'add', 'origin', 'https://gitlab.com/acme/site.git')
      g(lab, 'update-ref', 'refs/remotes/origin/main', 'HEAD')
      g(lab, 'branch', '-q', '--set-upstream-to=origin/main')
      check((await readGitPr(lab, ENV)).kind === 'none' && calls() === 0, 'a remote that is not github.com asks gh nothing')
      // A repository's settings cannot turn the question into something else.
      const sly = make('sly-remote')
      g(sly, 'remote', 'add', 'origin', 'https://github.com/acme/site.git')
      g(sly, 'config', 'remote.origin.url', 'https://github.com/acme/site --web --repo evil/x')
      g(sly, 'update-ref', 'refs/remotes/origin/main', 'HEAD')
      g(sly, 'branch', '-q', '--set-upstream-to=origin/main')
      check((await readGitPr(sly, ENV)).kind === 'none' && calls() === 0, 'a remote address with anything after the repository in it is not asked about')
      check((await readGitPr(repo, ENV, () => false)).kind === 'none', "and the caller's rule for repository tops holds here too")
      // No more than a few questions a minute, whatever is asked about: a branch renamed again and again is not a stream of questions.
      resetGitPr([fake])
      const kinds: string[] = []
      for (let i = 0; i < 9; i++) {
        g(repo, 'branch', '-q', '-m', `spin-${i}`)
        g(repo, 'update-ref', `refs/remotes/origin/spin-${i}`, 'HEAD')
        g(repo, 'branch', '-q', `--set-upstream-to=origin/spin-${i}`)
        kinds.push((await readGitPr(repo, ENV)).kind)
      }
      check(calls() === 6 && kinds.slice(0, 6).every((k) => k === 'none') && kinds.slice(6).every((k) => k === 'unknown'), 'nine branches in a row: six questions reach gh, the rest are "not known just now"', `${calls()} ${kinds.join()}`)
      // No gh at all: none, and remembered.
      resetGitPr([join(root, 'no-such-dir', 'gh')])
      const t0 = Date.now()
      const absent = await readGitPr(repo, ENV)
      const again = await readGitPr(repo, ENV)
      check(absent.kind === 'none' && again.kind === 'none' && Date.now() - t0 < 4000, 'with no gh on this computer there is simply no pull request state')
      // gh that fails (not signed in): not known, and not an error.
      const failing = join(fakeDir, 'gh-fails')
      writeFileSync(failing, '#!/bin/sh\necho "HTTP 401: Requires authentication" >&2\nexit 1\n')
      chmodSync(failing, 0o755)
      resetGitPr([failing])
      check((await readGitPr(repo, ENV)).kind === 'unknown', 'a gh that is not signed in, or cannot reach GitHub, is "not known just now", not "no pull request"')
      // gh that never answers, with a helper of its own still running: stopped, helper and all, and not asked again for a while.
      const stuck = join(fakeDir, 'gh-stuck')
      const helperMark = `beacon-smoke-helper-${process.pid}`
      writeFileSync(stuck, `#!/bin/sh\necho x >> ${JSON.stringify(callLog)}.stuck\n/bin/sh -c 'exec -a ${helperMark} sleep 300' &\nwait\n`)
      chmodSync(stuck, 0o755)
      resetGitPr([stuck])
      const t1 = Date.now()
      const stalled = await readGitPr(repo, ENV)
      const took = Date.now() - t1
      await new Promise((r) => setTimeout(r, 300))
      let left = ''
      try {
        left = execFileSync('/usr/bin/pgrep', ['-f', helperMark], { encoding: 'utf8' })
      } catch {
        /* pgrep exits 1 when it finds none */
      }
      check(stalled.kind === 'unknown' && took >= 7000 && took < 12000 && left.trim() === '', `a gh that does not answer is stopped after its time (${took} ms), with the helper it started, and the answer is "not known"`, left)
      g(repo, 'branch', '-q', '-m', 'after-stall')
      g(repo, 'update-ref', 'refs/remotes/origin/after-stall', 'HEAD')
      g(repo, 'branch', '-q', '--set-upstream-to=origin/after-stall')
      const t2 = Date.now()
      check((await readGitPr(repo, ENV)).kind === 'unknown' && Date.now() - t2 < 3000, 'and gh is not started again for a while after that, whatever is asked about')
      resetGitPr()
    }
    await hostile("settings smuggled in through Beacon's own environment", () => undefined, { expectPlainRuns: false, baseEnv: { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.fsmonitor', GIT_CONFIG_VALUE_0: join(root, `prog-${n + 1}.sh`) } })
    {
      // A folder dressed up as a bare repository, with a config of its own.
      const dir = join(root, 'dressed-up')
      const mark = join(root, 'mark-bare')
      const prog = join(root, 'prog-bare.sh')
      writeFileSync(prog, `#!/bin/sh\necho ran >> ${JSON.stringify(mark)}\n`)
      chmodSync(prog, 0o755)
      g(root, 'clone', '-q', '--bare', clean, dir)
      g(dir, 'config', 'core.fsmonitor', prog)
      g(dir, 'config', 'core.bare', 'false')
      g(dir, 'config', 'core.worktree', clean)
      const r = await read(dir)
      check(!existsSync(mark) && r.kind === 'none', `a folder dressed up as a bare repository is not read as one, and its program does not run (${r.kind})`)
      try {
        execFileSync('git', ['status', '--porcelain=v2'], { cwd: dir, env: ENV, stdio: 'ignore', timeout: 20000 })
      } catch {
        /* its exit code does not matter */
      }
      check(existsSync(mark), '(control) plain git status in that folder does treat it as a repository and runs the program')
    }
    {
      // A submodule whose own config names a program: not entered.
      const parent = make('with-submodule')
      const mark = join(root, 'mark-sub')
      const prog = join(root, 'prog-sub.sh')
      writeFileSync(prog, `#!/bin/sh\necho ran >> ${JSON.stringify(mark)}\n`)
      chmodSync(prog, 0o755)
      try {
        g(parent, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', up, 'sub')
        g(parent, 'commit', '-q', '-m', 'add submodule')
        g(join(parent, 'sub'), 'config', 'core.fsmonitor', prog)
        writeFileSync(join(parent, 'sub', 'a.txt'), 'changed in the submodule\n')
        const r = await read(parent)
        check(!existsSync(mark) && r.kind === 'state', `a submodule with its own hostile config is not entered (${r.kind})`)
        try {
          execFileSync('git', ['status', '--porcelain=v2'], { cwd: parent, env: ENV, stdio: 'ignore', timeout: 20000 })
        } catch {
          /* its exit code does not matter */
        }
        check(existsSync(mark), '(control) plain git status in the parent does enter the submodule and run its program')
      } catch (e) {
        check(false, 'the submodule case could be set up', String(e).slice(0, 200))
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }

  console.log('5. wiring')
  {
    const read = (p: string): string => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8')
    const main = read('src/main/index.ts')
    const reader = read('src/main/git-reader.ts')
    const handler = main.slice(main.indexOf('const gitFolderFor = async'), main.indexOf('handleFromShell(IPC.WORK_FOLDER_WHERE'))
    check(handler.length > 0 && /if \(\(await proveHere\(\)\) !== 'here'\) return null/.test(handler), 'main reads git only when Prometheus has been proved to share this disk')
    check(/getDaemon\(`\/api\/sessions\/\$\{encodeURIComponent\(sessionId\)\}\/workspace`\)/.test(handler) && handler.indexOf('proveHere()') < handler.indexOf('getDaemon(') && handler.indexOf('getDaemon(') < handler.indexOf('readGit('), 'the folder is the one Prometheus names for that conversation, asked after the proof and before the reading')
    check(/async \(_e, sessionId: unknown\)/.test(handler) && !/folder: unknown\)|folder: string\)/.test(handler) && (main.match(/readGit\(/g) ?? []).length === 1, 'the page names a conversation, never a path, and this is the one place main reads git')
    check(/if \(conn !== connection \|\| typeof folder !== 'string'\) return null/.test(handler), 'an answer from a connection that has since been replaced is not used')
    check(/if \(folderProblem\(folder, home\) !== ''\) return null/.test(handler) && handler.indexOf('folderProblem(folder') < handler.indexOf('readGit(') && /return \{ folder, topAllowed: \(top\) => folderProblem\(top, home\) === '' \}/.test(handler) && /return at \? readGit\(at\.folder, process\.env, at\.topAllowed\) : none/.test(handler), "only a folder Beacon would let a person choose as a work folder is read, whatever set the binding, and the repository's top is held to the same rule")
    check(reader.indexOf('if (!topAllowed(at.top))') > 0 && reader.indexOf('if (!topAllowed(at.top))') < reader.indexOf('GIT_STATUS_ARGS], folder, o.env)') && (reader.match(/await open\(folder, baseEnv, topAllowed\)/g) ?? []).length === 3, 'the top is judged before status, the command that walks the folder, is run, on every one of the three reads')
    check(/if \(going && going\.conn === conn\) return going\.answer/.test(handler) && /if \(known && known\.conn === conn\) return known\.verdict/.test(main), 'one question per conversation at a time, and the shared-disk proof is good only for the connection it was made on')
    check(/handleFromShell\(IPC\.GIT_DETAIL, async \(_e, sessionId: unknown\)[\s\S]{0,260}const at = await gitFolderFor\(sessionId\)/.test(main) && /handleFromShell\(IPC\.GIT_DIFF, async \(_e, sessionId: unknown, path: unknown, mode: unknown\)[\s\S]{0,420}const at = await gitFolderFor\(sessionId\)\s*return at \? readGitDiff\(at\.folder, path, mode, process\.env, at\.topAllowed\)/.test(main) && (main.match(/gitFolderFor\(/g) ?? []).length === 4, "the panel's two reads find their folder the same way: the conversation's, proved here, allowed")
    check(/if \(going && going\.conn === conn\) return going\.answer as Promise<T>/.test(main) && /oncePer\(`detail\\n\$\{sessionId\}`/.test(main) && /oncePer\(`diff\\n\$\{sessionId\}\\n\$\{mode\}\\n\$\{path\}`/.test(main) && /if \(waiting\.length >= WAITING_MAX\) return BUSY/.test(reader) && /const WAITING_MAX = 16/.test(reader), 'the same question asked again while it is being answered is one question, and no more than a few reads wait their turn')
    check(/const entry = parseGitEntries\(out\)\?\.entries\.find\(\(e\) => e\.path === path\)\s*if \(!entry \|\| !entryHasDiff\(entry, mode\)\) return \{ kind: 'none' \}/.test(reader), 'a diff is read only for a path git itself has just listed, in the way it was listed')
    const prSrc = read('src/main/git-pr.ts')
    check(/spawn\(place, \[\.\.\.args\], \{ cwd: '\/', env, detached: true, stdio: \['ignore', 'pipe', 'ignore'\]/.test(prSrc) && (prSrc.match(/spawn\(/g) ?? []).length === 1 && /process\.kill\(-child\.pid, 'SIGKILL'\)/.test(prSrc) && /const args = ghPrArgs\(repo, up\.branch\)/.test(prSrc) && !/shell: true|execFile/.test(prSrc), 'gh is started in one place: at the top of the disk, as the head of its own group so that all of it can be stopped, and only with arguments ghPrArgs made')
    check(/handleFromShell\(IPC\.GIT_PR, async \(_e, sessionId: unknown\)[\s\S]{0,300}const at = await gitFolderFor\(sessionId\)\s*return at \? readGitPr\(at\.folder, process\.env, at\.topAllowed\)/.test(main), "the pull request is asked for the conversation's own folder, found the same way as every other git read")
    const untrackedSrc = read('src/main/git-untracked.ts')
    check(/if \(mode === 'untracked'\) return readUntracked\(o\.at\.top, path\)/.test(reader) && reader.indexOf("if (!entry || !entryHasDiff(entry, mode)) return { kind: 'none' }") < reader.indexOf('readUntracked(o.at.top, path)') && /O_RDONLY \| constants\.O_NOFOLLOW \| constants\.O_NONBLOCK/.test(untrackedSrc) && /if \(!real\.startsWith\(realTop === '\/' \? '\/' : `\$\{realTop\}\/`\)\)/.test(untrackedSrc), 'a file git does not track is read by Beacon itself, only once git has listed it, only if it is really inside the top, without following a link')
    check(/if \(!\(await ownStore\(o\)\)\) return \{ kind: 'unreadable', why: GIT_BORROWED \}/.test(reader) && reader.indexOf("if (!(await ownStore(o))) return { kind: 'unreadable'") < reader.indexOf('const r = await run([o.git, ...args], o.at.top, o.env)') && (reader.match(/if \(!\(await ownStore\(o\)\)\) return \{ kind: 'unreadable', why: GIT_BORROWED \}/g) ?? []).length === 2 && /if \(at\.linked\) \{\s*const back = await run\(\['\/bin\/cat', '--', `\$\{at\.gitDir\}\/gitdir`\], '\/', env\)\s*if \(back\.code !== 0 \|\| !worktreeNamesBack\(at\.top, at\.gitDir, back\.out\)\) return \{ kind: 'none' \}/.test(reader), "the file list, a tracked file's diff and the commit subjects are read only from a repository whose store is its own, and a linked worktree only if its store names the folder back")
    check((reader.match(/execFile\(/g) ?? []).length === 1 && (reader.match(/'exec "\$@"'/g) ?? []).length === 2 && /execFile\(SH, \['-c', script, 'sh', \.\.\.argv\]/.test(reader) && !/exec\(|spawn\(|shell: true/.test(reader), 'every command the reader runs goes through the one call that applies the process limit, with its arguments as data; the two that run without it (the self-test control, and asking where git is) run at the top of the disk, never in the folder')
    check(/timeout: timeMs, killSignal: 'SIGKILL', maxBuffer: OUT_MAX/.test(reader) && /script = NO_FORK_SCRIPT, timeMs = TIME_MS\)/.test(reader) && /const ONCE_TIME_MS = 20_000/.test(reader) && /if \(!\(await forkLimitEnforced\(probeEnv\)\)\) return \{ kind: 'unreadable', why: GIT_UNSAFE_HERE \}/.test(reader) && /if \(free\.code !== 0 \|\| !\/\^started:0\$\/m\.test\(free\.out\)\) return false/.test(reader) && /if \(limited\.timedOut \|\| limited\.code === null\) return false/.test(reader), 'each has a time limit and an output limit; nothing is read where the process limit is not enforced, and the self-test counts as passed only when the probe ran both without the limit (and worked) and under it (and did not)')
    const store = read('src/renderer/src/git-store.ts')
    check(/if \(here === null\) return \/\/ watchers ask again once the answer is in/.test(store) && /if \(!here\) return/.test(store) && /if \(!b \|\| \(daemon !== true && here !== true\)\) return/.test(store) && /if \(daemon === null\) return/.test(store), 'the window asks for nothing until main has said Prometheus shares this disk, and nothing at all when it does not')
    check(/\(w\) => \(w\.verdict === 'unknown' \? null : w\.here === true\)/.test(store) && /if \(answer === null\) \{[\s\S]{0,200}window\.setTimeout\(askHere, Math\.min\(30_000, 1000 \* 2 \*\* hereTries\+\+\)\)/.test(store), '"could not be told just now" is not "no": it is asked again, less and less often')
    check(/epoch\+\+\s*here = null\s*hereTries = 0\s*daemon = null\s*daemonDenied = false[\s\S]{0,300}entries\.clear\(\)\s*prs\.clear\(\)\s*prAsking\.clear\(\)\s*prQueue\.length = 0\s*asking\.clear\(\)\s*queue\.length = 0/.test(store) && (store.match(/if \(asked !== epoch\) return/g) ?? []).length >= 3, "another Prometheus, or a reconnection, forgets what was read, and an answer still on its way from the old one is ignored")
    check(/while \(asking\.size < AT_ONCE && queue\.length > 0\)/.test(store) && /const AT_ONCE = 3/.test(store) && /queue\.findIndex\(\(id\) => openIds\.has\(id\)\)/.test(store), 'at most three questions are with main at a time, the open conversation first')
    check(/if \(showing\(\)\) requestGit\(id, \{ open \}\)/.test(store) && /document\.addEventListener\('visibilitychange', ask\)/.test(store), 'a window that is not showing asks nothing, and asks again when it is shown')
    check(/window\.addEventListener\(WORKSPACE_CHANGED,[\s\S]{0,160}requestGit\(id, \{ force: true \}\)/.test(store) && /const WORKSPACE_CHANGED = 'beacon:workspace-changed'/.test(store) && /export const WORKSPACE_CHANGED = 'beacon:workspace-changed'/.test(read('src/renderer/src/components/WorkFolderChip.tsx')) && /if \(opts\.force\) going\.again = true/.test(store), "a conversation whose folder changes is read again at once, even if a read was already under way")
    check(/const branch = read\.kind === 'state' && read\.state\.branch && read\.state\.upstream \? read\.state\.branch : null/.test(store) && /Date\.now\(\) - now\.at < \(now\.retry \? PR_RETRY_MS : open \? PR_OPEN_MS : PR_ROW_MS\)/.test(store) && /const PR_OPEN_MS = 60_000\s*const PR_ROW_MS = 5 \* 60_000/.test(store) && /prAsking\.size >= 1/.test(store), 'the window asks about a pull request only for a branch that has an upstream, one question at a time, once a minute for the open conversation and once in five for a row')
    check(/if \(known && known\.branch !== branch\) \{\s*prs\.delete\(sessionId\)\s*notify\(sessionId\)/.test(store) && /if \(pr\.kind === 'unknown'\) \{[\s\S]{0,220}retry: true/.test(store), "a pull request learned for one branch is dropped the moment the branch changes; 'not known just now' keeps what was known and asks again soon")
    const markSrc = read('src/renderer/src/components/GitMark.tsx')
    check(/new IntersectionObserver\(/.test(markSrc) && /useGit\(sessionId, \{ watch: seen \}\)/.test(markSrc) && /useGit\(sessionId, \{ watch: true, open: true, refreshKey \}\)/.test(markSrc), 'a row reads only while it is on screen; the open conversation reads more often and when a turn ends')
    check(/<GitMark sessionId=\{s\.id\} \/>/.test(read('src/renderer/src/components/Sidebar.tsx')) && /<GitChip sessionId=\{sessionId\} refreshKey=\{turnsEnded\} onAsk=\{askAssistant\} \/>/.test(read('src/renderer/src/components/ChatShell.tsx')), 'the mark is on every session row and the chip in the conversation header')
    check(!/from 'electron'|from 'node:fs'|from 'fs'/.test(reader) && !/from 'node:|from 'electron'/.test(read('src/shared/git-state.ts')), 'the reader touches the folder only through those commands; the rules are pure')
  }
})().catch((e) => {
  console.error(e)
  failures++
})
