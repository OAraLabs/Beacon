// "Your Prometheus", the sidebar list (docs/MULTI-PROMETHEUS.md §4, §5), in the real app: a scratch profile and five stand-in
// Prometheus on loopback, each with its own key, the ones that can sign with a real Ed25519 node key:
//   A  proves who it is, the one Beacon starts on;
//   B  proves who it is, on its own hardware;
//   C  an older Prometheus: no challenge route, nothing pinned (its row carries "can't prove who it is");
//   D  Beacon pinned one node key for it, and another signs: "A different Prometheus answered";
//   E  nothing listens.
// With A alone there is no list and the title is "Beacon". With all five: a row each with its state in words, A marked, the name in
// the title and the composer; clicking B switches and B's key goes only to B; clicking D switches and D is sent no key at all, and its
// card says what's wrong. Keys are written through the app's own safeStorage under --use-mock-keychain (app-driver), never the real
// Keychain, and the user's own profile is never touched.
//
//   npm run build && npm run probe:instance-list [-- --shot <file.png>]   (--shot: pictures of the five rows, and of the switcher)
import { execFileSync } from 'node:child_process'
import { generateKeyPairSync, sign } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { WebSocketServer } from 'ws'
import { launchApp, sleep } from './app-driver.mjs'
import { profileDb } from './lib/profile-db.mjs'

if (process.platform !== 'darwin') {
  console.log('[probe] SKIPPED: macOS only (app-driver)')
  process.exit(3)
}
for (const k of Object.keys(process.env)) if (k.startsWith('BEACON_') || k.startsWith('PROMETHEUS_')) delete process.env[k]

let failures = 0
let checks = 0
const MIN_CHECKS = 30
const check = (ok, label, extra = '') => {
  checks++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${!ok && extra ? ` — ${String(extra).slice(0, 400)}` : ''}`)
  if (!ok) failures++
}
const json = (res, code, body) => res.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify(body))

function nodeKey() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  return { pub: publicKey.export({ format: 'der', type: 'spki' }).subarray(12).toString('base64'), priv: privateKey }
}
const message = (nonce, id, pub, at) =>
  ['prometheus-identity-challenge/v1', `nonce=${nonce}`, `instance_id=${id ?? ''}`, `node_pub=${pub}`, 'tls_spki_sha256=', `signed_at=${at}`, ''].join('\n')

/** A stand-in Prometheus: signs the challenge with `key` (404 without one), and answers /api/status to `token` only. */
function prometheus({ fp, key, instanceId, token, provider }) {
  const seen = []
  const frames = []
  const rest = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      seen.push({ path: req.url ?? '', auth: req.headers.authorization })
      if (req.url === '/api/hello') return json(res, 200, { v: '0.9.18', name: 'Stand-in', agent: 'Atlas', fp, pair: 'approve', tls: false })
      if (req.url === '/api/identity/challenge' && req.method === 'POST') {
        if (!key) return json(res, 404, { detail: 'Not Found' })
        const nonce = JSON.parse(body || '{}').nonce ?? ''
        const at = Math.floor(Date.now() / 1000)
        const sig = sign(null, Buffer.from(message(nonce, instanceId, key.pub, at)), key.priv).toString('base64')
        return json(res, 200, { v: 1, instance_id: instanceId, node_pub: key.pub, tls_spki_sha256: null, signed_at: at, sig })
      }
      if (req.headers.authorization !== `Bearer ${token}`) return json(res, 401, { error: 'unauthorized' })
      if ((req.url ?? '').startsWith('/api/status')) return json(res, 200, { state: 'idle', provider, model: 'stub-model' })
      if ((req.url ?? '').startsWith('/api/devices')) return json(res, 200, { devices: [], you: { role: 'owner' } })
      json(res, 200, [])
    })
  })
  const wsHttp = createServer()
  new WebSocketServer({ server: wsHttp }).on('connection', (ws) => {
    ws.on('message', (m) => frames.push(m.toString()))
    ws.send(JSON.stringify({ type: 'connected' }))
  })
  return { rest, wsHttp, seen, frames }
}

const [KA, KB, KD, KX] = [nodeKey(), nodeKey(), nodeKey(), nodeKey()]
const [IA, IB, ID, IX] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()]
const A = prometheus({ fp: 'a'.repeat(16), key: KA, instanceId: IA, token: 'KEY-A', provider: 'anthropic' })
const B = prometheus({ fp: 'b'.repeat(16), key: KB, instanceId: IB, token: 'KEY-B', provider: 'ollama' })
const C = prometheus({ fp: 'c'.repeat(16), key: null, instanceId: null, token: 'KEY-C', provider: 'anthropic' })
const D = prometheus({ fp: 'd'.repeat(16), key: KX, instanceId: IX, token: 'KEY-D', provider: 'anthropic' }) // KD is the one pinned
const servers = [A, B, C, D].flatMap((p) => [p.rest, p.wsHttp])
for (const s of servers) await new Promise((r) => s.listen(0, '127.0.0.1', r))
const port = (s) => s.address().port
const api = (p) => `http://127.0.0.1:${port(p.rest)}`
const ws = (p) => `ws://127.0.0.1:${port(p.wsHttp)}`
const gone = createServer()
await new Promise((r) => gone.listen(0, '127.0.0.1', r))
const EPORT = port(gone)
await new Promise((r) => gone.close(r)) // E: nothing listens there now

const profile = mkdtempSync(join(tmpdir(), 'beacon-p4-probe-'))
execFileSync('sqlite3', [join(profile, 'beacon.db'), `CREATE TABLE gateway_profiles (name TEXT PRIMARY KEY, api_base TEXT NOT NULL, ws_url TEXT NOT NULL, is_default INTEGER DEFAULT 0, pin TEXT);
  INSERT INTO gateway_profiles VALUES ('Alpha', '${api(A)}', '${ws(A)}', 1, NULL);`])
const until = async (fn, ms) => {
  const end = Date.now() + ms
  for (;;) {
    const v = await fn().catch(() => null)
    if (v || Date.now() > end) return v
    await sleep(250)
  }
}
const keyed = (p, key) => p.seen.filter((r) => r.auth === `Bearer ${key}`).length + p.frames.filter((f) => f.includes(key)).length
const anyKey = (p) => p.seen.filter((r) => r.auth).length + p.frames.filter((f) => /KEY-/.test(f)).length
const rowsOf = (page) =>
  page.evaluate(`[...document.querySelectorAll('[data-testid="instance-row"]')].map((b) => ({ id: b.dataset.instance, current: b.getAttribute('aria-current') === 'true', text: b.innerText }))`)

let app = null
try {
  // 1. A alone: nothing new on screen.
  app = await launchApp({ profile })
  const up = await until(async () => (await app.page.evaluate('window.beacon.connection.status()'))?.state === 'connected', 15000)
  check(!!up, 'connected to A')
  const one = await app.page.evaluate('window.beacon.instances.list()')
  check(one.length === 1 && one[0].proved === true, 'one Prometheus, proved (its node key pinned at the first answer)', JSON.stringify(one))
  await app.page.evaluate(`document.querySelector('button[title="Chats"]')?.click(); true`)
  await until(() => app.page.evaluate(`!!document.querySelector('aside.sidebar')`), 5000)
  check(!(await app.page.evaluate(`!!document.querySelector('[data-testid="instance-list"]')`)), 'with one, the sidebar has no list')
  check(
    (await app.page.evaluate(`(() => { const b = document.querySelector('[data-testid="app-chrome-brand"]'); return b?.tagName === 'BUTTON' && b.innerText.trim().startsWith('Beacon') })()`)) === true,
    'with one, the title bar still says "Beacon", and opens the switcher (Add a Prometheus…)'
  )
  check((await app.page.evaluate('document.title')) === 'Beacon', 'and the title is "Beacon"', await app.page.evaluate('document.title'))
  const aFolder = one[0].id

  // Each one's key, in its own folder, through the app's own safeStorage (mock keychain).
  const ids = { A: aFolder, B: 'probe-b', C: 'probe-c', D: 'probe-d', E: 'probe-e' }
  const keys = { A: 'KEY-A', B: 'KEY-B', C: 'KEY-C', D: 'KEY-D', E: 'KEY-E' }
  const wrote = await app.mainEval(`(() => {
    const fs = process.getBuiltinModule('fs'); const path = process.getBuiltinModule('path')
    const root = __electron.app.getPath('userData')
    for (const [id, key] of ${JSON.stringify(Object.keys(ids).map((k) => [ids[k], keys[k]]))}) {
      const dir = path.join(root, 'daemons', id); fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, 'credential.bin'), __electron.safeStorage.encryptString(key), { mode: 0o600 })
    }
    return true
  })()`)
  check(wrote === true, 'a key for each, written in its own folder')
  await app.quit()
  app = null

  const appDb = profileDb(profile, 'beacon')
  const row = (id, fp, base, wsUrl, label, inst, pub) =>
    `INSERT INTO daemon_folders (id, fp, api_base, last_active, instance_id, node_pub, label, ws_url, pin) VALUES ('${id}', ${fp ? `'${fp}'` : 'NULL'}, '${base}', 1, ${inst ? `'${inst}'` : 'NULL'}, ${pub ? `'${pub}'` : 'NULL'}, '${label}', '${wsUrl}', NULL);`
  execFileSync('sqlite3', [
    appDb,
    row('probe-b', 'b'.repeat(16), api(B), ws(B), 'Beta', IB, KB.pub) +
      row('probe-c', 'c'.repeat(16), api(C), ws(C), 'Cellar', null, null) +
      row('probe-d', 'd'.repeat(16), api(D), ws(D), 'Den', ID, KD.pub) +
      row('probe-e', 'e'.repeat(16), `http://127.0.0.1:${EPORT}`, `ws://127.0.0.1:${EPORT}`, 'Eaves', null, null)
  ])

  // 2. Five: the list (in the Chats sidebar; the app opens on Mission Control).
  app = await launchApp({ profile })
  const chats = () => app.page.evaluate(`document.querySelector('button[title="Chats"]')?.click(); true`)
  await chats()
  const back = await until(async () => (await app.page.evaluate('window.beacon.connection.status()'))?.state === 'connected', 15000)
  check(!!back && keyed(A, 'KEY-A') > 0, 'back on A, with its own key (the key written for it is the one it got)', `${keyed(A, 'KEY-A')} keyed request(s)`)
  const settled = await until(async () => {
    const r = await rowsOf(app.page)
    const t = (id) => r.find((x) => x.id === id)?.text ?? ''
    return r.length === 5 && t('probe-b').includes('Connected') && t('probe-c').includes('Connected') && t('probe-d').includes('different') && t('probe-e').includes("Can't reach") && t(aFolder).includes('·')
      ? r
      : null
  }, 20000)
  const rows = settled ?? (await rowsOf(app.page))
  const t = (id) => rows.find((x) => x.id === id)?.text ?? ''
  const shot = process.argv.indexOf('--shot')
  if (shot > 0 && process.argv[shot + 1]) {
    const png = await app.page.send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(process.argv[shot + 1], Buffer.from(png.result.data, 'base64'))
  }
  check(rows.length === 5, 'with five, a row each', JSON.stringify(rows))
  check(rows.filter((r) => r.current).length === 1 && rows.find((r) => r.current)?.id === aFolder, 'A is marked as the one Beacon is on, and only A', JSON.stringify(rows))
  check(/Alpha[\s\S]*Connected · /.test(t(aFolder)), "A's row: Connected, and which AI it's on (read from its own connection)", t(aFolder))
  check(/Beta[\s\S]*Connected · your own hardware/i.test(t('probe-b')), "B's row: Connected, on its own hardware", t('probe-b'))
  check(/Cellar[\s\S]*Connected[\s\S]*Can't prove who it is/.test(t('probe-c')), "C's row: Connected, with the note that it can't prove who it is", t('probe-c'))
  check(/Den[\s\S]*A different Prometheus answered/.test(t('probe-d')), "D's row: A different Prometheus answered", t('probe-d'))
  check(/Eaves[\s\S]*Can't reach it since \d/.test(t('probe-e')), "E's row: Can't reach it since a time", t('probe-e'))
  check(anyKey(D) === 0, 'D was asked who it is and sent no key at all', JSON.stringify(D.seen))
  check((await app.page.evaluate('document.title')) === 'Alpha — Beacon', 'the title names A', await app.page.evaluate('document.title'))
  const bar = await app.page.evaluate(`document.querySelector('[data-testid="app-chrome-brand"]')?.innerText ?? null`)
  check(bar === 'Alpha — Beacon', "and so does Beacon's own title bar", bar)
  const ph = await app.page.evaluate(`[...document.querySelectorAll('textarea')].map((x) => x.placeholder).filter((p) => p.startsWith('Message'))`)
  check(ph.length > 0 && ph.every((p) => p === 'Message Alpha…'), 'the composer says "Message Alpha…"', JSON.stringify(ph))
  check(await app.page.evaluate(`[...document.querySelectorAll('[data-testid="instance-add"]')].some((b) => b.innerText.trim() === 'Add a Prometheus…')`), 'the footer row says "Add a Prometheus…"')

  // 2b. From Mission Control, by keyboard: the name in the title bar opens the switcher; arrows move, Escape closes, Enter switches.
  const KEYS = { Enter: [13, '\r'], Escape: [27], ArrowDown: [40], ArrowUp: [38], Tab: [9] }
  const press = async (key) => {
    const [code, text] = KEYS[key]
    await app.page.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code: key, windowsVirtualKeyCode: code, ...(text ? { text } : {}) })
    await app.page.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key, windowsVirtualKeyCode: code })
    await sleep(150)
  }
  const focused = () => app.page.evaluate(`(() => { const a = document.activeElement; return a ? (a.dataset.instance ?? a.dataset.testid ?? a.tagName) : null })()`)
  const open = () => app.page.evaluate(`!!document.querySelector('[data-testid="title-switcher"]')`)
  await app.page.evaluate(`document.querySelector('button[title="Mission"]')?.click(); true`)
  await until(async () => !(await app.page.evaluate(`!!document.querySelector('aside.sidebar')`)), 5000)
  const brand = await app.page.evaluate(`(() => { const b = document.querySelector('[data-testid="app-chrome-brand"]'); return b ? { tag: b.tagName, popup: b.getAttribute('aria-haspopup'), expanded: b.getAttribute('aria-expanded'), text: b.innerText } : null })()`)
  check(brand?.tag === 'BUTTON' && brand.popup === 'menu' && brand.expanded === 'false' && brand.text.includes('Alpha'), 'on Mission Control, the name in the title bar is a button that opens a menu', JSON.stringify(brand))
  await app.page.evaluate(`document.querySelector('[data-testid="app-chrome-brand"]').focus(); true`)
  await press('Enter')
  const opened = await until(open, 3000)
  check(!!opened && (await app.page.evaluate(`document.querySelectorAll('[data-testid="title-switcher"] [data-testid="instance-row"]').length`)) === 5, 'Enter on it opens the switcher, a row for each', await app.page.evaluate(`document.querySelector('[data-testid="title-switcher"]')?.innerText ?? null`))
  if (shot > 0 && process.argv[shot + 1]) {
    const png = await app.page.send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(process.argv[shot + 1].replace(/\.png$/, '-switcher.png'), Buffer.from(png.result.data, 'base64'))
  }
  const first = await focused()
  check(first === aFolder, 'focus goes into the switcher, on the one Beacon is on', first)
  await press('ArrowDown')
  check((await focused()) === 'probe-b', 'ArrowDown moves to the next row', await focused())
  await press('Escape')
  check(!(await open()) && (await focused()) === 'app-chrome-brand', 'Escape closes it and gives focus back to the title bar', await focused())
  await press('Enter')
  await until(open, 3000)
  for (let i = 0; i < 6 && (await focused()) !== 'probe-c'; i++) await press('ArrowDown')
  check((await focused()) === 'probe-c', 'the arrows reach Cellar', await focused())
  await press('Enter')
  const onC = await until(async () => ((await app.page.evaluate('window.beacon.instances.list()')).find((i) => i.active)?.id === 'probe-c' && keyed(C, 'KEY-C') > 0 ? true : null), 15000)
  check(!!onC, 'Enter on Cellar switches to it (an older one: its own key goes, as before)', `${keyed(C, 'KEY-C')} keyed request(s)`)
  check(!(await open()), 'and the switcher closes')
  const stillMission = await until(async () => ((await app.page.evaluate(`!!document.querySelector('button[title="Mission"]')`)) && !(await app.page.evaluate(`!!document.querySelector('aside.sidebar')`)) ? true : null), 5000)
  check(!!stillMission, 'Beacon stays on Mission Control')
  check(keyed(C, 'KEY-A') === 0 && keyed(C, 'KEY-B') === 0, "Cellar got no one else's key")

  // 3. From the Chats sidebar, click B: the switch; B's key only to B.
  await chats()
  await until(() => app.page.evaluate(`!!document.querySelector('[data-instance="probe-b"]')`), 5000)
  const aKeyedBefore = keyed(A, 'KEY-A')
  await app.page.evaluate(`document.querySelector('[data-instance="probe-b"]').click()`)
  const onB = await until(async () => {
    const list = await app.page.evaluate('window.beacon.instances.list()')
    const st = await app.page.evaluate('window.beacon.connection.status()')
    return list.find((i) => i.active)?.id === 'probe-b' && st?.state === 'connected' && keyed(B, 'KEY-B') > 0 ? true : null
  }, 15000)
  check(!!onB, 'clicking B switches to B, and B gets its own key', `${keyed(B, 'KEY-B')} keyed request(s)`)
  const titled = await until(async () => ((await app.page.evaluate('document.title')) === 'Beta — Beacon' ? true : null), 5000)
  check(!!titled, 'the title names B now', await app.page.evaluate('document.title'))
  check(keyed(A, 'KEY-B') === 0 && keyed(B, 'KEY-A') === 0, "A never got B's key, B never got A's")
  check(keyed(A, 'KEY-A') >= aKeyedBefore, '(A was reached with its own key before)')
  check(await until(() => app.page.evaluate(`!!document.querySelector('[data-testid="instance-list"]')`), 5000), 'after the switch the list is still on screen (Beacon stays in Chats)')
  const marked = await until(async () => ((await rowsOf(app.page)).find((r) => r.current)?.id === 'probe-b' ? true : null), 5000)
  check(!!marked, "B's row is the marked one now")

  // 4. Click D, the red row: the switch happens, D is sent no key, and its card says what's wrong.
  await app.page.evaluate(`document.querySelector('[data-instance="probe-d"]').click()`)
  const card = await until(() => app.page.evaluate(`document.querySelector('[data-testid="identity-card"]')?.innerText ?? null`), 15000)
  check(!!card && /Something else is answering/.test(card) && /sent it nothing/.test(card), "on D: the card says something else is answering, and nothing was sent", card)
  await sleep(1500)
  check(anyKey(D) === 0, 'D was sent no key at all, on REST or the socket', JSON.stringify({ seen: D.seen.filter((r) => r.auth), frames: D.frames }))
  const onD = await app.page.evaluate('window.beacon.instances.list()')
  check(onD.find((i) => i.active)?.id === 'probe-d', 'Beacon is on D (the person chose it), still holding the key back', JSON.stringify(onD.map((i) => [i.id, i.active, i.state])))
} catch (e) {
  check(false, 'the probe ran to the end', e?.stack ?? String(e))
} finally {
  if (app) await app.quit().catch(() => undefined)
  for (const s of servers) s.close()
  rmSync(profile, { recursive: true, force: true })
}
if (failures || checks < MIN_CHECKS) {
  console.log(`\n[probe] FAIL — ${failures} failed, ${checks} ran (at least ${MIN_CHECKS} expected)`)
  process.exit(1)
}
console.log(`\n[probe] OK — ${checks} checks passed`)
