#!/usr/bin/env node
// License audit: is Beacon MIT everywhere the declaration surfaces, with one copyright line, and does every
// build carry the license and the third-party notices, with no install-time agreement in front of them?
//
// WHY. Beacon's source is published under the MIT License, the same license as Prometheus. The license
// field surfaces in three places a user can see: the package.json inside every app.asar, the .deb's
// `License:` field (electron-builder passes package.json's license to fpm), and the npm metadata itself.
// The macOS About box shows the `copyright` line from electron-builder.yml (Info.plist
// NSHumanReadableCopyright). Before the switch, Beacon was freeware under its own terms and every one of
// these said so ("SEE LICENSE IN LICENSE", "All rights reserved"); a release that still says either
// contradicts its own LICENSE.
//
// The license and the notices still reach the user: LICENSE ships as LICENSE.txt and THIRD_PARTY_NOTICES.txt
// beside it (electron-builder.yml extraResources); Chromium's licenses ship as LICENSES.chromium.html (macOS:
// scripts/after-extract.cjs puts it there; Linux: electron-builder keeps Electron's own copy). MIT asks
// for no agreement, so the dmg no longer shows one before it mounts and the AppImage no longer asks on
// its first run.
//
// What must hold, all fail-closed:
//   1. license is exactly "MIT";
//   2. LICENSE is the MIT License verbatim (the text Prometheus carries, word for word) with one
//      "Copyright (c) <year> <holder>" line;
//   3. the About-box copyright is that line verbatim, says no "All rights reserved" and names no license;
//      package.json's author is that line's holder; release-repo/LICENSE (the public repo's) is LICENSE
//      byte for byte: one text, one holder;
//   4. electron-builder.yml ships LICENSE and the notices, Chromium's licenses on macOS (the afterExtract
//      hook), and asks for no agreement (no dmg.license, no appImage.license);
//   5. a built app carries byte-identical copies of LICENSE and THIRD_PARTY_NOTICES.txt, and Chromium's
//      licenses; a dmg carries no agreement; an AppImage does not ask on first run;
//   6. each place is actually read: an artifact the reader cannot open is a failure, never a skip.
//
//   node scripts/check-license-metadata.mjs               # self-test, then the repo's own sources
//   node scripts/check-license-metadata.mjs --self-test   # self-test only
//   node scripts/check-license-metadata.mjs <target>…     # self-test, then each built artifact
//
// A target is a Beacon.app, an unpacked Linux dir (resources/app.asar), an app.asar (metadata only), a mac
// .zip (the app inside it), a .dmg (no agreement), a .deb (control `License:` and the files; Linux only, via
// dpkg-deb) or an .AppImage (extracted; Linux only).
import { execFileSync } from 'node:child_process'
import { closeSync, existsSync, fstatSync, mkdtempSync, openSync, readdirSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const require = createRequire(import.meta.url)
const SPDX = 'MIT'
const LICENSE_NAMES = /\b(MIT|Apache|BSD|GPL|LGPL|MPL|ISC)\b/
const RESERVED = /All rights reserved/i
const COPYRIGHT_LINE = /^Copyright \(c\) (\d{4}) (.+)$/
// The MIT License, as Prometheus's LICENSE and choosealicense.com carry it. Compared word for word, so
// line wrapping and trailing spaces do not matter and any other word does.
const MIT_BODY = `Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`
// What ships beside app.asar, and what it is copied from.
const BUNDLED = { 'LICENSE.txt': 'LICENSE', 'THIRD_PARTY_NOTICES.txt': 'THIRD_PARTY_NOTICES.txt' }
const CHROMIUM = 'LICENSES.chromium.html'

export function auditLicense(value, where) {
  if (typeof value !== 'string' || !value.trim()) return [`${where}: no license declared`]
  if (value !== SPDX) return [`${where}: license "${value}" is not "${SPDX}"`]
  return []
}

export function auditCopyright(value, where) {
  if (typeof value !== 'string' || !value.trim()) return [`${where}: no copyright line`]
  const p = []
  if (!COPYRIGHT_LINE.test(value)) p.push(`${where}: "${value}" is not "Copyright (c) <year> <holder>"`)
  if (RESERVED.test(value)) p.push(`${where}: "${value}" says "All rights reserved", which MIT does not`)
  if (LICENSE_NAMES.test(value)) p.push(`${where}: "${value}" names a license`)
  return p
}

const words = (t) => t.replace(/\s+/g, ' ').trim()

/** LICENSE itself: "MIT License", one copyright line, then the MIT text word for word, and nothing else. */
export function auditLicenseText(text, where) {
  if (typeof text !== 'string' || !text.trim()) return [`${where}: empty or missing`]
  const [title, copyright, ...rest] = text.replace(/\r\n?/g, '\n').replace(/[ \t]+$/gm, '').trim().split(/\n{2,}/)
  const p = []
  if (title !== 'MIT License') p.push(`${where}: the first line is "${title.split('\n')[0]}", not "MIT License"`)
  if (!COPYRIGHT_LINE.test(copyright ?? '') || RESERVED.test(copyright ?? '')) p.push(`${where}: the second paragraph is not one "Copyright (c) <year> <holder>" line`)
  if (words(rest.join('\n\n')) !== words(MIT_BODY)) p.push(`${where}: the license text is not the MIT License word for word`)
  return p
}

/** One text, one holder: this repository IS the public repo, so its LICENSE is the only one (no
 *  release-repo/ copy to drift), the About box says LICENSE's copyright line verbatim, and package.json's
 *  author is that line's holder. */
export function auditOneText({ license, secondCopy, copyright, author }) {
  const p = []
  const line = license?.split('\n').find((l) => COPYRIGHT_LINE.test(l))
  if (!line) return ['LICENSE: no "Copyright (c) <year> <holder>" line']
  const holder = line.match(COPYRIGHT_LINE)[2]
  if (secondCopy) p.push('release-repo/ exists: this repository is the public repo, so its root files are the public ones; a second copy only drifts')
  if (copyright !== line) p.push(`electron-builder.yml copyright: "${copyright}" is not LICENSE's line "${line}"`)
  if (author !== holder) p.push(`package.json author: "${author}" is not LICENSE's holder "${holder}"`)
  return p
}

/** electron-builder.yml ships the license, the notices and Chromium's licenses, and asks for no agreement. */
export function auditBuilderConfig(cfg) {
  const p = []
  const has = (list, from, to) => Array.isArray(list) && list.some((e) => e && e.from === from && e.to === to)
  for (const [to, from] of Object.entries(BUNDLED)) {
    if (!has(cfg?.extraResources, from, to)) p.push(`electron-builder.yml: extraResources does not ship ${from} as ${to}`)
  }
  if (cfg?.afterExtract !== 'scripts/after-extract.cjs') p.push(`electron-builder.yml: afterExtract is ${JSON.stringify(cfg?.afterExtract)}, not scripts/after-extract.cjs (Chromium's licenses on macOS)`)
  if (cfg?.dmg?.license !== undefined) p.push(`electron-builder.yml: dmg.license is ${JSON.stringify(cfg.dmg.license)}; MIT asks for no agreement before the dmg mounts`)
  if (cfg?.appImage?.license !== undefined) p.push(`electron-builder.yml: appImage.license is ${JSON.stringify(cfg.appImage.license)}; MIT asks for no agreement on the AppImage's first run`)
  return p
}

/** The text of a dmg's license agreement: the TEXT resource in the UDIF resource plist, which the trailer
 *  ('koly', the last 512 bytes) locates. Mac Roman, as dmgbuild writes it. null: the dmg has none.
 *  `source` is a path, or the image's bytes (the self-test). */
export function dmgAgreementText(source) {
  const bytes = Buffer.isBuffer(source) ? source : null
  const fd = bytes ? null : openSync(source, 'r')
  try {
    const size = bytes ? bytes.length : fstatSync(fd).size
    const read = (off, len) => {
      if (bytes) return bytes.subarray(off, off + len)
      const b = Buffer.alloc(len)
      readSync(fd, b, 0, len, off)
      return b
    }
    const koly = read(size - 512, 512)
    if (koly.toString('latin1', 0, 4) !== 'koly') throw new Error('not a UDIF disk image (no koly trailer)')
    const plist = read(Number(koly.readBigUInt64BE(0xd8)), Number(koly.readBigUInt64BE(0xe0))).toString('utf8')
    const text = plist.match(/<key>TEXT<\/key>\s*<array>[\s\S]*?<key>Data<\/key>\s*<data>([\s\S]*?)<\/data>/)
    return text ? new TextDecoder('macintosh').decode(Buffer.from(text[1].replace(/\s+/g, ''), 'base64')) : null
  } finally {
    if (fd != null) closeSync(fd)
  }
}

const normalize = (t) => t.replace(/\r\n?/g, '\n').replace(/[ \t]+$/gm, '').trim()

export function sameText(got, want, where) {
  if (got == null) return [`${where}: missing`]
  return normalize(got) === normalize(want) ? [] : [`${where}: differs from the repo's copy`]
}

/** What the app and the READMEs say about the license: the About line in each place a user reads it, and
 *  no leftover of the freeware terms anywhere in the source or the READMEs. `files` maps path → text. */
export const ABOUT_LINE = 'Free · open source (MIT) · beta'
export const ABOUT_AT = ['src/main/index.ts', 'src/renderer/src/components/ConnectionSettings.tsx', 'README.md']
const LEFTOVER = /closed[- ]source|Preview Terms|All rights reserved|proprietary freeware|SEE LICENSE IN LICENSE/i
export function auditStrings(files) {
  const p = []
  for (const at of ABOUT_AT) if (!files[at]?.includes(ABOUT_LINE)) p.push(`${at}: does not say "${ABOUT_LINE}"`)
  for (const [at, text] of Object.entries(files)) {
    const m = text.match(LEFTOVER)
    if (m) p.push(`${at}:${text.slice(0, m.index).split('\n').length}: still says "${m[0]}"`)
  }
  return p
}

/** The app links files on the public repo's main branch (src/shared/setup-links.ts: the setup guide).
 *  This repository is that repo, so each linked path must be here, or every installed Beacon links a 404. */
export function auditPublicLinks(source, exists) {
  const paths = [...source.matchAll(/github\.com\/OAraLabs\/Beacon\/blob\/main\/([^'"`\s)#]+)/gi)].map((m) => m[1])
  if (!paths.length) return ['src/shared/setup-links.ts: links no file on the public repo (expected the setup guide)']
  return paths.filter((f) => !exists(f)).map((f) => `${f}: the app links it on OAraLabs/Beacon's main branch, and it is not in this repository`)
}

/** A dmg must carry no agreement: `text` is what dmgAgreementText found (null: none). */
export function noAgreement(text, where) {
  return text == null ? [] : [`${where}: carries a license agreement ("${text.split('\n')[0].slice(0, 40)}…"); MIT asks for none`]
}

function selfTest() {
  const mit = (holder = 'OAra Labs, LLC', body = MIT_BODY) => `MIT License\n\nCopyright (c) 2026 ${holder}\n\n${body}\n`
  const wired = {
    extraResources: [{ from: 'LICENSE', to: 'LICENSE.txt' }, { from: 'THIRD_PARTY_NOTICES.txt', to: 'THIRD_PARTY_NOTICES.txt' }],
    afterExtract: 'scripts/after-extract.cjs',
    dmg: { title: 'Beacon', sign: true },
    appImage: {}
  }
  const oneText = { license: mit(), secondCopy: false, copyright: 'Copyright (c) 2026 OAra Labs, LLC', author: 'OAra Labs, LLC' }
  const without = (mutate) => { const c = structuredClone(wired); mutate(c); return c }
  const previewTerms = 'Beacon Preview Terms\nCopyright (c) 2026 OAra Labs, LLC. All rights reserved.\n\nBeacon is free to download and use.\n\nTHIRD_PARTY_NOTICES.\n'
  // A minimal UDIF: a resource plist holding a Mac Roman TEXT resource, then the koly trailer locating it.
  const fakeDmg = (body) => {
    const plist = Buffer.from(`<plist><dict><key>resource-fork</key><dict><key>TEXT</key><array><dict><key>Data</key><data>${body.toString('base64')}</data></dict></array></dict></dict></plist>`)
    const koly = Buffer.alloc(512)
    koly.write('koly', 0, 'latin1')
    koly.writeBigUInt64BE(0n, 0xd8)
    koly.writeBigUInt64BE(BigInt(plist.length), 0xe0)
    return Buffer.concat([plist, koly])
  }
  const bareDmg = () => Buffer.concat([Buffer.from('<plist/>'), (() => { const k = Buffer.alloc(512); k.write('koly', 0, 'latin1'); k.writeBigUInt64BE(8n, 0xe0); return k })()])
  const cases = [
    ['MIT passes', () => auditLicense('MIT', 'x'), true],
    ['SEE LICENSE IN LICENSE fails (the old freeware declaration)', () => auditLicense('SEE LICENSE IN LICENSE', 'x'), false],
    ['UNLICENSED fails', () => auditLicense('UNLICENSED', 'x'), false],
    ['lowercase mit fails (SPDX is exact)', () => auditLicense('mit', 'x'), false],
    ['an SPDX expression with MIT fails', () => auditLicense('(MIT OR Apache-2.0)', 'x'), false],
    ['another license fails (allowlist, not a denylist)', () => auditLicense('Apache-2.0', 'x'), false],
    ['a missing license fails', () => auditLicense(undefined, 'x'), false],
    ['an empty license fails', () => auditLicense('  ', 'x'), false],
    ['the release copyright passes', () => auditCopyright('Copyright (c) 2026 OAra Labs, LLC', 'x'), true],
    ['the old "All rights reserved" copyright fails', () => auditCopyright('Copyright (c) 2026 OAra Labs, LLC. All rights reserved.', 'x'), false],
    ['a copyright naming MIT fails', () => auditCopyright('Copyright (c) 2026 OAra Labs, LLC (MIT)', 'x'), false],
    ['a copyright in another shape fails', () => auditCopyright('© OAraLabs', 'x'), false],
    ['a missing copyright fails', () => auditCopyright(undefined, 'x'), false],
    ['the MIT License passes', () => auditLicenseText(mit(), 'x'), true],
    ["Prometheus's wrapping and spacing pass (word for word, not byte for byte)", () => auditLicenseText(mit().split('\n\n').map((b) => b.replace(/\n/g, ' ')).join('  \n\n'), 'x'), true],
    ['the old Preview Terms fail', () => auditLicenseText(previewTerms, 'x'), false],
    ['MIT with a word changed fails', () => auditLicenseText(mit('OAra Labs, LLC', MIT_BODY.replace('sublicense, ', '')), 'x'), false],
    ['MIT with terms appended fails', () => auditLicenseText(`${mit()}\nYou may not sell Beacon.\n`, 'x'), false],
    ['MIT with "All rights reserved" in the copyright fails', () => auditLicenseText(mit('OAra Labs, LLC. All rights reserved.'), 'x'), false],
    ['MIT with no copyright line fails', () => auditLicenseText(`MIT License\n\n${MIT_BODY}\n`, 'x'), false],
    ['an empty LICENSE fails', () => auditLicenseText('', 'x'), false],
    ['one text, one holder passes', () => auditOneText(oneText), true],
    ['a release-repo/ copy fails (this repo is the public one)', () => auditOneText({ ...oneText, secondCopy: true }), false],
    ['a public link to a file this repo has passes', () => auditPublicLinks("guide: 'https://github.com/OAraLabs/Beacon/blob/main/docs/SETUP.md'", () => true), true],
    ['a public link to a file this repo lacks fails', () => auditPublicLinks("guide: 'https://github.com/OAraLabs/Beacon/blob/main/docs/SETUP.md'", () => false), false],
    ['a source with no public link fails (the reader lost its subject)', () => auditPublicLinks('nothing here', () => true), false],
    ['an About box naming another holder fails', () => auditOneText({ ...oneText, copyright: 'Copyright (c) 2026 OAraLabs' }), false],
    ['an About box that still says "All rights reserved" fails', () => auditOneText({ ...oneText, copyright: 'Copyright (c) 2026 OAra Labs, LLC. All rights reserved.' }), false],
    ['a package.json author that is not the holder fails', () => auditOneText({ ...oneText, author: 'OAraLabs' }), false],
    ['a LICENSE with no copyright line fails', () => auditOneText({ ...oneText, license: 'MIT License' }), false],
    ['the wired builder config passes', () => auditBuilderConfig(wired), true],
    ['no LICENSE.txt in extraResources fails', () => auditBuilderConfig(without((c) => c.extraResources.shift())), false],
    ['no notices in extraResources fails', () => auditBuilderConfig(without((c) => c.extraResources.pop())), false],
    ['no Chromium licenses on macOS fails', () => auditBuilderConfig(without((c) => delete c.afterExtract)), false],
    ['a dmg agreement fails', () => auditBuilderConfig(without((c) => { c.dmg.license = 'LICENSE' })), false],
    ['an AppImage first-run agreement fails', () => auditBuilderConfig(without((c) => { c.appImage.license = 'LICENSE' })), false],
    ['a dmg with no agreement passes', () => noAgreement(dmgAgreementText(bareDmg()), 'x'), true],
    ['a dmg with an agreement fails', () => noAgreement(dmgAgreementText(fakeDmg(Buffer.from([0x42, 0xd1, 0x43]))), 'x'), false],
    ['the About line everywhere passes', () => auditStrings(Object.fromEntries(ABOUT_AT.map((f) => [f, `x ${ABOUT_LINE} y`]))), true],
    ['an About place without the line fails', () => auditStrings(Object.fromEntries(ABOUT_AT.map((f, i) => [f, i ? ABOUT_LINE : 'Free to use · beta']))), false],
    ['the old Settings line fails', () => auditStrings({ ...Object.fromEntries(ABOUT_AT.map((f) => [f, ABOUT_LINE])), 'src/x.tsx': 'Free to use · closed source · beta' }), false],
    ['a leftover "All rights reserved" fails', () => auditStrings({ ...Object.fromEntries(ABOUT_AT.map((f) => [f, ABOUT_LINE])), 'src/x.ts': '// Copyright. All rights reserved.' }), false],
    ['the dmg reader decodes Mac Roman (it would see the old agreement)', () => sameText(dmgAgreementText(fakeDmg(Buffer.from([0x42, 0xd1, 0x43]))), 'B—C', 'x'), true]
  ]
  let bad = 0
  for (const [name, run, shouldPass] of cases) {
    const problems = run()
    if ((problems.length === 0) !== shouldPass) {
      bad++
      console.error(`  ✗ self-test: ${name} — got ${problems.length ? problems.join('; ') : 'PASS'}`)
    }
  }
  if (bad) {
    console.error(`✗ check-license-metadata — self-test: ${bad} of ${cases.length} fixtures got the wrong verdict; refusing to check anything`)
    process.exit(3)
  }
  console.log(`✓ check-license-metadata — self-test: ${cases.length} fixtures, each with the right verdict`)
}

/** The repo's own sources: package.json, the lockfile's root entry, LICENSE, electron-builder.yml. */
function auditRepo() {
  const p = []
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
  p.push(...auditLicense(pkg.license, 'package.json'))
  const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'))
  p.push(...auditLicense(lock.packages?.['']?.license, 'package-lock.json (root package)'))
  p.push(...auditLicenseText(existsSync('LICENSE') ? readFileSync('LICENSE', 'utf8') : null, 'LICENSE'))
  if (!existsSync('THIRD_PARTY_NOTICES.txt')) p.push('THIRD_PARTY_NOTICES.txt: missing (npm run build && npm run notices)')
  const yml = readFileSync('electron-builder.yml', 'utf8')
  const m = yml.match(/^copyright:\s*(.+?)\s*$/m)
  const cfg = require('js-yaml').load(yml)
  p.push(...auditCopyright(m?.[1]?.replace(/^(['"])(.*)\1$/, '$2'), 'electron-builder.yml copyright'))
  p.push(...auditBuilderConfig(cfg))
  p.push(...auditOneText({
    license: existsSync('LICENSE') ? readFileSync('LICENSE', 'utf8') : null,
    secondCopy: existsSync('release-repo'),
    copyright: cfg?.copyright,
    author: typeof pkg.author === 'string' ? pkg.author : pkg.author?.name
  }))
  const strings = {}
  const walk = (d) => {
    for (const n of readdirSync(d)) {
      const f = join(d, n)
      if (statSync(f).isDirectory()) walk(f)
      else if (/\.(ts|tsx|mjs|cjs|js|md|html|css|json)$/.test(n) && !n.endsWith('-smoke.ts')) strings[f] = readFileSync(f, 'utf8')
    }
  }
  walk('src')
  p.push(...auditPublicLinks(readFileSync('src/shared/setup-links.ts', 'utf8'), existsSync))
  for (const f of ['README.md', 'electron-builder.yml', '.github/workflows/release.yml']) strings[f] = existsSync(f) ? readFileSync(f, 'utf8') : ''
  p.push(...auditStrings(strings))
  return p
}

function asarPackageJson(asarPath) {
  const asar = require('@electron/asar')
  return JSON.parse(asar.extractFile(asarPath, 'package.json').toString('utf8'))
}

/** NSHumanReadableCopyright out of an XML Info.plist (what electron-builder writes). */
function plistCopyright(xml) {
  const m = xml.match(/<key>NSHumanReadableCopyright<\/key>\s*<string>([^<]*)<\/string>/)
  return m ? m[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>') : undefined
}

/** Chromium's licenses: Electron's credits page (~20 MB, hundreds of components), with FFmpeg (LGPL, the
 *  one whose notice matters most) and Node.js among them. */
function auditChromium(html, where) {
  if (html == null) return [`${where}: missing`]
  const products = html.split('<div class="product">').length - 1
  const looksRight = products >= 100 && html.includes('<title>Credits</title>') && ['ffmpeg', 'Node.js'].every((t) => html.includes(`<span class="title">${t}</span>`))
  return looksRight ? [] : [`${where}: does not look like Electron's Chromium credits (${products} components)`]
}

/** What ships beside app.asar, read through `read(relativePath) → string | null`. */
function auditBundledFiles(read, label, chromiumAt) {
  return [
    ...Object.entries(BUNDLED).flatMap(([to, from]) => sameText(read(`resources/${to}`), readFileSync(from, 'utf8'), `${label} ${to}`)),
    ...auditChromium(read(chromiumAt), `${label} ${CHROMIUM}`)
  ]
}

const fileOrNull = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : null)
const LICENSE_ONLY = 'package.json license MIT'
const BUNDLE = 'LICENSE.txt and THIRD_PARTY_NOTICES.txt match the repo; Chromium licenses present'
const MAC_APP = `${LICENSE_ONLY}; About box is LICENSE's copyright line form, no "All rights reserved"; ${BUNDLE}`

function auditApp(appDir, label) {
  const asarPath = join(appDir, 'Contents/Resources/app.asar')
  if (!existsSync(asarPath)) return { problems: [`${label}: no Contents/Resources/app.asar`] }
  const plist = fileOrNull(join(appDir, 'Contents/Info.plist'))
  const read = (rel) => fileOrNull(join(appDir, 'Contents', rel.replace(/^resources\//, 'Resources/')))
  return {
    problems: [
      ...auditLicense(asarPackageJson(asarPath).license, `${label} app.asar package.json`),
      ...(plist == null ? [`${label}: no Contents/Info.plist`] : auditCopyright(plistCopyright(plist), `${label} About box (NSHumanReadableCopyright)`)),
      ...auditBundledFiles(read, label, `Resources/${CHROMIUM}`)
    ],
    checked: MAC_APP
  }
}

/** A Linux app directory: linux-unpacked, /opt/Beacon out of a .deb, or an AppImage's squashfs-root. */
function auditLinuxDir(dir, label) {
  const asarPath = join(dir, 'resources/app.asar')
  if (!existsSync(asarPath)) return [`${label}: no resources/app.asar`]
  return [
    ...auditLicense(asarPackageJson(asarPath).license, `${label} app.asar package.json`),
    ...auditBundledFiles((rel) => fileOrNull(join(dir, rel)), label, CHROMIUM)
  ]
}

function withTmp(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'beacon-license-'))
  try { return fn(dir) } finally { rmSync(dir, { recursive: true, force: true }) }
}

function auditTarget(target) {
  const t = resolve(target)
  if (!existsSync(t)) return { problems: [`${target}: no such file or directory`] }
  if (statSync(t).isDirectory()) {
    if (t.endsWith('.app')) return auditApp(t, target)
    if (existsSync(join(t, 'resources/app.asar'))) return { problems: auditLinuxDir(t, target), checked: `${LICENSE_ONLY}; ${BUNDLE}` }
    return { problems: [`${target}: neither a .app nor a dir with resources/app.asar`] }
  }
  if (t.endsWith('.asar')) return { problems: auditLicense(asarPackageJson(t).license, `${target} package.json`), checked: LICENSE_ONLY }
  if (t.endsWith('.dmg')) {
    return { problems: noAgreement(dmgAgreementText(t), `${target}`), checked: 'it carries no license agreement' }
  }
  if (t.endsWith('.zip')) {
    return withTmp((dir) => {
      const entry = (rel) => {
        try { return execFileSync('unzip', ['-p', t, `Beacon.app/Contents/${rel}`], { maxBuffer: 1 << 30 }) } catch { return null }
      }
      const asarPath = join(dir, 'app.asar')
      const asar = entry('Resources/app.asar')
      if (asar == null) return { problems: [`${target}: no Beacon.app/Contents/Resources/app.asar inside`] }
      writeFileSync(asarPath, asar)
      const plist = entry('Info.plist')?.toString('utf8')
      const read = (rel) => entry(rel.replace(/^resources\//, 'Resources/'))?.toString('utf8') ?? null
      return {
        problems: [
          ...auditLicense(asarPackageJson(asarPath).license, `${target}!app.asar package.json`),
          ...(plist == null ? [`${target}: no Info.plist inside`] : auditCopyright(plistCopyright(plist), `${target}!About box (NSHumanReadableCopyright)`)),
          ...auditBundledFiles(read, `${target}!`, `Resources/${CHROMIUM}`)
        ],
        checked: MAC_APP
      }
    })
  }
  if (t.endsWith('.deb')) {
    if (process.platform !== 'linux') return { problems: [`${target}: a .deb is read with dpkg-deb, which needs Linux`] }
    const license = execFileSync('dpkg-deb', ['-f', t, 'License'], { encoding: 'utf8' }).trim()
    return withTmp((dir) => {
      execFileSync('dpkg-deb', ['-x', t, dir])
      return {
        problems: [...auditLicense(license, `${target} control License`), ...auditLinuxDir(join(dir, 'opt/Beacon'), `${target}!/opt/Beacon`)],
        checked: `control License MIT; ${LICENSE_ONLY}; ${BUNDLE}`
      }
    })
  }
  if (t.endsWith('.AppImage')) {
    if (process.platform !== 'linux') return { problems: [`${target}: an AppImage extracts itself, which needs Linux`] }
    return withTmp((dir) => {
      execFileSync(t, ['--appimage-extract'], { cwd: dir, stdio: 'ignore' })
      const root = join(dir, 'squashfs-root')
      const appRun = fileOrNull(join(root, 'AppRun')) ?? ''
      const asks = /zenity --text-info|eulaAccepted/.test(appRun) ? [`${target}: AppRun asks for an agreement on first run; MIT asks for none`] : []
      return {
        problems: [...asks, ...auditLinuxDir(root, `${target}!`)],
        checked: `asks for no agreement on first run; ${LICENSE_ONLY}; ${BUNDLE}`
      }
    })
  }
  return { problems: [`${target}: do not know how to read its license metadata`] }
}

const args = process.argv.slice(2)
selfTest()
if (args.length === 1 && args[0] === '--self-test') process.exit(0)
const targets = args.filter((a) => a !== '--self-test')
const auditOrSay = (t) => {
  try { return auditTarget(t) } catch (e) { return { problems: [`${t}: could not be read (${e.message.split('\n')[0]})`] } }
}
const results = targets.length
  ? targets.map((t) => [t, auditOrSay(t)])
  : [['the repo (package.json, package-lock.json, LICENSE, electron-builder.yml, the files the app links)', { problems: auditRepo(), checked: `license MIT in both; LICENSE is the MIT License word for word, it is the only copy, the About box and author name its holder, and every file the app links on the public repo is here; the license, notices and Chromium licenses are wired, and no agreement is; the About line is in the app and the README, and nothing still says the freeware terms` }]]
let failed = 0
for (const [what, { problems, checked }] of results) {
  if (problems.length) {
    failed++
    console.error(`✗ ${what}\n    ${problems.join('\n    ')}`)
  } else {
    console.log(`✓ ${what} — ${checked}`)
  }
}
process.exit(failed ? 1 : 0)
