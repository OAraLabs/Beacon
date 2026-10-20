#!/usr/bin/env node
// Sign the packaged Mac app by certificate FINGERPRINT (SHA-1), the way electron-builder would sign it
// by name, and prove the result before anyone installs it. macOS only.
//
// WHY THIS EXISTS. Since 2026-10-06 the build keychain holds two "Developer ID Application: …" identities
// with the same name. codesign refuses a name that matches two (`ambiguous`), so `npm run pack:mac`
// exits 1 and leaves an UNSIGNED bundle behind. Passing the hash as CSC_NAME does not help: electron-
// builder 26 resolves it and then hands osx-sign the identity's NAME. @electron/osx-sign itself signs by
// hash, so this calls it directly with the options electron-builder would use.
//
//   npm run pack:mac:fingerprint                       (BEACON_SIGN_FINGERPRINT=<40 hex> in the env)
//   node scripts/sign-by-fingerprint.mjs <sha1> [--app <path>] [--compare <signed app>] [--verify-only] [--notarized]
//   node scripts/sign-by-fingerprint.mjs <sha1> --verify-only --dmg <image> [--notarized]
//   node scripts/sign-by-fingerprint.mjs --self-test
//
// WHAT IT GUARANTEES, each because the failure is quiet otherwise:
//   * the signer and the YAML reader are electron-builder's own copies (resolved through its package),
//     so this signs with the osx-sign version the normal build uses, not a second one;
//   * the options come from electron-builder.yml, and a signing option this script does not mirror makes
//     it REFUSE rather than sign differently from a normal build;
//   * only a Developer ID Application identity is used: anything else (Apple Development, Apple
//     Distribution, a Developer ID Installer) is refused BEFORE any codesign call, and refused again at
//     verify time from the leaf certificate itself — those sign and verify fine, then Gatekeeper rejects;
//   * after signing it verifies, with no flags needed: `codesign --verify --deep --strict`; every Mach-O
//     found BY CONTENT (so Squirrel's ShipIt, the updater's installer, is included) plus every bundle, signed
//     by the fingerprint's leaf, team set and equal to the certificate's, hardened runtime, secure
//     timestamp; and every item's entitlements equal to what electron-builder.yml gives it (the app
//     mac.entitlements, other executables mac.entitlementsInherit, libraries none), compared as data.
//     A non-Mach-O file (better-sqlite3's prebuilds for other platforms) needs no signature of its own:
//     the bundle's seal covers it, and the update zip drops the xattrs that carry one;
//   * with --compare it also checks each item against another signed build;
//   * with --notarized: the app is stapled, Gatekeeper accepts it as "Notarized Developer ID", and Apple's
//     `syspolicy_check distribution` passes; the ticket lists the CDHash of every nested item, ShipIt included.
//     NOT `spctl -t exec` per executable: it rejects ShipIt and crashpad even when they ARE notarized ("does
//     not seem to be an app"), and `codesign --check-notarization` passes unnotarized code;
//   * with --dmg <image> (verify only): the disk image is itself signed by the same Developer ID leaf with a
//     secure timestamp, and with --notarized stapled and accepted by Gatekeeper; then it is mounted
//     read-only, its root must hold exactly one .app (a real directory, not a symlink, with the config's
//     appId) and nothing else visible but the Applications link, and that app is verified in full, as above
//     (--compare applies to it too);
//   * the command line is strict: an unknown flag, a --flag=value form, an empty or missing value, a
//     repeated flag or a second fingerprint exits 2 rather than being ignored.
//
// NOT DONE HERE: notarization. On the pack:mac:fingerprint path electron-builder's afterSign hook
// (scripts/notarize.cjs) still runs, on the UNSIGNED bundle, and does nothing only because the npm script
// blanks APPLE_KEYCHAIN_PROFILE and APPLE_ID for that step. Notarize the signed bundle separately
// (scripts/notarize-once.sh), then re-run with --verify-only --notarized.
import { execFileSync, spawnSync } from 'node:child_process'
import { closeSync, existsSync, lstatSync, mkdtempSync, openSync, readFileSync, readSync, readdirSync, readlinkSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// electron-builder's own copies, resolved through its package: the same osx-sign the normal build signs with.
function builderDeps() {
  const eb = createRequire(createRequire(join(REPO, 'package.json')).resolve('electron-builder/package.json'))
  const abl = createRequire(eb.resolve('app-builder-lib/package.json'))
  return { osxSign: abl('@electron/osx-sign'), yaml: abl('js-yaml'), oxsVersion: abl('@electron/osx-sign/package.json').version }
}

// mac.* keys that change how electron-builder signs. Those this script mirrors are read below; the rest
// make it refuse, because signing without them would not be what a normal build produces.
const MIRRORED = ['entitlements', 'entitlementsInherit', 'hardenedRuntime']
const UNMIRRORED = [
  'identity', 'binaries', 'signIgnore', 'requirements', 'timestamp', 'provisioningProfile', 'additionalArguments',
  'entitlementsLoginHelper', 'strictVerify', 'preAutoEntitlements', 'type', 'sign', 'signingHashAlgorithms', 'forceCodeSigning'
]

/** Signing options from a parsed electron-builder config, or throw saying why it cannot mirror them. */
export function signOptionsFromConfig(config) {
  const mac = config?.mac
  if (!mac || typeof mac !== 'object') throw new Error('electron-builder.yml has no mac section')
  const unmirrored = UNMIRRORED.filter((k) => k in mac)
  if (unmirrored.length) throw new Error(`electron-builder.yml sets mac.${unmirrored.join(', mac.')}, which this script does not mirror — update it before signing by fingerprint`)
  if (typeof mac.entitlements !== 'string' || !mac.entitlements) throw new Error('mac.entitlements is not set; electron-builder would fall back to its template, which this script does not mirror')
  if (mac.entitlementsInherit != null && typeof mac.entitlementsInherit !== 'string') throw new Error('mac.entitlementsInherit is not a path')
  if (mac.hardenedRuntime != null && typeof mac.hardenedRuntime !== 'boolean') throw new Error('mac.hardenedRuntime is not a boolean')
  return {
    entitlements: mac.entitlements,
    // electron-builder: entitlementsInherit, else build/entitlements.mac.inherit.plist, else its template.
    // Only the explicit form is mirrored; without it, refuse rather than guess the fallback.
    entitlementsInherit: mac.entitlementsInherit ?? null,
    hardenedRuntime: mac.hardenedRuntime !== false
  }
}

export function isFingerprint(s) {
  return typeof s === 'string' && /^[0-9A-Fa-f]{40}$/.test(s)
}

const DEVID_APP = 'Developer ID Application: '
const DEVID_CA = 'Developer ID Certification Authority'

/** Is this leaf a Developer ID Application certificate for the team its name claims? Anything else —
 *  Apple Development, Apple Distribution, Mac Developer, a Developer ID Installer, no leaf (ad-hoc) — is
 *  refused: those sign fine and even pass `codesign --verify`, but Gatekeeper and notarization reject them. */
export function classifyLeaf(leaf) {
  if (!leaf || !leaf.subjectCN) return { ok: false, why: 'no signing certificate (ad-hoc or unsigned)' }
  if (!leaf.subjectCN.startsWith(DEVID_APP)) return { ok: false, why: `signed by "${leaf.subjectCN}", not a ${DEVID_APP.trim()} certificate` }
  if (leaf.issuerCN !== DEVID_CA) return { ok: false, why: `issued by "${leaf.issuerCN}", not the ${DEVID_CA}` }
  const team = /\(([A-Z0-9]{10})\)$/.exec(leaf.subjectCN)?.[1] ?? null
  if (!team || team !== leaf.subjectOU) return { ok: false, why: `the team in the name (${team}) and the certificate's OU (${leaf.subjectOU}) disagree` }
  return { ok: true, why: '', team }
}

const MH_KIND = { 2: 'executable', 6: 'library', 8: 'bundle' }
/** 'executable' | 'library' | 'bundle' | 'other' for a Mach-O header (thin, or a universal binary's first
 *  slice when the buffer reaches it), else null. By content: ShipIt and other helpers have no telling name. */
export function machOKind(bytes) {
  if (!bytes || bytes.length < 16) return null
  const le = bytes.readUInt32LE(0), be = bytes.readUInt32BE(0)
  if (le === 0xfeedfacf || le === 0xfeedface) return MH_KIND[bytes.readUInt32LE(12)] ?? 'other'
  if (be === 0xfeedfacf || be === 0xfeedface) return MH_KIND[bytes.readUInt32BE(12)] ?? 'other'
  if (be === 0xcafebabe || be === 0xcafebabf) {
    const n = bytes.readUInt32BE(4)
    if (n < 1 || n > 20) return null // 0xcafebabe is also a Java class file's magic; those have a large "count"
    const off = be === 0xcafebabe ? bytes.readUInt32BE(16) : Number(bytes.readBigUInt64BE(16))
    return off > 0 && off + 16 <= bytes.length ? machOKind(bytes.subarray(off)) : null
  }
  return null
}

/** machOKind for a file, reading only the headers it needs (Electron Framework is >100 MB). */
function machOKindOfFile(path) {
  const fd = openSync(path, 'r')
  try {
    const head = Buffer.alloc(32)
    if (readSync(fd, head, 0, 32, 0) < 16) return null
    const be = head.readUInt32BE(0)
    if (be === 0xcafebabe || be === 0xcafebabf) {
      const n = head.readUInt32BE(4)
      if (n < 1 || n > 20) return null
      const off = be === 0xcafebabe ? head.readUInt32BE(16) : Number(head.readBigUInt64BE(16))
      const slice = Buffer.alloc(32)
      if (readSync(fd, slice, 0, 32, off) < 16) return null
      return machOKind(slice)
    }
    return machOKind(head)
  } finally {
    closeSync(fd)
  }
}

/** Must this item carry a signature of its own? Every Mach-O and every bundle: yes. Any other file
 *  (better-sqlite3's linux/win32 .node prebuilds): no. osx-sign gives those an xattr signature, the update
 *  zip drops it, and the app's resource seal covers them either way (`codesign --verify --deep --strict`). */
export function requiresOwnSignature(kind) {
  return kind !== 'non-macho'
}

/** The keychain identity for a fingerprint, from `security find-identity -v -p codesigning` output:
 *  { found, name, ok, why }. ok only for a Developer ID Application identity. */
export function identityFromKeychain(listing, fingerprint) {
  const fp = String(fingerprint ?? '').toUpperCase()
  if (!isFingerprint(fp)) return { found: false, name: null, ok: false, why: 'not a 40-hex fingerprint' }
  const line = String(listing ?? '').split('\n').find((l) => new RegExp(`\\b${fp}\\b`).test(l.toUpperCase()))
  if (!line) return { found: false, name: null, ok: false, why: `no valid codesigning identity with fingerprint ${fp}` }
  const name = /"(.*)"/.exec(line)?.[1] ?? ''
  if (!name.startsWith(DEVID_APP)) return { found: true, name, ok: false, why: `"${name}" is not a ${DEVID_APP.trim()} identity; only Developer ID builds can be notarized and run on other Macs` }
  return { found: true, name, ok: true, why: '' }
}

/** Deep, key-order-independent equality of two entitlement sets. null (unreadable) never matches. */
export function entitlementsMatch(actual, expected) {
  if (actual == null || expected == null) return false
  const canon = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}` : Array.isArray(v) ? `[${v.map(canon).join(',')}]` : JSON.stringify(v))
  return canon(actual) === canon(expected)
}

const run = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
// stdout AND stderr, success or not: codesign -d writes its report to STDERR, so reading stdout alone
// sees an empty report for a perfectly signed file.
const runAll = (cmd, args, input) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', input })
  return { ok: r.status === 0, stdout: r.stdout ?? '', out: `${r.stdout ?? ''}${r.stderr ?? ''}` }
}
const plistToJson = (input) => JSON.parse(execFileSync('plutil', ['-convert', 'json', '-o', '-', '-'], { input, stdio: ['pipe', 'pipe', 'pipe'] }).toString())

/** Every nested thing to check, with what it is: the app, helper apps and frameworks (bundles), and every
 *  Mach-O file found BY CONTENT (executables like ShipIt, dylibs, .node addons), plus .node/.dylib files by
 *  name (non-Mach-O prebuilds that osx-sign still signs). */
function signedItems(app) {
  const out = new Map([['/', 'app']])
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      const st = lstatSync(p)
      if (st.isSymbolicLink()) continue
      const rel = p.slice(app.length)
      if (st.isDirectory()) {
        if (name.endsWith('.app')) out.set(rel, 'app')
        else if (name.endsWith('.framework')) out.set(rel, 'framework')
        walk(p)
      } else if (st.isFile()) {
        const kind = machOKindOfFile(p)
        if (kind) out.set(rel, kind)
        else if (/\.(dylib|node)$/.test(name)) out.set(rel, 'non-macho')
      }
    }
  }
  walk(app)
  return new Map([...out.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
}

/** Parse an RFC 2253 DN into { CN, OU, … } (first value of each). */
function parseDn(dn) {
  const out = {}
  for (const part of dn.split(/(?<!\\),/)) {
    const m = /^\s*([A-Za-z]+)=(.*)$/.exec(part)
    if (m && !(m[1] in out)) out[m[1]] = m[2].replace(/\\(.)/g, '$1')
  }
  return out
}

/** The leaf certificate of a signed path: SHA-1, subject CN/OU, issuer CN. null when there is none. */
function leafOf(path) {
  const dir = mkdtempSync(join(tmpdir(), 'beacon-sigleaf-'))
  try {
    spawnSync('codesign', ['-d', '--extract-certificates', path], { cwd: dir })
    if (!existsSync(join(dir, 'codesign0'))) return null
    const t = run('openssl', ['x509', '-inform', 'der', '-in', join(dir, 'codesign0'), '-noout', '-fingerprint', '-sha1', '-subject', '-issuer', '-nameopt', 'RFC2253'])
    const sha1 = /Fingerprint=([0-9A-F:]+)/i.exec(t)?.[1].replace(/:/g, '').toUpperCase() ?? null
    const subject = parseDn(/^subject=(.*)$/m.exec(t)?.[1] ?? '')
    const issuer = parseDn(/^issuer=(.*)$/m.exec(t)?.[1] ?? '')
    return { sha1, subjectCN: subject.CN ?? null, subjectOU: subject.OU ?? null, issuerCN: issuer.CN ?? null }
  } catch {
    return null
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** The entitlements a path is signed with, as data: {} when it carries none, null when unreadable. */
function entitlementsOf(path) {
  const r = spawnSync('codesign', ['-d', '--entitlements', '-', '--xml', path])
  if (r.status !== 0) return null
  if (!r.stdout || r.stdout.length === 0) return {}
  try {
    return plistToJson(r.stdout)
  } catch {
    return null
  }
}

/** What codesign reports about one path, reduced to the parts a second signature must match. */
function profile(path) {
  const d = runAll('codesign', ['-dvvv', path])
  if (!d.ok || /not signed at all/.test(d.out)) return { signed: false }
  const team = /^TeamIdentifier=(.*)$/m.exec(d.out)?.[1] ?? null
  const flags = /flags=(0x[0-9a-f]+)\(([^)]*)\)/.exec(d.out)
  const req = runAll('codesign', ['-d', '-r-', path])
  return {
    signed: true,
    team: team === 'not set' ? null : team,
    flags: flags ? flags[2] : '',
    timestamp: /^Timestamp=/m.test(d.out),
    leaf: leafOf(path),
    ent: entitlementsOf(path),
    dr: (/designated => (.*)/.exec(req.out) ?? [])[1] ?? ''
  }
}

/** The entitlements electron-builder would give an item, from the config: the app gets mac.entitlements,
 *  every other executable (helper apps, ShipIt, crashpad, spawn-helper) mac.entitlementsInherit, a
 *  Library/LoginItems helper mac.entitlementsLoginHelper (refused by the config guard, so none), and
 *  libraries, .node addons and frameworks none. */
function expectedEntitlements(rel, kind, expected) {
  if (rel === '/' || rel === `${sep}Contents${sep}MacOS${sep}Beacon`) return expected.app
  if (rel.includes('Library/LoginItems')) return {}
  if (kind === 'app' || kind === 'executable') return expected.inherit
  return {}
}

/** Is `path` (an .app or a .dmg) notarized, the way Gatekeeper decides on another Mac? A stapled ticket
 *  (`stapler validate`), Gatekeeper's verdict on the item itself, and — for an app — Apple's own
 *  pre-distribution check, `syspolicy_check distribution`, which covers the nested code the ticket lists
 *  (ShipIt included). NOT `spctl -t exec` per nested executable: for a standalone tool such as ShipIt it
 *  answers "the code is valid but does not seem to be an app" even in a correctly notarized build. */
/** Gatekeeper's verdict from `spctl --assess` (exit status, output): accepted AS NOTARIZED, nothing less. */
export function gatekeeperAccepts(ok, out) {
  return ok && /source=Notarized Developer ID/.test(out)
}

function notarizationProblems(path, label, spctlType) {
  const problems = []
  const st = runAll('xcrun', ['stapler', 'validate', path])
  if (!st.ok) problems.push(`${label}: not stapled (${st.out.trim().split('\n').pop()})`)
  const g = runAll('spctl', spctlType === 'open' ? ['--assess', '--type', 'open', '--context', 'context:primary-signature', '-vv', path] : ['--assess', '--type', 'exec', '-vv', path])
  if (!gatekeeperAccepts(g.ok, g.out)) problems.push(`${label}: Gatekeeper does not accept it as notarized (${(/source=([^\n]*)/.exec(g.out) ?? [])[1] ?? g.out.trim().split('\n').pop()})`)
  if (spctlType === 'exec') {
    const sp = runAll('syspolicy_check', ['distribution', path])
    if (/command not found|No such file/i.test(sp.out) || sp.out === '') problems.push(`${label}: syspolicy_check is unavailable (macOS 14 or later is needed to check notarization)`)
    else if (!sp.ok) {
      const issues = [...sp.out.matchAll(/^-{5,}\n([^\n]+)/gm)].map((m) => m[1].trim()).filter(Boolean)
      problems.push(`${label}: syspolicy_check distribution failed (${issues.join('; ') || sp.out.trim().split('\n')[0]})`)
    }
  }
  return problems
}

/** Verify a release .dmg: the dmg itself signed by the fingerprint's Developer ID Application leaf and
 *  timestamped (and with `notarized`, stapled and accepted by Gatekeeper as notarized); then mount it
 *  read-only and require exactly one .app at its root — a real directory inside the image, whose bundle id
 *  is the config's appId, with nothing else visible beside it but the Applications link — and verify that
 *  app exactly as `verifyApp` does (with `compare` and `notarized`). Detaches the image whatever happens. */
export function verifyDmg(dmg, fingerprint, opts, { notarized = false, expected, compare = null, appId } = {}) {
  const problems = []
  const label = `the dmg (${dmg.split(sep).pop()})`
  const d = runAll('codesign', ['-dvvv', dmg])
  // Names the cause; an unsigned dmg would also fail the strict verify, the pin and the timestamp below.
  if (!d.ok || /not signed at all/.test(d.out)) problems.push(`${label}: not signed`)
  else {
    const v = runAll('codesign', ['--verify', '--strict', dmg])
    if (!v.ok) problems.push(`${label}: codesign --verify --strict failed: ${v.out.trim().split('\n').pop()}`)
    const leaf = leafOf(dmg)
    if (leaf?.sha1 !== fingerprint.toUpperCase()) problems.push(`${label}: signed by leaf ${leaf?.sha1 ?? '?'}, not ${fingerprint.toUpperCase()}`)
    // Sharpens the message only: with one pin, a dmg whose leaf is not a Developer ID Application
    // certificate needs a pin that is not one either, and every item of the app inside then fails its own
    // classifyLeaf. The verdict does not rest on this line.
    const lc = classifyLeaf(leaf)
    if (!lc.ok) problems.push(`${label}: ${lc.why}`)
    if (!/^Timestamp=/m.test(d.out)) problems.push(`${label}: no secure timestamp`)
  }
  if (notarized) problems.push(...notarizationProblems(dmg, label, 'open'))
  const mnt = mkdtempSync(join(tmpdir(), 'beacon-dmg-'))
  let attached = false
  try {
    // Release dmgs up to 0.4.8 carry a license agreement: hdiutil prints it and asks on stdin, and with no
    // answer fails "attach canceled". Y agrees, for this read-only mount only; a dmg with none ignores it.
    const at = runAll('hdiutil', ['attach', '-readonly', '-nobrowse', '-noautoopen', '-mountpoint', mnt, dmg], 'Y\n')
    if (!at.ok) {
      const busy = /Resource busy/.test(at.out) ? '; it is probably attached already: `hdiutil info` lists it, detach it and re-run' : ''
      problems.push(`${label}: could not be mounted read-only (${at.out.trim().split('\n').pop()})${busy}`)
      return { items: 0, problems }
    }
    attached = true
    const root = readdirSync(mnt)
    const apps = root.filter((n) => /\.app$/i.test(n))
    if (apps.length !== 1) { problems.push(`${label}: expected exactly one .app at its root, found ${apps.length}`); return { items: 0, problems } }
    const app = join(mnt, apps[0])
    // A symlink would make everything below verify whatever it points at on THIS machine, not the image.
    const st = lstatSync(app)
    if (st.isSymbolicLink()) { problems.push(`${label}: ${apps[0]} at its root is a symlink (to ${readlinkSync(app)}), not an app inside the image`); return { items: 0, problems } }
    if (!st.isDirectory()) { problems.push(`${label}: ${apps[0]} at its root is not a directory`); return { items: 0, problems } }
    // (A real directory whose Contents is a symlink out of the image fails strict verify, "unsealed contents
    // present in the bundle root", and the item walk does not follow links: measured, so no guard here.)
    for (const n of root) {
      if (n === apps[0] || n.startsWith('.')) continue // electron-builder's background, volume icon, .DS_Store
      const p = join(mnt, n)
      if (n === 'Applications' && lstatSync(p).isSymbolicLink() && readlinkSync(p) === '/Applications') continue
      problems.push(`${label}: unexpected item at its root: ${n}`)
    }
    let info = null
    try { info = plistToJson(readFileSync(join(app, 'Contents/Info.plist'))) } catch { /* reported below */ }
    const id = info?.CFBundleIdentifier
    if (!appId || id !== appId) problems.push(`${label}: ${apps[0]} is ${id ?? 'without a readable bundle id'}, not electron-builder.yml's appId ${appId ?? '(none set)'}`)
    const inner = verifyApp(app, fingerprint, opts, { compare, notarized, expected })
    return { items: inner.items, problems: [...problems, ...inner.problems.map((p) => `${apps[0]} in the dmg: ${p}`)], shipitChecked: inner.shipitChecked, inside: `${apps[0]}, ${id} ${info?.CFBundleShortVersionString ?? '(no version)'}` }
  } finally {
    if (attached) {
      const det = runAll('hdiutil', ['detach', mnt])
      if (!det.ok) runAll('hdiutil', ['detach', mnt, '-force'])
    }
    rmSync(mnt, { recursive: true, force: true })
  }
}

/** Verify a signed app against a fingerprint and the config's entitlements. With `compare`, also item by
 *  item against another signed build; with `notarized`, also that it is stapled, Gatekeeper accepts the app
 *  as notarized, and `syspolicy_check distribution` passes (which covers the nested code, ShipIt included). */
export function verifyApp(app, fingerprint, opts, { compare = null, notarized = false, expected } = {}) {
  const problems = []
  const strict = runAll('codesign', ['--verify', '--deep', '--strict', app])
  if (!strict.ok) problems.push(`codesign --verify --deep --strict failed: ${strict.out.trim().split('\n').pop()}`)
  const items = signedItems(app)
  if (items.size <= 1) problems.push('found no signable items in the bundle')
  const want = fingerprint.toUpperCase()
  const mine = {}
  for (const [it, kind] of items) {
    if (!requiresOwnSignature(kind)) continue // sealed by the bundle; checked by the strict verify above
    const p = profile(it === '/' ? app : join(app, it))
    mine[it] = p
    if (!p.signed) { problems.push(`${it}: not signed`); continue }
    if (p.leaf?.sha1 !== want) problems.push(`${it}: signed by leaf ${p.leaf?.sha1 ?? '?'}, not ${want}`)
    const lc = classifyLeaf(p.leaf)
    if (!lc.ok) problems.push(`${it}: ${lc.why}`)
    if (!p.team) problems.push(`${it}: TeamIdentifier not set`)
    else if (lc.ok && p.team !== lc.team) problems.push(`${it}: TeamIdentifier ${p.team} is not the certificate's team ${lc.team}`)
    if (opts.hardenedRuntime && !/runtime/.test(p.flags)) problems.push(`${it}: no hardened runtime (flags ${p.flags || 'none'})`)
    if (!p.timestamp) problems.push(`${it}: no secure timestamp`)
    if (expected) {
      const exp = expectedEntitlements(it, kind, expected)
      if (p.ent === null) problems.push(`${it}: entitlements could not be read`)
      else if (!entitlementsMatch(p.ent, exp)) problems.push(`${it}: entitlements differ from electron-builder.yml (${Object.keys(p.ent).sort().join(', ') || 'none'} vs ${Object.keys(exp).sort().join(', ') || 'none'})`)
    }
  }
  // ShipIt is the updater's installer: it swaps the app on update. It must be among what was checked.
  const shipit = [...items.keys()].find((k) => k.endsWith(`${sep}Squirrel.framework${sep}Versions${sep}A${sep}Resources${sep}ShipIt`))
  if (existsSync(join(app, 'Contents/Frameworks/Squirrel.framework')) && !shipit) problems.push('Squirrel.framework is present but its ShipIt executable was not found to check')
  if (notarized) problems.push(...notarizationProblems(app, 'the app', 'exec'))
  if (compare) {
    const theirs = signedItems(compare)
    for (const it of items.keys()) if (!theirs.has(it)) problems.push(`${it}: present here, not in ${compare}`)
    for (const it of theirs.keys()) if (!items.has(it)) problems.push(`${it}: present in ${compare}, not here`)
    for (const it of [...items.keys()].filter((x) => theirs.has(x) && requiresOwnSignature(items.get(x)))) {
      const t = profile(it === '/' ? compare : join(compare, it))
      const m = mine[it]
      if (!m.signed || !t.signed) { if (m.signed !== t.signed) problems.push(`${it}: signed here ${m.signed}, in ${compare} ${t.signed}`); continue }
      for (const k of ['team', 'flags', 'dr', 'timestamp']) if (m[k] !== t[k]) problems.push(`${it}: ${k} differs from ${compare} (${m[k]} vs ${t[k]})`)
      if (m.ent === null || t.ent === null) problems.push(`${it}: entitlements unreadable here or in ${compare}`)
      else if (!entitlementsMatch(m.ent, t.ent)) problems.push(`${it}: entitlements differ from ${compare}`)
    }
  }
  return { items: items.size, problems, shipitChecked: Boolean(shipit) }
}

function selfTest() {
  let fails = 0
  const ok = (cond, what) => { console.log(`[self-test] ${cond ? 'PASS' : 'FAIL'}  ${what}`); if (!cond) fails++ }
  const throws = (fn, re) => { try { fn(); return false } catch (e) { return re.test(e.message) } }
  const { yaml } = builderDeps()
  const real = yaml.load(readFileSync(join(REPO, 'electron-builder.yml'), 'utf8'))
  const o = signOptionsFromConfig(real)
  ok(o.entitlements === 'build/entitlements.mac.plist' && o.entitlementsInherit === 'build/entitlements.mac.plist' && o.hardenedRuntime === true, `the repo's config mirrors (${JSON.stringify(o)})`)
  for (const k of UNMIRRORED) ok(throws(() => signOptionsFromConfig({ mac: { ...real.mac, [k]: 'x' } }), new RegExp(`mac\\.${k}\\b`)), `a config setting mac.${k} is refused, by name`)
  ok(throws(() => signOptionsFromConfig({ mac: { hardenedRuntime: true } }), /entitlements is not set/), 'a config without mac.entitlements is refused (no guessing electron-builder\'s template)')
  ok(throws(() => signOptionsFromConfig({}), /no mac section/), 'a config without a mac section is refused')
  ok(signOptionsFromConfig({ mac: { entitlements: 'e.plist', hardenedRuntime: false } }).hardenedRuntime === false, 'hardenedRuntime:false is mirrored, not forced on')
  ok(signOptionsFromConfig({ mac: { entitlements: 'e.plist' } }).entitlementsInherit === null, 'no entitlementsInherit → null (signing then refuses; see main)')
  ok(isFingerprint('55059EA496841EEAF7B8CA6824622D2BAE913C24') && isFingerprint('55059ea496841eeaf7b8ca6824622d2bae913c24'), 'a 40-hex fingerprint is accepted, either case')
  for (const bad of ['', 'Developer ID Application: X', '55059EA4', '55059EA496841EEAF7B8CA6824622D2BAE913C2Z', undefined]) ok(!isFingerprint(bad), `${JSON.stringify(bad)} is not a fingerprint`)

  // ── a Developer ID Application leaf, and nothing else (review should-fix 1) ──
  const DEVID_CA = 'Developer ID Certification Authority'
  ok(classifyLeaf({ subjectCN: 'Developer ID Application: Example Developer (53JM8W47RL)', subjectOU: '53JM8W47RL', issuerCN: DEVID_CA }).ok, 'a Developer ID Application leaf issued by the Developer ID CA is accepted')
  for (const [cn, issuer] of [
    ['Apple Development: dev@example.com (DEVTEAM001)', 'Apple Worldwide Developer Relations Certification Authority'],
    ['Apple Distribution: Example Developer (53JM8W47RL)', 'Apple Worldwide Developer Relations Certification Authority'],
    ['Mac Developer: Example Developer (ABCDE12345)', 'Apple Worldwide Developer Relations Certification Authority'],
    ['3rd Party Mac Developer Application: Example Developer (53JM8W47RL)', 'Apple Worldwide Developer Relations Certification Authority'],
    ['Developer ID Installer: Example Developer (53JM8W47RL)', DEVID_CA],
    ['Developer ID Application: Example Developer (53JM8W47RL)', 'Some Other CA'],
    ['', DEVID_CA]
  ]) ok(!classifyLeaf({ subjectCN: cn, subjectOU: '53JM8W47RL', issuerCN: issuer }).ok, `refused: ${JSON.stringify(cn.split(':')[0] || '(none)')} from ${JSON.stringify(issuer)}`)
  ok(!classifyLeaf(null).ok, 'no leaf at all (ad-hoc or unsigned) is refused')
  ok(!classifyLeaf({ subjectCN: 'Developer ID Application: Example Developer (53JM8W47RL)', subjectOU: 'OTHERTEAM1', issuerCN: DEVID_CA }).ok, 'a Developer ID leaf whose OU disagrees with the team in its name is refused')

  // The pre-sign refusal reads the keychain listing. Synthetic names and hashes: no real identity in the repo.
  const listing = [
    '  1) AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA "Apple Development: dev@example.com (DEVTEAM001)"',
    '  2) BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB "Developer ID Application: Example Co (TEAM123456)"',
    '  3) CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC "Developer ID Application: Example Co (TEAM123456)"',
    '     3 valid identities found'
  ].join('\n')
  const devid = identityFromKeychain(listing, 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')
  ok(devid.found && devid.ok && devid.name === 'Developer ID Application: Example Co (TEAM123456)', `a Developer ID Application fingerprint is accepted before signing, in either case (${JSON.stringify(devid)})`)
  const appdev = identityFromKeychain(listing, 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA')
  ok(appdev.found && !appdev.ok && /Developer ID Application/.test(appdev.why), `the Apple Development fingerprint (line 1 of the listing the docs point at) is refused BEFORE signing (${JSON.stringify(appdev)})`)
  ok(!identityFromKeychain(listing, 'DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD').found, 'a fingerprint not in the keychain is not found')
  ok(!identityFromKeychain(listing, 'AAAAAAAAAAAAAAAA').found, 'a partial fingerprint matches nothing')

  // ── Mach-O by content, so ShipIt (no telling name) is found (should-fix 2) ──
  const hdr64 = (filetype) => { const b = Buffer.alloc(32); b.writeUInt32LE(0xfeedfacf, 0); b.writeUInt32LE(0x0100000c, 4); b.writeUInt32LE(filetype, 12); return b }
  ok(machOKind(hdr64(2)) === 'executable', 'a 64-bit MH_EXECUTE header is an executable (ShipIt, helpers, crashpad, spawn-helper)')
  ok(machOKind(hdr64(6)) === 'library', 'MH_DYLIB is a library')
  ok(machOKind(hdr64(8)) === 'bundle', 'MH_BUNDLE is a bundle (.node)')
  const fat = Buffer.alloc(4096 + 32); fat.writeUInt32BE(0xcafebabe, 0); fat.writeUInt32BE(1, 4); fat.writeUInt32BE(0x0100000c, 8); fat.writeUInt32BE(4096, 16); hdr64(2).copy(fat, 4096)
  ok(machOKind(fat) === 'executable', 'a universal (fat) binary is classified by its first slice')
  ok(machOKind(Buffer.from('\x7fELF\x02\x01\x01\x00', 'latin1')) === null, 'an ELF .node (linux prebuild) is not Mach-O')
  ok(machOKind(Buffer.alloc(3)) === null, 'a short file is not Mach-O')

  // ── own signatures: Mach-O and bundles yes; other files only through the bundle seal ──
  // The update zip drops the per-file xattr signatures osx-sign puts on non-Mach-O files (better-sqlite3's
  // linux/win32 .node prebuilds); the app's resource seal still covers them, so they must not be required.
  for (const k of ['app', 'framework', 'executable', 'library', 'bundle', 'other']) ok(requiresOwnSignature(k) === true, `a ${k} must carry its own signature`)
  ok(requiresOwnSignature('non-macho') === false, 'a non-Mach-O file needs no signature of its own (the bundle seal covers it)')

  // ── entitlements compared as data on every run (should-fix 3) ──
  const want = { 'com.apple.security.cs.allow-jit': true, 'com.apple.security.device.audio-input': true }
  ok(entitlementsMatch({ 'com.apple.security.device.audio-input': true, 'com.apple.security.cs.allow-jit': true }, want), 'the same entitlements in another key order match')
  ok(!entitlementsMatch({ 'com.apple.security.cs.allow-jit': true }, want), 'a missing entitlement does not match')
  ok(!entitlementsMatch({ ...want, 'com.apple.security.get-task-allow': true }, want), 'an extra entitlement does not match')
  ok(!entitlementsMatch({ ...want, 'com.apple.security.cs.allow-jit': false }, want), 'a flipped value does not match')
  ok(!entitlementsMatch(null, want), 'unreadable entitlements never match (no silent pass)')
  ok(entitlementsMatch({}, {}) && !entitlementsMatch(null, {}), 'a library with none matches {}, but an unreadable one never does')

  // ── Gatekeeper's verdict: accepted AS NOTARIZED. With assessments disabled spctl accepts anything. ──
  ok(gatekeeperAccepts(true, 'Beacon.app: accepted\nsource=Notarized Developer ID\norigin=Developer ID Application: X (T)'), 'spctl accepted, source=Notarized Developer ID → notarized')
  for (const [okExit, out, why] of [
    [false, 'Beacon.app: rejected\nsource=Unnotarized Developer ID', 'rejected as unnotarized'],
    [true, 'Beacon.app: accepted\noverride=security disabled', 'accepted only because Gatekeeper assessments are disabled'],
    [true, 'Beacon.app: accepted\nsource=Developer ID', 'accepted as Developer ID, not as notarized'],
    [true, 'Beacon.app: accepted\nsource=Apple System', 'accepted as an Apple system component'],
    [false, 'Beacon.app: accepted\nsource=Notarized Developer ID', 'a notarized source line but a failing exit status']
  ]) ok(!gatekeeperAccepts(okExit, out), `not notarized: ${why}`)

  // ── the command line: anything not understood is refused (exit 2), never ignored ──
  const FPX = 'A'.repeat(40)
  const good = [
    [[FPX, '--verify-only', '--dmg', 'x.dmg', '--notarized'], (a) => a.dmg === 'x.dmg' && a.verifyOnly && a.notarized],
    [['--verify-only', FPX, '--app', 'a.app', '--compare', 'b.app'], (a) => a.fingerprint === FPX && a.app === 'a.app' && a.compare === 'b.app'],
    [[FPX, '--verify-only', '--dmg', 'x.dmg', '--compare', 'b.app'], (a) => a.dmg === 'x.dmg' && a.compare === 'b.app'],
    [[FPX], (a) => a.fingerprint === FPX && !a.verifyOnly && !a.dmg],
  ]
  for (const [argv, want] of good) { const a = parseArgs(argv); ok(!a.error && want(a), `parsed: ${argv.join(' ')}`) }
  for (const [argv, why] of [
    [[FPX, '--verify-only', '--dmg'], '--dmg with no value (last argument)'],
    [[FPX, '--verify-only', '--dmg', ''], '--dmg with an empty value (an unset $DMG)'],
    [[FPX, '--verify-only', '--dmg', '--notarized'], '--dmg whose value is another flag'],
    [[FPX, '--verify-only', '--dmg=x.dmg'], 'the --dmg=<path> form'],
    [[FPX, '--compare=b.app'], 'the --compare=<path> form'],
    [[FPX, '--verify-only', '--notarised'], 'an unknown flag (a typo of --notarized)'],
    [[FPX, '--verfy-only'], 'a mistyped --verify-only (it would otherwise SIGN in place)'],
    [[FPX, '--verify-only', '--dmg', 'a.dmg', '--dmg', 'b.dmg'], 'a repeated --dmg'],
    [[FPX, '--verify-only', '--dmg', 'a.dmg', '--app', 'b.app'], '--dmg together with --app'],
    [[FPX, '--dmg', 'a.dmg'], '--dmg without --verify-only'],
    [[FPX, 'B'.repeat(40), '--verify-only'], 'two fingerprints'],
    [['--verify-only'], 'no fingerprint'],
  ]) ok(Boolean(parseArgs(argv).error), `refused: ${why}`)
  console.log(`[self-test] ${fails === 0 ? 'PASS' : `FAIL (${fails})`}`)
  process.exit(fails === 0 ? 0 : 1)
}

const VALUED = { '--app': 'app', '--compare': 'compare', '--dmg': 'dmg' }
const SWITCHES = { '--verify-only': 'verifyOnly', '--notarized': 'notarized', '--self-test': 'selfTest' }

/** The command line. `error` set means a usage problem: print it and exit 2. Paths are returned as given.
 *  Anything not understood is refused, never ignored: an ignored `--dmg=<path>` or empty `--dmg "$DMG"` used
 *  to fall back to verifying dist/'s app and exit 0, and a mistyped --verify-only signed in place. */
export function parseArgs(argv) {
  const a = { fingerprint: undefined, app: undefined, compare: null, dmg: null, verifyOnly: false, notarized: false, selfTest: false }
  const seen = new Set()
  const positional = []
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i]
    if (seen.has(x)) return { ...a, error: `${x} is given more than once` }
    if (x in VALUED) {
      seen.add(x)
      const v = argv[i + 1]
      if (v === undefined || v === '' || v.startsWith('-')) return { ...a, error: `${x} needs a path${v === '' ? ' (it was given an empty one)' : ''}` }
      a[VALUED[x]] = v
      i++
    } else if (x in SWITCHES) {
      seen.add(x)
      a[SWITCHES[x]] = true
    } else if (x.startsWith('-')) {
      return { ...a, error: `unknown argument ${JSON.stringify(x)}${x.includes('=') ? ' (give the flag and its value as two arguments)' : ''}` }
    } else positional.push(x)
  }
  if (a.selfTest) return a
  if (positional.length !== 1 || !isFingerprint(positional[0])) return { ...a, error: 'usage' }
  a.fingerprint = positional[0]
  if (a.dmg && !a.verifyOnly) return { ...a, error: '--dmg verifies a release image; it needs --verify-only (this script signs .app bundles only)' }
  if (a.dmg && a.app) return { ...a, error: '--dmg verifies the app inside the image; it cannot be combined with --app' }
  return a
}

async function main() {
  const argv = process.argv.slice(2)
  const args = parseArgs(argv)
  if (args.selfTest) return selfTest()
  const { fingerprint } = args
  if (args.error === 'usage') {
    console.error('usage: node scripts/sign-by-fingerprint.mjs <sha1 of the Developer ID Application certificate> [--app <path>] [--compare <signed app>] [--verify-only] [--notarized]')
    console.error('       node scripts/sign-by-fingerprint.mjs <sha1> --verify-only --dmg <release.dmg> [--notarized]')
    console.error('       (npm run pack:mac:fingerprint reads it from BEACON_SIGN_FINGERPRINT)')
    console.error('       list identities: security find-identity -v -p codesigning')
    process.exit(2)
  }
  if (process.platform !== 'darwin') { console.error('macOS only'); process.exit(2) }
  if (args.error) { console.error(args.error); process.exit(2) }
  const dmg = args.dmg ? resolve(args.dmg) : null
  if (dmg && !existsSync(dmg)) { console.error(`no dmg at ${dmg}`); process.exit(2) }
  const app = resolve(REPO, args.app ?? 'dist/mac-arm64/Beacon.app')
  const compare = args.compare ? resolve(args.compare) : null
  if (!dmg && !existsSync(join(app, 'Contents/MacOS'))) { console.error(`no app bundle at ${app} — package first (npm run pack:mac:fingerprint does)`); process.exit(2) }
  if (compare && !existsSync(join(compare, 'Contents/MacOS'))) { console.error(`no app bundle to compare at ${compare}`); process.exit(2) }

  const { osxSign, yaml, oxsVersion } = builderDeps()
  const config = yaml.load(readFileSync(join(REPO, 'electron-builder.yml'), 'utf8'))
  const opts = signOptionsFromConfig(config)
  if (opts.entitlementsInherit === null) throw new Error('mac.entitlementsInherit is not set; electron-builder would fall back to a file or its template, which this script does not mirror')
  // What every signed item's entitlements must equal, read from the config's own plists (as data).
  const expected = {
    app: plistToJson(readFileSync(resolve(REPO, opts.entitlements))),
    inherit: plistToJson(readFileSync(resolve(REPO, opts.entitlementsInherit)))
  }

  if (!args.verifyOnly) {
    const ids = run('security', ['find-identity', '-v', '-p', 'codesigning'])
    const id = identityFromKeychain(ids, fingerprint)
    // Refused BEFORE any codesign call: an Apple Development (or any non-Developer-ID) identity signs fine
    // and verifies, but Gatekeeper and notarization reject the result.
    if (!id.ok) { console.error(`[sign] refused: ${id.why}`); process.exit(1) }
    const name = id.name
    const same = ids.split('\n').filter((l) => l.includes(`"${name}"`)).length
    console.log(`[sign] ${name} — fingerprint ${fingerprint.toUpperCase()}${same > 1 ? ` (${same} identities share this name, which is why the name cannot be used)` : ''}`)
    console.log(`[sign] @electron/osx-sign ${oxsVersion} (electron-builder's copy); entitlements ${opts.entitlements}, inherit ${opts.entitlementsInherit}, hardenedRuntime ${opts.hardenedRuntime}`)
    const ent = resolve(REPO, opts.entitlements)
    const entInherit = resolve(REPO, opts.entitlementsInherit)
    const electronVersion = JSON.parse(readFileSync(createRequire(join(REPO, 'package.json')).resolve('electron/package.json'), 'utf8')).version
    // The options electron-builder 26's MacTargetHelper builds, with the identity given as the hash.
    await osxSign.signAsync({
      identityValidation: false,
      identity: fingerprint.toUpperCase(),
      type: 'distribution',
      platform: 'darwin',
      version: electronVersion,
      app,
      ignore: (file) =>
        file.endsWith('.kext') ||
        file.startsWith('/Contents/PlugIns', app.length) ||
        file.includes('/node_modules/puppeteer/.local-chromium') ||
        file.includes('/node_modules/playwright-firefox/.local-browsers') ||
        file.includes('/node_modules/playwright/.local-browsers'),
      // electron-builder: the app gets mac.entitlements, a Library/LoginItems helper gets
      // mac.entitlementsLoginHelper (refused above if set, so none), everything else entitlementsInherit.
      optionsForFile: (filePath) => ({
        entitlements: filePath === app ? ent : filePath.includes('Library/LoginItems') ? undefined : entInherit,
        hardenedRuntime: opts.hardenedRuntime,
        timestamp: undefined,
        requirements: undefined,
        additionalArguments: []
      })
    })
    console.log(`[sign] signed ${app}`)
  }

  const { notarized } = args
  const v = dmg ? verifyDmg(dmg, fingerprint, opts, { notarized, expected, compare, appId: config.appId }) : verifyApp(app, fingerprint, opts, { compare, notarized, expected })
  if (v.problems.length) {
    console.error(`[verify] FAIL — ${v.problems.length} problem(s) across ${v.items} signed items:`)
    for (const p of v.problems) console.error(`  - ${p}`)
    process.exit(1)
  }
  if (dmg) console.log(`[verify] the dmg ${dmg.split(sep).pop()}: signed by ${fingerprint.toUpperCase()}, a Developer ID Application certificate, timestamped${notarized ? ', stapled and notarized per Gatekeeper' : ''}; nothing at its root but the Applications link and the app inside (${v.inside}):`)
  console.log(`[verify] PASS — ${v.items} items (ShipIt ${v.shipitChecked ? 'included' : 'absent'}): strict verify OK, every item signed by ${fingerprint.toUpperCase()}, a Developer ID Application certificate, team set${opts.hardenedRuntime ? ', hardened runtime' : ''}, timestamped, entitlements as electron-builder.yml${compare ? `, identical item by item to ${compare}` : ''}${notarized ? ', stapled, notarized per Gatekeeper, and syspolicy_check distribution passes' : ''}`)
  if (!notarized) console.log('[verify] notarization not checked: run scripts/notarize-once.sh, then re-verify with --notarized, before this bundle leaves the Mac')
}

// Run only when invoked as a script: probe:sign-fingerprint imports the pure helpers above.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((e) => {
    console.error(`[sign] FAIL: ${e.message}`)
    process.exit(1)
  })
}
