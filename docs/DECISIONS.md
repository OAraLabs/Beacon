# Decisions log

Calls that must not be quietly reversed. Format: what was chosen, what was rejected, why, and how to
reverse it (or why not to).

---

## D1 — Cookie encryption is on, and is never turned off once shipped

**Decided:** 2026-10-06 (PR 206, the packaged-app hardening).

**Chose:** the `enableCookieEncryption` Electron fuse ON in every release build
(`electron-builder.yml`). Chromium encrypts the cookie jar on disk with the "beacon-desktop Safe
Storage" Keychain key, the one safeStorage already uses for the API credential.

**Rejected:** leaving it at Electron's default (off), where cookie values sit in the profile's
`Cookies` SQLite file as plaintext, readable by anything that can read the user's files.

**Why:** measured on signed arm64 builds that differ only in this fuse, sharing one profile:
- turning it ON keeps every existing plaintext cookie readable; new cookies are written as `v10…`;
- turning it OFF again deletes every cookie of any domain that holds an encrypted one, its
  plaintext cookies included. Turning it back on restores nothing.

So switching it on costs users nothing, but switching it off after a release has shipped would sign
people out of every site whose cookies were written in between.

**Held by:** `smoke:release-gate` (runs in `verify`, so in CI) fails if the fuse is false or
missing from `electron-builder.yml`. `audit:bundle`, and so `install-local`, refuses a release bundle
whose binary has it off. `probe:hardening` reads it back from the built binary and checks a cookie
lands on disk encrypted.

**Reverse:** don't. If it ever has to happen, it is a two-release migration, not a config change.
First a release that still encrypts and exports every cookie through Electron's cookies API
(which hands them back decrypted) into Beacon's own storage. Then the release that turns the fuse
off and sets them again, now written as plaintext. Untested; the smoke has to be changed in that
same PR, deliberately.
