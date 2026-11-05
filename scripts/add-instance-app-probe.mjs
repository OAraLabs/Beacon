// "Add a Prometheus…" from the title bar (docs/MULTI-PROMETHEUS.md §6), in the real app at a 1512×944 window, from Mission Control:
// a scratch profile kept on stand-in A (the mini) with a key; B is another Prometheus at another loopback port, C a third. With ONE
// Prometheus the name in the title bar opens the switcher, and its "Add a Prometheus…" opens a short form (address, socket, key, Test,
// Add) clear of every drag region, keeping the keyboard. A wrong key is refused before anything is kept; B's key adds B and Beacon
// switches to it; A's key file and A's record are byte for byte as they were, and A never sees B's key. A's own address is "already
// kept". The switcher goes back to A. Settings → Advanced, given C's address, offers the Add form (with C's address) instead of adding C.
// Keys are written through the app's own safeStorage under --use-mock-keychain (app-driver), never the real Keychain.
//
//   npm run build && npm run probe:add-instance
import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
const MIN_CHECKS = 20
const check = (ok, label, extra = '') => {
  checks++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${!ok && extra ? ` — ${String(extra).slice(0, 500)}` : ''}`)
  if (!ok) failures++
}
const json = (res, code, body) => res.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify(body))
function nodeKey() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  return { pub: publicKey.export({ format: 'der', type: 'spki' }).subarray(12).toString('base64'), priv: privateKey }
}
const message = (nonce, id, pub, at) => ['prometheus-identity-challenge/v1', `nonce=${nonce}`, `instance_id=${id ?? ''}`, `node_pub=${pub}`, 'tls_spki_sha256=', `signed_at=${at}`, ''].join('\n')
function prometheus({ fp, name, token, provider = 'anthropic' }) {
  const key = nodeKey()
  const instanceId = randomUUID()
  const seen = []
  const frames = []
  const rest = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      seen.push({ path: req.url ?? '', auth: req.headers.authorization })
      if (req.url === '/api/hello') return json(res, 200, { v: '0.9.20', name, agent: 'Atlas', fp, pair: 'approve', tls: false })
      if (req.url === '/api/identity/challenge') {
        const nonce = JSON.parse(body || '{}').nonce ?? ''
        const at = Math.floor(Date.now() / 1000)
        return json(res, 200, { v: 1, instance_id: instanceId, node_pub: key.pub, tls_spki_sha256: null, signed_at: at, sig: sign(null, Buffer.from(message(nonce, instanceId, key.pub, at)), key.priv).toString('base64') })
      }
      if (req.headers.authorization !== `Bearer ${token}`) return json(res, 401, { error: 'unauthorized' })
      if ((req.url ?? '').startsWith('/api/status')) return json(res, 200, { state: 'idle', provider, model: 'stub-model' })
      json(res, 200, [])
    })
  })
  const wsHttp = createServer()
  new WebSocketServer({ server: wsHttp }).on('connection', (ws) => {
    ws.on('message', (m) => frames.push(m.toString()))
    ws.send(JSON.stringify({ type: 'connected' }))
  })
  return { rest, wsHttp, seen, frames, key }
}
const A = prometheus({ fp: 'a'.repeat(16), name: 'Mini', token: 'KEY-A' })
const B = prometheus({ fp: 'b'.repeat(16), name: 'Laptop', token: 'KEY-B', provider: 'ollama' })
const C = prometheus({ fp: 'c'.repeat(16), name: 'Third', token: 'KEY-C' })
const servers = [A, B, C].flatMap((p) => [p.rest, p.wsHttp])
for (const s of servers) await new Promise((r) => s.listen(0, '127.0.0.1', r))
const api = (p) => `http://127.0.0.1:${p.rest.address().port}`
const ws = (p) => `ws://127.0.0.1:${p.wsHttp.address().port}`
const keyed = (p, k) => p.seen.filter((r) => r.auth === `Bearer ${k}`).length + p.frames.filter((f) => f.includes(k)).length

const profile = mkdtempSync(join(tmpdir(), 'beacon-add-instance-'))
execFileSync('sqlite3', [join(profile, 'beacon.db'), `CREATE TABLE gateway_profiles (name TEXT PRIMARY KEY, api_base TEXT NOT NULL, ws_url TEXT NOT NULL, is_default INTEGER DEFAULT 0, pin TEXT);
  INSERT INTO gateway_profiles VALUES ('mini', '${api(A)}', '${ws(A)}', 1, NULL);`])
const until = async (fn, ms) => {
  const end = Date.now() + ms
  for (;;) {
    const v = await fn().catch(() => null)
    if (v || Date.now() > end) return v
    await sleep(200)
  }
}
const coveredIn = (rootExpr) => `(() => {
  const root = ${rootExpr}
  if (!root) return null
  const drag = [...document.querySelectorAll('*')].filter((e) => getComputedStyle(e).webkitAppRegion === 'drag').map((e) => e.getBoundingClientRect())
  const controls = [...root.querySelectorAll('button, input, select, textarea, a[href], [tabindex]:not([tabindex="-1"])')].filter((e) => e.getClientRects().length > 0)
  const covered = controls.filter((e) => { const q = e.getBoundingClientRect(); const x = q.x + q.width / 2, y = q.y + q.height / 2; return drag.some((r) => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) })
  return { controls: controls.length, covered: covered.map((e) => (e.innerText || e.getAttribute('aria-label') || e.placeholder || e.tagName).trim().slice(0, 40)) }
})()`
const FORM = `document.querySelector('[role="dialog"][aria-label="Add a Prometheus"]')`
const MENU = `document.querySelector('[data-testid="title-switcher"]')`
const setField = (label, v) =>
  `(() => { const el = ${FORM}?.querySelector('input[aria-label="${label}"]'); if (!el) return null; const s = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; s.call(el, ${JSON.stringify(v)}); el.dispatchEvent(new Event('input', { bubbles: true })); return el.value })()`
const clickIn = (root, text) => `(() => { const b = [...(${root}?.querySelectorAll('button') ?? [])].find((x) => x.innerText.trim() === ${JSON.stringify(text)}); if (!b || b.disabled) return false; b.click(); return true })()`
const result = () => app.page.evaluate(`${FORM}?.querySelector('[data-testid="add-result"]')?.innerText ?? null`)
const addDisabled = () => app.page.evaluate(`[...(${FORM}?.querySelectorAll('button') ?? [])].find((x) => x.innerText.trim() === 'Add')?.disabled ?? null`)
const sha = (f) => (existsSync(f) ? createHash('sha256').update(readFileSync(f)).digest('hex') : null)
const rowOf = (id) => execFileSync('sqlite3', [profileDb(profile, 'beacon'), `SELECT id || '|' || COALESCE(fp,'') || '|' || COALESCE(api_base,'') || '|' || COALESCE(ws_url,'') || '|' || COALESCE(label,'') || '|' || COALESCE(node_pub,'') || '|' || COALESCE(instance_id,'') || '|' || COALESCE(pin,'') FROM daemon_folders WHERE id = '${id}'`]).toString().trim()

let app = null
try {
  app = await launchApp({ profile })
  await app.mainEval(`(() => { __electron.BrowserWindow.getAllWindows()[0].setContentSize(1512, 944); return true })()`)
  check(!!(await until(async () => (await app.page.evaluate('window.beacon.connection.status()'))?.state === 'connected', 15000)), 'on A, the mini')
  const aId = (await app.page.evaluate('window.beacon.instances.list()'))[0]?.id
  // A's key, in A's folder, through the app's own safeStorage (mock keychain), so there is a key Add must leave alone.
  await app.mainEval(`(() => { const fs = process.getBuiltinModule('fs'); const path = process.getBuiltinModule('path'); const f = path.join(__electron.app.getPath('userData'), 'daemons', ${JSON.stringify(aId)}, 'credential.bin'); fs.writeFileSync(f, __electron.safeStorage.encryptString('KEY-A'), { mode: 0o600 }); return true })()`)
  const aKeyFile = join(profile, 'daemons', aId, 'credential.bin')
  const aKeyBefore = sha(aKeyFile)
  const aRowBefore = rowOf(aId)
  check(!!aKeyBefore && aRowBefore.startsWith(aId) && aRowBefore.split('|')[5] === A.key.pub, 'A is kept, with a key in its folder and its node key pinned', aRowBefore)

  // From Mission Control (its header is a drag region), with ONE Prometheus.
  await app.page.evaluate(`document.querySelector('nav[aria-label="Views"] button[title="Mission"]')?.click(); true`)
  await sleep(500)
  const brand = await app.page.evaluate(`(() => { const b = document.querySelector('[data-testid="app-chrome-brand"]'); return b ? { tag: b.tagName, popup: b.getAttribute('aria-haspopup'), text: b.innerText.trim() } : null })()`)
  check(brand?.tag === 'BUTTON' && brand.popup === 'menu' && brand.text.startsWith('Beacon'), 'with one Prometheus, the title bar ("Beacon") opens the switcher', JSON.stringify(brand))
  await app.page.evaluate(`document.querySelector('[data-testid="app-chrome-brand"]').click(); true`)
  const menu = await until(() => app.page.evaluate(`(() => { const m = ${MENU}; return m ? { rows: m.querySelectorAll('[data-testid="instance-row"]').length, add: !!m.querySelector('[data-testid="instance-add"]') } : null })()`), 3000)
  check(menu?.rows === 1 && menu.add, 'the menu: the one Beacon is on, and "Add a Prometheus…"', JSON.stringify(menu))
  const menuCover = await app.page.evaluate(coveredIn(MENU))
  check(!!menuCover && menuCover.covered.length === 0, 'no control in the menu on a drag region', JSON.stringify(menuCover))
  await app.page.evaluate(`${MENU}.querySelector('[data-testid="instance-add"]').click(); true`)
  check(!!(await until(() => app.page.evaluate(`!!${FORM}`), 3000)), '"Add a Prometheus…" opens the form')
  const formCover = await app.page.evaluate(coveredIn(FORM))
  check(!!formCover && formCover.controls >= 6 && formCover.covered.length === 0, 'no control in the form on a drag region', JSON.stringify(formCover))
  check((await app.page.evaluate(`(() => { const f = ${FORM}; return !!f && f.contains(document.activeElement) && document.activeElement.getAttribute('aria-label') === 'Address' })()`)) === true, 'focus starts in Address')

  // A key B refuses: said so, Add stays off, nothing kept.
  await app.page.evaluate(setField('Address', api(B)))
  await app.page.evaluate(setField('Socket', ws(B)))
  await app.page.evaluate(setField('Key', 'NOT-B-KEY'))
  await app.page.evaluate(clickIn(FORM, 'Test'))
  const r1 = await until(async () => { const t = await result(); return t && !/Checking/.test(t) ? t : null }, 8000)
  check(/refused/i.test(r1 ?? '') && (await addDisabled()) === true, 'a key B refuses: said so, and Add stays off', r1)
  check((await app.page.evaluate('window.beacon.instances.list()')).length === 1, 'nothing kept')

  // B's key: Test, then Add.
  await app.page.evaluate(setField('Key', 'KEY-B'))
  check((await addDisabled()) === true, 'a changed field needs a new Test before Add')
  await app.page.evaluate(clickIn(FORM, 'Test'))
  const r2 = await until(async () => { const t = await result(); return t && /Laptop/.test(t) ? t : null }, 8000)
  check(!!r2 && /proved who it is/i.test(r2) && (await addDisabled()) === false, 'Test: Laptop, it proved who it is, the key works; Add is on', r2)
  check(keyed(A, 'KEY-B') === 0 && !B.seen.some((r) => r.auth === 'Bearer KEY-A'), "nothing crossed: A never saw B's key, B never saw A's")
  await app.page.evaluate(clickIn(FORM, 'Add'))
  const onB = await until(async () => {
    const list = await app.page.evaluate('window.beacon.instances.list()')
    const st = await app.page.evaluate('window.beacon.connection.status()')
    return list.length === 2 && list.find((i) => i.active)?.label === 'Laptop' && st?.state === 'connected' && keyed(B, 'KEY-B') > 0 ? list : null
  }, 15000)
  check(!!onB, 'Add: B is kept beside A, Beacon is on B, with B\'s key', JSON.stringify(onB))
  check(!(await app.page.evaluate(`!!${FORM}`)), 'the form closed')
  check(sha(aKeyFile) === aKeyBefore, "A's key file is byte for byte as it was")
  check(rowOf(aId) === aRowBefore, "A's record and pins are exactly as they were", `${aRowBefore}\n${rowOf(aId)}`)
  check(keyed(A, 'KEY-B') === 0, "A never got B's key")
  const title = await until(async () => ((await app.page.evaluate('document.title')) === 'Laptop — Beacon' ? true : null), 5000)
  check(!!title, 'the title names B', await app.page.evaluate('document.title'))

  // A's own address: already kept, nothing written.
  await app.page.evaluate(`document.querySelector('[data-testid="app-chrome-brand"]').click(); true`)
  await until(() => app.page.evaluate(`!!${MENU}`), 3000)
  await app.page.evaluate(`${MENU}.querySelector('[data-testid="instance-add"]').click(); true`)
  await until(() => app.page.evaluate(`!!${FORM}`), 3000)
  await app.page.evaluate(setField('Address', api(A)))
  await app.page.evaluate(setField('Socket', ws(A)))
  await app.page.evaluate(setField('Key', 'ANOTHER-KEY'))
  await app.page.evaluate(clickIn(FORM, 'Test'))
  const r3 = await until(async () => { const t = await result(); return t && /already/i.test(t) ? t : null }, 8000)
  check(!!r3 && /Mini|mini/.test(r3) && (await addDisabled()) === true, "A's own address: Beacon already keeps it, and Add stays off", r3)
  check(sha(aKeyFile) === aKeyBefore && rowOf(aId) === aRowBefore && keyed(A, 'ANOTHER-KEY') === 0, 'and A is untouched, its key never offered the one typed')
  const esc = await app.page.evaluate(`(() => { document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return true })()`)
  check(esc === true && !!(await until(async () => !(await app.page.evaluate(`!!${FORM}`)), 2000)), 'Esc closes the form')

  // Back to A through the switcher.
  await app.page.evaluate(`document.querySelector('[data-testid="app-chrome-brand"]').click(); true`)
  await until(() => app.page.evaluate(`!!${MENU}`), 3000)
  await app.page.evaluate(`${MENU}.querySelector('[data-instance="${aId}"]').click(); true`)
  const onA = await until(async () => ((await app.page.evaluate('window.beacon.instances.list()')).find((i) => i.active)?.id === aId && (await app.page.evaluate('window.beacon.connection.status()'))?.state === 'connected' ? true : null), 15000)
  check(!!onA && keyed(A, 'KEY-A') > 0, 'the switcher goes back to A, with A\'s own key')

  // Settings → Advanced, a third Prometheus's address: nothing saved, the card hands over to the Add form.
  await app.page.evaluate(`window.dispatchEvent(new CustomEvent('beacon:open-settings', { detail: { section: 'connection' } })); true`)
  await until(() => app.page.evaluate(`!!document.querySelector('input[placeholder="http://host:8005"]')`), 5000)
  const set = (ph, v) => `(() => { const el = document.querySelector('input[placeholder="${ph}"]'); const s = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; s.call(el, '${v}'); el.dispatchEvent(new Event('input', { bubbles: true })); return el.value })()`
  await app.page.evaluate(set('http://host:8005', api(C)))
  await app.page.evaluate(set('ws://host:8010', ws(C)))
  await app.page.evaluate(`[...document.querySelectorAll('button')].find((b) => b.innerText.trim() === 'Save & test' && !b.disabled)?.click(); true`)
  const card = await until(() => app.page.evaluate(`document.querySelector('[data-testid="edit-address-other"]')?.innerText ?? null`), 8000)
  check(!!card && !/Add it/.test(card) && /Add a Prometheus/.test(card), 'Advanced keeps to this one: the card offers "Add a Prometheus…", not "Add it"', card)
  await app.page.evaluate(`[...document.querySelectorAll('[data-testid="edit-address-other"] button')].find((b) => b.innerText.trim() === 'Add a Prometheus…')?.click(); true`)
  const pre = await until(() => app.page.evaluate(`${FORM}?.querySelector('input[aria-label="Address"]')?.value ?? null`), 3000)
  check(pre === api(C) && (await app.page.evaluate('window.beacon.instances.list()')).length === 2, "it opens the form with C's address, and nothing was kept", pre)
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
