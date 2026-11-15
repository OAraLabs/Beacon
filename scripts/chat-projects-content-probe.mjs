#!/usr/bin/env node
// chat-projects-content-probe: a project's instructions and reference files, with the REAL transport and class (out/main/chat-projects-content-entry.js)
// against a REAL daemon (the Prometheus branch with chat projects, served over loopback by scripts/lib/serve_real_daemon.py --conversations).
//
//   1  instructions: a first save, read back, a stale revision (a conflict that carries what is there), a folder that already has another
//      instructions file (refused until the person says to go on), a text over the limit, and the file really is PROMETHEUS.md in the
//      project's folder;
//   2  reference files: bytes up and down unchanged (all 256 byte values, an accented name with a space, a web page that comes back as bytes),
//      a name taken, replacing, a name refused, deleting, deleting again;
//   3  the limit: exactly 20 MB goes up and comes back; one byte more is refused by Beacon before it is read, and by the daemon (413) when asked;
//   4  the transport only asks the instructions and files routes.
//
//   BEACON_REAL_DAEMON_SRC=<prometheus src of the chat-projects branch> BEACON_REAL_DAEMON_PY=<its python> npm run build && npm run probe:chat-projects-content
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, truncateSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { realDaemonConfigured, startRealDaemon } from './lib/real-daemon.mjs'

if (!realDaemonConfigured()) {
  console.log('[probe] SKIPPED: set BEACON_REAL_DAEMON_SRC and BEACON_REAL_DAEMON_PY (a skipped probe is not a passed one)')
  process.exit(3)
}
const { ChatProjectContent, RestClient } = createRequire(import.meta.url)('../out/main/chat-projects-content-entry.js')

let failures = 0
let checks = 0
const check = (ok, label, extra) => {
  checks++
  console.log(`[probe] ${ok ? 'PASS' : 'FAIL'}  ${label}${extra !== undefined ? `  — ${String(extra).slice(0, 400)}` : ''}`)
  if (!ok) failures++
}
const sha = (b) => createHash('sha256').update(b).digest('hex')
const MAX = 20 * 1024 * 1024

const d = await startRealDaemon({ name: 'Content', seedSessions: ['desktop:one-1'] })
check(!!d, 'a real daemon is up (the Prometheus chat-projects branch, over loopback)')
const scratch = mkdtempSync(join(tmpdir(), 'beacon-content-probe-'))
try {
  const rest = new RestClient(`http://127.0.0.1:${d.port}`, d.token)
  const content = new ChatProjectContent({
    request: (method, path, body) => rest.projectsCall(method, path, body),
    bytes: (method, path, opts) => rest.projectsBytes(method, path, opts),
    available: () => true,
    isCurrent: () => true
  })
  const made = await d.owner('POST', '/api/chat-projects', { name: 'Kitchen' })
  const P = made.body.project.id
  const folder = made.body.project.folder
  const make2 = await d.owner('POST', '/api/chat-projects', { name: 'Shadowed' })
  const P2 = make2.body.project.id
  const folder2 = make2.body.project.folder
  const none = { pickFiles: async () => { throw new Error('a panel') }, pickSaveAs: async () => { throw new Error('a panel') } }
  const fileAt = (name, data) => {
    const dir = mkdtempSync(join(scratch, 'f-'))
    const p = join(dir, name)
    writeFileSync(p, data)
    return p
  }
  const up = (paths, replace = false) => content.run({ op: 'upload', id: P, ...(replace ? { replace: true } : {}) }, { pickFiles: async () => paths, pickSaveAs: async () => null })
  const down = async (name) => {
    const out = join(scratch, `down-${Math.random().toString(36).slice(2)}`)
    const r = await content.run({ op: 'download', id: P, name }, { pickFiles: async () => null, pickSaveAs: async () => out })
    return { r, bytes: existsSync(out) ? readFileSync(out) : null }
  }

  // ── 1: instructions ───────────────────────────────────────────────────────────────────────────────────────────────────────────
  {
    const first = await content.run({ op: 'instructions', id: P }, none)
    check(first.ok && first.instructions.content === '' && first.instructions.rev === '' && first.instructions.maxChars === 12000, '1: no instructions yet: empty text, the empty revision, and the loader\'s limit', JSON.stringify(first))
    const saved = await content.run({ op: 'save-instructions', id: P, content: 'Be brief.', baseRev: '' }, none)
    check(saved.ok && saved.rev.length > 0, '1: a first save is made from the empty revision', JSON.stringify(saved))
    check(existsSync(join(folder, 'PROMETHEUS.md')) && readFileSync(join(folder, 'PROMETHEUS.md'), 'utf8') === 'Be brief.', '1: and it is PROMETHEUS.md in the project\'s folder, with that text')
    const again = await content.run({ op: 'instructions', id: P }, none)
    check(again.ok && again.instructions.content === 'Be brief.' && again.instructions.rev === saved.rev && again.instructions.effective.length === 1 && again.instructions.effective[0].chars === 9, '1: read back: the text, the same revision, and the file the loader reads')
    const stale = await content.run({ op: 'save-instructions', id: P, content: 'Mine.', baseRev: '' }, none)
    check(!stale.ok && stale.kind === 'conflict' && stale.current.content === 'Be brief.' && stale.current.rev === saved.rev && readFileSync(join(folder, 'PROMETHEUS.md'), 'utf8') === 'Be brief.', '1: a save from a stale revision is a conflict with what is there, and the file is unchanged')
    const over = await content.run({ op: 'save-instructions', id: P, content: 'x'.repeat(12001), baseRev: saved.rev }, none)
    check(!over.ok && over.kind === 'too_long', '1: a text over the loader\'s limit is refused in those words', JSON.stringify(over))
    const edit = await content.run({ op: 'save-instructions', id: P, content: 'Be brief. Metric units.\nÜmlaut and 日本語.', baseRev: saved.rev }, none)
    const back = await content.run({ op: 'instructions', id: P }, none)
    check(edit.ok && back.ok && back.instructions.content === 'Be brief. Metric units.\nÜmlaut and 日本語.', '1: a save from the current revision goes through, and text that is not ASCII comes back as it went')
    writeFileSync(join(folder2, 'CLAUDE.md'), 'Use tabs.\n')
    const sh = await content.run({ op: 'save-instructions', id: P2, content: 'New.', baseRev: '' }, none)
    check(!sh.ok && sh.kind === 'would_shadow' && sh.shadowed.join() === 'CLAUDE.md' && !existsSync(join(folder2, 'PROMETHEUS.md')), '1: another instructions file in the folder: refused, naming it, and nothing written')
    const anyway = await content.run({ op: 'save-instructions', id: P2, content: 'New.', baseRev: '', shadowOk: true }, none)
    const seen = await content.run({ op: 'instructions', id: P2 }, none)
    check(anyway.ok && seen.ok && seen.instructions.effective.some((f) => /PROMETHEUS\.md$/.test(f.path)) && seen.instructions.effective.some((f) => /CLAUDE\.md$/.test(f.path) && f.shadowedBy), '1: with the person\'s say-so it is saved, and what the loader reads says CLAUDE.md is now read by nobody (shadowed)', JSON.stringify(seen.instructions?.effective))
    const gone = await content.run({ op: 'instructions', id: 'cp_nope' }, none)
    check(!gone.ok && gone.kind === 'unknown_project', '1: a project that is not there is said so')
  }

  // ── 2: reference files ────────────────────────────────────────────────────────────────────────────────────────────────────────
  {
    const all = Buffer.from(Array.from({ length: 256 }, (_, i) => i))
    const big = Buffer.concat([randomBytes(300_000), all])
    const sent = await up([fileAt('data.bin', big), fileAt('résumé draft.txt', 'Café\n'), fileAt('page.html', '<script>alert(1)</script>')])
    check(sent.ok && sent.uploaded.map((f) => f.name).join() === 'data.bin,résumé draft.txt,page.html' && sent.failed.length === 0 && sent.existing.length === 0, '2: three files go up: binary, an accented name with a space, and a web page', JSON.stringify(sent))
    const list = await content.run({ op: 'files', id: P }, none)
    check(list.ok && list.files.length === 3 && list.files.find((f) => f.name === 'data.bin').size === big.byteLength && list.files.find((f) => f.name === 'résumé draft.txt').size === 6, '2: the list has them, with their sizes')
    const a = await down('data.bin')
    check(a.r.ok && a.bytes && sha(a.bytes) === sha(big), '2: a binary file comes back byte for byte (every byte value, 300 KB of random)')
    const b = await down('résumé draft.txt')
    check(b.bytes?.toString('utf8') === 'Café\n', '2: a name with accents and a space is one segment each way, and its text is unchanged')
    const c = await down('page.html')
    check(c.r.ok && c.bytes?.toString() === '<script>alert(1)</script>', '2: a web page is saved as bytes, as the daemon sent it (it is served as a download, never as a page)')
    const dup = await up([fileAt('page.html', '<p>other</p>')])
    check(dup.ok && dup.existing.join() === 'page.html' && dup.uploaded.length === 0 && (await down('page.html')).bytes.toString() === '<script>alert(1)</script>', '2: the same name again is said to be taken, and the file is as it was')
    const rep = await up([fileAt('page.html', '<p>other</p>')], true)
    check(rep.ok && rep.uploaded.length === 1 && (await down('page.html')).bytes.toString() === '<p>other</p>', '2: with Replace it is overwritten')
    const inPlace = await content.run({ op: 'upload', id: P, replace: true, name: 'page.html' }, { pickFiles: async () => [fileAt('whatever.html', '<p>in its place</p>'), fileAt('never.html', 'x')], pickSaveAs: async () => null })
    const listed = (await content.run({ op: 'files', id: P }, none)).files.map((f) => f.name).sort().join()
    check(inPlace.ok && inPlace.uploaded.length === 1 && (await down('page.html')).bytes.toString() === '<p>in its place</p>' && !/whatever|never/.test(listed), '2: Replace on a row puts one chosen file in that file\'s place under its name; no other file is added', listed)
    const hidden = await up([fileAt('.hidden', 'x')])
    check(hidden.ok && hidden.failed.length === 1 && hidden.failed[0].name === '.hidden' && /can't use that file name/.test(hidden.failed[0].message), '2: a name the daemon will not take is said so in plain words')
    const del = await content.run({ op: 'delete-file', id: P, name: 'data.bin' }, none)
    const del2 = await content.run({ op: 'delete-file', id: P, name: 'data.bin' }, none)
    check(del.ok && !del2.ok && del2.kind === 'unknown_file' && (await content.run({ op: 'files', id: P }, none)).files.length === 2, '2: delete removes that file; again, it is already gone')
    const miss = await down('nope.txt')
    check(!miss.r.ok && miss.r.kind === 'unknown_file' && miss.bytes === null, '2: a file that is not there is said so, and nothing is written')
  }

  // ── 3: the limit ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
  {
    const exact = randomBytes(MAX)
    const r = await up([fileAt('exactly-20mb.bin', exact)])
    check(r.ok && r.uploaded.length === 1 && r.uploaded[0].size === MAX, '3: a file of exactly 20 MB goes up (Beacon\'s limit is the daemon\'s)', JSON.stringify(r).slice(0, 200))
    const back = await down('exactly-20mb.bin')
    check(back.r.ok && back.bytes && sha(back.bytes) === sha(exact), '3: and comes back unchanged')
    const over = fileAt('too-big.bin', '')
    truncateSync(over, MAX + 1)
    const before = (await content.run({ op: 'files', id: P }, none)).files.length
    const refused = await up([over])
    check(refused.ok && refused.failed.length === 1 && /too large/.test(refused.failed[0].message) && (await content.run({ op: 'files', id: P }, none)).files.length === before, '3: a byte more is refused by Beacon before the file is read, and nothing was sent')
    const direct = await rest.projectsBytes('PUT', `/api/chat-projects/${P}/files/too-big.bin`, { body: Buffer.alloc(MAX + 1), maxBytes: MAX })
    check(direct.status === 413, '3: and the daemon refuses it itself (413), which is read as "too large" whatever its body says', direct.status)
    await content.run({ op: 'delete-file', id: P, name: 'exactly-20mb.bin' }, none)
  }

  // ── 4: the transport ──────────────────────────────────────────────────────────────────────────────────────────────────────────
  {
    const blocked = []
    for (const [m, p] of [['GET', '/api/config'], ['GET', `/api/chat-projects/${P}/files/..%2f..`], ['GET', `/api/chat-projects/${P}/files/../../x`], ['DELETE', `/api/chat-projects/${P}`], ['POST', `/api/chat-projects/${P}/files/a`]]) {
      try {
        await rest.projectsBytes(m, p, { maxBytes: 10 })
        blocked.push(false)
      } catch {
        blocked.push(true)
      }
    }
    check(blocked.every(Boolean), '4: the bytes call refuses any path that is not the instructions or files of a project, before it sends anything')
    const dead = new RestClient('http://127.0.0.1:1', 'x')
    const noAnswer = await dead.projectsBytes('GET', `/api/chat-projects/${P}/files/a.txt`, { maxBytes: 10 })
    check(noAnswer.status === 0 && noAnswer.bytes === null, '4: a Prometheus that cannot be reached is status 0, not a throw')
  }
} finally {
  rmSync(scratch, { recursive: true, force: true })
  d?.stop()
}
console.log(`[probe] ${failures === 0 ? 'PASS' : 'FAIL'}: ${checks - failures} of ${checks} checks`)
process.exit(failures === 0 ? 0 : 1)
