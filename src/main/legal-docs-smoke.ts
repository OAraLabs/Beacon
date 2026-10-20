/**
 * Headless smoke for Settings → About (@shared/legal-docs): where Beacon's license, the third-party
 * notices and Chromium's licenses are, packaged and unpackaged, on macOS and Linux.
 *
 * Proves that the channel opens only the three documents (a path, a near-miss name or a non-string is
 * refused before any path exists); that each packaged path is a file electron-builder.yml actually ships
 * under that name (read from the config, so renaming one side fails here); that in this checkout each
 * unpackaged path exists, reached the way main reaches it (import.meta.mainOutDir, two levels up); and
 * that main wires the channel through handleFromShell and refuses before it opens anything.
 *
 * WHAT THIS CANNOT PROVE: that shell.openPath shows the file. That needs a window and the OS's viewer;
 * the PR says how it was checked in the built app.
 *
 *   npm run build && npm run smoke:legal-docs
 */
import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { isLegalDoc, LEGAL_DOCS, legalDocPath, type LegalDoc } from '@shared/legal-docs'

let failures = 0
let checks = 0
function assert(cond: boolean, what: string, detail = ''): void {
  checks++
  console.log(`[smoke] ${cond ? 'PASS' : 'FAIL'}  ${what}${detail && !cond ? `\n        ${detail}` : ''}`)
  if (!cond) failures++
}
// The verdict is decided on exit, so a section that throws or returns early cannot pass by running fewer checks.
const MIN_CHECKS = 20
process.on('exit', (code) => {
  if (code === 0 && (failures > 0 || checks < MIN_CHECKS)) process.exitCode = 1
  console.log(`\n[smoke] outcome: ${failures === 0 && checks >= MIN_CHECKS ? 'PASS ✓' : `FAIL ✗ (${failures} failed, ${checks} of at least ${MIN_CHECKS} checks ran)`}`)
})

console.log('\n[smoke] === 1. only the three documents ===')
assert(LEGAL_DOCS.length === 3 && LEGAL_DOCS.every(isLegalDoc), 'license, notices and chromium are documents')
for (const bad of ['../LICENSE', '/etc/passwd', 'LICENSE', 'license ', 'License', '', 'notices/../../x', null, undefined, 1, {}, ['license']]) {
  assert(!isLegalDoc(bad), `refused: ${JSON.stringify(bad) ?? String(bad)}`)
}

console.log('\n[smoke] === 2. packaged: the files electron-builder.yml ships ===')
const macRes = '/Applications/Beacon.app/Contents/Resources'
const linuxRes = '/opt/Beacon/resources'
const mac = (doc: LegalDoc): string => legalDocPath(doc, { packaged: true, platform: 'darwin', resourcesPath: macRes, repoRoot: '/nowhere' })
const linux = (doc: LegalDoc): string => legalDocPath(doc, { packaged: true, platform: 'linux', resourcesPath: linuxRes, repoRoot: '/nowhere' })
assert(mac('license') === `${macRes}/LICENSE.txt`, 'macOS license: Resources/LICENSE.txt', mac('license'))
assert(mac('notices') === `${macRes}/THIRD_PARTY_NOTICES.txt`, 'macOS notices: Resources/THIRD_PARTY_NOTICES.txt', mac('notices'))
assert(mac('chromium') === `${macRes}/LICENSES.chromium.html`, 'macOS Chromium licenses: Resources/LICENSES.chromium.html', mac('chromium'))
assert(linux('license') === `${linuxRes}/LICENSE.txt`, 'Linux license: resources/LICENSE.txt', linux('license'))
assert(linux('notices') === `${linuxRes}/THIRD_PARTY_NOTICES.txt`, 'Linux notices: resources/THIRD_PARTY_NOTICES.txt', linux('notices'))
assert(linux('chromium') === '/opt/Beacon/LICENSES.chromium.html', "Linux Chromium licenses: electron-builder's copy at the app root, beside resources/", linux('chromium'))
assert(legalDocPath('license', { packaged: true, platform: 'linux', resourcesPath: `${linuxRes}/`, repoRoot: '' }) === `${linuxRes}/LICENSE.txt`, 'a trailing slash on resourcesPath changes nothing')

const outMain: unknown = import.meta.mainOutDir
const repoRoot = typeof outMain === 'string' && isAbsolute(outMain) ? resolve(outMain, '../..') : null
assert(repoRoot !== null, 'import.meta.mainOutDir is an absolute out/main, as main reads it', String(outMain))
if (repoRoot) {
  const yml = readFileSync(resolve(repoRoot, 'electron-builder.yml'), 'utf8')
  const shipsAs = (from: string, to: string): boolean => new RegExp(`- from: ${from.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}\\s*\\n\\s*to: ${to.replace(/\./g, '\\.')}\\s*$`, 'm').test(yml)
  assert(shipsAs('LICENSE', 'LICENSE.txt'), 'electron-builder.yml ships LICENSE as LICENSE.txt, the name the license path ends in')
  assert(shipsAs('THIRD_PARTY_NOTICES.txt', 'THIRD_PARTY_NOTICES.txt'), 'electron-builder.yml ships THIRD_PARTY_NOTICES.txt under that name')
  const hook = readFileSync(resolve(repoRoot, 'scripts/after-extract.cjs'), 'utf8')
  assert(/^afterExtract: scripts\/after-extract\.cjs\s*$/m.test(yml) && hook.includes("join(resources, 'LICENSES.chromium.html')") && hook.includes("'Contents', 'Resources'"), "electron-builder.yml's afterExtract hook puts LICENSES.chromium.html in the macOS app's Resources")

  console.log('\n[smoke] === 3. unpackaged: this checkout\'s own files ===')
  for (const doc of LEGAL_DOCS) {
    const p = legalDocPath(doc, { packaged: false, platform: process.platform, resourcesPath: '/nowhere', repoRoot })
    assert(p.startsWith(repoRoot) && existsSync(p), `${doc}: ${p.slice(repoRoot.length + 1)} exists`, p)
  }

  console.log('\n[smoke] === 4. main wires it, and refuses before it opens ===')
  const mainSrc = readFileSync(resolve(repoRoot, 'src/main/index.ts'), 'utf8')
  const at = mainSrc.indexOf('handleFromShell(IPC.LEGAL_DOC_OPEN')
  const handler = mainSrc.slice(at, at + 1200)
  assert(at >= 0, 'main registers LEGAL_DOC_OPEN through handleFromShell (the shell-page sender check)')
  assert(handler.indexOf('isLegalDoc(doc)') >= 0 && handler.indexOf('isLegalDoc(doc)') < handler.indexOf('shell.openPath('), 'it refuses anything but a document name before it opens anything')
  assert(handler.includes('legalDocPath(doc') && !/shell\.openPath\(\s*doc/.test(handler), 'it opens the path legalDocPath picks, never what the renderer sent')
  assert(handler.indexOf('existsSync(path)') >= 0 && handler.indexOf('existsSync(path)') < handler.indexOf('shell.openPath('), 'a missing file is reported, not handed to the OS')
}
