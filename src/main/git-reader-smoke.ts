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
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  GIT_MAX_ENTRIES,
  GIT_STATUS_ARGS,
  GIT_UNSAFE_HERE,
  GIT_WHERE_ARGS,
  GIT_PATH,
  NO_FORK_SCRIPT,
  gitOperation,
  gitReadEnv,
  gitText,
  parseGitStatus,
  parseGitWhere
} from '@shared/git-state'
import { GIT_OPEN_FRESH_MS, GIT_ROW_FRESH_MS, gitChip, gitMark, gitStale } from '@shared/git-view'
import type { GitRead, GitState } from '@shared/git-state'
import { forgetGitReads, forkLimitEnforced, readGit } from './git-reader'

const MIN_CHECKS = 120
let checks = 0
let failures = 0
let skipped = false
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
  if (failures === 0 && checks < MIN_CHECKS && !skipped) {
    console.error(`git-reader smoke: FAIL ✗ (only ${checks} of at least ${MIN_CHECKS} checks ran)`)
    process.exitCode = 1
  } else if (failures > 0) {
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

console.log('2. the commands and the environment')
{
  const all = [...GIT_WHERE_ARGS, ...GIT_STATUS_ARGS]
  for (const key of ['core.fsmonitor=false', 'core.hooksPath=/dev/null', 'core.preloadIndex=false', 'index.threads=1', 'safe.bareRepository=explicit']) {
    check(GIT_WHERE_ARGS.includes(key) && GIT_STATUS_ARGS.includes(key) && GIT_STATUS_ARGS[GIT_STATUS_ARGS.indexOf(key) - 1] === '-c', `both commands carry -c ${key}`)
  }
  check(GIT_STATUS_ARGS.includes('--no-optional-locks') && GIT_STATUS_ARGS.includes('--ignore-submodules=all') && GIT_STATUS_ARGS.includes('-z') && GIT_STATUS_ARGS.includes('--porcelain=v2'), 'status takes no lock, enters no submodule, and answers in the machine format')
  const verbs = all.filter((a) => !a.startsWith('-') && !a.includes('='))
  check(verbs.join() === 'rev-parse,status', 'the only git commands are rev-parse and status: nothing that writes, fetches or pushes', verbs.join())
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
      check(open.kind === 'state' && open.top === outer, '(control) with any top allowed, such a repository does read the folder above', JSON.stringify(open).slice(0, 160))
      check(held.kind === 'none', "with the caller's rule for tops, a repository whose settings name a folder above the work folder is not read")
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
    const handler = main.slice(main.indexOf('handleFromShell(IPC.GIT_READ'), main.indexOf('handleFromShell(IPC.WORK_FOLDER_WHERE'))
    check(handler.length > 0 && /if \(\(await proveHere\(\)\) !== 'here'\) return none/.test(handler), 'main reads git only when Prometheus has been proved to share this disk')
    check(/getDaemon\(`\/api\/sessions\/\$\{encodeURIComponent\(sessionId\)\}\/workspace`\)/.test(handler) && handler.indexOf('proveHere()') < handler.indexOf('getDaemon(') && handler.indexOf('getDaemon(') < handler.indexOf('readGit('), 'the folder is the one Prometheus names for that conversation, asked after the proof and before the reading')
    check(/async \(_e, sessionId: unknown\)/.test(handler) && !/path: unknown|folder: string\)/.test(handler) && (main.match(/readGit\(/g) ?? []).length === 1, 'the page names a conversation, never a path, and this is the one place main reads git')
    check(/if \(conn !== connection \|\| typeof folder !== 'string'\) return none/.test(handler), 'an answer from a connection that has since been replaced is not used')
    check(/if \(folderProblem\(folder, realHome\(\)\) !== ''\) return none/.test(handler) && handler.indexOf('folderProblem(folder') < handler.indexOf('readGit(') && /return readGit\(folder, process\.env, \(top\) => folderProblem\(top, home\) === ''\)/.test(handler), "only a folder Beacon would let a person choose as a work folder is read, whatever set the binding, and the repository's top is held to the same rule")
    check(reader.indexOf('if (!topAllowed(at.top))') > 0 && reader.indexOf('if (!topAllowed(at.top))') < reader.indexOf('GIT_STATUS_ARGS], folder, env)'), 'the top is judged before status, the command that walks the folder, is run')
    check(/if \(going && going\.conn === conn\) return going\.answer/.test(handler) && /if \(known && known\.conn === conn\) return known\.verdict/.test(main), 'one question per conversation at a time, and the shared-disk proof is good only for the connection it was made on')
    check((reader.match(/execFile\(/g) ?? []).length === 1 && (reader.match(/'exec "\$@"'/g) ?? []).length === 2 && /execFile\(SH, \['-c', script, 'sh', \.\.\.argv\]/.test(reader) && !/exec\(|spawn\(|shell: true/.test(reader), 'every command the reader runs goes through the one call that applies the process limit, with its arguments as data; the two that run without it (the self-test control, and asking where git is) run at the top of the disk, never in the folder')
    check(/timeout: TIME_MS, killSignal: 'SIGKILL', maxBuffer: OUT_MAX/.test(reader) && /if \(!\(await forkLimitEnforced\(probeEnv\)\)\) return \{ kind: 'unreadable', why: GIT_UNSAFE_HERE \}/.test(reader) && /if \(free\.code !== 0 \|\| !\/\^started:0\$\/m\.test\(free\.out\)\) return false/.test(reader) && /if \(limited\.timedOut \|\| limited\.code === null\) return false/.test(reader), 'each has a time limit and an output limit; nothing is read where the process limit is not enforced, and the self-test counts as passed only when the probe ran both without the limit (and worked) and under it (and did not)')
    const store = read('src/renderer/src/git-store.ts')
    check(/if \(here === null\) return askHere\(\)/.test(store) && /if \(!here\) return/.test(store) && /if \(!b \|\| here !== true\) return/.test(store), 'the window asks for nothing until main has said Prometheus shares this disk, and nothing at all when it does not')
    check(/\(w\) => \(w\.verdict === 'unknown' \? null : w\.here === true\)/.test(store) && /if \(answer === null\) \{[\s\S]{0,200}window\.setTimeout\(askHere, Math\.min\(30_000, 1000 \* 2 \*\* hereTries\+\+\)\)/.test(store), '"could not be told just now" is not "no": it is asked again, less and less often')
    check(/epoch\+\+\s*here = null\s*hereTries = 0\s*entries\.clear\(\)\s*asking\.clear\(\)\s*queue\.length = 0/.test(store) && (store.match(/if \(asked !== epoch\) return/g) ?? []).length >= 3, "another Prometheus, or a reconnection, forgets what was read, and an answer still on its way from the old one is ignored")
    check(/while \(asking\.size < AT_ONCE && queue\.length > 0\)/.test(store) && /const AT_ONCE = 3/.test(store) && /queue\.findIndex\(\(id\) => openIds\.has\(id\)\)/.test(store), 'at most three questions are with main at a time, the open conversation first')
    check(/if \(showing\(\)\) requestGit\(id, \{ open \}\)/.test(store) && /document\.addEventListener\('visibilitychange', ask\)/.test(store), 'a window that is not showing asks nothing, and asks again when it is shown')
    check(/window\.addEventListener\(WORKSPACE_CHANGED,[\s\S]{0,160}requestGit\(id, \{ force: true \}\)/.test(store) && /const WORKSPACE_CHANGED = 'beacon:workspace-changed'/.test(store) && /export const WORKSPACE_CHANGED = 'beacon:workspace-changed'/.test(read('src/renderer/src/components/WorkFolderChip.tsx')) && /if \(opts\.force\) going\.again = true/.test(store), "a conversation whose folder changes is read again at once, even if a read was already under way")
    const markSrc = read('src/renderer/src/components/GitMark.tsx')
    check(/new IntersectionObserver\(/.test(markSrc) && /useGit\(sessionId, \{ watch: seen \}\)/.test(markSrc) && /useGit\(sessionId, \{ watch: true, open: true, refreshKey \}\)/.test(markSrc), 'a row reads only while it is on screen; the open conversation reads more often and when a turn ends')
    check(/<GitMark sessionId=\{s\.id\} \/>/.test(read('src/renderer/src/components/Sidebar.tsx')) && /<GitChip sessionId=\{sessionId\} refreshKey=\{turnsEnded\} \/>/.test(read('src/renderer/src/components/ChatShell.tsx')), 'the mark is on every session row and the chip in the conversation header')
    check(!/from 'electron'|from 'node:fs'|from 'fs'/.test(reader) && !/from 'node:|from 'electron'/.test(read('src/shared/git-state.ts')), 'the reader touches the folder only through those commands; the rules are pure')
  }
})().catch((e) => {
  console.error(e)
  failures++
})
