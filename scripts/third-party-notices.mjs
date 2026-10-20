#!/usr/bin/env node
// THIRD_PARTY_NOTICES.txt: every third-party component that ships inside Beacon, with its license text.
// Beacon's LICENSE points at it, electron-builder.yml ships it (Resources/THIRD_PARTY_NOTICES.txt), and
// Settings → About opens it.
//
// WHAT SHIPS, and so what this lists:
//   - every production dependency in package-lock.json. electron-builder copies the pruned production
//     node_modules into app.asar whether or not any code loads them;
//   - every package rollup inlined into out/, read from the build's own record (bundledPackages in
//     electron.vite.config.ts). That is how a devDependency that lands in the bundle gets listed: today
//     only vite, whose preload helper the renderer carries;
//   - Electron itself. Chromium's licenses, and those of everything else built into Electron (Node.js,
//     FFmpeg, …), are Electron's LICENSES.chromium.html, which ships beside this file.
//
//   node scripts/third-party-notices.mjs           # self-test, then: is THIRD_PARTY_NOTICES.txt current?
//   node scripts/third-party-notices.mjs --write   # regenerate it (run `npm run build` first)
//
// Fails (exit 1), never skips, when:
//   - the committed file differs from what this build ships (a dependency changed: --write, commit);
//   - a shipped package is copyleft (GPL, LGPL, AGPL) with no permissive alternative. Releasing over one
//     is a decision for a human, not for this script;
//   - a package declares no license, or ships no license file and declares one whose text is not here;
//   - the build record is missing (nothing built yet) or holds a virtual module it cannot attribute.
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const OUT = 'THIRD_PARTY_NOTICES.txt'
const RECORD_DIR = 'node_modules/.cache/beacon-bundled-packages' // electron.vite.config.ts BUNDLED_PACKAGES_DIR
const TARGETS = ['main', 'preload', 'renderer']
const LICENSE_FILE = /^(licen[cs]e|copying|notice)([.-].*)?$/i

// A package whose license file also carries the licenses of everything IT bundles. Only its own code
// ships in Beacon, so only its own section is reproduced.
const OWN_SECTION_ONLY = { vite: '# Licenses of bundled dependencies' }

// A package whose package.json declares no license, read by hand from its license file. Pinned to the
// version, so an upgrade is read again.
const READ_FROM_FILE = { 'khroma@2.1.0': 'MIT' }

// The standard text, for a package that declares one of these and ships no license file of its own.
const STANDARD_TEXT = {
  MIT: `Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
associated documentation files (the "Software"), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the
following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial
portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT
LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO
EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER
IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
USE OR OTHER DEALINGS IN THE SOFTWARE.`
}

const COPYLEFT = /\b(A?GPL|LGPL)\b|\b(A?GPL|LGPL)-\d|General Public License/i
const COPYLEFT_TEXT = /GNU (AFFERO |LESSER |LIBRARY )?GENERAL PUBLIC LICENSE/

/** 'permissive' | 'dual' (copyleft OR something permissive: the permissive option is available) |
 *  'copyleft' | 'unknown'. AND, or a bare copyleft id, is copyleft. */
export function classify(license) {
  if (typeof license !== 'string' || !license.trim()) return 'unknown'
  const expr = license.replace(/[()]/g, ' ')
  if (/\sAND\s/i.test(expr)) return COPYLEFT.test(expr) ? 'copyleft' : 'permissive'
  const alts = expr.split(/\s+OR\s+/i).map((s) => s.trim()).filter(Boolean)
  const copyleft = alts.filter((a) => COPYLEFT.test(a))
  if (copyleft.length === 0) return 'permissive'
  return copyleft.length < alts.length ? 'dual' : 'copyleft'
}

function selfTest() {
  const cases = [
    ['MIT', 'permissive'],
    ['(MPL-2.0 OR Apache-2.0)', 'permissive'],
    ['(MIT OR GPL-3.0-or-later)', 'dual'],
    ['GPL-3.0', 'copyleft'],
    ['LGPL-2.1-or-later', 'copyleft'],
    ['AGPL-3.0-only', 'copyleft'],
    ['(GPL-2.0 OR LGPL-2.1)', 'copyleft'],
    ['MIT AND LGPL-3.0', 'copyleft'],
    ['GNU General Public License v3', 'copyleft'],
    ['', 'unknown'],
    [undefined, 'unknown']
  ]
  const bad = cases.filter(([license, want]) => classify(license) !== want)
  for (const [license, want] of bad) console.error(`  ✗ self-test: ${JSON.stringify(license)} → ${classify(license)}, want ${want}`)
  if (!COPYLEFT_TEXT.test('                    GNU LESSER GENERAL PUBLIC LICENSE')) bad.push(['text', 'LGPL heading'])
  if (COPYLEFT_TEXT.test('Permission is hereby granted, free of charge')) bad.push(['text', 'MIT body'])
  if (bad.length) {
    console.error(`✗ third-party-notices — self-test: ${bad.length} fixtures got the wrong verdict; refusing to check anything`)
    process.exit(3)
  }
  console.log(`✓ third-party-notices — self-test: ${cases.length + 2} fixtures, each with the right verdict`)
}

const normalize = (text) => text.replace(/\r\n?/g, '\n').replace(/[ \t]+$/gm, '').trim()

function declaredLicense(pj) {
  if (typeof pj.license === 'string') return pj.license
  if (pj.license?.type) return pj.license.type
  if (Array.isArray(pj.licenses)) return pj.licenses.map((l) => l.type ?? l).join(' OR ')
  return undefined
}

function homepage(pj) {
  const raw = typeof pj.repository === 'string' ? pj.repository : pj.repository?.url
  const repo = raw?.replace(/^git\+/, '').replace(/\.git$/, '').replace(/^git:\/\//, 'https://').replace(/^github:/, 'https://github.com/')
  return repo && /^https?:\/\//.test(repo) ? repo : typeof pj.homepage === 'string' ? pj.homepage : null
}

function author(pj) {
  const a = pj.author
  return typeof a === 'string' ? a : a?.name ?? null
}

/** One shipped package, read from disk: its declared license and every license/notice file it carries. */
function readPackage(dir, problems) {
  const pj = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  const license = declaredLicense(pj) ?? READ_FROM_FILE[`${pj.name}@${pj.version}`]
  const files = readdirSync(dir).filter((f) => LICENSE_FILE.test(f) && statSync(join(dir, f)).isFile()).sort()
  const texts = files.map((file) => {
    let text = normalize(readFileSync(join(dir, file), 'utf8'))
    const cut = OWN_SECTION_ONLY[pj.name]
    if (cut && text.includes(cut)) text = text.slice(0, text.indexOf(cut)).trim()
    return { file, text }
  })
  const kind = classify(license)
  if (kind === 'unknown') problems.push(`${pj.name}@${pj.version} (${dir}): declares no license`)
  if (kind === 'copyleft') problems.push(`${pj.name}@${pj.version}: COPYLEFT, ${license}`)
  if (kind === 'permissive' && texts.some((t) => COPYLEFT_TEXT.test(t.text))) {
    problems.push(`${pj.name}@${pj.version}: declares ${license}, but its ${texts.map((t) => t.file).join(', ')} carries a GNU license text; read it`)
  }
  if (texts.length === 0 && !STANDARD_TEXT[license]) problems.push(`${pj.name}@${pj.version}: no license file, and no standard text here for "${license}"`)
  return { name: pj.name, version: pj.version, license, kind, homepage: homepage(pj), author: author(pj), texts }
}

/** The package directories that ship: production dependencies, plus whatever the last build inlined. */
function shippedDirs(problems) {
  const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'))
  const dirs = new Set()
  for (const [dir, entry] of Object.entries(lock.packages)) {
    if (!dir || entry.dev || entry.devOptional || entry.link) continue
    if (!existsSync(join(dir, 'package.json'))) {
      // An optional package for another platform is in the lockfile and was not installed here.
      if (!entry.optional) problems.push(`${dir}: a production dependency, not installed (npm ci first)`)
      continue
    }
    dirs.add(dir)
  }
  const bundledOnly = []
  for (const target of TARGETS) {
    const file = join(RECORD_DIR, `${target}.json`)
    if (!existsSync(file)) {
      problems.push(`${file}: missing, so what the ${target} bundle inlined is unknown (npm run build first)`)
      continue
    }
    const record = JSON.parse(readFileSync(file, 'utf8'))
    for (const v of record.virtual) problems.push(`${target} bundle: virtual module ${v} cannot be attributed to a package`)
    for (const dir of record.packages) {
      if (!dirs.has(dir)) bundledOnly.push(dir)
      dirs.add(dir)
    }
  }
  return { dirs: [...dirs], bundledOnly: [...new Set(bundledOnly)].sort() }
}

function render(electron, packages) {
  const rule = '='.repeat(100)
  const thin = '-'.repeat(100)
  const width = Math.max(...packages.map((p) => `${p.name} ${p.version}`.length))
  const lines = [
    'THIRD-PARTY SOFTWARE NOTICES',
    '',
    'Beacon includes the open-source software listed below. Each component is distributed under its own',
    'license, reproduced in full under its name.',
    '',
    `Beacon is built on Electron ${electron.version}. Chromium, and the other open-source components built into`,
    'Electron (Node.js, FFmpeg, V8 and others), are listed with their licenses in LICENSES.chromium.html,',
    'which ships with Beacon beside this file.',
    '',
    `COMPONENTS (${packages.length + 1})`,
    '',
    `  ${`Electron ${electron.version}`.padEnd(width)}  ${electron.license}`,
    ...packages.map((p) => `  ${`${p.name} ${p.version}`.padEnd(width)}  ${p.license}`)
  ]
  for (const p of [electron, ...packages]) {
    lines.push('', rule, `${p.name} ${p.version}`, `License: ${p.license}`)
    if (p.homepage) lines.push(p.homepage)
    if (p.texts.length === 0) {
      lines.push(thin, `This package declares the ${p.license} license and ships no license file.${p.author ? ` Its author: ${p.author}.` : ''}`, '', STANDARD_TEXT[p.license])
    }
    for (const t of p.texts) lines.push(thin, ...(p.texts.length > 1 ? [`[${t.file}]`, ''] : []), t.text)
  }
  return lines.join('\n') + '\n'
}

function generate() {
  const problems = []
  const { dirs, bundledOnly } = shippedDirs(problems)
  const seen = new Map()
  for (const dir of dirs.sort()) {
    const p = readPackage(dir, problems)
    seen.set(`${p.name}@${p.version}`, p)
  }
  const packages = [...seen.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version, undefined, { numeric: true }))
  const electron = { ...readPackage('node_modules/electron', problems), name: 'Electron' }
  return { text: render(electron, packages), packages, bundledOnly, problems }
}

selfTest()
if (process.argv.includes('--self-test')) process.exit(0)
const { text, packages, bundledOnly, problems } = generate()
const dual = packages.filter((p) => p.kind === 'dual')
const noFile = packages.filter((p) => p.texts.length === 0)
console.log(`  ${packages.length} packages + Electron; inlined by the bundle but not production dependencies: ${bundledOnly.map((d) => d.replace(/^node_modules\//, '')).join(', ') || 'none'}`)
if (dual.length) console.log(`  dual-licensed, a permissive option available: ${dual.map((p) => `${p.name}@${p.version} (${p.license})`).join(', ')}`)
if (noFile.length) console.log(`  no license file of their own (standard ${[...new Set(noFile.map((p) => p.license))].join('/')} text used): ${noFile.map((p) => `${p.name}@${p.version}`).join(', ')}`)
if (problems.length) {
  console.error(`✗ third-party-notices — ${problems.length} problem(s):\n    ${problems.join('\n    ')}`)
  process.exit(1)
}
if (process.argv.includes('--write')) {
  writeFileSync(OUT, text)
  console.log(`✓ third-party-notices — wrote ${OUT} (${text.length} bytes)`)
  process.exit(0)
}
const committed = existsSync(OUT) ? readFileSync(OUT, 'utf8') : null
if (committed !== text) {
  console.error(`✗ third-party-notices — ${OUT} ${committed === null ? 'is missing' : 'is stale: it does not match what this build ships'}. Run \`npm run build && npm run notices\` and commit it.`)
  process.exit(1)
}
console.log(`✓ third-party-notices — ${OUT} lists exactly what this build ships, and nothing shipped is copyleft`)
