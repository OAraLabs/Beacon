# Local first: "How should your assistant think?" offers an AI you already run

Beacon onboarding, screen A2 (`docs/ONBOARDING-v0.4.0-O9.md` §2), redesigned so a person who already runs Ollama, LM Studio,
llama.cpp or vLLM can use it, on this Mac or on another computer they name. This spec is written before the code, and the red
tests are taken from it.

**Status (2026-10-20): spec and red tests. Nothing is built.**

Decisions (2026-10-20):
1. Reword the copy; no exemptions to `src/shared/onboarding-banned-words.json` ("model", "server", "address" stay banned).
2. Prometheus's switch-to-local route (§4.2) and the Settings switch (§6) ship in the same release as this screen. The cloud
   card's "You can switch to local any time." ships only with them (§5.3 says how that is enforced).
3. A window known to be too short is refused, with a card that says how to fix it, after the floor is measured (§4.3).

Prerequisite checked (2026-10-20): the eight-item fix plan in Prometheus's local tool-calling audit
(`docs/audits/local-tools-audit-2026-10-16/README.md` §9) against Prometheus main `2502c5a`. Items 1–7 are merged (Prometheus PRs 811, 813,
814, 815, 816, 818, 819 and 820) and released in 0.9.13. Item 8 is a decision about one live config, not code. Nothing in
items 1–5 is open, so nothing has to land before this work.

## 1. What exists, and what this adds

- **Prometheus setup mode** has `GET /api/setup/detect`. Without a query it tries four places on the computer it runs on:
  llama.cpp `:8080`, Ollama `:11434`, LM Studio `:1234` and vLLM `:8000` (`cli/init.py` `KNOWN_LOCAL_SERVERS`). With
  `?base_url=`, it tries one address. Setup's `configure` re-probes a local choice before writing it (`probe_backend`) and refuses
  with `backend_unreachable` otherwise. In onboarding path A, Prometheus runs on this Mac, so "where Prometheus runs" is this Mac.
- **No LAN scan exists, and none is added.** Prometheus looks at this Mac's four places, and at the one computer the person
  types. `web/discovery.py` only advertises; nothing browses.
- **What detection lacks today:**
  - It gives no reason when it finds nothing: every error is a silent `continue`.
  - The four places are tried one after another, up to about 4 s; one typed address, up to about 6 s.
  - It labels by port, so a typed Ollama, LM Studio or vLLM comes back as `llama_cpp` (`remote_server_candidates`) and would be
    configured with the wrong provider.
  - It reports Ollama's downloaded AIs, not its loaded ones, and lists embedding-only AIs that cannot chat.
  - It follows redirects (`urllib.request.urlopen`).
  - It knows no context window.
- **After setup**, `PUT /api/model` is cloud only (`web/model_settings.py`: it takes no `base_url`). There is no way to switch to a
  local AI without setting up again.

## 2. The screen (A2)

Title: **How should your assistant think?** Three cards, always in this order, so nothing moves when looking ends.

### 2.1 Use an AI you already run

- Body: "Free. Your conversations go to your own AI, not a company."
- Tag **Ready** when something usable was found (on this Mac, or by a Test that passed).
- While looking: "Looking on this Mac…"
- Found on this Mac, one usable AI: "Found on this Mac: **{app}** · {ai}"
- Found several: one radio row per usable AI ("Ollama · qwen3:8b", "LM Studio · gemma-3-12b"). The preselected row is a loaded
  one, otherwise the first. Order: by app (Ollama, LM Studio, llama.cpp, vLLM), then as the app listed them.
- Nothing found: "Nothing found on this Mac. Beacon looks for Ollama, LM Studio, llama.cpp and vLLM." with **Look again**.
- Found but nothing usable on this Mac: the card for the reason (§3), with **Look again**.
- Another computer: "Or use one on another computer", a field (placeholder "Its name, like my-computer.local") and **Test**.
  While testing: "Testing…". When it passes: "Found on {name}: **{app}** · {ai}", and that row becomes the selection (several
  usable AIs there: rows, as above). When it fails: the card for the reason (§3), under the field.

### 2.2 Quick start with a cloud AI

- Tag **Quickest** only when looking has finished and nothing usable was found, and no Test has passed.
- Body: "Ready in about a minute, with the largest AIs. Your messages go to the company you pick, and they charge for use. You can
  switch to local any time." The last sentence only when Prometheus says it can switch (§5.3).

### 2.3 Download an AI to this Mac

- Greyed out, not focusable, "Coming soon." Choosing it does nothing.

Under the cards, unchanged: "This Mac has {memory} of memory."

### 2.4 Selection and Continue

- Nothing is selected, and Continue is off, until looking ends or the person picks a card.
- Looking ends with something usable: the local card (and its preselected row) is selected. With nothing usable: the cloud card is
  selected.
- Once the person has picked anything (a card, a row, Test), Beacon never changes the selection itself.
- Continue on the local card needs a selected usable row. On the cloud card it is always on.
- **Continue, local** goes to A5 (Finishing setup) with that choice. No key, no A3 screens.
- **Continue, cloud** goes to A3c-1, as today.
- "Recommended" no longer appears on A2.

### 2.5 A5 with a local choice

The same three rows (Saving your choices · Starting your assistant · Connecting this Mac as its owner). Configure re-probes the
choice (§4.1). If the AI is no longer usable when configure runs, A5 shows the card for that reason, with **Try again** and
**Choose again**. Choose again goes back to A2, only from this failure, because configure has not written anything. Every other
A5 failure is as in O9.

## 3. Failure cards

Main-path copy is held to the banned-word list. Each card has Copy details, which may use the technical words, and carries
Prometheus's own `detail` sentence plus what was tried (ports, codes).

| `reason` (§4.1) | Title / body |
|---|---|
| `bad_target` (also caught in Beacon before any call) | That doesn't look like a computer's name. Try something like my-computer.local. |
| `name_not_found` | We couldn't find a computer called {name}. Check the spelling, and that it's turned on. |
| `no_answer` | {name} didn't answer. Check that it's turned on and on the same network as this Mac. |
| `refused` (another computer) | {name} is on, but no AI app there is open to other computers. In LM Studio, turn on Serve on Local Network. For Ollama, whoever set it up can allow it. · Get help ↗ |
| `refused` (this Mac) | The "Nothing found on this Mac" line of §2.1. |
| `not_ai` | Something on {name} answered, but it isn't an AI app Beacon knows. |
| `needs_key` | The AI app on {name} is locked with a password. Beacon can't use a locked one yet. |
| `no_models` | {app} is running, but has no AI downloaded yet. Download one in {app}, then test again. |
| `no_chat` | {app} has nothing that can hold a conversation. Download a chat AI in {app}, then test again. |
| `none_loaded` | {app} is open, but no AI is loaded. Load one in {app}, then test again. |
| `short_context` | {ai} is set up for short conversations only. In {app}, set Context Length to {min} or more, then test again. |
| anything else, or an answer Beacon cannot read | Beacon couldn't check {name}. Try again. (Never read as found.) |
| Prometheus has no probe route (§5.3) | Beacon can't look for these with this version of Prometheus. (The local card shows only this; cloud is Quickest.) |
| Looking failed (Prometheus did not answer) | We couldn't look on this Mac. · Look again |

On F1, when the choice is local, the existing "No answer yet." card adds: "It may still be loading the AI."

For this Mac, `{name}` is "this Mac" ("this Mac didn't answer" never appears: a this-Mac look that times out is "Looking failed").

## 4. Prometheus (public repo: every push gets the scan and the owner's go)

### 4.1 PR P1: checks that give a reason (setup mode)

One module, `prometheus/providers/local_probe.py`, used by detect, the new probe route, configure (§4.1) and the model routes
(§4.2), so there is one definition of "usable".

**What a probe does, for one base URL:**
- **Identify the app** by what it answers, never by its port:
  - Ollama: `GET /api/version` answers `{"version"}` and `GET /api/tags` answers `{"models": [...]}`.
  - LM Studio: `GET /api/v0/models` answers `{"data": [...]}` with per-model `type` and `state`.
  - llama.cpp: `GET /props` answers `default_generation_settings`.
  - vLLM: `GET /version` answers `{"version"}` and `GET /v1/models` answers `{"data": [...]}` with `max_model_len`.
  - Any other OpenAI-compatible answer to `GET /v1/models`: `openai_compatible`, configured as vLLM is (the OpenAI-compatible
    class with a placeholder key), and named "an AI app".
  These shapes are taken from the apps' documentation. They are confirmed against captures from real Ollama and LM Studio
  installs before Beacon reads them (§7.3).
- **Per AI**, report:
  - `id`.
  - `loaded`: Ollama `/api/ps`, LM Studio `state`, llama.cpp and vLLM always loaded; `null` when unknown.
  - `chat`: Ollama `POST /api/show` `capabilities` contains `completion`; LM Studio `type` is `llm` or `vlm`; `null` when unknown;
    `false` for embedding-only.
  - `window` and `window_source`:
    - llama.cpp: `/props` `n_ctx`, `served`.
    - LM Studio: `loaded_context_length`, `loaded`.
    - vLLM: `max_model_len`, `served`.
    - Ollama: the trained length from `/api/show`, `trained`. Since Prometheus PR 815 Prometheus asks Ollama to load at the window it budgets,
      capped by the trained length, so the trained length is the most it can get.
- **Rules for every request:** GET (or Ollama's one `POST /api/show`) to these fixed paths only; no redirects followed; at most
  256 KiB read per answer; timeouts of 1 s per request on this Mac and 3 s elsewhere; probes run in parallel (this Mac's four places
  within 1.5 s in all). Only parsed fields come back: never an answer's body. So the route cannot be used to read pages it was
  not built for.
- **A typed target** (`POST /api/setup/probe {"target"}`):
  - Accepted forms: a name (`my-computer`, `my-computer.local`), an IPv4 address, a bracketed IPv6 address, any of those with
    `:port`, or an `http://` / `https://` URL with no path beyond `/`.
  - Refused as `bad_target`: userinfo (`u:p@`), a query, a fragment, a path, any other scheme, more than 253 characters, control
    characters.
  - Without a port, the four known ports on that one computer are tried, in parallel.
  - The name is resolved once, IPv4 then IPv6, within 3 s (macOS `.local` lookups can stall on the missing family), and the
    probes use the resolved address with the name kept for `Host`.
- **The answer** (detect and probe share it):
  ```json
  {
    "target": "my-computer.local",
    "found": [
      {"app": "lm_studio", "provider": "lm_studio", "base_url": "http://my-computer.local:1234", "version": "0.3.x",
       "latency_ms": 12.0,
       "models": [{"id": "gemma-3-12b", "loaded": true, "chat": true, "window": 4096, "window_source": "loaded",
                   "usable": false, "problem": "short_context"}]}
    ],
    "reason": "short_context",
    "detail": "LM Studio on my-computer.local serves gemma-3-12b with a 4,096 window; Prometheus needs 24,576",
    "min_window": 24576
  }
  ```
  - `found` lists every app that answered as one. A model is `usable` when `chat` is not `false`, `loaded` is not `false` for an
    app that needs loading (LM Studio with nothing loaded and no just-in-time loading), and `window` is null or at least
    `min_window`.
  - `reason` is null when at least one model is usable. Otherwise it is the first that applies, in this order: `bad_target`,
    `name_not_found`, `no_answer` (every port timed out), `refused` (every port refused), `needs_key` (401/403), `not_ai`, then
    per-model problems over all models: `short_context`, `none_loaded`, `no_chat`, `no_models`.
  - `detail` is Prometheus's own sentence, for Copy details. It never echoes an answer's body.
- **`GET /api/setup/detect`** keeps `backends` (each with `models: [string]`, unchanged, for the old wizard) and adds
  `local: <the answer above, target null>`.
- **`POST /api/setup/configure`** with a local provider re-runs the probe for that `base_url` and requires the named model to be
  `usable` there. Otherwise it refuses `backend_unreachable` with the `reason`, or `model_not_served`. It also accepts
  `openai_compatible`. An app identified only as `openai_compatible` is accepted for `llama_cpp`, `lm_studio` and `vllm`
  too, because the old wizard labels every typed address `llama_cpp`. That keeps it working. It writes `context.effective_limit` as the measured window when one was measured and is smaller than the
  default, so LM Studio and vLLM (no window detection at boot) are budgeted at what they serve. New codes go in
  `web/setup_errors.py` `CATALOG` and `docs/contracts/setup-errors.md`.
- **`GET /api/setup/status`** adds `features: ["local_probe", "model_local"]` (the second only once P2 is in the same build).
- **Test hooks:** `local_probe.KNOWN_PLACES` (the four ports) is a module constant a test or recorder can point at stand-in apps
  on ephemeral ports, the way `key_check`'s are.

### 4.2 PR P2: switch to a local AI after setup

- `PUT /api/model` accepts `{provider: ollama | lm_studio | llama_cpp | vllm | openai_compatible, base_url, model}`, runs the
  same probe and `usable` rule, and saves with `applied: "on_restart"`, as the cloud switch does. A switch to local blanks the
  inline `api_key` and `base_url_env`, the way the cloud switch blanks what would carry over. A local-to-cloud switch blanks the
  `base_url`. Refusals use the §4.1 reasons as codes.
- `POST /api/model/probe {target?}`, operator only, answers the §4.1 shape. With no target, it looks at the computer Prometheus
  runs on.
- `GET /api/model` reports a local current choice as `{provider, model, base_url}`. Beacon names it "{app} · {ai} on {where}".

### 4.3 The floor: `min_window`, measured before it is set

Prometheus owns the number, because it knows its own overhead; Beacon only shows it.

- **Measure:** round 0 of a fresh install's first turn, in server tokens: Prometheus's `scripts/local_gate/measure_floor.py`
  drives real setup mode with no config (pair, configure for the server through the logging proxy, complete), then sends Beacon's
  first suggestion, and reads the first request that offers tools (`usage.prompt_tokens`; Ollama's `prompt_eval_count`).
- **Set (decided 2026-10-20):** `min_window` = round 0 + the local reply cap (`LOCAL_OUTPUT_CAP`, 4,096) + 4,096 of
  conversation, rounded up to the next multiple of 4,096, plus 4,096 of headroom (`local_probe.min_window_for`). The card says
  that number.
- **Measured 2026-10-20:** llama.cpp (a 27B on a desktop GPU, 51 tools offered): round 0 = 8,253, so the need is 16,445 and
  the floor is **24,576**. Ollama: pending (the GPU box's Ollama was stuck); it changes the floor only if its round 0 is
  above 12,288.
- **Until measured,** the red tests use the fixture's `min_window` and never a constant of Beacon's.

## 5. Beacon

### 5.1 The pure half: `src/shared/local-ai.ts`

- `normalizeTarget(text)` → `{ok: true, target} | {ok: false}`: the §4.1 forms, trimmed, checked before any call.
- `readLocalAnswer(status, body)` → the found rows (usable ones only, in §2.1's order) and the card. An unknown `reason`, a missing
  field or a non-200 is the "couldn't check" card, never found.
- `localCard(reason, {name, app, ai, min})` → title and body (§3).
- `pickInitial(look, touched)` → which card and row is selected (§2.4).
- `localConfigureBody(row)` → `{provider, base_url, model}`, no key.
- `localFeatures(status)` → whether Prometheus can probe, and whether it can switch (§5.3).
- Display names: `ollama` Ollama, `lm_studio` LM Studio, `llama_cpp` llama.cpp, `vllm` vLLM, `openai_compatible` "An AI app".

### 5.2 Main and IPC (CLAUDE.md's setting recipe; `handleFromShell`; bump `REGISTRATIONS`)

- `IPC.MODEL_LOCAL_LOOK` (`model:local-look`): main calls `GET /api/setup/detect` with the setup credential and answers the view.
- `IPC.MODEL_LOCAL_TEST` (`model:local-test`, text): `normalizeTarget`, then `POST /api/setup/probe`.
- `IPC.MODEL_LOCAL_CHOOSE` (`model:local-choose`, row id): holds `{kind: 'local', provider, base_url, model}` for the finish.
- **The page never sees a `base_url`.** It gets row ids, the app's display name, the AI's id, and where it is ("this Mac" or the
  typed name). Main keeps the rows of the last look and test, and drops them when the finish ends.
- `IPC.MODEL_FINISH`: the held choice is a cloud key or a local row. `ModelSetup.finish` sends `localConfigureBody` for a local
  row; `complete` and the owner trade are unchanged. A configure refusal with a §4.1 reason is the `local-gone` failure (§2.5),
  and the master token is not marked owner.

### 5.3 What Prometheus can do, decided once

`GET /api/setup/status` `features`:
- No `local_probe`: the local card shows "can't look with this version", and cloud is Quickest. Detect is not called.
- `local_probe` without `model_local`: the local card works, and the cloud card leaves out "You can switch to local any time."
- Both: the full screen.

### 5.4 The machine (`src/shared/onboarding.ts`)

- `continue` on A2 carries `choice: 'cloud' | 'local'`: cloud goes to A3c-1, local to A5. A2's `continue` without a choice does
  nothing.
- `chooseAgain`: A5 → A2, only when A5 failed `local-gone`. Its history is A2's own (Back to W2).
- Everything else as O9.

### 5.5 Strings (`src/shared/onboarding-strings.ts`, `a2`)

`cloud.title` "Quick start with a cloud AI"; `cloud.detail` without the last sentence, and `cloud.switch` "You can switch to local
any time."; `local.*` (§2.1 and §3); `download` "Download an AI to this Mac" / "Coming soon."; `tags.ready` "Ready";
`tags.quickest` "Quickest". `private` and A2's use of `common.recommended` go.

## 6. Settings: Config → Models → Main model

- A group "On your own computers", under the cloud companies. It uses the same look, Test and rows (§2.1), through
  `POST /api/model/probe`, and Save sends §4.2's `PUT /api/model`. Then **Restart now**, as for a cloud change.
- "Now:" names a local choice "{app} · {ai} on {where}".
- Shown only when Prometheus's answer to `GET /api/model` lists local providers among its choices (P2). Otherwise the section is
  as today.
- Copy held to the banned-word list, as the section is today (`smoke:main-model`).

## 7. Tests

### 7.1 Red now (this commit)

- **Beacon `smoke:local-ai`** (new): `@shared/local-ai` against an assumed-shape fixture (`src/main/fixtures/local_probe_assumed.json`,
  marked assumed and replaced by a recording, §7.3), the machine's two new events, the A2 strings, and `ModelSetup`'s local finish
  in a world of fakes. The stubs compile and answer wrongly, so `verify` is red on exactly this smoke.
- **Prometheus `tests/test_setup_local_probe.py`** (new): stand-in apps on ephemeral ports (Ollama, LM Studio, llama.cpp, vLLM,
  an HTML page, a 401, a redirect, a slow one, an embedding-only Ollama, an LM Studio with nothing loaded, a short window) behind
  `local_probe.KNOWN_PLACES`; every reason; app identified by answer, not port (the `llama_cpp` mislabel as a regression test);
  redirects not followed; the size cap; the parallel budget; detect's new `local` field beside the unchanged `backends`; configure's
  refusals and its `effective_limit`; `features`. The stub module answers wrongly, so these fail and the rest of the suite does not.

### 7.2 Written while building

- `smoke:onboarding-copy`: covers the new strings by itself (it walks the module). `smoke:ipc-sender`: the three registrations.
- `smoke:main-model`: a local current choice read, local rows offered only with P2, a local PUT body.
- Prometheus: P2's `PUT /api/model` local, its refusals and blanking, `POST /api/model/probe` operator only.
- `scripts/onboarding-local-probe.mjs`: the real app with real clicks, against a real Prometheus in a scratch home with
  `KNOWN_PLACES` pointed at stand-in apps on ephemeral ports (never 11434 or 1234 on the machine: real apps and other sessions use
  them), and a stand-in that answers chat. It checks:
  - found, preselected, then on to F1;
  - nothing found, and cloud is Quickest;
  - each Test card;
  - Choose again;
  - "can't look with this version" against a Prometheus without the route;
  - the rendered DOM against the banned-word list.
  It is run first on the unmodified build, and its PASS lines read, so a check that passes on an empty screen is caught.
- A sweep of about 25 targeted mutants over the readers, the selection rule, the finish and the probe's rules, each checked to
  have applied.

### 7.3 Recorded, not assumed

- `scripts/record-local-probe-<PR>.mjs`: a real Prometheus with P1 answering detect, probe and configure against the stand-ins, into
  `src/main/fixtures/local_probe_<PR>.json`. It replaces the assumed fixture, and the smoke reads it.
- One capture each of a real Ollama's and a real LM Studio's answers to the §4.1 paths, kept with Prometheus's tests, so the
  stand-ins are held to the real apps' shapes. Where they differ from §4.1, §4.1 changes.
- By hand before release: this Mac with a real Ollama and a real LM Studio, and one other computer by name. Anything not run is
  said so.

## 8. Order

1. This spec and the red tests (Beacon `smoke:local-ai`; Prometheus `test_setup_local_probe.py`).
2. Prometheus P1, then P2, and the §4.3 measurement. A Prometheus release (onboarding installs the latest).
3. The recorded fixtures (§7.3).
4. Beacon: the pure module, IPC, the machine, the screen, the finish; then Settings (§6).
5. The app probe, the mutation sweep, the hand check.
6. Public copies: Prometheus PRs and the Beacon mirror each get the scan and the owner's go before any push.

## 9. Open

- `needs_key` (vLLM `--api-key`, LM Studio with authentication on): refused, with no field for a key. A later version may add one.
- Ollama on another computer listens on its own machine only by default (`OLLAMA_HOST`). The `refused` card says "whoever set it
  up can allow it", and Copy details names the setting. A help page would do better.
- A window of `null` (an app that does not say) is allowed. Prometheus warns at boot, since Prometheus PR 814.
