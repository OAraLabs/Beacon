# Beacon desktop: notes for coding agents

Traps and recipes, not a tour. Each one has already cost a session real time.

## This repo is public

OAraLabs/Beacon is the only working repo, and it is public (MIT). Every push, branch, tag, PR, issue
and comment is published the moment it lands, and can't be taken back.

- **Before any push**, scan what you are about to publish (the diff, the commit messages, the PR or
  issue text) for tokens and secrets, tailnet addresses (100.64/10) and `*.ts.net` names, real
  computer names, email addresses other than support@oara.ai, real people's names, and absolute
  paths from your machine (`/Users/…`, `/home/…`). `npm run lint:names` checks src/, scripts/,
  .github/ and the root files, not docs/; read docs/ yourself. Report the result and push only on
  the owner's go.
- **The private predecessor.** Development before 2026-10-21 happened in a private repo,
  OAraLabs/beacon-desktop, now archived. A local read-only copy may sit at
  `~/projects/_archive/beacon-desktop` with pushing disabled. Read it for history; never add it as a
  remote here, never fetch or merge its history into this repo, and never copy its files without
  the same scan (its history holds what was scrubbed from this tree).
- **Old numbers.** A `#NNN` or "PR NNN" in a comment or doc written before 2026-10-21 means a
  beacon-desktop PR, not one here. Write new references to them as "beacon-desktop PR NNN", never
  `#NNN`, which GitHub links to an unrelated item in this repo.
- **Never rename the package.** `package.json` `"name": "beacon-desktop"` is the profile folder
  (`~/Library/Application Support/beacon-desktop`, `~/.config/beacon-desktop`), the Keychain item,
  the `.deb` package and the updater's cache folder. Renaming it strands every installed user's data.

## Releases

`docs/RELEASE-CHECKLIST.md` is the recipe: bump, tag `vX.Y.Z` on main, approve the `release`
environment, check the draft, and the owner publishes by hand. The feed installed apps read is this
repo's releases, so publishing a release is shipping an update to every user. A dry run is a
suffixed tag (`vX.Y.Z-dryrun.N`) that makes a prerelease draft; delete the draft and the tag after,
on the owner's OK.

## One item, one worktree

    scripts/new-worktree.sh <name> [branch]

Makes `.claude/worktrees/<name>` from a freshly fetched `origin/main` and runs `npm ci` in it.

- A worktree has no `node_modules` of its own. Skip `npm ci` and the build resolves upward into the
  main checkout's copy, then fails on whatever that copy lacks, with an error that doesn't say why.
- Don't symlink the main checkout's `node_modules` into a worktree. Install.
- Create the worktree before writing any file into it. A write that creates the directory first
  makes `git worktree add` fail with "already exists".

## Checking your work

    npm run typecheck                        # tsconfig.node.json + tsconfig.web.json
    npm run build && npm run smoke:<name>    # one smoke
    npm run verify:quick                     # typecheck, lints, a few fast smokes, build: the edit loop
    npm run verify                           # typecheck, lints, build, every smoke (~150 s): before you push

- Smokes run the built `out/main/<name>-smoke.js`, so a smoke tests whatever you last built.
  Rebuild after editing.
- CI runs `npm run verify` on macos-latest.
- Two smokes fail on Linux, whatever you changed:
  - `smoke:terminal` spawns `/bin/zsh`, which the Linux box doesn't have.
  - `smoke:install-guard` runs `scripts/install-local.sh`, the macOS installer.

## Paths to Beacon's own files

- In `src/main`, a path to build output starts from `import.meta.mainOutDir` (out/main), never
  `__dirname`. `__dirname` is the directory of whichever chunk rollup put the module in, and a new
  build input that imports the module moves it: in beacon-desktop PR 190 a smoke's import moved the sender check into
  `out/main/chunks/`, it refused Beacon's own page, and the app sat on "Loading…" with every check
  green. Windows load with `loadShellPage(win, route)` and bridge with `shellPreload()`
  (`src/main/shell-windows.ts`). `smoke:shell-url` fails a `__dirname` anywhere in `src/main`.

## Recipe: a setting that main has to honour

The order launch at login (beacon-desktop PR 182) used. Put the decision itself in a pure module
under `src/shared/` (there: `src/shared/login-item.ts`) so a smoke can test it without a window.

1. **IPC key**: add to `IPC` in `src/shared/ipc.ts`, e.g. `LOGIN_ITEM_GET: 'login-item:get'`.
2. **Bridge type**: add to `interface BeaconBridge` in the same file.
3. **Preload**: add to the `api: BeaconBridge` object in `src/preload/index.ts`, calling
   `ipcRenderer.invoke(IPC.…)`.
4. **Main handler**: `handleFromShell(IPC.…, …)` (a send: `onFromShell`) inside `app.whenReady()` in
   `src/main/index.ts`. Not `ipcMain.handle`: the helpers in `src/main/shell-windows.ts` refuse any
   sender that is not the shell page in a window Beacon created, and `smoke:ipc-sender` fails a raw
   registration that does not check its sender first. It also pins each file's registration count,
   so bump `REGISTRATIONS` in `src/main/ipc-sender-smoke.ts`.
5. **Settings section**: a `…Section` component in
   `src/renderer/src/components/ConnectionSettings.tsx`, mounted in `ConnectionSettings`.
6. **Smoke**: `src/main/<name>-smoke.ts`, registered in both configs:
   - `electron.vite.config.ts`: a main build input, `'<name>-smoke': resolve('src/main/<name>-smoke.ts')`.
     Without it nothing is built for the smoke to run.
   - `package.json`: `"smoke:<name>": "ELECTRON_RUN_AS_NODE=1 electron out/main/<name>-smoke.js"`.
     `smoke:all` runs every `smoke:*` script, so this line is what puts it in `verify`.

## Driving the real app

- A packaged probe needs a PROBE build: `npm run pack:mac:probe` → `dist-probe/mac-arm64/Beacon.app`.
  A release (`pack:mac`, `dist`, anything built from `electron-builder.yml`) exits at startup on
  `--remote-debugging-port`/`-pipe` and ignores `--inspect` (fuse), so a probe attaching to it finds
  no target and reports on nothing. The probe build differs in exactly those two
  (`electron-builder.probe.yml`) and has its own bundle id and package name, so launched bare it
  opens `~/Library/Application Support/beacon-desktop-probe`, not the real profile. `audit:bundle`,
  and so `install-local`, refuse it. `npm run probe:hardening` checks both builds.
- Dev runs are unaffected: `electron .` (the repo's package.json has no `beaconBuild`) keeps every switch,
  and the smokes run node_modules' Electron, whose fuses are never flipped.
- `scripts/app-driver.mjs` is macOS-only: it hard-codes `~/Library/Application Support/beacon-desktop`
  and the macOS layout of the Electron binary (the driven checkout's own `node_modules/electron`, so
  run `npm ci` in a worktree before probing from it). So are the probes built on it (`drafts-app-probe`,
  `error-boundary-app-probe`, `launch-restore-app-probe`). On Linux, drive the app through
  `scripts/cdp-harness.mjs` with `BEACON_CDP_ARGS="--user-data-dir=<tmp dir>"`. It launches the repo's
  Electron binary in its own process group and ends the whole group when the probe exits
  (`npm run probe:harness-reap` pins that). A shell with no desktop session needs `DISPLAY` (and
  `XAUTHORITY`); where Chromium has no usable sandbox, add `--no-sandbox`, and only against a local
  fake gateway. If you launch the app yourself, spawn the Electron binary, not `npx electron`:
  killing npx does not reach Electron, and Beacon does not exit on a plain SIGTERM.
- Don't reload with `location.reload()` through the page target. In a built app it does nothing: the
  shell loads from `file://`, `location.reload()` raises `will-navigate`, and the navigation guard
  every Beacon window gets (`adoptShellWindow`, `src/main/shell-windows.ts`) refuses everything but
  `about:blank` and the dev server (main logs `[shell] refused will-navigate away from the shell
  page`). CDP `Page.reload` and `webContents.reload()` from main skip that event and do reload.
  Set a `window` marker before reloading and assert it's gone after, or a reload that never happened
  passes. App code has the same trap: a renderer that needs to reload itself calls
  `window.beacon.reloadWindow()`, which asks main to reload the sender (the error boundary's
  "Reload Beacon" does this).
