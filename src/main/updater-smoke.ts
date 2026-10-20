/**
 * updater-smoke — the auto-update surface degrades honestly where it can't run.
 *
 * electron-updater only works inside a PACKAGED app, so the most this headless smoke can prove is
 * the honest-degradation contract: unpackaged builds report 'disabled' (never throw, never dial the
 * feed), checkForUpdates is a no-op, and installUpdate refuses unless an update is actually
 * downloaded. That's the failure mode worth pinning — an update-check crash at startup would take
 * down the whole app for a non-essential feature.
 *
 * Run: ELECTRON_RUN_AS_NODE=1 electron out/main/updater-smoke.js
 */
import { readFileSync } from 'node:fs'
import {
  checkForUpdates,
  describeError,
  FEED,
  getUpdaterStatus,
  initUpdater,
  installUpdate
} from './updater'

let failures = 0
function assert(cond: boolean, label: string): void {
  if (cond) console.log(`  ok   ${label}`)
  else {
    console.error(`  FAIL ${label}`)
    failures += 1
  }
}


// ── the error that broke the Settings dialog ─────────────────────────────────
//
// A failed check used to put the provider's ENTIRE message into UpdaterStatus.detail, and
// ConnectionSettings renders detail verbatim directly above the Test / Save & test row. For a
// failed unauthenticated feed request (here: the old private feed) that message is a 1.5 KB dump of every response header —
// including three Set-Cookie headers — which pushed the buttons out of the modal: the bearer
// token could not be changed at all while the update check was failing.
//
// FIXTURE PROVENANCE: captured from the real endpoint on 2026-09-15 —
//   curl -D - https://github.com/OAraLabs/beacon-desktop/releases.atom
// (HTTP/2 404, 3 set-cookie headers, _gh_sess alone 412 bytes), then assembled exactly the way
// builder-util-runtime's createHttpError does: `404 Not Found` + "\nHeaders: " + JSON at indent 2.
// The live cookie VALUES are replaced with same-shape synthetics — names, attributes, ordering and
// lengths are the real wire; no real session cookie is committed.
const REAL_404_DUMP = `404 Not Found
Headers: {
  "date": "Tue, 15 Sep 2026 23:41:37 GMT",
  "content-type": "text/plain; charset=utf-8",
  "vary": "X-PJAX, X-PJAX-Container, Turbo-Visit, Turbo-Frame, X-Requested-With, X-GitHub-Client-Version,Accept-Encoding, Accept, X-Requested-With",
  "cache-control": "no-cache",
  "strict-transport-security": "max-age=31536000; includeSubdomains; preload",
  "x-frame-options": "deny",
  "x-content-type-options": "nosniff",
  "x-xss-protection": "0",
  "referrer-policy": "origin-when-cross-origin, strict-origin-when-cross-origin",
  "content-security-policy": "default-src 'none'; base-uri 'self'; connect-src 'self'; form-action 'self'; img-src 'self' data:; script-src 'self'; style-src 'unsafe-inline'",
  "server": "github.com",
  "set-cookie": [
    "_gh_sess=e%h5ep-mvufCn1sOBBtNEsdYscJ2M88MDxV8N%VV%nSRDFN%BG1RUTeOrfHiYusATRSSGAojZ-h0%my7X%oCH_j7ZHvCawvJfmRL5PhOLxY0HFChhEWPbWyLfx8595gJPbNkAPpsFTZda4RGxWjrGboog641cYZ_75W9HT9oL0SW6NkFZAIRemiHuE3e9ZEY4WXmJy755s_EDyQOXB_LPfuARNSdrb9DA1k%OxF1zZ2QjADJu9MNPzZacCdeTS8kaE9aLUhoxc6HidD82PnM7NKXv4gQsTglpA4cQDwUiZgETJ5GBZESd76l%itRPId46XrkEFogJz_5XGCAB1vc9vPTL%nR_8; path=/; HttpOnly; secure; SameSite=Lax",
    "_octo=Tut18uxD5J_SxSnZ5bNcFROc-BB; expires=Wed, 15 Sep 2027 23:41:37 GMT; domain=.github.com; path=/; secure; SameSite=Lax",
    "logged_in=no; expires=Wed, 15 Sep 2027 23:41:37 GMT; domain=.github.com; path=/; HttpOnly; secure; SameSite=Lax"
  ],
  "content-length": "9",
  "x-github-request-id": "C622:1E81:C5B77:FAABB:6AA9D7B1",
  "x-github-edge-region": "iad"
}`

function errorRendering(): void {
  console.log('\n=== updater: a failed check cannot flood or leak into the UI ===')

  // The dump is the real thing, not a caricature: assert the fixture still has the shape that
  // broke the dialog, or every assertion below is measuring nothing.
  assert(REAL_404_DUMP.length > 1000, `fixture is the real unbounded dump (${REAL_404_DUMP.length} bytes)`)
  assert(/set-cookie/i.test(REAL_404_DUMP) && /_gh_sess=/.test(REAL_404_DUMP), 'fixture carries real Set-Cookie headers')

  const out = describeError(new Error(REAL_404_DUMP))

  // (1) bounded — this is what keeps the buttons on screen.
  assert(out.length <= 180, `summary is capped (${out.length} chars, was ${REAL_404_DUMP.length})`)
  assert(!out.includes('\n'), 'summary is a single line — no dump can grow the panel vertically')

  // (2) no cookie ever reaches a user-visible surface.
  assert(!/set-cookie/i.test(out), 'no set-cookie header name in the summary')
  assert(!/_gh_sess|_octo|logged_in/.test(out), 'no cookie NAME from the wire survives')
  assert(!/e%h5ep-mvufCn1sOBBtNEsdY/.test(out), 'no cookie VALUE from the wire survives')

  // (3) a SUMMARY, not a truncated dump. Capping alone would still leave 180 characters of header
  // soup in the panel; the point is that what is shown is the reason, not the first 180 bytes of it.
  assert(!/Headers:/i.test(out), 'no "Headers:" preamble survives into the summary')
  assert(
    !/"date"|"server"|"content-type"|x-github-request-id/i.test(out),
    'no response-header noise survives into the summary'
  )

  // (4) still says why — a summary, not a shrug.
  assert(/404/.test(out), "the summary keeps the provider's own reason (404)")
  // The feed is public now, so there is no token to advise. A summary that still told someone to
  // get one would send them looking for a Settings field that no longer exists.
  assert(!/token/i.test(out), 'the summary does not advise an update token (the feed is public)')

  // Each guard is proved where it is the ONLY thing that can save the string, so a mutation to
  // one of them cannot hide behind the other.

  // withoutCookies alone: cookies OUTSIDE a Headers: dump, so cutting dumps cannot help.
  const inlineCookie = 'Cannot parse releases feed: set-cookie: _gh_sess=LEAKED_SESSION_VALUE; path=/; HttpOnly'
  const inlineOut = describeError(new Error(inlineCookie))
  assert(!/LEAKED_SESSION_VALUE/.test(inlineOut), 'cookie redaction holds when the cookie is NOT inside a Headers: dump')
  assert(!/_gh_sess/.test(inlineOut), 'cookie name redacted inline too')

  // The cap alone: long, single-line, no cookies anywhere, so only truncation can bound it.
  const longNoCookies = 'ENOTFOUND api.github.com ' + 'x'.repeat(5000)
  const longOut = describeError(new Error(longNoCookies))
  assert(longOut.length <= 180, `the cap bounds a long cookie-free message too (${longOut.length} chars)`)
  assert(longOut.startsWith('ENOTFOUND'), 'truncation keeps the FRONT of the message (the reason), not the tail')

  // The real ERR_UPDATER_LATEST_VERSION_NOT_FOUND shape — a long URL, a 404, then a stack — which
  // is what a feed with only DRAFT releases answers (drafts are invisible to /releases/latest).
  const longWith404 =
    'Unable to find latest version on GitHub (https://api.github.com/repos/OAraLabs/beacon/releases/latest), ' +
    'please ensure a production release exists: HttpError: 404 Not Found ' + 'y'.repeat(4000)
  const long404Out = describeError(new Error(longWith404))
  assert(long404Out.length <= 180, `a long 404 is bounded by the same cap (${long404Out.length} chars)`)
  assert(
    /production release exists/.test(long404Out),
    "the provider's own cause survives the cap — it is the half a person can act on"
  )

  // Degenerate inputs must not throw or produce an empty label.
  assert(describeError(null).length > 0, 'a null error still yields a label')
  assert(describeError(new Error('')).length > 0, 'an empty message still yields a label')

  // The invariant is "the ONE place": a future third error path that sets state:'error' without
  // going through describeError would reintroduce the bug, and no mutation of describeError can
  // detect a guard that was never called. Pin it at the source.
  // Read via a path relative to the repo root (npm scripts run there). A miss must FAIL, not throw
  // a stack that reads like an infrastructure problem.
  let src = ''
  try {
    src = readFileSync('src/main/updater.ts', 'utf8')
  } catch {
    src = ''
  }
  assert(src.length > 0, 'could read src/main/updater.ts to check the error-state assignments')
  const errorAssignments = src.split('\n').filter((l) => /state:\s*'error'/.test(l))
  assert(errorAssignments.length > 0, 'found the error-state assignments to check')
  assert(
    errorAssignments.every((l) => l.includes('describeError(')),
    `every state:'error' assignment routes through describeError (${errorAssignments.length} checked)`
  )
}

// ── the feed is the public release repo, and carries no credential ───────────
//
// FEED is duplicated from electron-builder.yml's publish block by necessity (app-update.yml is
// generated at package time and not readable from source). Pin them together: a drift would
// silently point the updater at the wrong repository. What the PACKAGED app-update.yml says is
// checked separately, on the real artifact, by scripts/check-update-feed.mjs (release.yml runs it).
function feed(): void {
  console.log('\n=== updater: the feed is OAraLabs/beacon, public, no token ===')

  let yml = ''
  try {
    yml = readFileSync('electron-builder.yml', 'utf8')
  } catch {
    yml = ''
  }
  assert(yml.length > 0, 'could read electron-builder.yml to pin the feed against')
  // The block runs from the top-level `publish:` key to the next top-level key. Matched as a key at
  // column 0, so the word in a comment cannot stand in for it.
  const lines = yml.split('\n')
  const start = lines.findIndex((l) => /^publish:\s*$/.test(l))
  assert(start >= 0, 'electron-builder.yml declares a top-level publish block')
  const rest = lines.slice(start + 1)
  const end = rest.findIndex((l) => /^[A-Za-z]/.test(l))
  const publishBlock = (end < 0 ? rest : rest.slice(0, end))
    .filter((l) => !/^\s*#/.test(l))
    .join('\n')
  assert(/\S/.test(publishBlock), 'the publish block has content to check')

  // Anchored to end-of-line, NOT \b: `beacon\b` matches inside `beacon-desktop` (a hyphen IS a
  // word boundary), so the \b form would pass the OLD private feed — a drift pin that could not
  // detect the one drift that matters here.
  assert(
    new RegExp(`^\\s*-?\\s*provider:\\s*${FEED.provider}\\s*$`, 'm').test(publishBlock),
    `publish provider matches FEED (${FEED.provider})`
  )
  assert(
    new RegExp(`^\\s*owner:\\s*${FEED.owner}\\s*$`, 'm').test(publishBlock),
    `publish owner matches FEED (${FEED.owner})`
  )
  assert(
    new RegExp(`^\\s*repo:\\s*${FEED.repo}\\s*$`, 'm').test(publishBlock),
    `publish repo matches FEED (${FEED.repo})`
  )
  assert(FEED.owner === 'OAraLabs' && FEED.repo === 'beacon', 'FEED is the public release repo, OAraLabs/beacon')

  // No credential, on either side. `private: true` would make electron-updater go looking for
  // GH_TOKEN/GITHUB_TOKEN in the environment; `token:` would be baked into every installer.
  assert(!/^\s*private:/m.test(publishBlock), 'publish has no `private:` key — nothing reads a token from the environment')
  assert(!/^\s*token:/m.test(publishBlock), 'publish has no `token:` key — nothing is baked into app-update.yml')
  assert(!('private' in FEED) && !('token' in FEED), 'FEED carries neither private nor token')

  // And the app has no token path left to feed one in: the old Settings field wrote a PAT to the
  // keychain and setFeedURL'd it into a PrivateGitHubProvider. Pin its absence at the source, comments
  // stripped so the history in a comment cannot satisfy (or trip) the check.
  let src = ''
  try {
    src = readFileSync('src/main/updater.ts', 'utf8')
  } catch {
    src = ''
  }
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\])\/\/.*$/gm, '$1')
  assert(code.length > 0 && /export const FEED/.test(code), 'could read updater.ts code to check for a token path')
  assert(!/setFeedURL|GH_TOKEN|GITHUB_TOKEN|\btoken\b/i.test(code), 'updater.ts has no setFeedURL / token path')
}

function main(): void {
  console.log('\n=== updater: honest degradation outside a packaged app ===')

  const seen: string[] = []
  initUpdater((s) => seen.push(s.state))

  const st = getUpdaterStatus()
  assert(st.state === 'disabled', 'unpackaged build → status "disabled" (no crash, no feed dial)')
  assert(!!st.detail, 'disabled carries a WHY (the dev-build reason)')
  assert(seen.length === 1 && seen[0] === 'disabled', 'onChange fired exactly once with the gated state')

  // Re-init must be safe (idempotent wiring) — still disabled, one more notification, no throw.
  initUpdater(() => undefined)
  assert(getUpdaterStatus().state === 'disabled', 're-init stays disabled')

  // The manual controls are no-ops here — they must NOT throw outside a packaged app.
  let threw = false
  try {
    checkForUpdates()
  } catch {
    threw = true
  }
  assert(!threw, 'checkForUpdates() is a safe no-op unpackaged')
  assert(installUpdate() === false, 'installUpdate() refuses when nothing is downloaded')

  errorRendering()
  feed()

  console.log(`\n${failures === 0 ? 'PASS' : `FAIL (${failures})`}\n`)
  process.exit(failures === 0 ? 0 : 1)
}

main()
