// Probe for app-driver's scratchProfile(): the copy of the live cache DB that every real-app probe
// starts from. beacon.db is in WAL mode, so what a read-only copy can open depends on whether the
// app that owns it is running — and the probes are run both ways.
//
// Each scenario builds a FAKE live profile and runs scratchProfile() in a child with HOME pointed at
// it (os.homedir() honours $HOME, and LIVE_PROFILE is derived from it), and with a stub `pgrep`
// first on PATH, since the real one would see the user's own Beacon. The user's profile is never
// opened: the probe refuses to start if the child would resolve it.
//
//   closed          no lock, no Beacon, no side files       → copied, every row, live DB untouched
//   stale lock      SingletonLock names a dead pid          → same as closed
//   crashed         a hot -wal holds committed rows         → copied WITH those rows (an immutable
//                                                             read would silently drop them)
//   running         a writer holds the DB open, lock live   → copied, including its uncheckpointed rows
//
// In every scenario the copy's outbox is empty (the driver must not replay a pending send).
//
//   npm run probe:scratch-profile
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DRIVER = pathToFileURL(join(REPO, 'scripts/app-driver.mjs')).href
const REAL_PROFILE = join(homedir(), 'Library/Application Support/beacon-desktop')

let failures = 0
let checks = 0
const MIN_CHECKS = 20
const check = (ok, what, detail = '') => {
  checks++
  console.log(`[probe] ${ok ? 'PASS' : 'FAIL'}  ${what}${!ok && detail ? `\n        ${detail}` : ''}`)
  if (!ok) failures++
}
// The verdict rides process exit, so an early throw can't skip it into a silent pass.
process.on('exit', (code) => {
  if (checks < MIN_CHECKS) console.log(`[probe] FAIL  only ${checks} of ${MIN_CHECKS} checks ran — the probe stopped early`)
  if (failures || checks < MIN_CHECKS || code) {
    console.log(`[probe] ${failures} failure(s)`)
    process.exitCode = 1
  } else console.log(`[probe] all ${checks} checks passed`)
})

const root = mkdtempSync(join(tmpdir(), 'beacon-scratch-profile-probe-'))
const bin = join(root, 'bin')
mkdirSync(bin)
// Exit status comes from the environment: FAKE_PGREP 1 = "no Beacon running", 0 = "Beacon is running".
// FAKE_PGREP_FLIP=<file>: "not running" on the first call, "running" on every later one — Beacon
// starting while the copy is being taken.
writeFileSync(
  join(bin, 'pgrep'),
  [
    '#!/bin/sh',
    'if [ -n "$FAKE_PGREP_FLIP" ]; then',
    '  if [ -e "$FAKE_PGREP_FLIP" ]; then echo 424242; exit 0; fi',
    '  : > "$FAKE_PGREP_FLIP"; exit 1',
    'fi',
    '[ "${FAKE_PGREP:-1}" = 0 ] && echo 424242',
    'exit "${FAKE_PGREP:-1}"',
    '',
  ].join('\n'),
)
chmodSync(join(bin, 'pgrep'), 0o755)

const copies = [] // scratchProfile() makes its own temp dirs; removed at the end
const sqlite = (db, stmt) => execFileSync('sqlite3', [db, stmt]).toString().trim()
const sha = (f) => (existsSync(f) ? createHash('sha256').update(readFileSync(f)).digest('hex') : null)

/** A fake HOME whose live profile has a WAL-mode beacon.db: `rows` sessions, one pending outbox send. */
function fakeHome(name, rows = 3) {
  const home = join(root, name)
  const profile = join(home, 'Library/Application Support/beacon-desktop')
  mkdirSync(profile, { recursive: true })
  const db = join(profile, 'beacon.db')
  const inserts = Array.from({ length: rows }, (_, i) => `INSERT INTO sessions VALUES ('s${i}');`).join('')
  sqlite(db, `PRAGMA journal_mode=WAL; CREATE TABLE sessions (id TEXT); CREATE TABLE outbox (id TEXT); ${inserts} INSERT INTO outbox VALUES ('pending'); PRAGMA wal_checkpoint(TRUNCATE);`)
  // macOS's sqlite3 CLI keeps -wal/-shm after a clean close (persistent WAL); Beacon's own SQLite
  // deletes them. Everything is checkpointed into the main file above, so removing them leaves
  // exactly what a quit Beacon leaves.
  for (const s of ['-wal', '-shm']) rmSync(db + s, { force: true })
  return { home, profile, db }
}

/** Run scratchProfile() as the probes do, in a child that sees `home` as $HOME. */
function runScratch(home, env = {}) {
  const r = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', `const m = await import(${JSON.stringify(DRIVER)}); console.log('DIR=' + m.scratchProfile())`],
    { env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, ...env }, encoding: 'utf8', timeout: 30_000 },
  )
  const dir = /^DIR=(.*)$/m.exec(r.stdout ?? '')?.[1] ?? null
  if (dir) copies.push(dir)
  return { status: r.status, dir, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() }
}

const countIn = (dir, table) => {
  try {
    return Number(sqlite(join(dir, 'beacon.db'), `SELECT count(*) FROM ${table}`))
  } catch (e) {
    return `unreadable: ${String(e.stderr ?? e.message).trim()}`
  }
}
const firstLine = (s) => s.split('\n').find((l) => /Error|error|failed/.test(l)) ?? s.split('\n').pop()

try {
  // ── the probe never reaches the user's profile ──
  {
    const { home, profile } = fakeHome('guard', 1)
    const seen = execFileSync(process.execPath, ['-e', 'console.log(require("os").homedir())'], { env: { ...process.env, HOME: home }, encoding: 'utf8' }).trim()
    const ok = seen === home && resolve(profile) !== resolve(REAL_PROFILE)
    check(ok, 'a child given a fake HOME resolves the live profile inside it, not the real one', `homedir()=${seen}`)
    if (!ok) throw new Error('refusing to continue: the child would see the real profile')
  }

  // ── closed: Beacon not running, clean shutdown (no -wal/-shm) ──
  {
    const { home, db } = fakeHome('closed', 3)
    check(!existsSync(db + '-wal') && !existsSync(db + '-shm'), 'closed: the fake live DB has no side files (a clean shutdown)')
    const before = sha(db)
    const r = runScratch(home, { FAKE_PGREP: '1' })
    check(r.status === 0 && r.dir, 'closed: scratchProfile() succeeds with Beacon not running', firstLine(r.out))
    check(r.dir && countIn(r.dir, 'sessions') === 3, 'closed: the copy holds every session row', r.dir ? `sessions=${countIn(r.dir, 'sessions')}` : 'no copy')
    check(r.dir && countIn(r.dir, 'outbox') === 0, 'closed: the copy\'s outbox is emptied')
    check(sha(db) === before && !existsSync(db + '-wal') && !existsSync(db + '-shm'), 'closed: the live DB is byte-identical and gained no side files')
  }

  // ── stale lock: SingletonLock left by a dead process ──
  {
    const { home, profile } = fakeHome('stale-lock', 2)
    let dead = 999_999
    for (;;) {
      try {
        process.kill(dead, 0)
        dead--
      } catch (e) {
        if (e.code === 'ESRCH') break
        dead--
      }
    }
    symlinkSync(`fakehost-${dead}`, join(profile, 'SingletonLock'))
    const r = runScratch(home, { FAKE_PGREP: '1' })
    check(r.status === 0 && r.dir, `stale lock: a SingletonLock naming dead pid ${dead} does not block the copy`, firstLine(r.out))
    check(r.dir && countIn(r.dir, 'sessions') === 2, 'stale lock: the copy holds every session row', r.dir ? `sessions=${countIn(r.dir, 'sessions')}` : 'no copy')
  }

  // ── crashed: a hot WAL with committed rows the main file does not have ──
  {
    const { home, db } = fakeHome('crashed', 1)
    // Snapshot the db trio while a writer still holds it open with checkpointing off: that is the
    // state a crash leaves behind.
    const snap = join(root, 'crash-snap')
    mkdirSync(snap)
    execFileSync('sqlite3', [db], {
      input: `PRAGMA wal_autocheckpoint=0;\nINSERT INTO sessions VALUES ('only-in-wal');\n.shell cp "${db}" "${db}-wal" "${db}-shm" "${snap}/"\n`,
    })
    for (const s of ['', '-wal', '-shm']) writeFileSync(db + s, readFileSync(join(snap, 'beacon.db' + s)))
    const mainOnly = Number(execFileSync('sqlite3', [`file:${db}?mode=ro&immutable=1`, 'SELECT count(*) FROM sessions']).toString().trim())
    check(existsSync(db + '-wal') && mainOnly === 1, 'crashed: the fake has a hot -wal, and the main file alone holds 1 of the 2 rows', `main file alone: ${mainOnly}`)
    const r = runScratch(home, { FAKE_PGREP: '1' })
    check(r.status === 0 && r.dir, 'crashed: scratchProfile() succeeds', firstLine(r.out))
    check(r.dir && countIn(r.dir, 'sessions') === 2, 'crashed: the copy includes the row that exists only in the WAL', r.dir ? `sessions=${countIn(r.dir, 'sessions')}` : 'no copy')
  }

  // ── running: a writer holds the DB open, with rows not yet checkpointed ──
  {
    const { home, profile, db } = fakeHome('running', 1)
    symlinkSync(`fakehost-${process.pid}`, join(profile, 'SingletonLock')) // a live pid: ours
    const writer = spawn('sqlite3', [db], { stdio: ['pipe', 'pipe', 'inherit'] })
    let ready = ''
    writer.stdout.on('data', (d) => (ready += d))
    writer.stdin.write(`PRAGMA wal_autocheckpoint=0;\nINSERT INTO sessions VALUES ('uncheckpointed');\nSELECT 'ready';\n`)
    for (let i = 0; i < 100 && !ready.includes('ready'); i++) await new Promise((r) => setTimeout(r, 50))
    check(ready.includes('ready') && existsSync(db + '-shm'), 'running: a writer holds the fake DB open (WAL + shm present)')
    const r = runScratch(home, { FAKE_PGREP: '0' })
    writer.stdin.end()
    await new Promise((r) => writer.on('exit', r))
    check(r.status === 0 && r.dir, 'running: scratchProfile() succeeds while the DB is open', firstLine(r.out))
    check(r.dir && countIn(r.dir, 'sessions') === 2, 'running: the copy includes the writer\'s uncheckpointed row', r.dir ? `sessions=${countIn(r.dir, 'sessions')}` : 'no copy')
    check(r.dir && countIn(r.dir, 'outbox') === 0, 'running: the copy\'s outbox is emptied')
  }

  // ── Beacon running by pgrep alone, no lock (packaged app, side files present) ──
  {
    const { home, db } = fakeHome('pgrep-only', 2)
    const writer = spawn('sqlite3', [db], { stdio: ['pipe', 'pipe', 'inherit'] })
    let ready = ''
    writer.stdout.on('data', (d) => (ready += d))
    // A table read, not a bare SELECT 'ready': a constant SELECT never opens the pager, so the DB
    // would not actually be open and no -shm would exist.
    writer.stdin.write(`SELECT count(*) FROM sessions;\nSELECT 'ready';\n`)
    for (let i = 0; i < 100 && !ready.includes('ready'); i++) await new Promise((r) => setTimeout(r, 50))
    check(ready.includes('ready') && existsSync(db + '-shm'), 'pgrep-only: a reader holds the fake DB open (shm present), with no SingletonLock')
    const r = runScratch(home, { FAKE_PGREP: '0' })
    writer.stdin.end()
    await new Promise((r) => writer.on('exit', r))
    check(r.status === 0 && r.dir && countIn(r.dir, 'sessions') === 2, 'pgrep-only: a running Beacon with no lock file is still copied in full', firstLine(r.out))
  }

  // ── doubt counts as in use: each signal alone keeps the driver off the immutable read ──
  // With Beacon possibly running, an immutable read could race its writes and copy a torn DB. The
  // driver must take the -readonly path instead, which on a DB nobody has opened fails LOUDLY. Each
  // scenario has only ONE signal, so it pins that signal: the side-file check can't stand in for it.
  {
    const { home } = fakeHome('pgrep-alone', 1)
    const r = runScratch(home, { FAKE_PGREP: '0' })
    check(r.status !== 0 && /-readonly \(Beacon is running/.test(r.out), 'pgrep alone: Beacon running (no lock, no side files) → -readonly, never an immutable read', firstLine(r.out))
  }
  {
    const { home, profile } = fakeHome('lock-alone', 1)
    symlinkSync(`fakehost-${process.pid}`, join(profile, 'SingletonLock'))
    const r = runScratch(home, { FAKE_PGREP: '1' })
    check(r.status !== 0 && /-readonly \(pid \d+ holds SingletonLock/.test(r.out), 'lock alone: a live SingletonLock (no pgrep hit, no side files) → -readonly, never an immutable read', firstLine(r.out))
  }
  {
    const { home } = fakeHome('starts-mid-copy', 1)
    const r = runScratch(home, { FAKE_PGREP_FLIP: join(root, 'flip') })
    check(r.status !== 0 && /came into use during the immutable copy/.test(r.out), 'Beacon starting during an immutable copy → the copy is refused, not returned', firstLine(r.out))
  }
} catch (e) {
  check(false, 'the probe ran to completion', String(e?.stack ?? e))
} finally {
  for (const d of [root, ...copies]) rmSync(d, { recursive: true, force: true })
}
