// afterExtract hook (electron-builder.yml): Chromium's licenses go inside Beacon.app.
//
// electron-builder extracts its Electron distribution into appOutDir: the app, and beside it LICENSE and
// LICENSES.chromium.html, the licenses of Chromium and of everything else built into Electron (Node.js,
// FFmpeg's LGPL among them). On macOS it then deletes both files (app-builder-lib electronMac.js,
// createMacApp), so no Mac build carried them. This hook runs in between and copies the file into the
// app's Resources, from the same distribution the build packs.
//
// Not from node_modules/electron/dist: `npm ci` does not always download that. The first release run of
// PR 216 had no such directory, and electron-builder only warned "file source doesn't exist".
// On Linux electron-builder keeps the file at the app's root, so this is macOS only. A missing file fails
// the build; scripts/check-license-metadata.mjs fails a built app that lacks it.
const { copyFileSync, existsSync } = require('fs')
const { join } = require('path')

exports.default = async function afterExtract(context) {
  const { electronPlatformName, appOutDir, packager } = context
  if (electronPlatformName !== 'darwin') return
  const from = join(appOutDir, 'LICENSES.chromium.html')
  const resources = join(appOutDir, packager.info.framework.distMacOsAppName, 'Contents', 'Resources')
  if (!existsSync(from)) throw new Error(`afterExtract: the Electron distribution has no LICENSES.chromium.html (${from})`)
  if (!existsSync(resources)) throw new Error(`afterExtract: no ${resources} to put Chromium's licenses in`)
  copyFileSync(from, join(resources, 'LICENSES.chromium.html'))
  console.log(`  • afterExtract  copied Chromium's licenses into ${packager.info.framework.distMacOsAppName}/Contents/Resources`)
}
