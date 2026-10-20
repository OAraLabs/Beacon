#!/usr/bin/env node
// Probe for scripts/sign-by-fingerprint.mjs on a REAL signed bundle. macOS only.
//
// The self-test (smoke:sign-fingerprint) pins the pure decisions. This drives the verifier against
// real signatures: a correctly signed bundle must PASS, and each broken copy must FAIL for its reason.
// Copies are made with `ditto` under a temp dir and re-signed there with codesign; the source bundle,
// /Applications and the keychain are never written.
//
//   BEACON_SIGN_FINGERPRINT=<sha1> npm run pack:mac:fingerprint      (makes dist/mac-arm64/Beacon.app)
//   BEACON_SIGN_FINGERPRINT=<sha1> npm run probe:sign-fingerprint     (BEACON_BUNDLE=<app> for another)
//
// Cases:
//   ok          the signed bundle verifies.
//   shipit      Squirrel's ShipIt re-signed WITHOUT hardened runtime → FAIL on ShipIt (it was never checked).
//   ent         a helper re-signed with other entitlements, runtime and timestamp intact → FAIL with no
//               --compare (entitlements were only checked against another build).
//   notarized   --notarized on an unnotarized bundle → FAIL, and each of the three checks says so: no
//               staple, Gatekeeper's "Unnotarized Developer ID", syspolicy_check's "Notary Ticket Missing".
//   dmg-local   a dmg built and signed here (not notarized): --dmg PASSES (signed dmg, the app inside
//               verified); --dmg --notarized FAILS on the dmg's missing staple AND Gatekeeper's verdict.
//   dmg-adhoc / dmg-nots / dmg-badapp   a dmg signed ad hoc, a dmg signed with no secure timestamp, and a
//               properly signed dmg around an app with a bad helper → each FAILS for that reason.
//   dmg-tampered / dmg-twoapps   the signed dmg with one byte flipped, and a signed dmg holding two apps →
//               each FAILS for that reason; dmg-usage: --dmg without --verify-only → exit 2;
//               dmg-detach: nothing this run's verifier mounted is left attached.
//   node-own-sig     a Mach-O .node re-signed with no runtime or timestamp, app re-sealed → FAIL on the .node.
//   zip-shape-local  this build with its non-Mach-O prebuilds' xattr signatures stripped → PASSES, alone and
//                    with --compare against the original.
//   dmg-args     an empty, missing or --dmg=<path> value, or an unknown flag → exit 2, nothing verified instead.
//   dmg-leafpin  the dmg checked against another fingerprint → FAIL on the dmg's own leaf.
//   dmg-compare  --dmg with --compare: the app inside vs its source build PASSES, vs a changed build FAILS.
//   dmg-symlink  a signed image whose root Beacon.app is a symlink out of the image → FAIL.
//   dmg-file     a signed image whose root Beacon.app is a plain file → FAIL, saying so.
//   dmg-odd      a signed image whose one app is another bundle id, beside an Install.command → FAIL on both
//                (the Applications link is expected).
// With BEACON_NOTARIZED_DMG=<a release dmg, itself signed, notarized and stapled> and
// BEACON_NOTARIZED_FINGERPRINT=<its cert>:
//   dmg-release that dmg → --dmg --notarized PASSES (the dmg, then the app inside it in full).
//   good        the notarized app inside it → --notarized PASSES (the per-executable spctl it used to run
//               rejects ShipIt in a correctly notarized build: "does not seem to be an app").
//   zip-shape   that app with the per-file signatures stripped from its non-Mach-O .node files (the update
//               zip drops those xattrs; the bundle seal still covers them) → PASSES.
//   unstapled   that app with its stapled ticket removed → --notarized FAILS.
// Optional, each with the same fingerprint:
//   BEACON_NOTARIZED_ZIP=<the release's -mac.zip>   zip-real: the app extracted from it → --notarized PASSES.
//   BEACON_UNSIGNED_DMG=<an unsigned release dmg, e.g. v0.3.0-dryrun.1's>   dmg-draft: --dmg FAILS on the dmg.
// Any of these left unset is printed as SKIPPED, never counted as a pass; set but unusable is a FAILURE.
//   appdev      only once the code under test refuses Apple Development identities (else it would SIGN
//               with that key): signing with the keychain's Apple Development identity is refused before
//               any codesign call, and the copy's signature is byte-for-byte unchanged.
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { closeSync, copyFileSync, existsSync, fstatSync, mkdtempSync, openSync, readFileSync, readSync, rmSync, writeFileSync, writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SCRIPT = join(REPO, 'scripts/sign-by-fingerprint.mjs')
const FP = process.env.BEACON_SIGN_FINGERPRINT ?? ''
const APP = resolve(REPO, process.env.BEACON_BUNDLE ?? 'dist/mac-arm64/Beacon.app')
const SHIPIT = 'Contents/Frameworks/Squirrel.framework/Versions/A/Resources/ShipIt'
const NDMG = process.env.BEACON_NOTARIZED_DMG ? resolve(process.env.BEACON_NOTARIZED_DMG) : null
const NFP = process.env.BEACON_NOTARIZED_FINGERPRINT ?? ''
const NZIP = process.env.BEACON_NOTARIZED_ZIP ? resolve(process.env.BEACON_NOTARIZED_ZIP) : null
const UDMG = process.env.BEACON_UNSIGNED_DMG ? resolve(process.env.BEACON_UNSIGNED_DMG) : null
const HELPER = 'Contents/Frameworks/Beacon Helper (GPU).app'

let failures = 0
let checks = 0
const MIN_CHECKS = 36 // the cases that run on every Mac: everything but the release artifacts and appdev
const check = (ok, what, detail = '') => {
  checks++
  console.log(`[probe] ${ok ? 'PASS' : 'FAIL'}  ${what}${!ok && detail ? `\n        ${detail}` : ''}`)
  if (!ok) failures++
}
const tmp = mkdtempSync(join(tmpdir(), 'beacon-sign-probe-'))
process.on('exit', () => {
  rmSync(tmp, { recursive: true, force: true })
  if (checks < MIN_CHECKS) console.log(`[probe] FAIL  only ${checks} of ${MIN_CHECKS} checks ran`)
  if (failures || checks < MIN_CHECKS) {
    console.log(`[probe] ${failures} failure(s)`)
    process.exitCode = 1
  } else console.log(`[probe] all ${checks} checks passed`)
})

const sh = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: 'utf8', ...opts })
const verify = (app, ...extra) => verifyAs(FP, app, ...extra)
const ownTmp = () => ({ env: { ...process.env, TMPDIR: tmp } }) // the verifier mounts dmgs under tmpdir()
const verifyAs = (fp, app, ...extra) => {
  const r = sh(process.execPath, [SCRIPT, fp, '--verify-only', '--app', app, ...extra], ownTmp())
  return { code: r.status, out: `${r.stdout}${r.stderr}` }
}
const verifyDmg = (fp, dmg, ...extra) => {
  const r = sh(process.execPath, [SCRIPT, fp, '--verify-only', '--dmg', dmg, ...extra], ownTmp())
  return { code: r.status, out: `${r.stdout}${r.stderr}` }
}
const mounts = []
process.on('exit', () => { for (const m of mounts) sh('hdiutil', ['detach', m, '-force']) })
const firstLines = (out, n = 6) => out.split('\n').slice(0, n).join(' | ')
const copy = (name) => {
  const dest = join(tmp, name)
  const r = sh('ditto', [APP, dest])
  if (r.status !== 0) throw new Error(`ditto failed: ${r.stderr}`)
  return dest
}
const sigDigest = (app) => createHash('sha256').update(readFileSync(join(app, 'Contents/_CodeSignature/CodeResources'))).update(readFileSync(join(app, 'Contents/MacOS/Beacon'))).digest('hex')

if (process.platform !== 'darwin') { console.log('[probe] macOS only'); process.exit(2) }
if (!/^[0-9A-Fa-f]{40}$/.test(FP)) { console.log('[probe] set BEACON_SIGN_FINGERPRINT to the signing certificate\'s SHA-1'); process.exit(2) }
if (!existsSync(join(APP, SHIPIT))) { console.log(`[probe] no signed bundle with ShipIt at ${APP} — run: npm run pack:mac:fingerprint`); process.exit(2) }

try {
  // ok
  const base = verify(APP)
  check(base.code === 0 && /\[verify\] PASS/.test(base.out), 'ok: the fingerprint-signed bundle verifies', base.out.split('\n').slice(-4).join(' | '))

  // shipit: re-sign ShipIt with the same certificate but WITHOUT --options runtime
  const s = copy('shipit.app')
  const ent = join(tmp, 'shipit-ent.plist')
  writeFileSync(ent, sh('codesign', ['-d', '--entitlements', '-', '--xml', join(s, SHIPIT)], { encoding: 'buffer' }).stdout)
  const rs = sh('codesign', ['--force', '--sign', FP, '--timestamp', '--entitlements', ent, join(s, SHIPIT)])
  // Re-seal the framework and the app around it, so `codesign --verify --deep --strict` passes and ONLY a
  // check that looks at ShipIt itself can catch the missing runtime.
  const rf = sh('codesign', ['--force', '--sign', FP, '--timestamp', '--options', 'runtime', join(s, 'Contents/Frameworks/Squirrel.framework')])
  const ra2 = sh('codesign', ['--force', '--sign', FP, '--timestamp', '--options', 'runtime', '--preserve-metadata=entitlements', s])
  const strict = sh('codesign', ['--verify', '--deep', '--strict', s])
  check(rs.status === 0 && rf.status === 0 && ra2.status === 0 && strict.status === 0 && !/runtime/.test(sh('codesign', ['-dv', join(s, SHIPIT)]).stderr), 'shipit: the copy\'s ShipIt lost its hardened runtime, and the bundle still passes strict verify (precondition)', `${rs.stderr} ${rf.stderr} ${ra2.stderr} ${strict.stderr}`)
  const vs = verify(s)
  check(vs.code === 1 && /ShipIt: no hardened runtime/.test(vs.out), 'shipit: verification FAILS on ShipIt without hardened runtime', vs.out.split('\n').slice(0, 6).join(' | '))

  // shipit-gone: ShipIt replaced by a non-Mach-O file and the bundle re-sealed, so strict verify passes and
  // the walker (which finds executables by content) no longer sees an executable there. Only the explicit
  // "Squirrel is present, so ShipIt must have been checked" guard can catch it.
  const g = copy('shipit-gone.app')
  writeFileSync(join(g, SHIPIT), '#!/bin/sh\nexit 0\n')
  const rg1 = sh('codesign', ['--force', '--sign', FP, '--timestamp', join(g, SHIPIT)])
  const rg2 = sh('codesign', ['--force', '--sign', FP, '--timestamp', '--options', 'runtime', join(g, 'Contents/Frameworks/Squirrel.framework')])
  const rg3 = sh('codesign', ['--force', '--sign', FP, '--timestamp', '--options', 'runtime', '--preserve-metadata=entitlements', g])
  const strictG = sh('codesign', ['--verify', '--deep', '--strict', g])
  check(rg1.status === 0 && rg2.status === 0 && rg3.status === 0 && strictG.status === 0, 'shipit-gone: ShipIt is no longer a Mach-O, and the bundle still passes strict verify (precondition)', `${rg1.stderr} ${rg2.stderr} ${rg3.stderr} ${strictG.stderr}`)
  const vg = verify(g)
  check(vg.code === 1 && /ShipIt executable was not found/.test(vg.out), 'shipit-gone: verification FAILS because ShipIt could not be checked', vg.out.split('\n').slice(0, 6).join(' | '))

  // ent: a helper re-signed with a different entitlements set, runtime + timestamp kept
  const e = copy('ent.app')
  const other = join(tmp, 'other.plist')
  writeFileSync(other, '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>com.apple.security.cs.allow-jit</key><true/></dict></plist>\n')
  const re = sh('codesign', ['--force', '--sign', FP, '--timestamp', '--options', 'runtime', '--entitlements', other, join(e, HELPER)])
  const s2 = sh('codesign', ['--force', '--sign', FP, '--timestamp', '--options', 'runtime', '--preserve-metadata=entitlements', e])
  const strictE = sh('codesign', ['--verify', '--deep', '--strict', e])
  check(re.status === 0 && s2.status === 0 && strictE.status === 0, 'ent: the copy\'s GPU helper carries other entitlements, and the bundle still passes strict verify (precondition)', `${re.stderr} ${s2.stderr} ${strictE.stderr}`)
  const ve = verify(e)
  check(ve.code === 1 && /Beacon Helper \(GPU\)[^\n]*entitlements/.test(ve.out), 'ent: verification FAILS on the helper\'s entitlements with NO --compare', ve.out.split('\n').slice(0, 6).join(' | '))

  // node-own-sig: a Mach-O addon (node-pty's pty.node, an MH_BUNDLE) re-signed with no runtime and no
  // timestamp, the app re-sealed around it: only a check on the .node's OWN signature can catch it, and the
  // non-Mach-O exemption must not swallow it.
  const PTY = 'Contents/Resources/app.asar.unpacked/node_modules/node-pty/build/Release/pty.node'
  const n = copy('node-own-sig.app')
  const rn = sh('codesign', ['--force', '--sign', FP, '--timestamp=none', join(n, PTY)])
  const rn2 = sh('codesign', ['--force', '--sign', FP, '--timestamp', '--options', 'runtime', '--preserve-metadata=entitlements', n])
  const strictN = sh('codesign', ['--verify', '--deep', '--strict', n])
  check(rn.status === 0 && rn2.status === 0 && strictN.status === 0 && /Mach-O/.test(sh('file', [join(n, PTY)]).stdout), 'node-own-sig: the copy\'s pty.node (Mach-O) has no runtime or timestamp, and the bundle still passes strict verify (precondition)', `${rn.stderr} ${rn2.stderr} ${strictN.stderr}`)
  const vno = verify(n)
  check(vno.code === 1 && /pty\.node: no hardened runtime/.test(vno.out) && /pty\.node: no secure timestamp/.test(vno.out), 'node-own-sig: verification FAILS on the Mach-O .node\'s own signature', firstLines(vno.out))

  // zip-shape-local: what the update zip does to this build — the non-Mach-O prebuilds lose the xattrs
  // that carry their own signatures; the seal still covers them, so it must PASS, alone and in --compare.
  const PREBUILDS = 'Contents/Resources/app.asar.unpacked/node_modules/better-sqlite3/prebuilds'
  const NON_MACHO = ['linux-arm64.node', 'linux-x64.node', 'linuxmusl-arm64.node', 'linuxmusl-x64.node', 'win32-arm64.node', 'win32-x64.node']
  const zl = copy('zipshape-local.app')
  for (const f of NON_MACHO) sh('xattr', ['-c', join(zl, PREBUILDS, f)])
  check(/not signed at all/.test(sh('codesign', ['-dv', join(zl, PREBUILDS, 'linux-x64.node')]).stderr) && sh('codesign', ['--verify', '--deep', '--strict', zl]).status === 0, 'zip-shape-local: the non-Mach-O prebuilds carry no signature of their own, and the bundle still passes strict verify (precondition)')
  const vzl = verify(zl)
  check(vzl.code === 0 && /\[verify\] PASS/.test(vzl.out), 'zip-shape-local: verification PASSES — a non-Mach-O file needs no signature of its own', firstLines(vzl.out))
  const vzc = verify(zl, '--compare', APP)
  check(vzc.code === 0 && /identical item by item/.test(vzc.out), 'zip-shape-local: --compare against the xattr-signed build PASSES (non-Mach-O files are compared by the seal, not one by one)', firstLines(vzc.out))

  // notarized: this bundle is not notarized, so --notarized must fail, and each of its three checks say so
  const vn = verify(APP, '--notarized')
  check(vn.code === 1, '--notarized on an unnotarized bundle FAILS', vn.out.split('\n').slice(-3).join(' | '))
  check(/the app: not stapled/.test(vn.out) && /the app: Gatekeeper does not accept it as notarized \(Unnotarized Developer ID\)/.test(vn.out) && /Notary Ticket Missing/.test(vn.out), '--notarized names the missing staple, Gatekeeper\'s "Unnotarized Developer ID" AND syspolicy_check\'s "Notary Ticket Missing"', firstLines(vn.out, 8))

  // dmg-local: a dmg built here from the signed app and signed with the same certificate, not notarized
  const src = join(tmp, 'dmgsrc')
  sh('mkdir', ['-p', src])
  sh('ditto', [APP, join(src, 'Beacon.app')])
  const ldmg = join(tmp, 'local.dmg')
  const mk = sh('hdiutil', ['create', '-quiet', '-volname', 'Beacon', '-srcfolder', src, '-ov', '-format', 'UDZO', ldmg])
  const sg = sh('codesign', ['--sign', FP, '--timestamp', ldmg])
  check(mk.status === 0 && sg.status === 0 && sh('codesign', ['--verify', ldmg]).status === 0, 'dmg-local: a dmg holding the signed app, itself signed with the certificate (precondition)', `${mk.stderr} ${sg.stderr}`)
  const dl = verifyDmg(FP, ldmg)
  check(dl.code === 0 && /dmg/i.test(dl.out) && /PASS/.test(dl.out), 'dmg-local: --dmg PASSES — the dmg is signed by the pinned Developer ID leaf, and the app inside verifies', firstLines(dl.out))
  const dln = verifyDmg(FP, ldmg, '--notarized')
  check(dln.code === 1 && /the dmg \([^)]*\): not stapled/.test(dln.out) && /the dmg \([^)]*\): Gatekeeper does not accept it as notarized/.test(dln.out), 'dmg-local: --dmg --notarized FAILS on the dmg\'s missing staple AND Gatekeeper\'s verdict on the dmg', firstLines(dln.out, 8))
  check(/Beacon\.app in the dmg: the app: not stapled/.test(dln.out) && /Beacon\.app in the dmg: the app: syspolicy_check distribution failed/.test(dln.out), 'dmg-local: --dmg --notarized ALSO holds the app inside to --notarized (its own staple and syspolicy_check)', firstLines(dln.out, 8))

  // dmg-adhoc / dmg-nots / dmg-badapp: each breaks exactly one thing the dmg check owns
  const mkDmg = (name, appPath) => {
    const dir = join(tmp, `${name}-src`)
    sh('mkdir', ['-p', dir])
    sh('ditto', [appPath, join(dir, 'Beacon.app')])
    const out = join(tmp, `${name}.dmg`)
    const r = sh('hdiutil', ['create', '-quiet', '-volname', 'Beacon', '-srcfolder', dir, '-ov', '-format', 'UDZO', out])
    return r.status === 0 ? out : null
  }
  const adhoc = mkDmg('adhoc', APP)
  const sa = adhoc && sh('codesign', ['--sign', '-', adhoc])
  const va = adhoc ? verifyDmg(FP, adhoc) : { code: -1, out: 'no dmg' }
  check(sa?.status === 0 && va.code === 1 && /the dmg \([^)]*\): (no signing certificate|signed by leaf)/.test(va.out) && !/Beacon\.app in the dmg/.test(va.out), 'dmg-adhoc: an ad-hoc-signed dmg around a good app FAILS on the dmg alone (no Developer ID leaf)', firstLines(va.out))
  const nots = mkDmg('nots', APP)
  const sn = nots && sh('codesign', ['--sign', FP, '--timestamp=none', nots])
  const vt = nots ? verifyDmg(FP, nots) : { code: -1, out: 'no dmg' }
  check(sn?.status === 0 && vt.code === 1 && /the dmg \([^)]*\): no secure timestamp/.test(vt.out), 'dmg-nots: a dmg signed without a secure timestamp FAILS', firstLines(vt.out))
  const bad = mkDmg('badapp', e)
  const sb = bad && sh('codesign', ['--sign', FP, '--timestamp', bad])
  const vb = bad ? verifyDmg(FP, bad) : { code: -1, out: 'no dmg' }
  check(sb?.status === 0 && vb.code === 1 && /Beacon\.app in the dmg[^\n]*entitlements/.test(vb.out), 'dmg-badapp: a properly signed dmg around an app with a bad helper FAILS on the app inside', firstLines(vb.out))

  // dmg-tampered: one byte of the signed dmg flipped → its signature AND its image checksum both fail
  const tdmg = join(tmp, 'tampered.dmg')
  copyFileSync(ldmg, tdmg)
  const fd = openSync(tdmg, 'r+')
  const at = Math.floor(fstatSync(fd).size / 2)
  const byte = Buffer.alloc(1)
  readSync(fd, byte, 0, 1, at)
  byte[0] ^= 0xff
  writeSync(fd, byte, 0, 1, at)
  closeSync(fd)
  check(sh('codesign', ['--verify', '--strict', tdmg]).status !== 0, 'dmg-tampered: one byte of the signed dmg flipped breaks its signature (precondition)')
  const vtd = verifyDmg(FP, tdmg)
  check(vtd.code === 1 && /the dmg \([^)]*\): codesign --verify --strict failed/.test(vtd.out) && /the dmg \([^)]*\): could not be mounted read-only/.test(vtd.out), 'dmg-tampered: --dmg FAILS on the dmg\'s broken signature AND refuses to read the app from a corrupt image', firstLines(vtd.out))

  // dmg-twoapps: a second .app beside Beacon.app would go unverified → refused
  const two = join(tmp, 'twoapps-src')
  sh('mkdir', ['-p', two])
  sh('ditto', [APP, join(two, 'Beacon.app')])
  sh('ditto', [APP, join(two, 'Other.app')])
  const twodmg = join(tmp, 'twoapps.dmg')
  const mt = sh('hdiutil', ['create', '-quiet', '-volname', 'Beacon', '-srcfolder', two, '-ov', '-format', 'UDZO', twodmg])
  const st2 = mt.status === 0 && sh('codesign', ['--sign', FP, '--timestamp', twodmg])
  const vtw = mt.status === 0 ? verifyDmg(FP, twodmg) : { code: -1, out: 'no dmg' }
  check(st2?.status === 0 && vtw.code === 1 && /the dmg \([^)]*\): expected exactly one \.app at its root, found 2/.test(vtw.out), 'dmg-twoapps: a properly signed dmg holding two apps FAILS (one would go unverified)', firstLines(vtw.out))

  // dmg-args: a --dmg the parser cannot use must stop the run, not fall back to verifying dist/'s app
  const argRuns = [['--dmg', ''], ['--dmg'], [`--dmg=${ldmg}`], ['--notarised']].map((extra) => [extra, sh(process.execPath, [SCRIPT, FP, '--verify-only', ...extra], ownTmp())])
  check(argRuns.every(([, r]) => r.status === 2), 'dmg-args: an empty, missing or --dmg=<path> value, and an unknown flag, each exit 2 (nothing verified in their place)', argRuns.map(([x, r]) => `${JSON.stringify(x)}→${r.status}`).join(' '))

  // dmg-leafpin: a dmg signed by a Developer ID leaf other than the pinned one (the leaf classifier is
  // satisfied, so only the pin can catch it)
  const OTHER_FP = 'A'.repeat(40)
  const vlp = verifyDmg(OTHER_FP, ldmg)
  check(vlp.code === 1 && new RegExp(`the dmg \\([^)]*\\): signed by leaf ${FP.toUpperCase()}, not ${OTHER_FP}`).test(vlp.out), 'dmg-leafpin: a dmg whose Developer ID leaf is not the pinned fingerprint FAILS on the dmg itself', firstLines(vlp.out))

  // dmg-compare: --compare applies to the app inside the dmg, both ways
  const vdc = verifyDmg(FP, ldmg, '--compare', APP)
  check(vdc.code === 0 && /identical item by item/.test(vdc.out), 'dmg-compare: the dmg\'s app compared with the build it was made from PASSES', firstLines(vdc.out))
  const vdx = verifyDmg(FP, ldmg, '--compare', e)
  check(vdx.code === 1 && /Beacon\.app in the dmg: [^\n]*Helper \(GPU\)[^\n]*entitlements differ from/.test(vdx.out), 'dmg-compare: the dmg\'s app compared with a build whose helper differs FAILS (--compare is not ignored)', firstLines(vdx.out))

  // small images, built and signed here, whose ROOT is wrong
  const mkImage = (name, populate) => {
    const dir = join(tmp, `${name}-src`)
    sh('mkdir', ['-p', dir])
    populate(dir)
    const out = join(tmp, `${name}.dmg`)
    const c = sh('hdiutil', ['create', '-quiet', '-volname', 'Beacon', '-srcfolder', dir, '-ov', '-format', 'UDZO', out])
    const g2 = c.status === 0 && sh('codesign', ['--sign', FP, '--timestamp', out])
    return g2?.status === 0 ? out : null
  }
  const rootEntries = (dmg) => {
    const m = join(tmp, `peek-${dmg.split('/').pop()}`)
    sh('mkdir', ['-p', m])
    if (sh('hdiutil', ['attach', '-readonly', '-nobrowse', '-noautoopen', '-mountpoint', m, dmg]).status !== 0) return null
    mounts.push(m)
    const r = sh('ls', ['-la', m]).stdout
    sh('hdiutil', ['detach', m])
    mounts.splice(mounts.indexOf(m), 1)
    return r
  }

  // dmg-symlink: the root Beacon.app is a symlink to an app OUTSIDE the image (the image ships no app)
  const symdmg = mkImage('symlink', (d) => sh('ln', ['-s', APP, join(d, 'Beacon.app')]))
  const symLs = symdmg && rootEntries(symdmg)
  check(Boolean(symLs) && /Beacon\.app -> \//.test(symLs), 'dmg-symlink: the signed image\'s root Beacon.app is a symlink out of the image (precondition)', String(symLs).slice(0, 300))
  const vsy = symdmg ? verifyDmg(FP, symdmg) : { code: -1, out: 'no dmg' }
  check(vsy.code === 1 && /the dmg \([^)]*\): Beacon\.app at its root is a symlink/.test(vsy.out), 'dmg-symlink: --dmg FAILS instead of verifying whatever the link points at', firstLines(vsy.out))

  // dmg-file: the root Beacon.app is a plain file, not a bundle
  const filedmg = mkImage('file', (d) => writeFileSync(join(d, 'Beacon.app'), 'not an app\n'))
  const vfi = filedmg ? verifyDmg(FP, filedmg) : { code: -1, out: 'no dmg' }
  check(vfi.code === 1 && /the dmg \([^)]*\): Beacon\.app at its root is not a directory/.test(vfi.out), 'dmg-file: --dmg FAILS, saying so, when the root Beacon.app is a plain file', firstLines(vfi.out))

  // dmg-odd: the one root .app is not Beacon (another bundle id), an executable sits beside it, and the
  // usual Applications link is there too (that one is expected)
  const odddmg = mkImage('odd', (d) => {
    sh('mkdir', ['-p', join(d, 'Other.app/Contents/MacOS')])
    writeFileSync(join(d, 'Other.app/Contents/Info.plist'), '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.example.other</string><key>CFBundleExecutable</key><string>Other</string><key>CFBundleShortVersionString</key><string>9.9.9</string></dict></plist>\n')
    writeFileSync(join(d, 'Other.app/Contents/MacOS/Other'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    writeFileSync(join(d, 'Install.command'), '#!/bin/sh\necho hi\n', { mode: 0o755 })
    sh('ln', ['-s', '/Applications', join(d, 'Applications')])
  })
  const oddLs = odddmg && rootEntries(odddmg)
  check(Boolean(oddLs) && /Other\.app/.test(oddLs) && /Install\.command/.test(oddLs) && /Applications -> \/Applications/.test(oddLs), 'dmg-odd: the signed image\'s root holds Other.app, Install.command and Applications -> /Applications (precondition)', String(oddLs).slice(0, 300))
  const vod = odddmg ? verifyDmg(FP, odddmg) : { code: -1, out: 'no dmg' }
  check(vod.code === 1 && /the dmg \([^)]*\): Other\.app is com\.example\.other, not electron-builder\.yml's appId/.test(vod.out), 'dmg-odd: --dmg FAILS when the app inside is not Beacon (bundle id vs the config\'s appId)', firstLines(vod.out))
  check(vod.code === 1 && /the dmg \([^)]*\): unexpected item at its root: Install\.command/.test(vod.out) && !/unexpected item at its root: Applications/.test(vod.out), 'dmg-odd: --dmg FAILS on an unexpected root item, and accepts the Applications link', firstLines(vod.out))

  // dmg-usage: --dmg verifies only; it must not be mistaken for a signing run. --app names a path that does
  // not exist, so a script that failed to refuse here still could not sign anything real.
  const ru = sh(process.execPath, [SCRIPT, FP, '--dmg', ldmg, '--app', join(tmp, 'no-such.app')])
  check(ru.status === 2 && /needs --verify-only/.test(`${ru.stdout}${ru.stderr}`), 'dmg-usage: --dmg without --verify-only is refused (exit 2)', `${ru.stdout}${ru.stderr}`.slice(0, 200))

  // dmg-detach: every image the verifier mounted is detached again, pass or fail
  const tag = tmp.split('/').pop() // this run's verifier mounts live under tmp (TMPDIR), so concurrent runs don't count
  const left = sh('hdiutil', ['info']).stdout.split('\n').filter((l) => /beacon-dmg-/.test(l) && l.includes(tag))
  check(left.length === 0, 'dmg-detach: no image the verifier mounted is still attached after the dmg cases', left.join(' | '))

  // ── a NOTARIZED build: the passing case, and copies of it made bad ──
  const nfpOk = /^[0-9A-Fa-f]{40}$/.test(NFP)
  // Unset: SKIPPED, never counted. Set but unusable: a FAILURE, so a run meant to cover them can't go green.
  const usable = (envName, path, cases) => {
    if (!path) { console.log(`[probe] SKIPPED  ${cases}: set ${envName} and BEACON_NOTARIZED_FINGERPRINT (not counted as passes)`); return false }
    if (!existsSync(path)) { check(false, `${cases}: ${envName} is set, but there is no file at ${path}`); return false }
    if (!nfpOk) { check(false, `${cases}: ${envName} is set, but BEACON_NOTARIZED_FINGERPRINT is not a 40-hex fingerprint`); return false }
    return true
  }
  // Each run works on its own APFS clone of a release dmg: hdiutil refuses a second attach of one image
  // ("Resource busy"), so two probes sharing BEACON_NOTARIZED_DMG would fail each other otherwise.
  const own = (path, name) => {
    const dest = join(tmp, name)
    return sh('cp', ['-c', path, dest]).status === 0 || sh('cp', [path, dest]).status === 0 ? dest : null
  }
  if (usable('BEACON_NOTARIZED_DMG', NDMG, 'dmg-release / good / zip-shape / unstapled')) {
    const ndmg = own(NDMG, 'release.dmg')
    // dmg-release: what people download — the dmg signed, timestamped, stapled, notarized, and the app inside
    const dsig = sh('codesign', ['-dvvv', ndmg])
    check(Boolean(ndmg) && sh('codesign', ['--verify', '--strict', ndmg]).status === 0 && /^Timestamp=/m.test(dsig.stderr) && sh('xcrun', ['stapler', 'validate', ndmg]).status === 0, 'dmg-release: the release dmg (this run\'s clone) is signed, timestamped and stapled (precondition)', dsig.stderr.slice(0, 300))
    const vr = verifyDmg(NFP, ndmg, '--notarized')
    check(vr.code === 0 && /the dmg [^\n]*stapled and notarized/.test(vr.out) && /\[verify\] PASS/.test(vr.out), 'dmg-release: --dmg --notarized PASSES on a signed, notarized, stapled release dmg', firstLines(vr.out, 8))

    const mnt = join(tmp, 'mnt')
    sh('mkdir', ['-p', mnt])
    // Release dmgs up to 0.4.8 carry a license agreement: answer it, or hdiutil cancels the attach.
    const at = sh('hdiutil', ['attach', '-readonly', '-nobrowse', '-noautoopen', '-mountpoint', mnt, ndmg], { input: 'Y\n' })
    if (at.status === 0) mounts.push(mnt)
    const good = join(tmp, 'notarized.app')
    sh('ditto', [join(mnt, 'Beacon.app'), good])
    sh('hdiutil', ['detach', mnt])
    mounts.length = 0
    check(at.status === 0 && sh('xcrun', ['stapler', 'validate', good]).status === 0 && sh('syspolicy_check', ['distribution', good]).status === 0, 'good: the copied app is stapled and passes Apple\'s syspolicy_check distribution (precondition)', at.stderr)
    const vg = verifyAs(NFP, good, '--notarized')
    check(vg.code === 0 && /notarized/i.test(vg.out), 'good: --notarized PASSES on a correctly notarized build (ShipIt and all)', firstLines(vg.out, 8))

    // zip-shape: the update zip drops per-file xattr signatures on non-Mach-O files; the seal still covers them
    const z = join(tmp, 'zipshape.app')
    sh('ditto', [good, z])
    const nm = 'Contents/Resources/app.asar.unpacked/node_modules/better-sqlite3/prebuilds'
    for (const f of ['linux-arm64.node', 'linux-x64.node', 'linuxmusl-arm64.node', 'linuxmusl-x64.node', 'win32-arm64.node', 'win32-x64.node']) sh('xattr', ['-c', join(z, nm, f)])
    const unsignedNow = sh('codesign', ['-dv', join(z, nm, 'linux-x64.node')]).status !== 0
    check(unsignedNow && sh('codesign', ['--verify', '--deep', '--strict', z]).status === 0, 'zip-shape: the non-Mach-O prebuilds now carry no signature of their own, and the bundle still passes strict verify (precondition)')
    const vz = verifyAs(NFP, z)
    check(vz.code === 0, 'zip-shape: verification PASSES — a non-Mach-O file needs no signature of its own', firstLines(vz.out))

    // unstapled: remove the stapled ticket (Contents/CodeResources, outside the code seal)
    const u = join(tmp, 'unstapled.app')
    sh('ditto', [good, u])
    rmSync(join(u, 'Contents/CodeResources'), { force: true })
    check(sh('xcrun', ['stapler', 'validate', u]).status !== 0 && sh('codesign', ['--verify', '--deep', '--strict', u]).status === 0, 'unstapled: the ticket is gone and the signature is intact (precondition)')
    const vu = verifyAs(NFP, u, '--notarized')
    check(vu.code === 1 && /not stapled/i.test(vu.out), 'unstapled: --notarized FAILS on a notarized-but-unstapled app', firstLines(vu.out))

  }
  if (usable('BEACON_NOTARIZED_ZIP', NZIP, 'zip-real')) {
    // zip-real: the update payload Squirrel installs, extracted the way it does (ditto)
    const zx = join(tmp, 'zipx')
    const ux = sh('ditto', ['-x', '-k', NZIP, zx])
    check(ux.status === 0 && existsSync(join(zx, 'Beacon.app', SHIPIT)), 'zip-real: the release zip extracts to a Beacon.app with ShipIt (precondition)', ux.stderr)
    const vx = verifyAs(NFP, join(zx, 'Beacon.app'), '--notarized')
    check(vx.code === 0 && /\[verify\] PASS/.test(vx.out), 'zip-real: --notarized PASSES on the app from the release zip', firstLines(vx.out, 8))
  }
  if (usable('BEACON_UNSIGNED_DMG', UDMG, 'dmg-draft')) {
    // dmg-draft: a release dmg that is itself unsigned → --dmg must fail on the dmg
    const udmg = own(UDMG, 'draft.dmg')
    check(Boolean(udmg) && /not signed at all/.test(sh('codesign', ['-dv', udmg]).stderr), 'dmg-draft: the dmg (this run\'s clone) is unsigned (precondition)')
    const vd = verifyDmg(NFP, udmg, '--notarized')
    check(vd.code === 1 && /the dmg \([^)]*\): not signed/.test(vd.out), 'dmg-draft: --dmg FAILS on an unsigned release dmg', firstLines(vd.out))
  }

  // appdev: only when the code under test already refuses non-Developer-ID identities
  const mod = await import(SCRIPT)
  // Both refusals must already be in place — the verify-time one (classifyLeaf) AND the pre-sign one
  // (identityFromKeychain) — or this case would reach codesign with the Apple Development key.
  const synth = '  1) AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA "Apple Development: dev@example.com (DEVTEAM001)"'
  const refusesAppDev =
    !mod.classifyLeaf({ subjectCN: 'Apple Development: x (Y)', subjectOU: 'Y', issuerCN: 'Apple Worldwide Developer Relations Certification Authority' }).ok &&
    typeof mod.identityFromKeychain === 'function' &&
    mod.identityFromKeychain(synth, 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA').ok === false
  const appDevLine = sh('security', ['find-identity', '-v', '-p', 'codesigning']).stdout.split('\n').find((l) => /"Apple Development:/.test(l))
  const appDevFp = appDevLine ? /\b([0-9A-F]{40})\b/.exec(appDevLine)?.[1] : null
  if (!refusesAppDev) {
    check(false, 'appdev: the code under test does not refuse Apple Development identities yet — case skipped so it cannot sign with one')
  } else if (!appDevFp) {
    console.log('[probe] SKIPPED  appdev: no Apple Development identity in this keychain to try (not counted as a pass)')
  } else {
    const a = copy('appdev.app')
    const before = sigDigest(a)
    const ra = sh(process.execPath, [SCRIPT, appDevFp, '--app', a])
    check(ra.status !== 0 && /Developer ID Application/.test(`${ra.stdout}${ra.stderr}`) && sigDigest(a) === before, 'appdev: signing with the Apple Development identity is refused before any codesign call (copy\'s signature unchanged)', `${ra.stdout}${ra.stderr}`.slice(0, 300))
  }
} catch (e) {
  check(false, 'the probe ran to completion', String(e?.stack ?? e))
}
