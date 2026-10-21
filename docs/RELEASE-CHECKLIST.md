# Releasing Beacon: what the pipeline does, and what it cannot decide

_Since 2026-10-21 releases are built here, in OAraLabs/Beacon: the source, the releases and the
update feed are one repo. Until then they were built in the maintainers' private repository and
attached to drafts here; installed apps read the same feed either way (see "The feed" below)._

## Cutting a release

1. Bump `version` in `package.json` and `package-lock.json` (both root entries) and merge.
2. `git tag vX.Y.Z <merge commit> && git push origin vX.Y.Z`.
3. `.github/workflows/release.yml` runs:
   - **preflight**: the tag must equal `v<package.json version>` (a suffix such as `-rc.1` is
     allowed and marks the draft prerelease). The run must be in the repo the shipped feed names
     (OAraLabs/beacon; GitHub names are case-insensitive). A published release with this tag must
     not exist. Any failure stops the run before the builds.
   - **build** waits for a maintainer to approve the `release` environment (Actions → the run →
     Review deployments), which holds the signing secrets.
   - **build** (macOS arm64, Ubuntu): signs and notarizes when the secrets are there (below). The
     .dmg is signed (`dmg.sign`), then notarized and stapled in its own right, and re-hashed into
     `latest-mac.yml` and its blockmap (`scripts/rehash-update-file.mjs`), because stapling changes its
     bytes. Checks the app's and the dmg's signatures match what was expected, then runs
     `audit:bundle` and `audit:update-feed` on the packaged app.
   - **publish-draft**: checks the release set is complete and that every file a `latest-*.yml`
     names is in it with the sha512 and size the feed claims, runs `audit:update-feed` on the shipped zip, deb and AppImage, creates or
     refreshes the DRAFT on the pushed tag (`--verify-tag`) with the run's own token, then reads the
     draft back and diffs its asset list against what was meant to go up.
4. Open the draft. Its notes say whether the mac build was notarized. Install the dmg on a Mac that
   is not the build machine, then publish by hand.

A dry run is a suffixed tag on the current version, e.g. `v0.4.9-dryrun.1`: it builds, signs,
notarizes and makes a prerelease draft that clients never see. Delete the draft and the tag after.

Nothing auto-publishes. The updater only ever sees **published, non-prerelease** releases, so
"the draft exists" and "clients can see it" are different states.

A `v*` tag is the only trigger: the `release` environment admits only `v*` tags, so there is no
manual or branch run.

## Secrets (in the `release` environment of OAraLabs/Beacon)

They are environment secrets, not repository secrets: only the build job, which names the
environment, can read them, and only after a maintainer approves the run. Pull requests never see
them.

| Secret | Used for | Missing → |
|---|---|---|
| `CSC_LINK`, `CSC_KEY_PASSWORD` | the Developer ID Application certificate as a **base64** .p12 (`base64 -i cert.p12`), and its password. The workflow imports it into its own keychain; electron-builder 26's import is broken (the workflow comment says how) | mac build is **unsigned**, run stays green with a warning |
| `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` | notarization (`scripts/notarize.cjs`) | mac build is signed but **not notarized**, run stays green with a warning |

Publishing needs no secret: publish-draft uses the run's `GITHUB_TOKEN`, and is the only job given
`contents: write`.

**The signing certificate** in `CSC_LINK` is SHA-1 `55059EA496841EEAF7B8CA6824622D2BAE913C24`,
issued under Apple's "Developer ID Certification Authority" G2. It **expires 2031-07-09**. (Until
2026-10-21 CI used a certificate under the legacy CA that expires 2027-02-01.) The build job pins it
as `SIGN_FINGERPRINT` in release.yml, and pins the G2 CA too: when the runner image lacks it, the job
fetches it from apple.com and imports it only if its SHA-1 matches. The "Signing certificate expiry"
step reads the certificate off the signed app and prints its fingerprint and dates. From 60 days
before `notAfter` it raises a warning, and it also warns if the app was signed by any certificate
other than the pinned one.

When `CSC_LINK` changes, change `SIGN_FINGERPRINT` with it. Don't revoke the old certificate while
builds signed with it are in use.

`scripts/sign-by-fingerprint.mjs --verify-only --app dist/mac-arm64/Beacon.app` runs after the
signature checks. It checks every bundle and every Mach-O found by content (ShipIt included) against
the pinned leaf: a Developer ID Application certificate, team, hardened runtime, secure timestamp, and
entitlements equal to `electron-builder.yml`'s. On every signed run release.yml also checks the dmg
(`--dmg`, after it was notarized, stapled and re-hashed), and on notarized runs both calls get
`--notarized`. A missing script fails the step:
- `--notarized`: the app is stapled, Gatekeeper accepts it as notarized, and Apple's
  `syspolicy_check distribution` passes (macOS 14+; the ticket lists the CDHash of every nested item,
  ShipIt included). Per-executable `spctl -t exec` is NOT the check: it rejects ShipIt and crashpad
  even when they are notarized ("does not seem to be an app").
- `--dmg <Beacon-x.y.z-arm64.dmg> --notarized`: **the dmg people download must itself be signed,
  notarized and stapled** (decided 2026-10-06; the v0.3.0-dryrun.1 draft's dmg was unsigned while the
  app inside was notarized). It checks the dmg signed by the pinned leaf, timestamped, stapled and
  accepted by Gatekeeper; then mounts it read-only, where the root must hold exactly one `.app` (a real
  directory, not a symlink, whose bundle id is `appId`) and nothing else visible but the
  `Applications` link, and verifies that app in full.

The command line is strict: an empty `--dmg "$DMG"`, a `--dmg=<path>` or an unknown flag exits 2
instead of quietly verifying something else. The verifier compares entitlements with the checkout it
runs from, so check an artifact from the commit that built it.

**Two identities with the same name ⇒ sign by fingerprint (local builds).** A keychain can hold two
`Developer ID Application: <name> (<team>)` certificates at once (a renewal, or a certificate made
for CI). codesign refuses a name that matches two
(`ambiguous`), and `pack:mac` then exits 1 **leaving an unsigned bundle behind**. `CSC_NAME=<hash>`
does not help: electron-builder 26 hands osx-sign the identity's name. Use
`BEACON_SIGN_FINGERPRINT=<sha1> npm run pack:mac:fingerprint` (the SHA-1 is in
`security find-identity -v -p codesigning`; pick a **Developer ID Application** line, since the script
refuses Apple Development and any other kind). It packages unsigned, signs with electron-builder's own
osx-sign by hash using the options in `electron-builder.yml` (and refuses if the config uses a signing
option it does not mirror), then verifies as above. `npm run sign:fingerprint -- <sha1> --verify-only`
re-checks any signed `.app`; add `--compare /Applications/Beacon.app` to check it item by item against a
previous build. It does not notarize: on this path `afterSign` runs on the unsigned bundle and is a
no-op only because the npm script blanks the `APPLE_*` variables, so run `scripts/notarize-once.sh` on
the signed result, then verify with `--notarized`.

**Notarization is the ship gate for any Mac that is not the build machine.** A signed but
un-notarized app passes `codesign --verify` and is still refused by Gatekeeper elsewhere. Squirrel.Mac
also refuses unsigned updates, so an unsigned mac release can be installed by hand but never
auto-updates.

## The license and the notices

Beacon is MIT, the same license as Prometheus. `LICENSE` is the MIT License word for word under one line,
`Copyright (c) 2026 OAra Labs, LLC`. The same text is the public repo's LICENSE and Settings → About →
License. `package.json` (and the lockfile's root entry) say `"license": "MIT"`, which surfaces in the app's
bundled package.json and in the `.deb`'s `License:` control field. `package.json`'s author is the holder,
and `electron-builder.yml`'s `copyright` (the macOS About box) is LICENSE's copyright line verbatim, which
reserves nothing. This repository is the public repo, so there is one LICENSE. The About line, "Free · open
source (MIT) · beta", is the same in the macOS About panel, Settings → About and both READMEs. The names and
the icon are not licensed by MIT: `TRADEMARKS.md`.

**PRIVACY.md makes a promise the code has to keep:** Beacon connects only to the daemon and services you
configure, the sites you open in its browser pane, and GitHub for updates; when asked, GitHub for Prometheus
(path A) and openrouter.ai (the OpenRouter sign-in, 0.4.0); and sends no analytics. The
renderer's CSP admits nothing remote. Chromium's built-in spellchecker is macOS only (`@shared/spellcheck`),
because on Linux it downloads dictionaries from Google's CDN. `smoke:spellcheck` fails any window, view or
webview that turns it on outside macOS. Anything new that reaches the network breaks the promise: change
PRIVACY.md and the README, or don't ship it.

What ships with every build (`electron-builder.yml`):
- `LICENSE` as `LICENSE.txt` and `THIRD_PARTY_NOTICES.txt`, beside app.asar (`extraResources`);
- Chromium's licenses, `LICENSES.chromium.html`: Electron's own copy. On macOS electron-builder deletes it,
  so the `afterExtract` hook (`scripts/after-extract.cjs`) copies it into Resources first, from the Electron
  distribution the build packs (not `node_modules/electron/dist`, which `npm ci` does not always fill); on
  Linux electron-builder keeps it at the app's root;
- no install-time agreement: MIT asks for none, so there is no `dmg.license` and no `appImage.license`.
  Releases up to 0.4.8 carried one; a script that mounts one of those dmgs has to answer it (`hdiutil
  attach` asks on stdin and fails "attach canceled"), which is why `scripts/sign-by-fingerprint.mjs` still
  answers Y.

`THIRD_PARTY_NOTICES.txt` is generated: `npm run build && npm run notices`. It lists every production
dependency (all of them ship in app.asar) and every package the bundle inlined (recorded at build time,
`bundledPackages` in `electron.vite.config.ts`), with each license text. `smoke:third-party-notices`, in
`verify` and in each release build job, fails when it is stale and when anything shipped is GPL, LGPL or
AGPL with no permissive option. Electron's own Chromium components include LGPL code (FFmpeg, parts of
Blink); those are in `LICENSES.chromium.html`, not in this check.

`scripts/check-license-metadata.mjs` requires MIT and the one copyright line everywhere, refuses any leftover
of the freeware terms in the source and the READMEs, and checks that each artifact carries the files and no
agreement:
- `smoke:license-metadata`, in `npm run verify`, checks the repo files and the electron-builder wiring;
- each release build job checks what it just built: the app, the zip and the dmg (no agreement) on macOS;
  the unpacked app, the `.deb` and the AppImage (no first-run prompt) on Linux.

## The feed

`electron-builder.yml` `publish:` is `github / OAraLabs / beacon`, with no `private:` and no
`token:`. electron-builder bakes it into `app-update.yml` inside every installer, and
electron-updater's public `GitHubProvider` reads `releases.atom` unauthenticated. The guards:

- `npm run smoke:updater` pins `FEED` in `src/main/updater.ts` to the publish block, and fails a
  `private:` or `token:` key.
- `npm run audit:update-feed <Beacon.app | dir | .zip | .deb | .AppImage>` reads the PACKAGED
  `app-update.yml` and fails a wrong repo, a `token:`, a `private:`, a token-shaped string or an
  unknown key. Its self-test runs first (`smoke:update-feed` runs only that).
- `npm run probe:updater-feed` (GUI Electron, after `npm run build`) proves on the real library that
  the shipped feed builds the public provider even with `GH_TOKEN` set.

`app-update.yml` is written only for dmg/zip targets on macOS. `pack:mac` (`--dir`) produces a bundle
**without** it, so a build installed from `pack:mac` can never update itself. Install release
builds from the dmg.

**Builds before 0.3.0 point at the private repo** (`OAraLabs/beacon-desktop`, `private: true`) and
will never see releases on OAraLabs/beacon. Install 0.3.0 by hand once; it updates itself from then
on. The Settings → Updates token field those builds had is removed in 0.3.0; a token saved there
stays in `update-credential.bin` in the profile, unread.

## The public repo's files

This repository is OAraLabs/Beacon: the source, and the releases and update feed beside it. Its root
`README.md`, `LICENSE`, `SECURITY.md`, `CONTRIBUTING.md`, `TRADEMARKS.md`, `PRIVACY.md` and
`.github/ISSUE_TEMPLATE/bug.yml` are the public ones; there is no `release-repo/` copy
(`smoke:license-metadata` fails one). The app links `docs/SETUP.md` on main (`src/shared/setup-links.ts`),
and `smoke:license-metadata` fails a linked file that is missing here. `assets/` holds the screenshots the
landing README used before the source was public; links outside this repo may still point at them. The
setup guide's connect steps follow the setup wizard (`src/renderer/src/components/SetupWizard.tsx`).
Change one, change both.

## Not in scope

No Windows target and no Intel mac build (see `mac.target` in `electron-builder.yml`).

## Still unverified

An installed build discovering and applying an update from OAraLabs/beacon. That needs a published
release, a signed and notarized mac build, and an older installed 0.3.x. Everything before it is
necessary but not sufficient; don't call auto-update done until an older build has updated itself.
