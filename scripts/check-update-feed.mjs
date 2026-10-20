#!/usr/bin/env node
// Update-feed audit: does the PACKAGED app-update.yml point at the public release repo, and carry no
// credential?
//
// WHY THE ARTIFACT. electron-builder writes app-update.yml at package time from electron-builder.yml's
// `publish:` block, and that generated file is the only thing electron-updater reads. updater-smoke
// pins the source config; this reads what actually ships, because the packager reads disk and its
// own defaults, not our intent (see check-bundle.mjs for the time that difference shipped secrets).
//
// What must hold, all fail-closed:
//   1. provider github, owner OAraLabs, repo beacon: the public, installers-only repo.
//   2. No `token:` key (it would sit in plain text in every installer) and no `private:` key (with
//      `private: true` electron-updater reads GH_TOKEN/GITHUB_TOKEN from the environment).
//   3. No token-shaped string anywhere in the file, whatever key it hides under.
//   4. Every line is a flat `key: value` with a key we know. Anything else is refused rather than
//      skipped: a parser that ignores what it does not understand is how a nested `token:` passes.
//
// The checker proves itself before it checks anything: a self-test runs a passing fixture and one
// failing fixture per rule, and exits 3 if any fixture gets the wrong verdict.
//
//   node scripts/check-update-feed.mjs --self-test           # self-test only (smoke:update-feed)
//   node scripts/check-update-feed.mjs <target> [<target>…]  # self-test, then each target
//
// A target is an app-update.yml, a Beacon.app, an unpacked dir (dist/linux-unpacked), or a shipped
// artifact: a mac .zip, a .deb, or an .AppImage (Linux only: it is extracted by running it).
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const EXPECTED = { provider: 'github', owner: 'OAraLabs', repo: 'beacon' }
// What electron-builder 26 writes for a github publish entry with no token (verified against a real
// `electron-builder --dir` build). A key outside this set fails until someone looks at it.
const KNOWN_KEYS = new Set(['provider', 'owner', 'repo', 'updaterCacheDirName'])
const TOKEN_SHAPES = /\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/

/** Returns a list of problems; empty means the file is acceptable. */
export function auditFeed(text) {
  const problems = []
  if (typeof text !== 'string' || !text.trim()) return ['app-update.yml is empty']
  if (TOKEN_SHAPES.test(text)) problems.push('a GitHub-token-shaped string is in the file')
  const fields = {}
  for (const [i, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.replace(/\s+#.*$/, '')
    if (!line.trim() || /^\s*#/.test(line)) continue
    const m = line.match(/^([A-Za-z][A-Za-z0-9_]*):\s*(.*?)\s*$/)
    if (!m) {
      problems.push(`line ${i + 1} is not a flat \`key: value\`: ${JSON.stringify(raw.slice(0, 60))}`)
      continue
    }
    const [, key, rawVal] = m
    const val = rawVal.replace(/^(['"])(.*)\1$/, '$2')
    if (key === 'token') problems.push('a `token:` key is present: it would ship in plain text')
    else if (key === 'private') problems.push(`a \`private:\` key is present (${val}): the updater would read GH_TOKEN from the environment`)
    else if (!KNOWN_KEYS.has(key)) problems.push(`unknown key \`${key}\`: refused until someone checks what it does`)
    if (key in fields) problems.push(`\`${key}\` appears twice`)
    fields[key] = val
  }
  for (const [k, want] of Object.entries(EXPECTED)) {
    if (fields[k] !== want) problems.push(`${k} is ${fields[k] === undefined ? 'missing' : JSON.stringify(fields[k])}, want ${JSON.stringify(want)}`)
  }
  return problems
}

function selfTest() {
  const good = 'owner: OAraLabs\nrepo: beacon\nprovider: github\nupdaterCacheDirName: beacon-desktop-updater\n'
  const cases = [
    ['the real shape passes', good, true],
    ['quoted values pass', "owner: 'OAraLabs'\nrepo: \"beacon\"\nprovider: github\n", true],
    ['the OLD feed (private source repo) fails', 'owner: OAraLabs\nrepo: beacon-desktop\nprovider: github\nprivate: true\n', false],
    ['the old repo alone fails (repo pin is exact, not a prefix)', good.replace('repo: beacon', 'repo: beacon-desktop'), false],
    ['private: true fails', good + 'private: true\n', false],
    ['private: false fails too (the key itself is refused)', good + 'private: false\n', false],
    ['a token key fails', good + 'token: abc\n', false],
    ['a token-shaped value under another key fails', good.replace('beacon-desktop-updater', 'ghp_' + 'a'.repeat(36)), false],
    ['a fine-grained PAT shape fails', good + '# github_pat_' + 'B'.repeat(40) + '\n', false],
    ['a nested token fails (not skipped as unparsed)', good + 'requestHeaders:\n  authorization: token abc\n', false],
    ['an unknown key fails', good + 'host: example.com\n', false],
    ['a wrong owner fails', good.replace('OAraLabs', 'someone-else'), false],
    ['a missing provider fails', good.replace('provider: github\n', ''), false],
    ['a duplicate key fails', good + 'repo: beacon\n', false],
    ['an empty file fails', '', false]
  ]
  let bad = 0
  for (const [name, text, shouldPass] of cases) {
    const problems = auditFeed(text)
    const passed = problems.length === 0
    if (passed !== shouldPass) {
      bad++
      console.error(`  ✗ self-test: ${name} — got ${passed ? 'PASS' : `FAIL (${problems.join('; ')})`}`)
    }
  }
  if (bad) {
    console.error(`✗ check-update-feed — self-test: ${bad} of ${cases.length} fixtures got the wrong verdict; refusing to check anything`)
    process.exit(3)
  }
  console.log(`✓ check-update-feed — self-test: ${cases.length} fixtures, each with the right verdict`)
}

/** Read app-update.yml out of whatever the target is. Throws with a reason it cannot. */
function readFeed(target) {
  const p = resolve(target)
  if (!existsSync(p)) throw new Error(`no such file or directory: ${target}`)
  const tmp = () => mkdtempSync(join(tmpdir(), 'beacon-feed-'))
  if (statSync(p).isDirectory()) {
    for (const rel of ['Contents/Resources/app-update.yml', 'resources/app-update.yml', 'app-update.yml']) {
      if (existsSync(join(p, rel))) return { from: join(target, rel), text: readFileSync(join(p, rel), 'utf8') }
    }
    throw new Error(`no app-update.yml under ${target} (looked in Contents/Resources/, resources/, ./)`)
  }
  if (p.endsWith('.yml')) return { from: target, text: readFileSync(p, 'utf8') }
  if (p.endsWith('.zip')) {
    const entry = 'Beacon.app/Contents/Resources/app-update.yml'
    return { from: `${target}!${entry}`, text: execFileSync('unzip', ['-p', p, entry], { encoding: 'utf8' }) }
  }
  if (p.endsWith('.deb')) {
    const dir = tmp()
    try {
      execFileSync('sh', ['-c', 'dpkg-deb -x "$1" "$2"', 'sh', p, dir])
      const found = execFileSync('find', [dir, '-path', '*/resources/app-update.yml'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean)
      if (found.length !== 1) throw new Error(`expected one resources/app-update.yml in the .deb, found ${found.length}`)
      return { from: `${target}!${found[0].slice(dir.length)}`, text: readFileSync(found[0], 'utf8') }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
  if (p.endsWith('.AppImage')) {
    if (process.platform !== 'linux' || process.arch !== 'x64') throw new Error('an .AppImage can only be inspected on x64 Linux (it is extracted by running it)')
    const dir = tmp()
    try {
      execFileSync('chmod', ['+x', p])
      execFileSync(p, ['--appimage-extract', 'resources/app-update.yml'], { cwd: dir, stdio: ['ignore', 'ignore', 'pipe'] })
      const f = join(dir, 'squashfs-root/resources/app-update.yml')
      if (!existsSync(f)) throw new Error('the AppImage has no resources/app-update.yml')
      return { from: `${target}!/resources/app-update.yml`, text: readFileSync(f, 'utf8') }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
  throw new Error(`do not know how to read app-update.yml out of ${target}`)
}

const args = process.argv.slice(2)
selfTest()
if (args.length === 1 && args[0] === '--self-test') process.exit(0)
if (!args.length) {
  console.error('✗ check-update-feed — no target given (an app-update.yml, Beacon.app, unpacked dir, .zip, .deb or .AppImage)')
  process.exit(2)
}
let failed = 0
for (const target of args.filter((a) => a !== '--self-test')) {
  let feed
  try {
    feed = readFeed(target)
  } catch (err) {
    failed++
    console.error(`✗ ${target} — could not read app-update.yml: ${err.message}`)
    continue
  }
  const problems = auditFeed(feed.text)
  if (problems.length) {
    failed++
    console.error(`✗ ${feed.from}\n    ${problems.join('\n    ')}`)
  } else {
    console.log(`✓ ${feed.from} — ${EXPECTED.provider} ${EXPECTED.owner}/${EXPECTED.repo}, no token, no private flag`)
  }
}
process.exit(failed ? 1 : 0)
