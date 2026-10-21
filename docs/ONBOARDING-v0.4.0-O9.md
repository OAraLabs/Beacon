# O9: how the assistant thinks (path A, after Prometheus is installed)

Beacon v0.4.0 first run, build-plan item O9 (the main onboarding spec's §3.2, §4 A2–A5, §11). This is
the spec Beacon builds O9 against. It is written before the code, and the red tests in this PR are taken from it.

**Status (2026-10-11): built**, against Prometheus PR 732 (merged, e867e41): the `openrouter` provider and
`POST /api/setup/check-key`. §6 says what the recorded daemon answers; where the build differs from what this spec first said,
the text below is the build, and §9 lists those changes. The owner's decisions (2026-10-10): Beacon runs the OpenRouter sign-in
itself; OpenRouter is Recommended and needs credit; pasted Anthropic and OpenAI keys sit under "Other options"; cloud is
recommended on every Mac; O9 ends by trading the setup-mode master token for an owner credential.

## 1. Where O9 starts and ends

- **Starts at A2.** A-inst (O7/O8, merged in beacon-desktop PR 237) has installed Prometheus.app, started it, and connected with the
  setup-mode secret. Beacon holds the daemon's **master token** (setup mode cannot mint a device; Prometheus PR 696), and
  the daemon is in setup mode with `configured: false`.
- **Ends at F1** ("Say hello"), with:
  1. a cloud AI configured and checked (`/api/setup/configure`, then `/api/setup/complete`, after which the same process
     is the configured daemon);
  2. **an owner credential in Beacon's keychain entry and the master token gone from Beacon** (§5);
  3. the connection brought up with the owner credential.
- Nothing in O9 is reachable in a release build: the onboarding gate stays closed until O10.

## 2. The screens (copy from the main spec §4, with the decisions above)

Main-path copy is held to `src/shared/onboarding-banned-words.json` (no "model", "provider", "API", "token", "server"...).

| Screen | Title | What it holds | Primary | Back |
|---|---|---|---|---|
| **A2** | How should your assistant think? | Two choices. **With a cloud AI**, tagged *Recommended* and preselected **on every Mac**: "Ready in about a minute and usually smarter. Your messages go to the company you pick, and they charge for use." **Privately on this Mac**: shown greyed, "Coming soon" (P11, the private download, is not built; O9 does not offer it). A hardware line, information only: "This Mac has {memory} of memory." | Continue | W2 (Prometheus stays installed) |
| **A3c-1** | Connect a cloud AI | The Recommended card, preselected: **Sign in with OpenRouter**, "One account that gives your assistant Claude, ChatGPT, Gemini and more. No key to copy." and, plainly on the card, "OpenRouter needs a few dollars of credit before your assistant can answer: $5 is the smallest amount, plus a small card fee." with **Add credit on OpenRouter ↗** (`https://openrouter.ai/settings/credits`). A collapsed **Other options** link, never preselected, opening: **Use a key from Anthropic (Claude)** and **Use a key from OpenAI (ChatGPT)**. | Continue | A2 |
| **A3c-or** | Sign in with OpenRouter | "We'll open OpenRouter in your browser. Sign in, or create an account, then choose Authorize." The credit line again, always. Status: "Waiting for you to finish in the browser…". When the browser comes back, the key is checked HERE (its cards are this screen's). | (none while waiting) | A3c-1 (stops the sign-in) |
| **A3c-2** | Connect your Anthropic account / Connect your OpenAI account | Steps: open the company's key page ↗, create a key named "Prometheus", copy it, paste it. A masked field with Show. Fine print: "{Company} charges you for use, so your account needs credit or a payment method before your assistant can answer. Your key stays on this Mac." (Prometheus PR 732: a good Anthropic or OpenAI key is `ok` even on an empty account, so the screen says it before the first message finds out.) | Check key (the check runs here; its cards are this screen's) | A3c-1 |
| **A5** | Finishing setup | Rows: Saving your choices · Starting your assistant · Connecting this Mac as its owner. Shown only while it works; on success straight to F1. Its cards retry in place. | — | none: it runs with nothing behind it |

**Cards** (title · body · buttons), each with Copy details (technical words allowed there):

| When | Title | Body | Buttons |
|---|---|---|---|
| OpenRouter key check says `no_credit` | Your OpenRouter account needs credit | Add a few dollars ($5 is the smallest amount), then try again. | Add credit on OpenRouter ↗ · Try again |
| Sign-in not finished (closed the tab, 30 min passed, code expired) | The sign-in didn't finish | Start it again when you're ready. | Start again |
| Chose not to authorize (callback without a code) | OpenRouter wasn't connected | You chose not to connect it. Try again, or pick another option. | Try again · Other options |
| OpenRouter unreachable (the exchange, or the check says `unreachable`, which is also what a rate limit, 429, comes back as) | We couldn't reach OpenRouter | Check your internet connection. If OpenRouter is busy, wait a minute. Then try again. | Try again |
| The key from the sign-in refused (`bad_key`) | OpenRouter didn't accept the sign-in | Start it again. If it keeps happening, pick another option. | Try again · Other options |
| Pasted key, wrong shape (`sk-ant-` / `sk-`) | That doesn't look like a key from {Company} | {Company} keys start with "{prefix}". Copy the whole key and paste it again. | Paste again |
| Pasted key `bad_key` | {Company} didn't accept this key | It may have been deleted, or copied only in part. Make a new key and paste it here. | Open {Company} ↗ · Try again |
| Pasted key `no_credit` (kept for safety: Prometheus PR 732 never says it for Anthropic or OpenAI) | Your {Company} account needs credit | {Company} needs credit or a payment method before your assistant can answer. Add one, then try again. | Open {Company} billing ↗ · Try again |
| Pasted key `unreachable` (no connection, or the company busy) | We couldn't reach {Company} | Check your internet connection. If {Company} is busy, wait a minute. Then try again. | Try again |
| Configure or complete refused, or the daemon did not come back as configured in 60 s | Prometheus didn't start | Try once more. If it still doesn't start, we'll help. | Try again · Get help ↗ |
| The owner trade failed (§5) | Beacon couldn't finish connecting | Try once more. | Try again · Get help ↗ |

## 3. The machine (`src/shared/onboarding.ts`)

- New screens: `A3c-1`, `A3c-or`, `A3c-2`, `A5`. `A2` leaves `PENDING_SCREENS` (which is then empty of path A).
- Events: `continue` (A2 → A3c-1, a cloud AI being the only choice; A3c-1 → A3c-or), `otherKey` {company: 'anthropic' |
  'openai'} (A3c-1 → A3c-2), `signedIn` (A3c-or → A5, once the key is checked), `keyAccepted` (A3c-2 → A5, once the key is
  checked), `setUp` (A5 → F1). A5 and the F1 after it have no history: the master token is gone and there is nothing to go
  back to.
- Back: A3c-1 → A2; A3c-or and A3c-2 → A3c-1; A2 → W2 (the history `installed` set).
- **Resuming on this Mac:** a relaunch while the saved Prometheus is on this Mac (127.0.0.1), still in setup mode, with its
  setup credential kept, starts the new flow at A2 (entry `resumeModel`, Back to W2). A part-way setup anywhere else is the
  existing wizard, as before. (The gate still decides whether the new flow shows at all.)
- `useRunningHere` and "choosing A again comes back to A2": out of O9.

## 4. OpenRouter sign-in, run by Beacon (main process)

From OpenRouter's documentation (`openrouter.ai/docs/guides/overview/auth/oauth`, read 2026-10-10): authorization at
`https://openrouter.ai/auth` with `callback_url`, `code_challenge`, `code_challenge_method=S256`, optional `state` and
`key_label`; the callback receives `?code=` (and `state`, which is NOT returned when the person denies access); the
exchange is `POST https://openrouter.ai/api/v1/auth/keys` with JSON `{code, code_verifier, code_challenge_method}`,
answering `{key}`; errors 400 (method mismatch), 403 (bad code or verifier, or expired: codes last 10 minutes, single
use), 405. Localhost callbacks are allowed on any port.

What Beacon does:
1. **Verifier and challenge (RFC 7636):** the verifier is 32 random bytes, base64url without padding (43 characters); the
   challenge is base64url(SHA-256(verifier)), method S256 (the documentation's own sample uses `base64url`). `state` is
   another 32 random bytes, base64url.
2. **The callback listener:** an HTTP server in main on an ephemeral port, **loopback only** (127.0.0.1 and ::1, so
   `localhost` resolves either way), path `/openrouter/callback`, one attempt at a time. Anything else answers 404. The
   callback is accepted once: `state` must match (compared in constant time) and `code` must be present; otherwise it is
   "OpenRouter wasn't connected" (no code) or ignored (wrong state: not this sign-in). It answers a small static page,
   "You can close this tab and go back to Beacon" (no script; `Content-Security-Policy: default-src 'none'`), then closes.
3. **The browser:** `shell.openExternal` on the authorization URL with `callback_url=http://localhost:{port}/openrouter/callback`,
   the challenge, `state`, and `key_label=Prometheus on {this Mac's name}`. Main owns the URL; the page never names it.
4. **Waiting:** up to 30 minutes (account creation and buying credit happen in the browser; the Q1 clock pauses). Back
   stops it and closes the listener.
5. **The exchange:** `POST https://openrouter.ai/api/v1/auth/keys` from main, `redirect: 'error'`, 16 KiB answer cap,
   10 s timeout. The key must be a non-empty string of at most 512 printable characters. 400/403 → "The sign-in didn't
   finish" (start again); network → "We couldn't reach OpenRouter".
6. **The key never reaches the page and is never stored by Beacon.** Main hands it to Prometheus's key check (§6), then to
   `/api/setup/configure`; Prometheus keeps it in its own env file. The verifier, state and key live in one object in
   main and are dropped when the sign-in ends.
7. **Dev or probe build only:** `BEACON_OPENROUTER_BASE` points both URLs at a loopback stub, the way `BEACON_PROMETHEUS_*`
   do for A-inst; a release build always uses openrouter.ai.

Pasted keys (A3c-2) are typed into the page, sent to main once, checked and configured there, and not kept by Beacon.

## 5. Ending: the owner credential, and the master token discarded

After `POST /api/setup/complete` the setup-mode process becomes the configured daemon (Prometheus PRs 695 and 696). Then, in main:

1. wait for `GET /api/status` to answer 200 to the master token (60 s, as A-inst);
2. `GET /api/hello`: a hello with a version (a configured daemon names the agent its owner chose, so the name is not
   asked); then **hello's `fp` and `pair.fp` (beside `pair.secret`) compared as plain strings, empty included, a missing
   `pair.fp` being `""`** (the owner's rule, 2026-10-10; the same check A-inst makes, beacon-desktop PR 240). The daemon writes `pair.fp` at boot
   from its instance key; recorded against Prometheus PR 695 at `3090556`, the boot that follows `complete` writes it before
   `/api/status` answers, so at this step both say the new key's fingerprint. `pair.fp` is read under the secret's rules; one
   that cannot be trusted refuses. A sanity check that this is our daemon, not proof of identity (`fp` is public);
3. only then run the app's launcher with `--pair` (it writes a fresh `pair.secret`): nothing is written or sent before hello
   says this is ours. This is A-inst's order, and now A-inst's code: one function, `pairThisMac` (src/main/prometheus-install.ts),
   ends both;
4. `POST /api/pair/local {code, name: "Beacon on this Mac"}` → `{token, revoked_previous, api_base_port, ws_port}`: an
   **owner credential**;
5. keep it in Beacon's keychain entry, **replacing** the master token (the same `setToken` every way of connecting uses),
   and bring the connection up with it; check `GET /api/status` answers 200 to it;
6. drop every in-memory copy of the master token, and record in Beacon's settings that this connection holds an owner
   credential (`onboarding:credential` = `owner`), so a relaunch part-way through (configured daemon, credential still
   `master`) resumes at this step instead of opening the app with the master key.

If any step fails, A5 shows "Beacon couldn't finish connecting" and does not go on to F1: there is no path to F1 that keeps
the master token. The daemon's own copy of the master token (its env file) is Prometheus's to keep or retire.

## 6. What Prometheus PR 732 answers (recorded)

`scripts/record-model-setup-732.mjs` → `src/main/fixtures/model_setup_732.json`, from a real daemon in a scratch home. The
shapes live in one module (`src/shared/model-setup.ts`); they matched what this spec assumed, plus two fields and five refusals.

| | Answer |
|---|---|
| Key check | `POST /api/setup/check-key` `{"provider", "api_key"}`, master token → `200 {"result": "ok" \| "bad_key" \| "no_credit" \| "unreachable", "status"?, "detail"?}`. `status` is the company's HTTP status; `detail` is Prometheus's own sentence (it never relays a company's words, which can echo the key). A key each company refuses was `bad_key` with `status` 401 (recorded with obviously fake keys); a string not shaped like a key is `bad_key` with no call made. |
| Refusals | no credential → 401; not JSON, no `api_key` → 400 `bad_request`; a `base_url` → 400 `unexpected_base_url`; another provider → 400 `unsupported_provider`. Beacon reads every one as `unreachable` with the details kept, never `ok`. |
| What `ok` means | OpenRouter: the key is good AND the account has credit (a one-token paid call after the free one). Anthropic and OpenAI: the key is good, nothing about credit (their free model list); `no_credit` never comes from them. A 429 from anyone is `unreachable`. |
| Configure | `{"provider": "openrouter", "api_key"}` with no model → configured on `anthropic/claude-sonnet-5` (a paid one); the key is kept in Prometheus's env file (`~/.config/prometheus/env`) and never in its config. |

## 7. Tests (written first; green with the code)

- `smoke:openrouter-signin` (pure): RFC 7636 Appendix B vector (verifier `dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk`
  → challenge `E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM`); fresh verifiers are 43 base64url characters and never
  repeat; the authorization URL carries exactly the documented parameters with a localhost callback; callback parsing
  (code and matching state → the code; no code → declined; wrong or missing state → not ours; extra junk ignored); the
  exchange answer (a key, or why not, by status); the redirect and size rules.
- `smoke:model-setup` (pure + main with fakes): the key-check answers map to the cards above (and anything unknown is
  not `ok`); the configure bodies for OpenRouter, Anthropic and OpenAI; key shapes for pasted keys; **the end of O9**:
  configure → complete → status 200 → `--pair` → hello and `pair.fp` (plain strings, missing = `""`) → `/api/pair/local` → the owner
  credential replaces the master token, the connection is brought up with it, and the master token is in no update the
  page is sent and in no saved state; a failure at any step stops before F1 with the master token not marked as owner.
- `smoke:onboarding`: the machine of §3 (each event only where it applies; Back; no Back from A5 or after it; A2 no longer
  pending).
- `scripts/onboarding-model-probe.mjs` (built): the real app with real clicks, a real Prometheus from main with Prometheus PR 732 in a
  scratch home (its key check pointed at a stand-in provider on this Mac through `key_check`'s module constants, so no third
  party is contacted), a loopback OpenRouter stand-in for the exchange, and a stand-in launcher doing what `--pair` does;
  resumed at A2; the shape card and a refused key; the sign-in with no credit, then with credit on to F1; the trade checked
  against the daemon's own registry (an owner device "Beacon on this Mac", not the master token), and no key or credential in
  the page or Beacon's profile on disk.

## 8. Open, for the owner

1. **A new network contact for Beacon:** the code-for-key exchange goes from Beacon to `openrouter.ai`. The LICENSE draft
   (beacon-desktop PR 225) names only the GitHub release and update hosts; it should name OpenRouter, "if you choose to sign in with it".
2. **Privately on this Mac** is shown as "Coming soon" in O9 (P11 not built). The main spec also allowed offering it when
   Ollama or LM Studio is already running; O9 does not.
3. **Gemini** under Other options (main spec §3.2) is left out: Prometheus's setup does not accept it yet (P8).
4. **Retiring the daemon's master token** (it stays in Prometheus's env file, readable by the agent's own shell on macOS)
   is Prometheus's, and still a release gate (Prometheus PR 695's design note).

## 9. What changed from this spec while building

1. **The key check runs where the key arrives** (A3c-or after the sign-in, A3c-2's Check key), with its cards there, not at A5.
   A5 then only saves, starts and trades, retrying in place. `finish` does not ask again for a key just accepted (OpenRouter's
   check spends one token).
2. **Hello and `pair.fp` come before `--pair`** (§5): A-inst's order, now shared code.
3. **Resuming at A2 on this Mac** (§3) is built. Resuming part-way through the trade (`resumeAtTrade`, a configured daemon on this
   Mac with the credential still the master token) is decided by a tested function but not yet wired into startup: with the gate
   closed in every release build, it lands with O10.
4. **Copy** for Prometheus PR 732's two facts (§2): the paste screen says the account needs credit; "couldn't reach" also says "wait a minute".
