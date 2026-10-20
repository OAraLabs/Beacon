#!/usr/bin/env node
// lint:names — no real person, computer or address in what Beacon ships, or in its source.
//
// WHY. 0.4.1's "type its address" field suggested the owner's own Mac mini by name: a real person's real computer, in front of every
// user. Comments naming people rode along too: the main and renderer bundles are not minified, so a source comment is
// shipped bytes. And the source itself is published, so a test's home path, a recorded machine name or a tester's name in a
// fixture is published with it.
//
// It reads two sets:
//   * THE SHIPPED SET, after the build, the way electron-builder.yml picks it: out/** except out/main/*-smoke.js and *.map
//     (electron-builder.yml `files`), plus package.json and the two files beside app.asar (`extraResources`): LICENSE and
//     THIRD_PARTY_NOTICES.txt. node_modules is third-party text and is not read here (audit:bundle reads the whole asar for
//     tailnet addresses).
//   * THE SOURCE: every text file under src/, scripts/ (fixtures included) and .github/, and every file at the repo root
//     except the internal notes that are not published (INTERNAL below).
//
// What it refuses: the owner's first name used as a name (capitalised, not followed by an English word, so a sentence that starts
// with it as the verb passes, and the possessive, or the name in parentheses, does not); a home directory under /home/ named after that person; a tailnet (CGNAT
// 100.64/10) address (the range itself, written as its base address and "/10", is not an address); a full tailnet host name
// (anything.tailXXXX.ts.net; the bare ".ts.net" suffix in code that recognises Tailscale names is fine, and a line marked // precommit:allow-example-host
// `precommit:allow-example-host` may carry a sanctioned example); and the PRIVATE list below.
//
// THE PRIVATE LIST is stored as truncated SHA-256 digests, so this file does not itself publish the names it keeps out. That is
// against grep, not against a guess: anyone can hash a candidate and compare. It holds the owner's surname, login and personal
// mail account; a tester's first name; the owner's employer's mail domain; the owner's computer names; and the owner's home
// subnet (the first three octets of an IPv4 address are hashed). A word is checked whole, and each run of its hyphen-separated
// parts, lower-cased.
//
// Generic examples for documentation-style text: my-computer.local, 192.168.1.20, /home/demo, "Alex's Mac mini", "a friend".
// Proves itself first: every pattern must catch a planted sample and pass an innocent one, the private matcher must catch a planted
// test-only entry, the list must hold exactly its entries, and each scan must read the files it names as present.
//
// Run: npm run build && npm run lint:names      (also part of `npm run build`, `dist:mac` and `dist:linux`)
import { chacha20poly1305 } from '@noble/ciphers/chacha.js'
import { createHash, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const digest = (s) => createHash('sha256').update(s).digest('hex').slice(0, 16)

const PRIVATE = [
  { what: 'a private name (the owner, 1 of 3)', d: 'b38239a7bdb06d8f' },
  { what: 'a private name (the owner, 2 of 3)', d: '51aa16a2ccaf89af' },
  { what: 'a private name (the owner, 3 of 3)', d: '8bec158b4fc8c68f' },
  { what: 'a private name (a tester)', d: '9ce8db922a8f4a7a' },
  { what: "a private name (the owner's mail domain)", d: 'ece59ac3d33e8bfb' },
  { what: "a private name (the owner's computers, 1 of 4)", d: 'c55508be401591fa' },
  { what: "a private name (the owner's computers, 2 of 4)", d: '05ede2a98eaec54d' },
  { what: "a private name (the owner's computers, 3 of 4)", d: 'eef192d6e17c3214' },
  { what: "a private name (the owner's computers, 4 of 4)", d: '4797c075e8e55725' },
  { what: "the owner's home network", d: '9f3e303e5df9ee0e', ipPrefix: true }
]
const PRIVATE_COUNT = 10

// A name split by an escaped or invisible separator (a newline escape inside a JSON string, a no-break space) is still the
// is also read with those separators removed.
const SEPARATORS = /\\[nt]|\\u00a0|\\u200[b-d]|[\u00a0\u200b-\u200d]/gi
const joined = (text) => text.replace(SEPARATORS, '')

// SEALED ANSWERS. A pairing fixture holds the daemon's sealed answer (x25519-hkdf-sha256-chacha20poly1305, the contract's
// recipe), and the contract vectors' requester key sits beside it in src/main/fixtures/pairing_seal_v1.json, so the plaintext is
// as public as the fixture. Every sealed answer that key opens is read like any other text, and its name must be one the fixture
// itself records: a fixture whose plaintext was renamed while its ciphertext was not contradicts itself.
const b64u = (s) => Buffer.from(s, 'base64url')
const x25519 = (d, x) => ({
  priv: d && createPrivateKey({ key: { kty: 'OKP', crv: 'X25519', d: d.toString('base64url'), x: x.toString('base64url') }, format: 'jwk' }),
  pub: createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x: x.toString('base64url') }, format: 'jwk' })
})
function unseal(priv, sealed, requestId) {
  try {
    const shared = diffieHellman({ privateKey: priv, publicKey: x25519(null, b64u(sealed.ephemeral_public_key)).pub })
    const key = Buffer.from(hkdfSync('sha256', shared, Buffer.from(requestId), Buffer.from('prometheus-pair-v1/seal'), 32))
    return Buffer.from(chacha20poly1305(key, b64u(sealed.nonce), Buffer.from(requestId)).decrypt(b64u(sealed.ciphertext))).toString('utf8')
  } catch { return null }
}
function seal(pub, plaintext, requestId) {
  const eph = generateKeyPairSync('x25519')
  const key = Buffer.from(hkdfSync('sha256', diffieHellman({ privateKey: eph.privateKey, publicKey: pub }), Buffer.from(requestId), Buffer.from('prometheus-pair-v1/seal'), 32))
  const nonce = randomBytes(12)
  const ciphertext = chacha20poly1305(key, nonce, Buffer.from(requestId)).encrypt(Buffer.from(plaintext))
  return { alg: 'x25519-hkdf-sha256-chacha20poly1305', ephemeral_public_key: eph.publicKey.export({ format: 'jwk' }).x, nonce: nonce.toString('base64url'), ciphertext: Buffer.from(ciphertext).toString('base64url') }
}
/** Every sealed answer in a JSON text: the plaintexts `priv` opens, how many it cannot, and every string the JSON records. */
function sealedIn(text, priv) {
  const json = JSON.parse(text)
  const blobs = []
  const strings = new Set()
  const walk = (o) => {
    if (typeof o === 'string') strings.add(o)
    else if (o && typeof o === 'object') {
      if (typeof o.ciphertext === 'string' && typeof o.nonce === 'string' && typeof o.ephemeral_public_key === 'string') blobs.push(o)
      for (const v of Object.values(o)) walk(v)
    }
  }
  walk(json)
  const ids = [...new Set(text.match(/\b[0-9a-f]{32}\b/g) ?? [])]
  const opened = []
  let closed = 0
  for (const b of blobs) {
    const pt = ids.map((id) => unseal(priv, b, id)).find((x) => x != null)
    if (pt == null) closed++
    else opened.push(pt)
  }
  return { opened, closed, strings }
}
/** A sealed plaintext whose name the fixture does not record anywhere else: the fixture contradicts itself. */
function fiction(opened, strings) {
  const all = [...strings]
  return opened.map((pt) => { try { return JSON.parse(pt).name } catch { return null } })
    .filter((n) => typeof n === 'string' && !all.some((x) => x === n || x.includes(JSON.stringify(n))))
}

const NAMES = [
  { what: 'a person (a first name, as a name)', re: new RegExp('\\b' + 'W' + 'ill\\b(?! [a-z])', 'g') },
  { what: 'a person (a home directory)', re: new RegExp('/home/' + 'will\\b', 'g') },
  { what: 'a person (a mail address)', re: new RegExp('\\b' + 'will@[a-z0-9-]+\\.[a-z]', 'gi') },
  { what: 'a tailnet address', re: /\b100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}\b(?!\/10\b)/g },
  { what: 'a tailnet host name', re: /\b[a-z0-9-]+\.tail[a-z0-9]+\.ts\.net\b/gi, pragma: 'precommit:allow-example-host' } // precommit:allow-example-host
]

function privateHits(text, list) {
  const out = []
  const byDigest = new Map(list.filter((e) => !e.ipPrefix).map((e) => [e.d, e]))
  const ipList = list.filter((e) => e.ipPrefix)
  for (const m of text.matchAll(/[a-z0-9]+(?:-[a-z0-9]+)*/gi)) {
    const parts = m[0].toLowerCase().split('-')
    for (let i = 0; i < parts.length; i++)
      for (let j = i + 1; j <= parts.length; j++) {
        const e = byDigest.get(digest(parts.slice(i, j).join('-')))
        if (e) out.push({ what: e.what, d: e.d, at: m.index, match: m[0] })
      }
  }
  for (const m of text.matchAll(/\b(\d{1,3}\.\d{1,3}\.\d{1,3})\.\d{1,3}\b/g))
    for (const e of ipList) if (digest(m[1]) === e.d) out.push({ what: e.what, d: e.d, at: m.index, match: m[0] })
  return out
}

function lineOf(text, at) {
  const start = text.lastIndexOf('\n', at - 1) + 1
  const end = text.indexOf('\n', at)
  return text.slice(start, end < 0 ? text.length : end)
}

function hits(text, list = PRIVATE) {
  const pattern = NAMES.flatMap(({ what, re, pragma }) =>
    [...text.matchAll(re)].filter((m) => !pragma || !lineOf(text, m.index).includes(pragma)).map((m) => ({ what, at: m.index, match: m[0] })))
  return [...pattern, ...privateHits(text, list)]
}

// What a hit prints: never the private value itself (CI logs are public), only its kind and a masked shape.
const mask = (h) => (h.d ? `${h.match[0]}…(${h.match.length})` : h.what.startsWith('a tailnet address') ? '100.x.x.x' : h.match)

// ── self-test ────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const TEST_ONLY = [{ what: 'planted', d: digest('zqxplanted') }, { what: 'planted net', d: digest('203.0.113'), ipPrefix: true }]
const PLANTED = ['mail wi' + 'll@example.org', 'W' + 'ill\'s Mac mini', 'see (W' + 'ill, 2026-10-17)', 'cd /home/' + 'will/projects', '100.' + '101.2.3:8010',
  'mini.' + 'tail9z9z.ts.net'] // precommit:allow-example-host
const PLANTED_PRIVATE = ['/Users/zqxplanted/projects', 'zqxplanted-mac-mini.local', 'x@zqxplanted.com', 'host 203.0.113.56 is up']
const INNOCENT = ['Beacon will forget this address.', 'W' + 'ill throw OperationCancelled if canceled.', 'my-computer.local or 192.168.1.20',
  'if (name.endsWith(".ts.net")) return "tailscale"', 'Tailscale is 100.' + '64.0.0/10', '/home/demo/projects/willow',
  "Alex's Mac mini", '/Users/me/notes.md', 'mail me@example.com', 'you will@ least try', 'goodwill-mini', 'mini.tail1234.ts.net // precommit:allow-example-host']
let bad = 0
for (const p of PLANTED) if (hits(p, []).length === 0) (bad++, console.error(`✗ lint:names self-test — a planted "${p}" was not caught`))
for (const p of PLANTED_PRIVATE) if (privateHits(p, TEST_ONLY).length === 0) (bad++, console.error(`✗ lint:names self-test — a planted private "${p}" was not caught`))
for (const p of [...INNOCENT, ...PLANTED_PRIVATE]) if (hits(p).length > 0) (bad++, console.error(`✗ lint:names self-test — an innocent "${p}" was caught (${hits(p).map((h) => h.what).join(', ')})`))
if (PRIVATE.length !== PRIVATE_COUNT || PRIVATE.some((e) => !/^[0-9a-f]{16}$/.test(e.d)) || new Set(PRIVATE.map((e) => e.d)).size !== PRIVATE.length)
  (bad++, console.error(`✗ lint:names self-test — the private list must hold exactly ${PRIVATE_COUNT} distinct 16-hex digests`))
for (const p of ['zqx\\nplanted is here', 'zqx\u00a0planted', 'zqx\\u00a0planted']) if (privateHits(joined(p), TEST_ONLY).length === 0) (bad++, console.error(`✗ lint:names self-test — a split "${p}" was not caught`))
if (privateHits(joined('one\\ntwo, a\\tb'), TEST_ONLY).length > 0) (bad++, console.error('✗ lint:names self-test — joining separators made an innocent text a hit'))
{
  const req = generateKeyPairSync('x25519')
  const id = 'ab'.repeat(16)
  const pt = JSON.stringify({ token: 't', device_id: 'd', name: "zqxplanted's Mac" })
  const fixture = (recorded) => JSON.stringify({ request_id: id, device_name: recorded, response: { sealed: seal(req.publicKey, pt, id) } })
  const got = sealedIn(fixture("zqxplanted's Mac"), req.privateKey)
  if (got.opened.length !== 1 || got.closed !== 0 || privateHits(got.opened[0], TEST_ONLY).length === 0) (bad++, console.error('✗ lint:names self-test — a planted name inside a sealed answer was not read'))
  if (fiction(got.opened, got.strings).length !== 0) (bad++, console.error('✗ lint:names self-test — a sealed name the fixture records was called fiction'))
  const renamed = sealedIn(fixture("Alex's Mac"), req.privateKey)
  if (fiction(renamed.opened, renamed.strings).length !== 1) (bad++, console.error('✗ lint:names self-test — a fixture renamed outside its ciphertext was not caught'))
  if (sealedIn(fixture('x'), generateKeyPairSync('x25519').privateKey).closed !== 1) (bad++, console.error('✗ lint:names self-test — a blob for another key was not counted as unread'))
}
if (bad) process.exit(2)

// ── the two sets ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
const BINARY = /\.(png|jpe?g|gif|ico|icns|webp|pdf|woff2?|ttf|otf|mp4|mov|webm|zip|gz|node|wasm)$/i
const walk = (d, keep, out = []) => {
  for (const n of readdirSync(d)) {
    const p = join(d, n)
    if (n === 'node_modules' || n === '.git') continue
    if (statSync(p).isDirectory()) walk(p, keep, out)
    else if (keep(relative(ROOT, p))) out.push(p)
  }
  return out
}

const INTERNAL = ['HANDOFF.md', 'PR-DESCRIPTION.md', 'CLAUDE.md']
const rootFiles = readdirSync(ROOT).filter((n) => !INTERNAL.includes(n) && n !== '.git' && n !== '.DS_Store' && !/^\.env/.test(n) && !BINARY.test(n) && !/\.tsbuildinfo$/.test(n) && statSync(join(ROOT, n)).isFile()).map((n) => join(ROOT, n))
const source = [...['src', 'scripts', '.github'].flatMap((d) => walk(join(ROOT, d), (r) => !BINARY.test(r))), ...rootFiles]
const sourceRel = source.map((f) => relative(ROOT, f))
for (const need of ['src/main/index.ts', 'src/main/fixtures/pairing_seal_v1.json', 'scripts/check-shipped-names.mjs', '.github/workflows/release.yml', 'README.md'])
  if (!sourceRel.includes(need)) (console.error(`✗ lint:names — the source scan did not read ${need}`), process.exit(2))

if (!existsSync(join(ROOT, 'out'))) {
  console.error('✗ lint:names — no out/ (run the build first)')
  process.exit(2)
}
const shipped = walk(join(ROOT, 'out'), (r) => !r.endsWith('.map') && !/^out\/main\/[^/]+-smoke\.js$/.test(r))
for (const f of ['package.json', 'LICENSE', 'THIRD_PARTY_NOTICES.txt']) shipped.push(join(ROOT, f))
const shippedRel = shipped.map((f) => relative(ROOT, f))
if (!shippedRel.includes('out/main/index.js') || !shippedRel.includes('out/renderer/index.html') || shippedRel.some((r) => /^out\/main\/[^/]+-smoke\.js$/.test(r))) {
  console.error('✗ lint:names — the shipped set is not what electron-builder ships (out/main/index.js and the page must be in it, no smoke entry point)')
  process.exit(2)
}

const VECTORS = join(ROOT, 'src/main/fixtures/pairing_seal_v1.json')
if (!existsSync(VECTORS)) (console.error('✗ lint:names — no pairing_seal_v1.json: the sealed answers cannot be read'), process.exit(2))
const V = JSON.parse(readFileSync(VECTORS, 'utf8'))
const vectorKey = x25519(Buffer.from(V.requester_private_hex, 'hex'), Buffer.from(V.requester_public_hex, 'hex')).priv

const found = []
let sealedOpened = 0
let sealedClosed = 0
for (const f of [...shipped, ...source]) {
  const r = relative(ROOT, f)
  const text = readFileSync(f, 'utf8')
  const seen = new Set()
  for (const h of hits(text)) {
    if (h.d) seen.add(h.d)
    found.push(`  ${r}:${text.slice(0, h.at).split('\n').length}  ${h.what}: "${mask(h)}"`)
  }
  const glued = joined(text)
  if (glued !== text) for (const h of privateHits(glued, PRIVATE)) if (!seen.has(h.d)) (seen.add(h.d), found.push(`  ${r}  ${h.what}, split by a separator: "${mask(h)}"`))
  if (/^src\/main\/fixtures\/.+\.json$/.test(r) && text.includes('"ciphertext"')) {
    const { opened, closed, strings } = sealedIn(text, vectorKey)
    sealedOpened += opened.length
    sealedClosed += closed
    for (const pt of opened) for (const h of hits(pt)) found.push(`  ${r}  inside a sealed answer, ${h.what}: "${mask(h)}"`)
    for (const n of fiction(opened, strings)) found.push(`  ${r}  a sealed answer names a device this fixture records nowhere ("${n[0]}…(${n.length})"): its ciphertext and its plaintext disagree`)
  }
}
if (sealedOpened === 0) (console.error('✗ lint:names — no sealed answer was opened with the vectors\' key: the sealed pass read nothing'), process.exit(2))
if (found.length) {
  console.error(`✗ lint:names — ${found.length} real name(s) or address(es) in what Beacon ships or in its source:\n${found.join('\n')}\n  Use a generic example (my-computer.local, 192.168.1.20, /home/demo, "Alex's Mac mini"), or say "the owner" in a comment.`)
  process.exit(1)
}
console.log(`✓ lint:names — ${shipped.length} shipped files and ${source.length} source files, no real names or addresses; ${sealedOpened} sealed answers opened and read, ${sealedClosed} sealed to keys no fixture holds (self-test: ${PLANTED.length + PLANTED_PRIVATE.length} caught, ${INNOCENT.length} passed, ${PRIVATE.length} private entries)`)
