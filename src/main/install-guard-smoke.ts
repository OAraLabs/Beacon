/**
 * install-guard-smoke — the installer REFUSES a stale build.
 *
 * WHAT HAPPENED. scripts/install-local.sh took the first existing candidate with
 * dist/mac-arm64 at the head of the list. That was correct when written
 * (2026-08-01); #47 moved the mac target to `arch: [universal]` on 2026-08-15 and
 * the output moved to dist/mac-universal. The arm64 directory stayed behind as a
 * leftover and kept winning. On 2026-08-17 the script installed an Aug-1 bundle,
 * printed "installed:" and a build date of "now" — because it was reporting the
 * COPY's mtime, which cp had just set. A check that reported success about the
 * wrong artifact.
 *
 * WHY THE INTERESTING TEST IS THE REFUSAL. Reordering the preference passes any
 * test that only walks the happy path — and the happy path looked fine for
 * sixteen days. So the assertions below are mostly about what the script must
 * REFUSE and what it must SAY, not about it succeeding.
 *
 * Drives the REAL script via BEACON_DIST_ROOT + BEACON_INSTALL_DRY_RUN, so it
 * tests the shipped file rather than a copy of its logic, and installs nothing.
 *
 * Step 1 too: it quits THIS app, found by executable, and nothing else called Beacon, and a real
 * install refuses when it cannot. Those sections drive the real script against decoy processes,
 * inside a sandbox that keeps it off the real machine; see below.
 *
 * Run: npm run smoke:install-guard
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  utimesSync
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'

let failures = 0
function check(cond: boolean, label: string): void {
  if (cond) console.log(`  ok   ${label}`)
  else {
    console.error(`  FAIL ${label}`)
    failures += 1
  }
}

const SCRIPT = join(process.cwd(), 'scripts', 'install-local.sh')
const root = mkdtempSync(join(tmpdir(), 'beacon-install-'))

/** A fake built bundle with a controllable mtime. */
function makeBuild(arch: string, ageSeconds: number, version = '9.9.9', dist = root): string {
  const app = join(dist, arch, 'Beacon.app', 'Contents')
  mkdirSync(app, { recursive: true })
  writeFileSync(
    join(app, 'Info.plist'),
    `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict>` +
      `<key>CFBundleShortVersionString</key><string>${version}</string></dict></plist>`
  )
  const bundle = join(dist, arch, 'Beacon.app')
  const when = new Date(Date.now() - ageSeconds * 1000)
  utimesSync(bundle, when, when)
  return bundle
}

// ── KEEPING THE SCRIPT OFF THE REAL MACHINE ────────────────────────────────
//
// Step 1 quits processes, and the install deletes and copies bundles. An earlier version of this
// smoke kept the script off the real machine only because the script happened to call ps and
// osascript by bare name, so stubs first on PATH answered. A mutant that let the dry run act once
// quit the developer's running Beacon through it, and `/bin/ps`, `/usr/bin/osascript`, a PATH reset
// or the `kill` builtin would each have walked past the stubs. So there are three layers, and the
// smoke REFUSES to run (exit 2) unless all three hold, before it runs the script at all:
//
//   1. A SANDBOX around every run of the script (sandbox-exec). It may signal only its own process
//      group (the decoys below), never another (Beacon, launched by launchd, is its own). It may not
//      run osascript, launchctl, lsregister, open, automator or shortcuts: each is denied by its
//      resolved path too, because sandbox path rules match resolved paths, and lsregister's usual
//      spelling runs through three symlinks. A first version denied only that spelling, so every
//      smoke run registered its temp bundle with LaunchServices: 28 stale records, removed
//      2026-10-05. It may not open apps through LaunchServices (lsopen) or write /Applications or the
//      real ~/Desktop and ~/Downloads, and it may not send Apple Events. setuid tools such as /bin/ps
//      cannot run in it at all. Its self-test proves every rule: it runs each denied tool, signals a
//      process in another session, writes canaries, and runs a small compiled probe that sends a
//      real Apple Event to Finder (or the Dock) and opens a URL through LaunchServices. Each probe
//      does nothing if it gets through: an event class no app handles, never prompting for consent,
//      and a URL scheme nothing claims. Inside the sandbox the event fails as process-not-found
//      (-600) though Finder is running, and the open fails with -54; the kernel's sandbox report
//      names both denials (measured 2026-10-06, macOS 15.6.1).
//   2. A STATIC refusal of the spellings that bypass the stubs: a process tool by absolute path,
//      `command -p`, a PATH assignment, `builtin`/`enable`/`hash`, `env -i`, `eval`, path_helper,
//      sourcing another file, `open`. It checks its own fixtures first.
//   3. A PREFLIGHT: the sourced script's beacon_processes, run against a known decoy table, returns
//      exactly that table, read through the stub ps.
//
// Every process the script can see is a DECOY this smoke spawned: a /bin/sleep, detached so launchd
// reaps it, shown under a fake executable path by stub ps/pgrep/pkill/killall/osascript on PATH. And
// every run installs into a temp BEACON_INSTALL_DIR with HOME in a temp dir, so /Applications is
// never the install dir.

const fake = mkdtempSync(join(tmpdir(), 'beacon-procs-'))
const bin = join(fake, 'bin')
const procs = join(fake, 'procs.tsv')
const calls = join(fake, 'calls.log')
const home = join(fake, 'home') // HOME for every run: the script's ~/Downloads and ~/Desktop
const desktop = join(home, 'Desktop')
const downloads = join(home, 'Downloads')
const apps = join(fake, 'Applications') // BEACON_INSTALL_DIR for every run
const emptyDist = join(fake, 'no-dist')
for (const d of [bin, desktop, downloads, emptyDist]) mkdirSync(d, { recursive: true })

const REAL_HOME = homedir()
// Every decoy path below is a REAL file with its own inode (the script compares spellings by inode,
// and refuses an absolute path that does not exist), so the classifier is tested the same way on any
// Mac: nothing depends on what this machine happens to have installed.
function realExe(path: string): string {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, '')
  return path
}
const APP_EXE = realExe(join(apps, 'Beacon.app', 'Contents', 'MacOS', 'Beacon'))
// The iOS app's shape: a flat bundle, executable at its root.
const SIM_EXE = realExe(
  join(fake, 'Library/Developer/CoreSimulator/Devices/71ACFBC6-5726-42B1-993C-27F10EDDEAB0') +
    '/data/Containers/Bundle/Application/437AF33D-51AA-4674-A591-594F2B11BDA8/Beacon.app/Beacon'
)
// Mac Beacons this install does not touch. Every one answers to com.oaralabs.beacon.
const DIST_EXE = realExe(join(fake, 'worktree', 'dist', 'mac-arm64', 'Beacon.app', 'Contents', 'MacOS', 'Beacon'))
const USER_APPS_EXE = realExe(join(home, 'Applications', 'Beacon.app', 'Contents', 'MacOS', 'Beacon'))
const COPY2_EXE = realExe(join(apps, 'Beacon 2.app', 'Contents', 'MacOS', 'Beacon'))
// Full copies step 3 deletes (real directories, not symlinks): targets.
const DESK_EXE = realExe(join(desktop, 'Beacon.app', 'Contents', 'MacOS', 'Beacon'))
const DL_EXE = realExe(join(downloads, 'Beacon.app', 'Contents', 'MacOS', 'Beacon'))
// A quarantined app opened in place runs from a read-only copy whose real bundle the path hides.
// Real, as a translocated copy is (a read-only mount): only the translocation rule may refuse it.
const TRANSLOCATED_EXE = realExe(
  join(fake, 'AppTranslocation', '6A5D9E2C-1B3F-4C8D-9E7A-0F1E2D3C4B5A', 'd', 'Beacon.app', 'Contents', 'MacOS', 'Beacon')
)
// A working directory where a relative argv[0] and a process title name real files, so that only the
// rule for argv[0] that is not an absolute path may refuse them: relative to the installer's own
// directory is not relative to the process's.
const ODD_CWD = join(fake, 'odd-cwd')
realExe(join(ODD_CWD, 'Beacon'))
realExe(join(ODD_CWD, 'Beacon: idle'))

const stubs: Record<string, string> = {
  // The live table, "<pid>\t<exe>\t<ucomm>": rows whose decoy is still running. kill -0 runs in the
  // sandbox, which hides every process outside our group, so a dead decoy's recycled pid reads as gone.
  _rows: `while IFS="$(printf '\\t')" read -r pid exe ucomm; do
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null && printf '%s\\t%s\\t%s\\n' "$pid" "$exe" "$ucomm"
done < "$STUB_PROCS"
exit 0`,
  // pgrep/pkill/killall matching: -x NAME (the kernel's name, ucomm) or -f REGEX (the path).
  _match: `case "$1" in -x|-f) ;; *) echo "stub: unsupported match $*" >&2; exit 2 ;; esac
"$STUB_BIN/_rows" | while IFS="$(printf '\\t')" read -r pid exe ucomm; do
  if [ "$1" = -x ]; then [ "$ucomm" = "$2" ] && echo "$pid"; else [[ "$exe" =~ $2 ]] && echo "$pid"; fi
done
exit 0`,
  // STUB_PS: ok | fail (every call) | fail-names (only the ucomm list fails) | fail-after-N (the first N
  // path lists answer; later ones fail).
  ps: `echo "ps $*" >> "$STUB_LOG"
case "$*" in
  "-axo pid=,comm=") col=path ;;
  "-axo pid=,ucomm=") col=name ;;
  *) echo "stub ps: unexpected arguments: $*" >&2; exit 2 ;;
esac
case "$STUB_PS" in
  fail) echo "ps: (stub) failed" >&2; exit 1 ;;
  fail-names) [ $col = path ] || { echo "ps: (stub) failed" >&2; exit 1; } ;;
  fail-after-*)
    n=$(grep -c '^ps -axo pid=,comm=$' "$STUB_LOG")
    if [ $col = path ] && [ "$n" -gt "\${STUB_PS#fail-after-}" ]; then echo "ps: (stub) failed" >&2; exit 1; fi ;;
esac
"$STUB_BIN/_rows" | while IFS="$(printf '\\t')" read -r pid exe ucomm; do
  if [ $col = path ]; then printf '%6s %s\\n' "$pid" "$exe"; else printf '%6s %s\\n' "$pid" "$ucomm"; fi
done`,
  pgrep: `echo "pgrep $*" >> "$STUB_LOG"
out="$("$STUB_BIN/_match" "$@")" || exit 2
[ -n "$out" ] || exit 1
echo "$out"`,
  pkill: `echo "pkill $*" >> "$STUB_LOG"
out="$("$STUB_BIN/_match" "$@")" || exit 2
[ -n "$out" ] || exit 1
for pid in $out; do kill -TERM "$pid"; done`,
  killall: `echo "killall $*" >> "$STUB_LOG"
name="\${@: -1}"
out="$("$STUB_BIN/_match" -x "$name")" || exit 2
[ -n "$out" ] || exit 1
for pid in $out; do kill -TERM "$pid"; done`,
  // STUB_OSASCRIPT: quits (the app at STUB_APP_EXE quits) | denied (no Automation permission) |
  // relaunch (it quits, and STUB_RELAUNCH_PID starts from the same bundle, as a Dock click would).
  osascript: `echo "osascript $*" >> "$STUB_LOG"
if [ "$STUB_OSASCRIPT" = denied ]; then
  echo "execution error: Not authorized to send Apple events to Beacon. (-1743)" >&2; exit 1
fi
case "$*" in *quit*)
  "$STUB_BIN/_rows" | while IFS="$(printf '\\t')" read -r pid exe ucomm; do
    [ "$exe" = "$STUB_APP_EXE" ] && kill -TERM "$pid"
  done
  if [ "$STUB_OSASCRIPT" = relaunch ]; then printf '%s\\t%s\\tBeacon\\n' "$STUB_RELAUNCH_PID" "$STUB_APP_EXE" >> "$STUB_PROCS"; fi ;;
esac
exit 0`,
  // The script's waits poll every 0.5 s; this keeps a 10 s timeout under a second. STUB_SWAP="K OLD
  // NEW": at the K-th sleep, OLD exits and NEW is running from the same path.
  sleep: `if [ -n "$STUB_SWAP" ]; then
  set -- $STUB_SWAP
  k=$(( $(cat "$STUB_PROCS.sleeps" 2>/dev/null || echo 0) + 1 )); echo "$k" > "$STUB_PROCS.sleeps"
  if [ "$k" -eq "$1" ]; then
    kill -KILL "$2" 2>/dev/null
    awk -F'\\t' -v o="$2" -v n="$3" 'BEGIN { OFS = "\\t" } $1 == o { $1 = n } { print }' "$STUB_PROCS" > "$STUB_PROCS.new"
    mv "$STUB_PROCS.new" "$STUB_PROCS"
  fi
fi
exec /bin/sleep 0.05`
}
for (const [name, body] of Object.entries(stubs)) {
  writeFileSync(join(bin, name), `#!/bin/bash\n${body}\n`)
  chmodSync(join(bin, name), 0o755)
}

const decoys: number[] = []
/** A /bin/sleep this smoke owns, re-parented to launchd so it is reaped the moment it dies. */
function decoy(ignoresTerm = false): number {
  const body = ignoresTerm ? "trap '' TERM; exec /bin/sleep 300" : 'exec /bin/sleep 300'
  const out = execFileSync('/bin/sh', ['-c', `/bin/sh -c "${body}" </dev/null >/dev/null 2>&1 & echo $!`], {
    encoding: 'utf8'
  })
  const pid = Number(out.trim())
  if (!(pid > 1)) throw new Error(`could not spawn a decoy (got ${out})`)
  decoys.push(pid)
  return pid
}
function alive(pid: number): boolean {
  const r = spawnSync('/bin/ps', ['-o', 'comm=', '-p', String(pid)], { encoding: 'utf8' })
  return r.stdout.trim() === '/bin/sleep'
}
function pgid(pid: number): string {
  return spawnSync('/bin/ps', ['-o', 'pgid=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim()
}
function killDecoys(): void {
  for (const pid of decoys.splice(0)) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      /* already gone */
    }
  }
}
process.on('exit', killDecoys)

/** A guard that protects the real machine did not hold: stop before anything can act. */
function refuse(why: string): never {
  console.error(`\nREFUSING TO RUN the install script: ${why}\n`)
  killDecoys()
  process.exit(2)
}

interface Run {
  code: number
  out: string
}

if (/["\\]/.test(REAL_HOME)) refuse(`HOME contains a quote or backslash, which the sandbox profile cannot hold: ${REAL_HOME}`)
const LSREG = '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister'
// The tools the profile denies, each by its spelling and its resolved path.
const EXEC_DENIED = ['/usr/bin/osascript', '/bin/launchctl', LSREG, '/usr/bin/open', '/usr/bin/automator', '/usr/bin/shortcuts']
const deniedPaths = [...new Set(EXEC_DENIED.flatMap((t) => (existsSync(t) ? [t, realpathSync(t)] : [t])))]
// /Applications covers its /System/Volumes/Data firmlink too (measured); the self-test writes both.
const writeDenied = ['/Applications', `${REAL_HOME}/Desktop`, `${REAL_HOME}/Downloads`]
const PROFILE = [
  '(version 1)',
  '(allow default)',
  '(deny signal (target others))',
  '(deny appleevent-send)',
  '(deny lsopen)',
  `(deny process-exec ${deniedPaths.map((p) => `(literal "${p}")`).join(' ')})`,
  `(deny file-write* ${writeDenied.map((p) => `(subpath "${p}")`).join(' ')})`
].join('\n')

// `probe ae <pid>`: one Apple Event of a class no app handles, never prompting for consent.
// `probe lsopen`: open a URL whose scheme nothing claims. Each prints the OSStatus it got.
const PROBE_C = `#include <CoreServices/CoreServices.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
int main(int argc, char **argv) {
  if (argc > 2 && !strcmp(argv[1], "ae")) {
    pid_t pid = (pid_t)atoi(argv[2]);
    AEAddressDesc addr; AppleEvent ev = {typeNull, NULL}, reply = {typeNull, NULL};
    if (AECreateDesc(typeKernelProcessID, &pid, sizeof(pid), &addr)) return 2;
    if (AECreateAppleEvent('bcon', 'prob', &addr, kAutoGenerateReturnID, kAnyTransactionID, &ev)) return 2;
    printf("ae %d\\n", (int)AESendMessage(&ev, &reply, kAENoReply | kAENeverInteract | kAEDoNotPromptForUserConsent, kAEDefaultTimeout));
    return 0;
  }
  if (argc > 1 && !strcmp(argv[1], "lsopen")) {
    CFURLRef u = CFURLCreateWithString(NULL, CFSTR("x-beacon-sandbox-probe:nothing"), NULL);
    printf("lsopen %d\\n", (int)LSOpenCFURLRef(u, NULL));
    return 0;
  }
  return 2;
}
`

/** /bin/bash with these arguments, inside the sandbox. The only way this smoke runs the script. */
function bash(args: string[], env: Record<string, string>, cwd?: string): Run {
  const r = spawnSync('/usr/bin/sandbox-exec', ['-p', PROFILE, '/bin/bash', ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
    cwd
  })
  if (r.error) refuse(`could not run sandbox-exec: ${r.error.message}`)
  return { code: r.status ?? 1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` }
}

/** Fake path → the decoy pid standing in for it, or [pid, the kernel's name when not the basename]. */
type Table = Record<string, number | [number, string]>
interface StubOpts {
  osascript?: 'quits' | 'denied' | 'relaunch'
  ps?: string // ok | fail | fail-after-N
  appExe?: string
  relaunchPid?: number
  swap?: [number, number, number] // at the K-th sleep, OLD exits and NEW runs from the same path
  installDir?: string
  homeDir?: string // HOME for the run (its Desktop is BEACON_DESKTOP_DIR); default: home
  cwd?: string // the installer's working directory; default: the smoke's
}
function stubEnv(table: Table = {}, o: StubOpts = {}): Record<string, string> {
  const rows = Object.entries(table).map(([exe, v]) => {
    const [pid, ucomm] = typeof v === 'number' ? [v, basename(exe).slice(0, 16)] : v
    return `${pid}\t${exe}\t${ucomm}\n`
  })
  writeFileSync(procs, rows.join(''))
  writeFileSync(calls, '')
  rmSync(`${procs}.sleeps`, { force: true })
  return {
    PATH: `${bin}:${process.env.PATH}`,
    HOME: o.homeDir ?? home,
    BEACON_DESKTOP_DIR: join(o.homeDir ?? home, 'Desktop'),
    BEACON_INSTALL_DIR: o.installDir ?? apps,
    STUB_BIN: bin,
    STUB_PROCS: procs,
    STUB_LOG: calls,
    STUB_APP_EXE: o.appExe ?? APP_EXE,
    STUB_OSASCRIPT: o.osascript ?? 'quits',
    STUB_PS: o.ps ?? 'ok',
    STUB_RELAUNCH_PID: String(o.relaunchPid ?? ''),
    STUB_SWAP: o.swap ? o.swap.join(' ') : ''
  }
}

// ── layer 2: the static refusal, which proves itself on fixtures first ──
// Command position: line start; after ; & | ` $( "{ " or a case arm's ")"; after "! "; after the
// keywords if/elif/then/else/do/while/until and the prefixes exec/command/nohup/time/xargs. Not after
// a bare "(": the check reads lines, not shell, and "(source build, not the copy)" in an echo is
// prose. So `( open …)` in a subshell is not seen here; the sandbox denies open by exec and lsopen.
const CMD = String.raw`(^\s*|[;&|\`]\s*|\$\(\s*|\{\s+|\)\s+|(^|\s)!\s+|\b(if|elif|then|else|do|while|until|exec|command|nohup|time|xargs)\s+)`
const BYPASSES: Array<[RegExp, string]> = [
  [/(^|[^\w./])\/(usr\/)?s?bin\/(ps|pgrep|pkill|kill|killall|osascript|launchctl|env|open|automator|shortcuts)\b/, 'a process tool by absolute path'],
  [/\bcommand\s+-[A-Za-z]*p/, '`command -p`, which searches the default PATH'],
  [/(^|[\s;&|(])(export\s+|declare\s+-x\s+|typeset\s+-x\s+)?PATH\+?=/, 'a PATH assignment'],
  [/\b(builtin|enable|hash)\s/, '`builtin`, `enable` or `hash`'],
  [/\benv\s+(-i\b|-u\s*PATH\b|--unset[= ]PATH\b)/, '`env -i` or `env -u PATH`, which drop PATH'],
  [/\beval\b|path_helper|\/etc\/profile/, '`eval`, path_helper or /etc/profile, which can rewrite PATH'],
  [new RegExp(`${CMD}(source|\\.)\\s+\\S`), 'sourcing another file, which this check cannot see into'],
  [new RegExp(`${CMD}open(\\s|$)`), '`open`, which starts an app outside the sandbox']
]
function bypasses(text: string): string[] {
  const found: string[] = []
  text.split('\n').forEach((line, i) => {
    if (line.trim().startsWith('#')) return
    for (const [re, what] of BYPASSES) if (re.test(line)) found.push(`line ${i + 1}: ${what}: ${line.trim()}`)
  })
  return found
}
{
  const mustFlag = [
    'table="$(/bin/ps -axo pid=,comm=)"',
    '  /usr/bin/osascript -e "tell application id \\"$BUNDLE_ID\\" to quit"',
    'table="$(command -p ps -axo pid=,comm=)"',
    'command -pv ps',
    'table="$(${PS:-/bin/ps} -axo pid=,comm=)"',
    'export PATH=/usr/bin:/bin:$PATH',
    'PATH=/usr/bin ps -axo pid=,comm=',
    'builtin kill -TERM $pids',
    'hash -p /bin/ps ps',
    '/usr/bin/pkill -x Beacon || true',
    '/bin/kill -TERM $pids',
    'env -i bash -c x',
    'eval "$(/usr/libexec/path_helper -s)"',
    '. /etc/profile',
    'source "$REPO_ROOT/scripts/lib.sh"',
    'env -u PATH ps -axo pid=,comm=',
    'open -b "$BUNDLE_ID"',
    '[[ -n "$x" ]] && open -a Beacon',
    'if open -b "$BUNDLE_ID"; then :; fi',
    'elif open -a Beacon; then :',
    'while open -a Beacon; do :; done',
    '! open -a Beacon',
    'exec open -a Beacon',
    'command open -a Beacon',
    'nohup open -a Beacon &',
    'time open -a Beacon',
    '{ open -a Beacon; }',
    'x=`open -a Beacon`',
    '  beacon) open -a Beacon ;;',
    // One per remaining command position, so dropping any of them from CMD is noticed.
    'true; open -a Beacon',
    'true | open -a Beacon',
    'x="$(open -a Beacon)"',
    'until open -a Beacon; do :; done',
    'ls | xargs open',
    'if true; then open -a Beacon; fi',
    'if false; then :; else open -a Beacon; fi',
    'for x in a; do open -a Beacon; done'
  ]
  const mustPass = [
    '# table="$(/bin/ps -axo pid=,comm=)" in a comment',
    'table="$(ps -axo pid=,comm=)" || die "x"',
    'osascript -e "tell application id \\"$BUNDLE_ID\\" to quit" >/dev/null 2>&1 || true',
    'BUILT_VERSION="$(/usr/libexec/PlistBuddy -c x "$BUILT/Contents/Info.plist")"',
    'kill -TERM $pids 2>/dev/null || true',
    'DIST_ROOT="${BEACON_DIST_ROOT:-$REPO_ROOT/dist}"',
    'REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"',
    'echo "open it with:  open -b $BUNDLE_ID"',
    `echo "  built:   $(date -r "$BUILT_EPOCH" '+%Y-%m-%d %H:%M')  (source build, not the copy)"`,
    'echo "    (alias skipped — Finder declined; the app is still installed)"'
  ]
  const missed = mustFlag.filter((l) => bypasses(l).length === 0)
  const noisy = mustPass.filter((l) => bypasses(l).length > 0)
  if (missed.length || noisy.length) {
    refuse(`the static check is broken: missed ${JSON.stringify(missed)}, flagged ${JSON.stringify(noisy)}`)
  }
  const found = bypasses(readFileSync(SCRIPT, 'utf8'))
  if (found.length) refuse(`install-local.sh reaches past the stubs:\n  ${found.join('\n  ')}`)
  console.log(`\n=== guard: no stub bypass in the script (${mustFlag.length} + ${mustPass.length} fixtures checked) ===`)
}

// ── layer 1: the sandbox, which proves itself before the script runs at all ──
{
  // Like Beacon: its own session, outside our process group.
  const away = spawn('/bin/sleep', ['300'], { detached: true, stdio: 'ignore' })
  away.unref()
  const awayPid = away.pid ?? 0
  decoys.push(awayPid)
  const near = decoy()
  if (!awayPid || pgid(awayPid) === pgid(process.pid) || pgid(near) !== pgid(process.pid)) {
    refuse(`could not set up the sandbox self-test (pgid away ${pgid(awayPid)}, near ${pgid(near)}, ours ${pgid(process.pid)})`)
  }
  // The self-test's own fixed lists, not the profile's: dropping a rule from the profile must not drop
  // its proof with it, and a tool that is not where this list says is a refusal, not a skip.
  // Each tool runs with arguments that do nothing if the denial ever fails: usage text, a version.
  const MUST_NOT_RUN: Array<[string, string]> = [
    ['/usr/bin/osascript', "-e 'return 1'"],
    ['/bin/launchctl', 'version'],
    [LSREG, ''],
    ['/usr/bin/open', '-h'],
    ['/usr/bin/automator', '-h'],
    ['/usr/bin/shortcuts', '--help']
  ]
  const missing = MUST_NOT_RUN.filter(([tool]) => !existsSync(tool)).map(([tool]) => tool)
  if (missing.length) refuse(`these tools are not where the self-test expects them, so their denial is unproved: ${missing.join(', ')}`)
  const MUST_NOT_WRITE = ['/Applications', '/System/Volumes/Data/Applications', `${REAL_HOME}/Desktop`, `${REAL_HOME}/Downloads`]
  const canaries = MUST_NOT_WRITE.map((d) => join(d, `.beacon-install-guard-${process.pid}`))
  // Each canary is first written OUTSIDE the sandbox (and removed), so a failure inside it can only be
  // the sandbox's: not privacy protection, permissions or a leftover. The pre-check proves itself on a
  // directory nobody can write.
  const writableOutside = (c: string): boolean => {
    try {
      mkdirSync(dirname(c), { recursive: true })
      mkdirSync(c)
      rmdirSync(c)
      return true
    } catch {
      return false
    }
  }
  const locked = join(fake, 'locked')
  mkdirSync(locked)
  chmodSync(locked, 0o555)
  if (writableOutside(join(locked, 'canary'))) refuse('the canary pre-check is broken: it wrote into a read-only directory')
  chmodSync(locked, 0o755)
  for (const c of canaries) {
    if (!writableOutside(c)) refuse(`cannot write ${c} outside the sandbox either, so a denial inside it proves nothing`)
  }
  // The Apple Event and LaunchServices probe, compiled here: no system tool sends an event that is
  // harmless when it lands, and a copied system binary is killed on launch.
  const probe = join(fake, 'beacon-sandbox-probe')
  writeFileSync(`${probe}.c`, PROBE_C)
  const cc = spawnSync('cc', ['-Wno-deprecated-declarations', '-framework', 'CoreServices', '-o', probe, `${probe}.c`], {
    encoding: 'utf8'
  })
  if (cc.status !== 0) refuse(`could not compile the sandbox probe (cc exit ${cc.status}): ${cc.stderr ?? cc.error}`)
  // A process that takes Apple Events, so a -600 from inside the sandbox can only be the denial. This user's own: with a second
  // user logged in (fast user switching) the first Finder may be theirs, which kill -0 cannot reach, and the run is refused.
  const target = ['Finder', 'Dock']
    .map((n) => spawnSync('/usr/bin/pgrep', ['-x', '-u', String(process.getuid?.() ?? ''), n], { encoding: 'utf8' }).stdout.split('\n')[0].trim())
    .find((p) => p !== '')
  if (!target) refuse('no Finder or Dock running to send the Apple Event probe to, so that rule cannot be proved')
  const r = bash(
    [
      '-c',
      [
        `kill -0 ${awayPid} 2>/dev/null && echo "BREACH: signalled a process outside the group"`,
        `kill -0 ${near} 2>/dev/null || echo "BROKEN: cannot signal our own decoy"`,
        ...MUST_NOT_RUN.map(
          ([tool, args]) => `'${tool}' ${args} >/dev/null 2>&1; s=$?; [ $s -eq 126 ] || echo "BREACH: ran ${tool} (exit $s)"`
        ),
        ...canaries.map((c) => `mkdir '${c}' 2>/dev/null && echo "BREACH: wrote ${c}"`),
        // Allowed, these print ae 0 (delivered) or ae -1744 (would need consent), and lsopen -10814.
        `v="$('${probe}' ae ${target})"; [ "$v" = "ae -600" ] || echo "BREACH: sent an Apple Event to pid ${target} ($v)"`,
        `v="$('${probe}' lsopen)"; [ "$v" = "lsopen -54" ] || echo "BREACH: opened a URL through LaunchServices ($v)"`,
        'echo SELF-TEST-RAN'
      ].join('\n')
    ],
    {}
  )
  for (const c of canaries) if (existsSync(c)) rmdirSync(c)
  killDecoys()
  const targetAlive = spawnSync('/bin/kill', ['-0', String(target)]).status === 0
  if (!r.out.includes('SELF-TEST-RAN') || /BREACH|BROKEN/.test(r.out) || !targetAlive) {
    refuse(`sandbox self-test${targetAlive ? '' : ` (the Apple Event target, pid ${target}, exited mid-test)`}:\n${r.out}`)
  }
  console.log(
    `=== guard: sandbox holds (no signal outside the group; ${MUST_NOT_RUN.length} tools denied; ` +
      `${canaries.length} canaries unwritable; no Apple Event; no LaunchServices open) ===`
  )
}

// ── layer 3: the preflight ──
{
  const a = decoy()
  const s = decoy()
  const r = bash(['-c', 'source "$1"; beacon_processes', 'bash', SCRIPT], {
    ...stubEnv({ [APP_EXE]: a, [SIM_EXE]: s }),
    BEACON_DIST_ROOT: emptyDist,
    BEACON_INSTALL_DRY_RUN: '1'
  })
  const want = `target ${a} ${APP_EXE}\nother ${s} ${SIM_EXE}`
  if (r.code !== 0 || r.out.trim() !== want) refuse(`beacon_processes did not return the decoy table:\n${r.out}`)
  if (!/^ps -axo pid=,comm=$/m.test(readFileSync(calls, 'utf8'))) refuse('beacon_processes did not read the stub ps')
  killDecoys()
  console.log('=== guard: the script sees the decoy table, through the stub ps ===')
}

function run(env: Record<string, string> = {}): Run {
  return bash([SCRIPT], { ...stubEnv(), BEACON_DIST_ROOT: root, BEACON_INSTALL_DRY_RUN: '1', ...env })
}

// ── THE ASSERTION THAT MATTERS ─────────────────────────────────────────────
console.log('\n=== a build older than HEAD is REFUSED ===')
makeBuild('mac-universal', 60 * 60 * 24 * 16) // 16 days old — the real case
const stale = run()
check(stale.code !== 0, `exits NON-ZERO on a stale build (got ${stale.code})`)
check(/PREDATES the current commit/i.test(stale.out), 'says the build predates the commit — the reason, not just a failure')
check(/older by \d+ minute/i.test(stale.out), 'STATES THE AGE, so the operator sees how stale')
check(/npm run dist/.test(stale.out), 'names the fix')
check(!/installed:/i.test(stale.out), 'and does NOT report success')

console.log('\n=== the deliberate override is loud ===')
const forced = run({ BEACON_ALLOW_STALE_INSTALL: '1' })
check(forced.code === 0, 'an explicit override proceeds')
check(/STALE BUILD ON PURPOSE/i.test(forced.out), 'and announces it — an override that is silent is just the bug again')

console.log('\n=== it says what is going in, BEFORE installing ===')
rmSync(join(root, 'mac-universal'), { recursive: true, force: true })
makeBuild('mac-universal', 5, '1.2.3')
const fresh = run()
check(fresh.code === 0, 'a fresh build is accepted')
check(/installing from: .*mac-universal/.test(fresh.out), 'prints the RESOLVED PATH — which artifact, not just that one was found')
check(/built:\s+\d{4}-\d{2}-\d{2}/.test(fresh.out), 'prints the build mtime')
check(/version: 1\.2\.3/.test(fresh.out), 'prints the app version read from the bundle')
check(
  fresh.out.indexOf('installing from') < fresh.out.indexOf('dry run'),
  'the announcement comes BEFORE the install, not after — the old script reported on the way out'
)

console.log('\n=== two builds present: chosen, never silently ===')
makeBuild('mac-arm64', 60 * 60 * 24 * 16) // the stale leftover that caused this
const both = run()
check(both.code === 0, 'still resolves')
check(/MULTIPLE builds on disk/i.test(both.out), 'SAYS there is more than one rather than quietly picking')
check(/mac-arm64/.test(both.out) && /mac-universal/.test(both.out), 'lists every candidate with its date')
check(
  /installing from: .*mac-universal/.test(both.out),
  'picks the NEWEST — not the first in a hardcoded order, which is what rotted'
)

console.log('\n=== nothing to install ===')
rmSync(root, { recursive: true, force: true })
mkdirSync(root, { recursive: true })
const none = run()
check(none.code !== 0, 'no build at all → non-zero')
check(/no built app/i.test(none.out), 'and says so')

// ── STEP 1 STOPS THIS APP, AND NOTHING ELSE CALLED "Beacon" ────────────────
//
// Step 1 found the app with `pgrep -x Beacon` and, after 10 s, ran `pkill -x Beacon`. The iOS Beacon
// in the Simulator is also a process named exactly Beacon, so on 2026-10-05 pgrep matched pid 54832
// (/Applications/Beacon.app) AND pid 84490 (…/CoreSimulator/…/Beacon.app/Beacon): the wait never saw
// "no Beacon", and the pkill took the Simulator's app down with the Mac one.

/** Step 1 itself, for real against the stubs: the script sourced, then stop_running_beacon called. */
function stepOne(table: Table, o: StubOpts = {}): Run {
  // Sourcing loads the functions and returns. Belt and braces for a script that ran its body anyway:
  // DRY_RUN and a dist root with no build stop it at "no built app", long before step 2. DRY_RUN is
  // cleared only for the one call. The script goes in as $1, not $0: the source guard compares
  // BASH_SOURCE with $0.
  return bash(
    ['-c', 'source "$1"; DRY_RUN=; stop_running_beacon', 'bash', SCRIPT],
    { ...stubEnv(table, o), BEACON_DIST_ROOT: emptyDist, BEACON_INSTALL_DRY_RUN: '1' },
    o.cwd
  )
}
const quitsSent = (): string[] =>
  readFileSync(calls, 'utf8')
    .split('\n')
    .filter((l) => l.startsWith('osascript') && l.includes('quit'))
const has = (out: string, pid: number, re: RegExp): boolean =>
  out.split('\n').some((l) => new RegExp(`\\bpid ${pid}\\b`).test(l) && re.test(l))
const leftAlone = (out: string, pid: number): boolean => has(out, pid, /alone/)
const sigterm = (out: string): string => out.split('\n').find((l) => /SIGTERM/.test(l)) ?? ''
const names = (line: string, pid: number): boolean => new RegExp(`\\b${pid}\\b`).test(line)

console.log("\n=== only the Simulator's Beacon is running: nothing to stop ===")
{
  const sim = decoy()
  const r = stepOne({ [SIM_EXE]: sim })
  check(r.code === 0, `step 1 returns cleanly (got ${r.code})`)
  check(alive(sim), "the Simulator's Beacon is still running — the original bug killed it")
  check(quitsSent().length === 0, `no quit is sent at all (sent: ${JSON.stringify(quitsSent())})`)
  check(leftAlone(r.out, sim), 'it SAYS it saw that pid and left it alone')
  killDecoys()
}

console.log('\n=== only the Mac app is running: it quits on the Apple Event ===')
{
  const app = decoy()
  const r = stepOne({ [APP_EXE]: app })
  check(r.code === 0, `step 1 returns cleanly (got ${r.code})`)
  check(!alive(app), 'the installed Beacon is gone')
  const sent = quitsSent()
  check(
    sent.length === 1 && sent[0].includes('tell application id "com.oaralabs.beacon" to quit'),
    `one quit, addressed by bundle id, not by name (sent: ${JSON.stringify(sent)})`
  )
  killDecoys()
}

console.log('\n=== a dist/ build is running too: no Apple Event, SIGTERM to the target pid ===')
{
  // A dist/ build answers to com.oaralabs.beacon too, so a quit by bundle id could reach it. No
  // Simulator row here: the dist/ row alone has to be what stops the Apple Event.
  const app = decoy()
  const dist = decoy()
  const r = stepOne({ [APP_EXE]: app, [DIST_EXE]: dist })
  check(r.code === 0, `step 1 returns cleanly (got ${r.code})`)
  check(quitsSent().length === 0, `no quit by bundle id (sent: ${JSON.stringify(quitsSent())})`)
  check(!alive(app), 'the installed Beacon is gone')
  check(names(sigterm(r.out), app) && !names(sigterm(r.out), dist), `the SIGTERM named its pid only: "${sigterm(r.out).trim()}"`)
  check(alive(dist) && leftAlone(r.out, dist), 'the dist/ build is still running, and it SAYS it left that pid alone')
  killDecoys()
}

console.log('\n=== the Apple Event is refused (no Automation permission) ===')
{
  const app = decoy()
  const r = stepOne({ [APP_EXE]: app }, { osascript: 'denied' })
  check(r.code === 0, `step 1 still gets the app to quit (got ${r.code})`)
  check(!alive(app), "SIGTERM to the app's own pid stopped it (Electron runs before-quit on SIGTERM, as on ⌘Q)")
  check(names(sigterm(r.out), app), 'it says which pid got the SIGTERM')
  killDecoys()
}

console.log('\n=== two targets (the app and a ~/Downloads copy): both get the SIGTERM ===')
{
  const app = decoy()
  const dl = decoy()
  const r = stepOne({ [APP_EXE]: app, [DL_EXE]: dl }, { osascript: 'denied' })
  check(r.code === 0, `step 1 returns cleanly (got ${r.code})`)
  check(!alive(app) && !alive(dl), `both are gone (app ${alive(app) ? 'alive' : 'gone'}, copy ${alive(dl) ? 'alive' : 'gone'})`)
  check(names(sigterm(r.out), app) && names(sigterm(r.out), dl), `the SIGTERM named both pids: "${sigterm(r.out).trim()}"`)
  killDecoys()
}

console.log('\n=== it relaunches during the wait: the SIGTERM goes to the pid running NOW ===')
{
  const first = decoy()
  const second = decoy()
  const r = stepOne({ [APP_EXE]: first }, { osascript: 'relaunch', relaunchPid: second })
  check(r.code === 0, `step 1 returns cleanly (got ${r.code})`)
  check(!alive(second), 'the relaunched app is gone too')
  check(
    names(sigterm(r.out), second) && !names(sigterm(r.out), first),
    `the SIGTERM named the new pid, not the one listed before the wait: "${sigterm(r.out).trim()}"`
  )
  killDecoys()
}

console.log('\n=== the app ignores both: REFUSE, never SIGKILL ===')
{
  const app = decoy(true)
  const dist = decoy()
  const sim = decoy()
  const r = stepOne({ [APP_EXE]: app, [DIST_EXE]: dist, [SIM_EXE]: sim })
  check(r.code !== 0, `exits NON-ZERO rather than installing over a live app (got ${r.code})`)
  check(
    /still running/i.test(r.out) && /nothing (was )?installed/i.test(r.out),
    'says it is still running and that nothing was installed'
  )
  check(new RegExp(`still running \\(pid ${app}\\)`).test(r.out), 'names the pid that would not quit')
  check(alive(app), 'the app was left running — no SIGKILL')
  check(alive(dist) && alive(sim), 'and the other Beacons were not signalled')
  killDecoys()
}

console.log('\n=== a different pid is running by the time it refuses: it names that one ===')
{
  // The app ignores the SIGTERM, then exits during the wait and another instance, which ignores it
  // too, runs from the same bundle. The refusal has to name the one running now.
  const first = decoy(true)
  const second = decoy(true)
  const dist = decoy()
  const r = stepOne({ [APP_EXE]: first, [DIST_EXE]: dist }, { swap: [3, first, second] })
  check(r.code !== 0, `exits NON-ZERO (got ${r.code})`)
  check(
    new RegExp(`still running \\(pid ${second}\\)`).test(r.out),
    `names the pid running at the end, not the one it signalled: "${r.out.split('\n').find((l) => /still running/.test(l)) ?? ''}"`
  )
  check(alive(second), 'and left it running')
  killDecoys()
}

console.log('\n=== another spelling of the installed app is still the installed app ===')
{
  // Compared by inode: a symlink, /private/var for /var, a case variant on case-insensitive APFS, a
  // /../ that resolves back to it. The kernel's name for each is Beacon, whatever argv[0] says.
  const link = join(fake, 'links', 'beacon')
  mkdirSync(dirname(link), { recursive: true })
  symlinkSync(APP_EXE, link)
  const spellings: Array<[string, string]> = [
    ['a symlink named beacon', link],
    ['/private/var for /var', APP_EXE.startsWith('/var/') ? `/private${APP_EXE}` : realpathSync(APP_EXE)],
    ['a path through /../', `${apps}/../${basename(apps)}/Beacon.app/Contents/MacOS/Beacon`]
  ]
  const lower = APP_EXE.replace('/Beacon.app/', '/beacon.app/')
  if (existsSync(lower)) spellings.push(['a case variant', lower])
  else console.log('  (case-sensitive filesystem: no case-variant spelling to test)')
  for (const [label, exe] of spellings) {
    const pid = decoy()
    const r = stepOne({ [exe]: [pid, 'Beacon'] })
    check(r.code === 0 && has(r.out, pid, /replaces/) && !alive(pid), `${label}: listed as the app this install replaces, and stopped`)
    killDecoys()
  }
}

// Each one EXISTS (or, relative, exists from the installer's directory), so it is refused by its own
// rule and not by "not on disk", which would hide a broken rule. The non-canonical ones resolve to the
// dist/ build: a real Beacon, just not one this install replaces.
const DIST_REL = DIST_EXE.slice(fake.length + 1) // worktree/dist/mac-arm64/Beacon.app/Contents/MacOS/Beacon
// [label, argv[0], the reason the refusal must give, the kernel's name when not the basename]
const UNPLACEABLE: Array<[string, string, RegExp, string?]> = [
  ['under App Translocation (an app opened in place from a download)', TRANSLOCATED_EXE, /App Translocation/],
  ['by a relative path', './Beacon', /not an absolute path/],
  ['under a process title', 'Beacon: idle', /not an absolute path/, 'Beacon'],
  ['by a /../ path', `${fake}/worktree/../${DIST_REL}`, /not canonical/],
  ['by a /./ path', `${fake}/./${DIST_REL}`, /not canonical/],
  ['by a // path', `${fake}//${DIST_REL}`, /not canonical/],
  // The installed app exec'd with argv[0] set to a path that is not on disk would otherwise read as
  // some other Beacon, and step 2 would replace its bundle under it.
  ['by an absolute path that is not on disk (an exec -a spoof, or a bundle deleted under it)', `${fake}/gone/Beacon.app/Contents/MacOS/Beacon`, /not on disk/]
]
console.log('\n=== the install slot is a symlink: step 2 replaces the link, so what it points to is left alone ===')
{
  // /Applications/Beacon.app a symlink to a dist/ build: step 2's rm -rf removes only the link, so
  // that build, run by its own path or through the link, is not this install's to stop. HOME has no
  // copies at all, so nothing is replaced: an empty list, which bash 3.2 cannot expand under set -u.
  const linkedApps = join(fake, 'Applications-linked')
  mkdirSync(linkedApps, { recursive: true })
  symlinkSync(dirname(dirname(dirname(DIST_EXE))), join(linkedApps, 'Beacon.app'))
  const VIA_LINK = join(linkedApps, 'Beacon.app', 'Contents', 'MacOS', 'Beacon')
  const bareHome = join(fake, 'home-bare')
  mkdirSync(bareHome, { recursive: true })
  const dist = decoy()
  const linked = decoy()
  const r = stepOne({ [DIST_EXE]: dist, [VIA_LINK]: linked }, { installDir: linkedApps, homeDir: bareHome })
  check(r.code === 0, `step 1 returns cleanly (got ${r.code}): ${r.out.trim().split('\n').pop()}`)
  check(alive(dist) && leftAlone(r.out, dist), 'the dist/ build the install slot points to is left alone')
  check(alive(linked) && leftAlone(r.out, linked), 'and so is that build run through the link')
  check(quitsSent().length === 0 && !sigterm(r.out), 'and nothing is sent')
  killDecoys()
}
console.log('\n=== a symlinked ~/Desktop copy is NOT replaced, so what it points to is left alone ===')
{
  // Step 3 keeps a symlink there ("aliases/symlinks are fine"). The dist/ build it points to is not
  // this install's to stop, whether a probe runs it by its own path or through the link.
  const linkedHome = join(fake, 'home-linked')
  mkdirSync(join(linkedHome, 'Desktop'), { recursive: true })
  symlinkSync(dirname(dirname(dirname(DIST_EXE))), join(linkedHome, 'Desktop', 'Beacon.app'))
  const VIA_LINK = join(linkedHome, 'Desktop', 'Beacon.app', 'Contents', 'MacOS', 'Beacon')
  const app = decoy()
  const dist = decoy()
  const linked = decoy()
  const r = stepOne({ [APP_EXE]: app, [DIST_EXE]: dist, [VIA_LINK]: linked }, { homeDir: linkedHome })
  check(r.code === 0, `step 1 returns cleanly (got ${r.code})`)
  check(has(r.out, app, /replaces/) && !alive(app), 'the installed app is still the target, and stopped')
  check(alive(dist) && leftAlone(r.out, dist), 'the dist/ build the link points to is left alone')
  check(alive(linked) && leftAlone(r.out, linked), 'and so is that build run through the link')
  killDecoys()
}
for (const [label, exe, why, ucomm] of UNPLACEABLE) {
  // Alone, as it would be: the single-instance lock keeps a translocated copy from running beside the
  // installed app, so there is no target to fall back on.
  console.log(`\n=== a Beacon running ${label}, alone: REFUSE, it cannot be placed ===`)
  const odd = decoy()
  const r = stepOne({ [exe]: ucomm ? [odd, ucomm] : odd }, { cwd: exe.startsWith('/') ? undefined : ODD_CWD })
  check(r.code !== 0, `exits NON-ZERO (got ${r.code})`)
  const line = r.out.split('\n').find((l) => /cannot place/.test(l) && new RegExp(`\\bpid ${odd}\\b`).test(l)) ?? ''
  check(why.test(line) && /cannot tell which bundle/.test(r.out), `and says which pid, and the right reason: "${line.trim()}"`)
  check(quitsSent().length === 0 && alive(odd), 'having sent nothing')
  killDecoys()
}
console.log('\n=== the Downloads bug: a translocated copy beside other Beacons, none of them a target ===')
{
  // Finding 3's case as it would really be: no installed app running (the single-instance lock), but
  // the Simulator's and a dist/ build may be. With no target in the list, a refusal that only runs
  // once there are pids to quit never runs.
  const odd = decoy()
  const sim = decoy()
  const dist = decoy()
  const r = stepOne({ [TRANSLOCATED_EXE]: odd, [SIM_EXE]: sim, [DIST_EXE]: dist })
  check(r.code !== 0 && /cannot tell which bundle/.test(r.out), `exits NON-ZERO and says why (got ${r.code})`)
  check(quitsSent().length === 0 && !sigterm(r.out) && [odd, sim, dist].every(alive), 'having sent nothing to any of them')
  killDecoys()
}

console.log('\n=== an unplaceable Beacon beside the app: refuse BEFORE quitting anything ===')
{
  const odd = decoy()
  const app = decoy()
  const r = stepOne({ [TRANSLOCATED_EXE]: odd, [APP_EXE]: app })
  check(r.code !== 0 && /cannot tell which bundle/.test(r.out), `exits NON-ZERO and says why (got ${r.code})`)
  check(quitsSent().length === 0 && !sigterm(r.out) && alive(app) && alive(odd), 'having sent nothing to either')
  killDecoys()
}

// Both lists: a failed name list alone would leave no candidates, which reads as nothing running.
for (const [which, mode] of [
  ['no process list at all', 'fail'],
  ['no list of kernel names (ucomm), paths fine', 'fail-names']
]) {
  console.log(`\n=== ${which}: refuse, do not assume nothing is running ===`)
  const app = decoy()
  const r = stepOne({ [APP_EXE]: app }, { ps: mode })
  check(r.code !== 0, `exits NON-ZERO when ps fails (got ${r.code})`)
  check(/could not list processes/i.test(r.out), 'and says why')
  check(quitsSent().length === 0 && alive(app), 'having sent nothing')
  killDecoys()
}

// A failed ps read as "nothing running" would install over a live app. Each place step 1 lists
// processes after the first is pinned: the Apple Event's wait, the list re-read for the SIGTERM, and
// the one re-read for the refusal (call 23: the list, the re-read, then 20 polls of the wait).
const PS_LATER: Array<[string, Table, StubOpts, boolean]> = [
  ['the wait after the Apple Event', {}, { osascript: 'denied', ps: 'fail-after-1' }, false],
  ['the re-read before the SIGTERM', { [DIST_EXE]: 0 }, { ps: 'fail-after-1' }, false],
  ['the re-read before the refusal', { [DIST_EXE]: 0 }, { ps: 'fail-after-22' }, true]
]
for (const [where, extra, o, hung] of PS_LATER) {
  console.log(`\n=== ps fails at ${where}: refuse, a failed list is not "it quit" ===`)
  const app = decoy(hung)
  const table: Table = { [APP_EXE]: app }
  for (const exe of Object.keys(extra)) table[exe] = decoy()
  const r = stepOne(table, o)
  check(r.code !== 0, `exits NON-ZERO (got ${r.code})`)
  check(/could not list processes/i.test(r.out), 'and says why')
  check(alive(app) === (hung || !sigterm(r.out)), 'with no SIGTERM sent on a guess')
  killDecoys()
}

console.log('\n=== the dry run reports what step 1 would stop, and stops nothing ===')
{
  makeBuild('mac-universal', 5)
  const t = { app: decoy(), desk: decoy(), dl: decoy() }
  const o = { sim: decoy(), dist: decoy(), userApps: decoy(), copy2: decoy() }
  const r = bash([SCRIPT], {
    ...stubEnv({
      [APP_EXE]: t.app,
      [DESK_EXE]: t.desk,
      [DL_EXE]: t.dl,
      [SIM_EXE]: o.sim,
      [DIST_EXE]: o.dist,
      [USER_APPS_EXE]: o.userApps,
      [COPY2_EXE]: o.copy2
    }),
    BEACON_DIST_ROOT: root,
    BEACON_INSTALL_DRY_RUN: '1'
  })
  check(r.code === 0 && /dry run —/.test(r.out), `the dry run completes (got ${r.code})`)
  check(has(r.out, t.app, /replaces/), 'the installed app is listed as one to quit')
  check(has(r.out, t.desk, /replaces/) && has(r.out, t.dl, /replaces/), 'so are the ~/Desktop and ~/Downloads copies step 3 deletes')
  check(
    Object.values(o).every((p) => leftAlone(r.out, p)),
    "the Simulator's, a dist/ build, ~/Applications and 'Beacon 2.app' are all left alone"
  )
  const would = r.out.split('\n').find((l) => /would quit/.test(l)) ?? ''
  check(
    Object.values(t).every((p) => names(would, p)) && /SIGTERM/.test(would),
    `it would quit all three, by SIGTERM since other Beacons run: "${would.trim()}"`
  )
  check(quitsSent().length === 0 && !sigterm(r.out.replace(would, '')), 'nothing is sent in a dry run')
  check([...Object.values(t), ...Object.values(o)].every(alive), 'and every process is still running')
  killDecoys()
}

console.log('\n=== step 5: a real install refreshes LaunchServices, a BEACON_INSTALL_DIR one does not ===')
{
  // A real install has no BEACON_INSTALL_DIR at all, so it is UNSET here, not set to "". Then step 5
  // runs lsregister on the installed bundle, and the sandbox refuses that exec (proved above): it
  // registers nothing. The exit status the script reports is the proof the exec was attempted: 126
  // is the sandbox's refusal. A deleted exec reports nothing, and a misspelled path reports 127.
  const env = { ...stubEnv(), BEACON_DIST_ROOT: emptyDist, BEACON_INSTALL_DRY_RUN: '1' }
  const real = bash(['-c', 'unset BEACON_INSTALL_DIR; source "$1"; refresh_launchservices', 'bash', SCRIPT], env)
  const temp = bash(['-c', 'source "$1"; refresh_launchservices', 'bash', SCRIPT], { ...env, BEACON_INSTALL_DIR: apps })
  const said = (r: Run): string => r.out.trim().replace(/\n\s*/g, ' / ')
  check(
    /refreshing LaunchServices/.test(real.out) && /lsregister exited 126\b/.test(real.out) && !/left alone/.test(real.out),
    `without BEACON_INSTALL_DIR it runs lsregister (here, refused by the sandbox) (said: ${said(real)})`
  )
  check(
    /LaunchServices left alone/.test(temp.out) && !/refreshing|lsregister/.test(temp.out),
    `with it, it leaves LaunchServices alone (said: ${said(temp)})`
  )
}

// ── THE REAL INSTALL PATH REFUSES TOO ──────────────────────────────────────
//
// Step 1 has to run in the install itself, in the main shell, before anything is replaced: proving
// the function refuses proves nothing if the body never calls it, or swallows its exit. So one real,
// non-dry install runs end to end into a temp INSTALL_DIR, with HOME in a temp dir, inside the
// sandbox. The fake build carries a real app.asar so it passes audit:bundle.
console.log('\n=== a real install: refuses over an app that will not quit, installs once it has ===')
{
  const installApps = join(fake, 'install', 'Applications')
  const installDist = join(fake, 'dist')
  mkdirSync(installApps, { recursive: true })
  const TEMP_APP_EXE = join(installApps, 'Beacon.app', 'Contents', 'MacOS', 'Beacon')
  const installed = (): string => {
    const plist = join(installApps, 'Beacon.app', 'Contents', 'Info.plist')
    return existsSync(plist) ? (/<string>([^<]*)<\/string>/.exec(readFileSync(plist, 'utf8'))?.[1] ?? '?') : 'none'
  }
  const env = (table: Table): Record<string, string> => ({
    ...stubEnv(table, { appExe: TEMP_APP_EXE, installDir: installApps }),
    BEACON_DIST_ROOT: installDist,
    BEACON_INSTALL_DRY_RUN: ''
  })
  const where = bash(['-c', 'source "$1"; echo "INSTALL_DIR=$INSTALL_DIR"', 'bash', SCRIPT], env({}))
  if (!where.out.includes(`INSTALL_DIR=${installApps}\n`)) {
    check(false, `the script installs into BEACON_INSTALL_DIR (it said: ${where.out.trim()}); not running the install`)
  } else {
    // What is installed now: the build the install must leave alone when it refuses.
    makeBuild('mac-arm64', 60, '0.0.1-old', join(fake, 'old'))
    execFileSync('/bin/cp', ['-R', join(fake, 'old', 'mac-arm64', 'Beacon.app'), installApps])
    // The new build: what audit:bundle requires of a release (scripts/bundle-facts.mjs), built for
    // real. An app.asar whose package.json says beaconBuild: release, and an Electron Framework
    // carrying a V1 fuse wire (sentinel, version 1, length, one '0'/'1' per fuse) set to the release
    // fuses: RunAsNode off, cookie encryption on, NODE_OPTIONS off, inspector off, asar integrity on,
    // app only from the asar. This test is about step 1 inside a real install, so the build has to
    // get past the audit the way a release does, not around it.
    const stage = join(fake, 'stage')
    for (const d of ['out/main', 'out/renderer']) mkdirSync(join(stage, d), { recursive: true })
    writeFileSync(join(stage, 'package.json'), '{"name":"beacon-desktop","main":"out/main/index.js","beaconBuild":"release"}')
    writeFileSync(join(stage, 'out/renderer/index.html'), '<!doctype html>')
    for (const f of ['index', 'a', 'b', 'c', 'd', 'e', 'f']) writeFileSync(join(stage, `out/main/${f}.js`), '')
    const contents = join(installDist, 'mac-arm64', 'Beacon.app', 'Contents')
    mkdirSync(join(contents, 'Resources'), { recursive: true })
    execFileSync('npx', ['--yes', '@electron/asar', 'pack', stage, join(contents, 'Resources', 'app.asar')], { stdio: 'ignore' })
    const framework = join(contents, 'Frameworks', 'Electron Framework.framework', 'Electron Framework')
    mkdirSync(dirname(framework), { recursive: true })
    writeFileSync(framework, Buffer.concat([Buffer.from('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX'), Buffer.from([1, 8]), Buffer.from('01001111')]))
    makeBuild('mac-arm64', 5, '7.7.7', installDist)

    const hung = decoy(true)
    const sim = decoy()
    const refused = bash([SCRIPT], env({ [TEMP_APP_EXE]: hung, [SIM_EXE]: sim }))
    check(refused.code !== 0, `the install exits NON-ZERO while the app will not quit (got ${refused.code})`)
    check(/Nothing was installed/.test(refused.out) && !/installed:/.test(refused.out), 'and says nothing was installed')
    check(installed() === '0.0.1-old', `the installed build is untouched (found ${installed()})`)
    check(alive(hung) && alive(sim), 'no SIGKILL, and the Simulator untouched')
    killDecoys()

    mkdirSync(join(downloads, 'Beacon.app'), { recursive: true }) // a full copy step 3 deletes
    const app = decoy()
    const sim2 = decoy()
    const done = bash([SCRIPT], env({ [TEMP_APP_EXE]: app, [SIM_EXE]: sim2 }))
    check(done.code === 0 && /installed:/.test(done.out), `the install completes once the app quits (got ${done.code})`)
    const stoppedAt = done.out.indexOf('SIGTERM')
    check(stoppedAt >= 0 && stoppedAt < done.out.indexOf('installing to'), 'the app was stopped BEFORE the copy')
    check(installed() === '7.7.7', `the new build is installed (found ${installed()})`)
    check(!alive(app) && alive(sim2), 'the app was stopped, the Simulator was not')
    check(!existsSync(join(downloads, 'Beacon.app')), 'the ~/Downloads copy was removed (from the temp HOME)')
    check(
      /LaunchServices left alone/.test(done.out) && !/refreshing LaunchServices/.test(done.out),
      'and the temp install was NOT registered with LaunchServices'
    )
    if (done.code !== 0) console.error(done.out)
    killDecoys()
  }
}

rmSync(fake, { recursive: true, force: true })
rmSync(root, { recursive: true, force: true })
console.log(`\n${failures === 0 ? 'PASS' : `FAIL (${failures})`}\n`)
process.exit(failures === 0 ? 0 : 1)
