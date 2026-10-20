// electron-builder `afterSign` hook — conditional notarization.
//
// Runs notarytool ONLY when Apple credentials are present in the environment; otherwise it
// no-ops, so `npm run dist` still produces a usable (unsigned/ad-hoc) .dmg for local use on
// your own Mac. To produce a distributable, Gatekeeper-clean build, export before running:
//
//   export APPLE_ID="you@example.com"
//   export APPLE_APP_SPECIFIC_PASSWORD="abcd-efgh-ijkl-mnop"   # appleid.apple.com → App-Specific Passwords
//   export APPLE_TEAM_ID="XXXXXXXXXX"                          # your Developer Team ID
//
// Signing itself is handled by electron-builder when a "Developer ID Application" identity is
// in your login keychain (or via CSC_LINK/CSC_KEY_PASSWORD); notarization is this extra step.

const { notarize } = require('@electron/notarize')

exports.default = async function notarizing(context) {
  const { electronPlatformName, appOutDir } = context
  if (electronPlatformName !== 'darwin') return

  // Two ways to hand notarytool a credential, neither of which passes through Beacon's code:
  //   APPLE_KEYCHAIN_PROFILE=<name>  — stored once with `xcrun notarytool store-credentials <name>`
  //                                    (the app-specific password lives in the login keychain)
  //   APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD + APPLE_TEAM_ID — the CI shape (repo secrets)
  const { APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID, APPLE_KEYCHAIN_PROFILE } = process.env
  const credential = APPLE_KEYCHAIN_PROFILE
    ? { keychainProfile: APPLE_KEYCHAIN_PROFILE }
    : APPLE_ID && APPLE_APP_SPECIFIC_PASSWORD && APPLE_TEAM_ID
      ? { appleId: APPLE_ID, appleIdPassword: APPLE_APP_SPECIFIC_PASSWORD, teamId: APPLE_TEAM_ID }
      : null
  if (!credential) {
    console.log(
      '[notarize] skipped — set APPLE_KEYCHAIN_PROFILE (local) or APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD + ' +
        'APPLE_TEAM_ID (CI) to notarize. The .dmg will be unsigned (run locally with right-click → Open).'
    )
    return
  }

  const appName = context.packager.appInfo.productFilename
  console.log(`[notarize] submitting ${appName}.app to notarytool (this can take a few minutes)…`)
  await notarize({ tool: 'notarytool', appPath: `${appOutDir}/${appName}.app`, ...credential })
  console.log('[notarize] done — ticket stapled.')
}
