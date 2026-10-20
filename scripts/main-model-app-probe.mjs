#!/usr/bin/env node
// main-model-app-probe — Config → Models → "Main model" in the BUILT app, against a REAL configured Prometheus (main with #737),
// with real clicks and typing.
//
//   export BEACON_SIGNED_PYTHON=<a python with Prometheus's dependencies, e.g. ~/projects/Prometheus/.venv/bin/python>
//   export BEACON_PROMETHEUS_SRC=<prometheus tree at main, with #737>/src
//   npm run build && npm run probe:main-model [screenshot-dir]
//
// The world (scripts/lib/model-daemon.mjs): the daemon in a scratch home on loopback and ephemeral ports, under an mDNS sandbox and a
// listen tripwire that each prove themselves first; its key check and Beacon's OpenRouter sign-in both go to a stand-in on this
// Mac. The browser is a recorder (shell.openExternal replaced from main's inspector); the probe does what OpenRouter's page does
// when the person authorizes. Beacon holds the operator credential, the way it does after setup.
//
// 1. The section says what runs (Anthropic, its version, a key saved), in plain words.
// 2. Change → the OpenRouter row → Sign in with OpenRouter → authorized → "This key works." → Save: Prometheus saved OpenRouter
//    with the signed-in key in its env file (not its config), nothing running changed, the section offers [Restart now].
// 3. [Restart now] → Prometheus restarts (same ports, 127.0.0.1 only) → the section says OpenRouter runs, nothing pending.
// 4. Change → OpenAI → a refused key: "didn't accept", Save stays off; a good key: "This key works." → Save → saved, pending.
// 5. No key ever reached the page or Beacon's profile. An approved device that is not the owner sees no section.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchApp } from './app-driver.mjs'
import { GOOD, modelDaemonConfigured, sleep, startWorld, until } from './lib/model-daemon.mjs'

const SHOTS = process.argv[2] ?? null
if (process.platform !== 'darwin' || !modelDaemonConfigured()) {
  console.log('[probe] SKIPPED: macOS, with BEACON_SIGNED_PYTHON and BEACON_PROMETHEUS_SRC')
  process.exit(3)
}
for (const k of Object.keys(process.env)) if (k.startsWith('BEACON_GATEWAY') || k.startsWith('PROMETHEUS_') || k === 'BEACON_OPENROUTER_BASE') delete process.env[k]
const WORDS = JSON.parse(readFileSync(new URL('../src/shared/onboarding-banned-words.json', import.meta.url), 'utf8')).words

let failures = 0
let checks = 0
const check = (ok, label, extra = '') => {
  checks++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${!ok && extra ? ` — ${String(extra).slice(0, 700)}` : ''}`)
  if (!ok) failures++
}
const MIN_CHECKS = 35
process.on('exit', () => {
  if (failures || checks < MIN_CHECKS) {
    console.log(`\n[probe] FAIL — ${failures} failed, ${checks} ran (at least ${MIN_CHECKS} expected)`)
    process.exitCode = 1
  } else console.log(`\n[probe] OK — ${checks} checks passed`)
})

const world = await startWorld()
const profile = mkdtempSync(join(tmpdir(), 'beacon-main-model-profile-'))
let app = null
const SECTION = '[data-testid="main-model"]'
const section = () =>
  app.page.evaluate(`(() => {
    const s = document.querySelector(${JSON.stringify(SECTION)})
    if (!s) return null
    const t = (id) => s.querySelector('[data-testid="' + id + '"]')?.innerText ?? null
    const save = s.querySelector('[data-testid="main-model-save"]')
    // The section's own words: without its title (it names the thing) and without what Prometheus reports (versions, names it sent).
    const c = s.cloneNode(true)
    c.querySelectorAll('[data-testid="main-model-title"], [data-untrusted]').forEach((n) => n.remove())
    return { text: s.innerText, own: c.innerText, now: t('main-model-now'), next: t('main-model-next'), verdict: t('main-model-verdict'), status: t('main-model-status'),
      restart: !!s.querySelector('[data-testid="main-model-restart"]'), saveOn: !!save && !save.disabled, editing: !!s.querySelector('[data-testid="main-model-editor"]') }
  })()`)
const settle = (pred, ms = 10000) => until(async () => { const s = await section(); return s && pred(s) ? s : null }, ms, 150)
/** A real click: scrolled into view, hit-tested at its centre, then a mouse press. */
async function click(selector) {
  const at = await app.page.evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)})
    if (!el) return 'missing'
    el.scrollIntoView({ block: 'center' })
    const r = el.getBoundingClientRect()
    const x = r.left + r.width / 2, y = r.top + r.height / 2
    const hit = document.elementFromPoint(x, y)
    if (!(hit && (hit === el || el.contains(hit)))) return 'covered'
    if (el.disabled) return 'disabled'
    return { x, y }
  })()`)
  if (typeof at === 'string') return at
  for (const type of ['mousePressed', 'mouseReleased']) await app.page.send('Input.dispatchMouseEvent', { type, x: at.x, y: at.y, button: 'left', clickCount: 1 })
  return 'clicked'
}
async function type(selector, value) {
  const r = await click(selector)
  if (r !== 'clicked') return r
  await app.page.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); el.select?.(); return true })()`)
  await app.page.send('Input.insertText', { text: value })
  return 'typed'
}
async function shot(name) {
  if (!SHOTS) return
  mkdirSync(SHOTS, { recursive: true })
  const r = await app.page.send('Page.captureScreenshot', { format: 'png' })
  if (r.result?.data) writeFileSync(join(SHOTS, `${name}.png`), Buffer.from(r.result.data, 'base64'))
}
const jargon = (text) => WORDS.filter((w) => new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(text))

let d = null
try {
  d = await world.configured()
  const g0 = await d.call('GET', '/api/model', undefined, d.master)
  check(g0.json?.running?.provider === 'anthropic' && g0.json?.key?.present === true, 'the scratch Prometheus runs Anthropic with a key saved', JSON.stringify(g0.json?.running))
  Object.assign(process.env, { BEACON_GATEWAY_HOST: '127.0.0.1', BEACON_GATEWAY_API_PORT: String(d.api), BEACON_GATEWAY_WS_PORT: String(d.ws), BEACON_OPENROUTER_BASE: world.STUB })
  app = await launchApp({ profile })
  check(app.pagePath.includes('/out/renderer/'), "the page is this checkout's build", app.pagePath)
  await app.mainEval(`globalThis.__opened = []; __electron.shell.openExternal = async (u) => { globalThis.__opened.push(String(u)) }; true`)
  const saved = await app.page.evaluate(`window.beacon.setup.save({ address: '127.0.0.1', apiPort: ${d.api}, wsPort: ${d.ws}, token: ${JSON.stringify(d.master)} }).then((r) => r.ok)`)
  check(saved === true, "Beacon holds the operator credential (its own setup IPC; the mock keychain)")

  // ── 1. what runs ─────────────────────────────────────────────────────────────────────────────────────────────────────
  check((await click('nav[aria-label="Views"] [title="Config"]')) === 'clicked', "a real click on the rail's Config entry")
  const s1 = await settle((s) => !!s.now)
  check(s1?.now === 'Now: Anthropic (Claude) · claude-sonnet-5', 'Config → Models → Main model: what runs, by company and version', JSON.stringify(s1))
  check(!!s1 && /A key for Anthropic \(Claude\) is saved/.test(s1.text) && !s1.restart && s1.next === null, 'a key is saved; nothing to restart', s1?.text)
  check(!!s1 && jargon(s1.own).length === 0, 'its own words keep to the plain-language list', jargon(s1?.own ?? '').join(', '))
  await shot('1-now')

  // ── 2. OpenRouter by signing in ──────────────────────────────────────────────────────────────────────────────────────
  check((await click('[data-testid="main-model-change"]')) === 'clicked', 'Change')
  check((await click('[data-testid="main-model-choice-openrouter"]')) === 'clicked', 'the OpenRouter row')
  const offered = await settle((s) => s.editing && /Sign in with OpenRouter/.test(s.text) && /paste a key/i.test(s.text))
  check(!!offered && !offered.saveOn, 'OpenRouter offers Sign in with OpenRouter, or a pasted key; Save waits for a key', offered?.text)
  check((await click('[data-testid="main-model-signin"]')) === 'clicked', 'Sign in with OpenRouter')
  const url = await until(async () => (await app.mainEval('globalThis.__opened.slice()'))[0] ?? null, 5000)
  const u = url ? new URL(url) : null
  check(!!u && u.origin + u.pathname === `${world.STUB}/auth` && u.searchParams.get('code_challenge_method') === 'S256' && /^http:\/\/localhost:\d+\/openrouter\/callback$/.test(u.searchParams.get('callback_url') ?? ''), "the browser is sent to (the stand-in for) OpenRouter's page: the same sign-in as setup, PKCE S256, a localhost callback", url ?? 'nothing opened')
  const cb = new URL(u.searchParams.get('callback_url'))
  const authorized = await fetch(`http://127.0.0.1:${cb.port}${cb.pathname}?code=probe-code&state=${encodeURIComponent(u.searchParams.get('state'))}`)
  await until(() => world.stub.issued.length >= 1, 5000)
  const issued = world.stub.issued[0]
  check(authorized.status === 200 && createHash('sha256').update(issued?.body.code_verifier ?? '').digest('base64url') === u.searchParams.get('code_challenge'), 'authorized: the exchange carried the verifier for the challenge the browser carried')
  const works = await settle((s) => s.verdict === 'This key works.' && s.saveOn, 20000)
  const checkedBy = world.stub.requests.filter((r) => r.path === '/api/v1/chat/completions' && r.auth === `Bearer ${issued?.key}`).length
  check(!!works && checkedBy >= 1, "\"This key works.\": Prometheus checked the signed-in key with OpenRouter before anything was saved, and Save is on", JSON.stringify({ verdict: works?.verdict, checkedBy }))
  await shot('2-signed-in')
  check((await click('[data-testid="main-model-save"]')) === 'clicked', 'Save')
  const s2 = await settle((s) => s.restart && !!s.next)
  check(s2?.now === 'Now: Anthropic (Claude) · claude-sonnet-5' && s2?.next === 'After a restart: OpenRouter · anthropic/claude-sonnet-5', 'saved: Anthropic still runs, OpenRouter after a restart', JSON.stringify(s2))
  check(!!s2 && s2.restart && /Restart Prometheus/.test(s2.text), 'and it offers [Restart now]', s2?.text)
  const g2 = await d.call('GET', '/api/model', undefined, d.master)
  const yaml = readFileSync(join(d.home, '.prometheus/prometheus.yaml'), 'utf8')
  const envFile = readFileSync(join(d.home, '.config/prometheus/env'), 'utf8')
  check(g2.json?.saved?.provider === 'openrouter' && g2.json?.running?.provider === 'anthropic' && g2.json?.pending === true, 'Prometheus agrees: saved OpenRouter, running Anthropic, pending', JSON.stringify({ saved: g2.json?.saved, running: g2.json?.running }))
  check(!!issued && envFile.split('\n').some((l) => l.startsWith('OPENROUTER_API_KEY=') && l.includes(issued.key)) && !yaml.includes(issued.key), "the signed-in key is in Prometheus's env file, not its config", envFile.split('\n').map((l) => l.replace(/=.*/, '=…')).join(' '))
  await shot('2-saved')

  // ── 3. [Restart now] ─────────────────────────────────────────────────────────────────────────────────────────────────
  const fp = (await d.call('GET', '/api/hello')).json?.fp
  check((await click('[data-testid="main-model-restart"]')) === 'clicked', '[Restart now]')
  const s3 = await settle((s) => s.now === 'Now: OpenRouter · anthropic/claude-sonnet-5', 60000)
  check(!!s3 && s3.next === null && !s3.restart, 'after the restart: OpenRouter runs, nothing pending, no restart offered', JSON.stringify(s3))
  const g3 = await d.call('GET', '/api/model', undefined, d.master)
  check(g3.json?.running?.provider === 'openrouter' && g3.json?.applied === 'live' && (await d.call('GET', '/api/hello')).json?.fp === fp, 'Prometheus agrees, and it is the same computer (fp)', JSON.stringify(g3.json?.running))
  const where = d.listening()
  check(where.length > 0 && where.every((n) => n.startsWith('127.0.0.1:')), 'it came back on 127.0.0.1 only', JSON.stringify(where))
  await shot('3-restarted')

  // ── 4. OpenAI with a pasted key ──────────────────────────────────────────────────────────────────────────────────────
  check((await click('[data-testid="main-model-change"]')) === 'clicked' && (await click('[data-testid="main-model-choice-openai"]')) === 'clicked', 'Change → OpenAI')
  const refusedKey = 'sk-proj-refused' + 'r'.repeat(40)
  check((await type('[data-testid="main-model-key"]', refusedKey)) === 'typed' && (await click('[data-testid="main-model-check"]')) === 'clicked', 'a pasted key, then Check key')
  const no = await settle((s) => /didn't accept this key/.test(s.verdict ?? ''), 15000)
  check(!!no && !no.saveOn && no.verdict === "OpenAI (ChatGPT) didn't accept this key. Make a new key and paste it here.", 'a refused key: said so, and Save stays off', JSON.stringify(no))
  await type('[data-testid="main-model-key"]', GOOD.openai)
  await click('[data-testid="main-model-check"]')
  const yes = await settle((s) => s.verdict === 'This key works.' && s.saveOn, 15000)
  check(!!yes, 'a good key: "This key works.", Save on', JSON.stringify(await section()))
  // A key changed after its check is not the key that was checked: Save goes off until it is checked again.
  await type('[data-testid="main-model-key"]', refusedKey)
  const edited = await settle((s) => !s.saveOn && s.verdict === null, 5000)
  check(!!edited, 'the key edited after a good check: the verdict goes, and Save is off again', JSON.stringify(await section()))
  await type('[data-testid="main-model-key"]', GOOD.openai)
  await click('[data-testid="main-model-check"]')
  await settle((s) => s.verdict === 'This key works.' && s.saveOn, 15000)
  await click('[data-testid="main-model-save"]')
  const s4 = await settle((s) => s.next === 'After a restart: OpenAI (ChatGPT) · gpt-5.6-luna')
  const g4 = await d.call('GET', '/api/model', undefined, d.master)
  check(!!s4 && s4.restart && g4.json?.saved?.provider === 'openai' && readFileSync(join(d.home, '.config/prometheus/env'), 'utf8').split('\n').some((l) => l.startsWith('OPENAI_API_KEY=') && l.includes(GOOD.openai)), 'saved OpenAI with the key that was checked; restart offered', JSON.stringify({ s4, saved: g4.json?.saved }))
  check(!!s4 && jargon(s4.own).length === 0, 'the section\'s own words still keep to the list', jargon(s4?.own ?? '').join(', '))
  await shot('4-openai')

  // ── 5. no key reached the page or the profile; the owner only ────────────────────────────────────────────────────────
  const dump = await app.page.evaluate(`JSON.stringify({ html: document.documentElement.outerHTML, ls: Object.entries(localStorage), ss: Object.entries(sessionStorage) })`)
  const keys = [['signed-in key', issued?.key], ['refused key', refusedKey]]
  check(keys.every(([, k]) => k && !dump.includes(k)), "neither the signed-in key nor a pasted one is in the page's DOM or storage")
  await app.quit()
  app = null
  const leaks = []
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const f = join(dir, e.name)
      if (e.isDirectory()) walk(f)
      else if (e.isFile() && statSync(f).size < 50_000_000) for (const [n, k] of [...keys, ['pasted key', GOOD.openai]]) if (readFileSync(f).includes(k)) leaks.push(`${n} in ${f.replace(profile, '<profile>')}`)
    }
  }
  walk(profile)
  check(leaks.length === 0, "and none is anywhere in Beacon's profile", leaks.join(' | '))
  app = await launchApp({ profile })
  const asDevice = await app.page.evaluate(`window.beacon.setup.save({ address: '127.0.0.1', apiPort: ${d.api}, wsPort: ${d.ws}, token: ${JSON.stringify(d.device)} }).then((r) => r.ok)`)
  const read = await app.page.evaluate('window.beacon.mainModel.get()')
  check(asDevice === true && read?.kind === 'hidden', 'an approved device that is not the owner: hidden (Prometheus said 403 operator_only)', JSON.stringify(read))
} catch (e) {
  check(false, 'the probe ran to the end', e?.stack ?? String(e))
} finally {
  if (app) await app.quit()
  const end = await world.stopAll()
  check(end.alive === 0, 'every daemon this probe started has stopped', `${end.alive} alive`)
  check(end.tripped.length === 0, 'no daemon ever listened beyond 127.0.0.1 (the tripwire read every 150 ms)', end.tripped.join(' | '))
  rmSync(profile, { recursive: true, force: true })
  if (existsSync(profile)) console.log('[probe] note: the scratch profile is still there')
}
