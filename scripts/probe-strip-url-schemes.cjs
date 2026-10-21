// electron-builder afterPack hook for the PROBE build only (electron-builder.probe.yml): remove every
// URL scheme from the probe app's Info.plist before fuses are flipped and the app is signed.
//
// WHY. beacon:// belongs to the installed release. On 2026-10-06 a probe build (its own bundle id,
// com.oaralabs.beacon.probe) declared the scheme and claimed it at startup, LaunchServices stored the
// probe build as the scheme's default handler, and beacon:// links opened the probe build instead of
// /Applications/Beacon.app. main now claims the scheme only in a release (src/main/index.ts), but a
// stored handler that still names the probe id would route links to ANY probe build that declares the
// scheme, so the declaration has to go too.
//
// WHY A HOOK. The config cannot do it: electron-builder merges arrays across `extends` by union (a
// `protocols: []` in the probe config keeps the release's scheme), and its schema rejects `null`.
//
// Fail-closed both ways: it refuses to touch any bundle but the probe's (a release must keep its deep
// links), and it throws if the Info.plist still declares a scheme afterwards.
const { execFileSync } = require('node:child_process')
const { join } = require('node:path')

const PROBE_ID = 'com.oaralabs.beacon.probe'

exports.default = async function stripUrlSchemes(context) {
  if (context.electronPlatformName !== 'darwin') return // the .desktop x-scheme-handler is Linux-only; probe builds are mac
  const id = context.packager.appInfo.id
  if (id !== PROBE_ID) {
    throw new Error(`probe-strip-url-schemes: refusing to strip URL schemes from ${id}; this hook is for ${PROBE_ID} only`)
  }
  const plist = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Info.plist')
  const read = () => JSON.parse(execFileSync('plutil', ['-convert', 'json', '-o', '-', plist], { encoding: 'utf8' }))
  if (read().CFBundleURLTypes !== undefined) execFileSync('plutil', ['-remove', 'CFBundleURLTypes', plist])
  const left = read().CFBundleURLTypes
  if (left !== undefined) throw new Error(`probe-strip-url-schemes: ${plist} still declares URL types: ${JSON.stringify(left)}`)
  console.log(`[probe-strip-url-schemes] ${id}: Info.plist declares no URL schemes`)
}
