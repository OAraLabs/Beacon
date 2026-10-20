/**
 * cdp-harness-reap-probe — a probe that exits takes the app it launched down WITH it.
 *
 * WHY. cdp-harness.mjs launched the app as `npx electron .` and its reap signalled that `npx`
 * process. Killing npx does not reach the Electron binary it started, and Beacon does not quit on
 * a plain SIGTERM anyway (it hides to the tray). Measured 2026-10-11 on Linux: every probe run left
 * one live Beacon behind — its window, its tray icon, its CDP port and its profile lock — and the
 * next run's "port already serving CDP" refusal or a stale instance answering was the only sign.
 *
 * HOW. Each case runs a tiny probe in a CHILD process that imports the harness and then leaves the
 * way real probes leave. The parent then looks for any process still carrying that run's own
 * `--user-data-dir=<unique dir>` — so it can only ever see, and only ever clean up, what this run
 * started. Survivors are reported, then killed by PID so a red run does not leak either.
 *
 *   1. a normal finish        — the probe calls process.exit(0) after attaching
 *   2. a failure exit         — process.exit(1) after attaching (a probe with a failed check)
 *   3. an uncaught exception  — the harness's own handler exits
 *
 * Run: npm run probe:harness-reap
 *      (Linux without a desktop session: DISPLAY=:1 BEACON_CDP_ARGS=--no-sandbox npm run probe:harness-reap)
 */
import { spawn, execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HARNESS = fileURLToPath(new URL('./cdp-harness.mjs', import.meta.url))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Every live process whose command line carries `token`, as [pid, command]. Never this one. */
function holders(token) {
  const out = execFileSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8' })
  return out
    .split('\n')
    .map((l) => l.trim().match(/^(\d+)\s+(.*)$/))
    .filter((m) => m && m[2].includes(token) && Number(m[1]) !== process.pid)
    .map((m) => [Number(m[1]), m[2]])
}

const CASES = [
  { name: 'a normal finish', tail: `process.exit(0)` },
  { name: 'a failure exit', tail: `process.exit(1)` },
  { name: 'an uncaught exception', tail: `setTimeout(() => { throw new Error('probe blew up') }, 0)` }
]

let failures = 0
for (const c of CASES) {
  const ud = mkdtempSync(join(tmpdir(), 'beacon-reap-probe-'))
  const script = join(ud, 'probe.mjs')
  writeFileSync(
    script,
    `const h = await import(${JSON.stringify(HARNESS)})\n` +
      `const ready = await h.evaluate('document.readyState')\n` +
      `console.log('[child] attached, document ' + ready)\n` +
      `${c.tail}\n`
  )
  const env = { ...process.env, BEACON_CDP_ARGS: `${process.env.BEACON_CDP_ARGS ?? ''} --user-data-dir=${ud}`.trim() }
  const child = spawn(process.execPath, [script], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  let log = ''
  child.stdout.on('data', (d) => (log += d))
  child.stderr.on('data', (d) => (log += d))
  const code = await new Promise((r) => child.on('exit', (c2) => r(c2)))
  const attached = log.includes('[child] attached')
  // Give a straggler the time a real one would take to notice its parent left.
  await sleep(3000)
  const left = holders(`--user-data-dir=${ud}`)
  const ok = attached && left.length === 0
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${c.name}: exit ${code}, ${attached ? 'attached' : 'NEVER ATTACHED'}, ${left.length} process(es) left`)
  if (!attached) console.log(log.split('\n').slice(-8).map((l) => `         ${l}`).join('\n'))
  for (const [pid, cmd] of left.slice(0, 3)) console.log(`         left: ${pid} ${cmd.slice(0, 110)}`)
  if (!ok) failures++
  for (const [pid] of left) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      /* already gone */
    }
  }
  await sleep(500)
  rmSync(ud, { recursive: true, force: true })
}

console.log(failures === 0 ? '[reap] PASS: every case took its app down with it' : `[reap] FAIL: ${failures} of ${CASES.length} case(s) left the app running`)
process.exit(failures === 0 ? 0 : 1)
