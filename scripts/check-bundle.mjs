#!/usr/bin/env node
// Bundle audit: what is inside the built app.asar, and does any of it not belong there?
//
// WHY. On 2026-09-07 the installed Beacon.app was found to contain the gitignored design
// prototypes — with real tailnet addresses in them — plus a 17 MB stale git worktree, docs, and
// handoff notes. The pre-commit guard never saw any of it because the guard reads git and the
// packager reads disk. This is the check on the other side of that seam: it reads the ARTIFACT.
//
// Four assertions, all fail-closed:
//   1. Top-level entries are exactly the allowlist. A new directory in the repo root cannot ship
//      by accident, because it would have to be named here first.
//   2. No .dc.html anywhere, and no raw CGNAT-range (the tailnet /10) address anywhere in the asar's bytes —
//      the two concrete things that leaked.
//   3. The expected entries ARE present (out/main/index.js, package.json, out/renderer/index.html).
//      A lister that returns nothing must not pass; "demand a positive signal each step ran."
//   4. It is a RELEASE: the asar's package.json says beaconBuild: release, and (for a .app) the
//      binary's fuses are the release set (scripts/bundle-facts.mjs). install-local runs this, so a
//      probe build (debuggable, electron-builder.probe.yml) or a bundle packaged without the
//      hardening cannot be installed. Read from the artifact, like everything else here.
//
// Run: npm run audit:bundle [path/to/app.asar]   (default: the newest dist/**/app.asar)
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { RELEASE_FUSES, fuseMismatches, readBuildFlavor, readFuses } from './bundle-facts.mjs'

const ALLOWED_TOP = new Set(['out', 'node_modules', 'package.json'])
const MUST_EXIST = ['/out/main/index.js', '/out/renderer/index.html', '/package.json']
const TAILNET = /100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.[0-9]{1,3}\.[0-9]{1,3}/g

function newestAsar(root) {
  const found = []
  const walk = (d) => { for (const n of readdirSync(d)) { const p = join(d, n); const st = statSync(p); if (st.isDirectory()) walk(p); else if (n === 'app.asar') found.push({ p, m: st.mtimeMs }) } }
  if (existsSync(root)) walk(root)
  return found.sort((a, b) => b.m - a.m)[0]?.p
}

const asar = process.argv[2] || newestAsar(join(process.cwd(), 'dist'))
if (!asar || !existsSync(asar)) { console.error('✗ audit:bundle — no app.asar found (run: npm run dist)'); process.exit(2) }

const listing = execFileSync('npx', ['--yes', '@electron/asar', 'list', asar], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split('\n').filter(Boolean)
if (listing.length < 10) { console.error(`✗ audit:bundle — the lister returned ${listing.length} entries; that is not a bundle`); process.exit(2) }

const problems = []
// 1. top level
const top = new Set(listing.map((e) => e.split('/')[1]).filter(Boolean))
for (const t of top) if (!ALLOWED_TOP.has(t)) problems.push(`top-level entry not in the allowlist: /${t}  (${listing.filter((e) => e.startsWith('/' + t + '/') || e === '/' + t).length} entries)`)
// 2. the two concrete leaks
const proto = listing.filter((e) => e.endsWith('.dc.html'))
if (proto.length) problems.push(`${proto.length} design prototype(s) inside the bundle: ${proto.slice(0, 3).join(', ')}`)
const bytes = readFileSync(asar, 'latin1')
const hits = bytes.match(TAILNET) || []
if (hits.length) problems.push(`${hits.length} raw tailnet-range address(es) inside the bundle: ${[...new Set(hits)].slice(0, 3).join(', ')}`)
// 3. positive signal
for (const m of MUST_EXIST) if (!listing.includes(m)) problems.push(`expected entry missing: ${m}`)
// 4. a release, not a probe build, and hardened
const flavor = readBuildFlavor(asar)
if (flavor !== 'release') problems.push(`package.json beaconBuild is ${JSON.stringify(flavor)}, must be "release" (a probe build, or packaged without electron-builder.yml)`)
const app = asar.match(/^(.*\.app)\/Contents\/Resources\/app\.asar$/)?.[1]
let fuseNote = 'fuses not checked (not inside a .app)'
if (app) {
  const bad = fuseMismatches(await readFuses(app), RELEASE_FUSES)
  for (const b of bad) problems.push(`fuse: ${b}`)
  fuseNote = `${Object.keys(RELEASE_FUSES).length} release fuses as required`
}

if (problems.length) {
  console.error(`✗ audit:bundle — ${asar}\n  ${problems.join('\n  ')}\n  → electron-builder.yml \`files\` is an include list; the packager reads DISK, not git. A release is \`npm run dist\` / \`pack:mac\` (electron-builder.yml), never pack:mac:probe.`)
  process.exit(1)
}
console.log(`✓ audit:bundle — ${listing.length} entries, top level {${[...top].sort().join(', ')}}, no prototypes, no tailnet addresses, ${MUST_EXIST.length} expected entries present, beaconBuild release, ${fuseNote}`)
