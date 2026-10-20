#!/usr/bin/env bash
#
# install-local.sh — put the freshly built Beacon where macOS will actually run it.
#
# WHY THIS EXISTS
# ---------------
# `npm run dist` writes dist/mac-arm64/Beacon.app. It does NOT touch the copy in
# /Applications, and macOS LaunchServices resolves an app by its BUNDLE ID
# (com.oaralabs.beacon) rather than by the icon you clicked. So with two copies
# on disk, double-clicking a freshly-built one on the Desktop can silently launch
# the stale /Applications build instead.
#
# Observed 2026-07-31: /Applications/Beacon.app dated Jul 16 kept launching even
# though the Desktop copy had just been rebuilt — four rebuild cycles were spent
# chasing "the build didn't take" when the build was fine every time.
#
# This script makes /Applications the single installed copy, removes duplicate
# bundles that create the ambiguity, and leaves a Desktop ALIAS (a pointer, not
# a second app) so the icon still works.
#
# Usage:  npm run install-local        (builds, then installs)
#         ./scripts/install-local.sh   (installs an existing dist/ build)

set -euo pipefail

APP_NAME="Beacon.app"
# The Desktop alias is NOT named "Beacon.app" — Finder names an alias after the
# original's DISPLAY name, so the file on disk is "Beacon". See step 4.
ALIAS_NAME="${APP_NAME%.app}"
BUNDLE_ID="com.oaralabs.beacon"
# Overridable so install-guard-smoke can run one real install into a temp dir.
INSTALL_DIR="${BEACON_INSTALL_DIR:-/Applications}"
# Overridable so step 4 can be exercised without writing to the real Desktop.
DESKTOP="${BEACON_DESKTOP_DIR:-$HOME/Desktop}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Overridable so the behaviour below can be tested without a real build tree.
DIST_ROOT="${BEACON_DIST_ROOT:-$REPO_ROOT/dist}"
# Resolve + validate + report, then stop. Used by install-smoke.
DRY_RUN="${BEACON_INSTALL_DRY_RUN:-}"

die() { echo "error: $*" >&2; exit 1; }

# Places step 3 looks for full copies, and every bundle this install replaces or
# deletes: the installed one, plus each duplicate step 3 will actually delete. A
# symlink is not one, in either place: step 2's rm -rf removes only a link in the
# install slot, and step 3 leaves one alone, so what it points to (a dist/ build,
# say) is not this install's to stop. The list can be empty; bash 3.2 cannot
# expand an empty array under set -u, so each loop over it is guarded.
DUPLICATE_BUNDLES=("$DESKTOP/$APP_NAME" "$HOME/Downloads/$APP_NAME")
REPLACED_BUNDLES=()
if [[ ! -L "$INSTALL_DIR/$APP_NAME" ]]; then REPLACED_BUNDLES+=("$INSTALL_DIR/$APP_NAME"); fi
for dup in "${DUPLICATE_BUNDLES[@]}"; do
  if [[ -d "$dup" && ! -L "$dup" ]]; then REPLACED_BUNDLES+=("$dup"); fi
done

# ── Step 1's targets: this app, by path, never by name ──────────────────────
#
# ⚠ THIS STOPPED EVERYTHING CALLED "Beacon", INCLUDING THE iOS APP.
#
# Step 1 found the app with `pgrep -x Beacon` and, if it had not quit within
# 10 s, ran `pkill -x Beacon`. The iOS Beacon running in the Simulator is also a
# process named exactly Beacon (…/CoreSimulator/Devices/…/Beacon.app/Beacon).
# Observed 2026-10-05: pgrep matched it and /Applications/Beacon.app both, so the
# wait never saw "no Beacon", and the pkill killed the Simulator's app. Its bundle
# id is com.oaralabs.beacon too, so the id cannot tell them apart either.
#
# A process is a target only when its path is Contents/MacOS/Beacon inside a
# bundle this install replaces or deletes. Anything else called Beacon is named
# in the output and left alone, unless its path cannot be placed at all, and
# then the install refuses rather than guess.

# "<kind> <pid> <path>" for every process whose executable the kernel names
# Beacon (ps ucomm: what `pgrep -x Beacon` matched, and what argv[0], exec -a or
# a process title cannot change). <path> is argv[0] (ps comm).
#   target   argv[0] is, or is another spelling of, Contents/MacOS/Beacon in a
#            bundle this install replaces or deletes. Spellings are compared by
#            device and inode, so a symlink, a case variant on case-insensitive
#            APFS or the /System/Volumes/Data firmlink is still this app.
#   other    any other absolute path that exists: the iOS Simulator's Beacon, a
#            dist/ build a packaged probe is running, a mounted DMG
#   unknown  argv[0] that does not say which bundle it runs from: relative, a
#            process title, a path that does not exist (an exec -a spoof of the
#            installed app, or a bundle deleted while it runs), not canonical
#            (/./, /../, //) without resolving to a replaced bundle, or under App
#            Translocation, where an app opened in place from a download runs
#            from a read-only copy
# Run it in $(…) and check the status: a failed ps is not "nothing running".
beacon_processes() {
  local names paths pid name exe kind bundle id ids=""
  names="$(ps -axo pid=,ucomm=)" || die "could not list processes, so cannot tell whether Beacon is running; nothing was installed"
  paths="$(ps -axo pid=,comm=)" || die "could not list processes, so cannot tell whether Beacon is running; nothing was installed"
  for bundle in ${REPLACED_BUNDLES[@]+"${REPLACED_BUNDLES[@]}"}; do
    if id="$(stat -L -f %d:%i "$bundle/Contents/MacOS/Beacon" 2>/dev/null)"; then ids="$ids $id "; fi
  done
  while read -r pid name; do
    [[ "$name" == "Beacon" ]] || continue
    exe="$(awk -v p="$pid" '$1 == p { sub(/^ *[0-9]+ /, ""); print; exit }' <<<"$paths")"
    [[ -n "$exe" ]] || continue # it exited between the two lists
    case "$exe" in
      */AppTranslocation/*) kind=unknown ;;
      /*) kind=other ;;
      *) kind=unknown ;;
    esac
    if [[ "$kind" == other ]]; then
      for bundle in ${REPLACED_BUNDLES[@]+"${REPLACED_BUNDLES[@]}"}; do
        if [[ "$exe" == "$bundle/Contents/MacOS/Beacon" ]]; then kind=target; fi
      done
    fi
    if [[ "$kind" == other ]]; then
      if id="$(stat -L -f %d:%i "$exe" 2>/dev/null)" && [[ "$ids" == *" $id "* ]]; then
        kind=target
      elif [[ ! -e "$exe" ]]; then
        kind=unknown
      else
        case "$exe" in */./* | */../* | *//*) kind=unknown ;; esac
      fi
    fi
    echo "$kind $pid $exe"
  done <<<"$names"
}

# The target pids in a beacon_processes listing, each after a space.
target_pids() {
  local kind pid exe out=""
  while read -r kind pid exe; do
    if [[ "$kind" == target ]]; then out="$out $pid"; fi
  done <<<"$1"
  echo "$out"
}

# True once nothing runs from a replaced bundle. Polls every 0.5 s, $1 times.
targets_exit_within() {
  local procs _
  for _ in $(seq 1 "$1"); do
    procs="$(beacon_processes)" || exit 1
    grep -q '^target ' <<<"$procs" || return 0
    sleep 0.5
  done
  return 1
}

# Why beacon_processes called argv[0] unknown, for the refusal: the same rules.
unplaced_reason() {
  case "$1" in
    */AppTranslocation/*) echo "App Translocation: an app opened in place from a download" ;;
    /*)
      if [[ ! -e "$1" ]]; then
        echo "not on disk: deleted, moved or trashed while it runs, or a spoofed argv[0]"
      else
        echo "not canonical (/./, /../ or //), and not a bundle this install replaces"
      fi
      ;;
    *) echo "not an absolute path: relative, or a process title" ;;
  esac
}

# Step 1. Lists every process called Beacon, then quits the targets; a dry run
# stops at the list.
stop_running_beacon() {
  local procs kind pid exe pids others="" unknown=""
  procs="$(beacon_processes)" || exit 1
  while read -r kind pid exe; do
    case "$kind" in
      target) echo "==> Beacon is running from a bundle this install replaces: pid $pid  $exe" ;;
      other) others="$others $pid"; echo "    leaving pid $pid alone: it is called Beacon but is not this app  $exe" ;;
      unknown) unknown="$unknown $pid"; echo "==> cannot place pid $pid ($(unplaced_reason "$exe")): $exe" ;;
    esac
  done <<<"$procs"
  # Leaving it alone is not safe either: a translocated ~/Downloads copy runs
  # from the bundle step 3 deletes.
  [[ -z "$unknown" ]] || die "cannot tell which bundle pid$unknown runs from (why, above). Quit it, then re-run. Nothing was installed."
  pids="$(target_pids "$procs")"
  [[ -n "$pids" ]] || return 0

  # The quit Apple Event is addressed by bundle id, and every Mac Beacon answers
  # to com.oaralabs.beacon, a dist/ build a probe is running included. So it is
  # sent only when the targets are the only Beacons running; otherwise straight
  # to SIGTERM, which is addressed by pid. (The Simulator's Beacon shares the id
  # but is not registered with LaunchServices, so it is skipped needlessly.)
  if [[ -n "$DRY_RUN" ]]; then
    if [[ -n "$others" ]]; then echo "    dry run: would quit pid$pids by SIGTERM (a quit by bundle id could reach pid$others)"
    else echo "    dry run: would quit pid$pids with the quit Apple Event, then SIGTERM"; fi
    return 0
  fi
  if [[ -z "$others" ]]; then
    echo "==> quitting it"
    osascript -e "tell application id \"$BUNDLE_ID\" to quit" >/dev/null 2>&1 || true
    targets_exit_within 20 && return 0
    echo "==> still running after 10 s"
  else
    echo "==> another Beacon is running (pid$others), and a quit by bundle id could reach it: quitting by pid"
  fi

  # SIGTERM to the target pids is the same quit: Electron runs before-quit and
  # will-quit on it, as on ⌘Q (measured 2026-10-05, Electron 44). The Apple
  # Event also needs Automation permission for whatever runs this script, and
  # does not land without it. The pids are read again, not taken from the list
  # above: one may have exited and another started during the wait.
  procs="$(beacon_processes)" || exit 1
  pids="$(target_pids "$procs")"
  [[ -n "$pids" ]] || return 0
  echo "==> sending SIGTERM to pid$pids"
  # shellcheck disable=SC2086 # $pids is a list of pids
  kill -TERM $pids 2>/dev/null || true
  targets_exit_within 20 && return 0

  # No SIGKILL. An app that ignores a quit AND a SIGTERM is hung or busy, and
  # whoever is at the keyboard should decide what happens to it, not this script.
  procs="$(beacon_processes)" || exit 1
  pids="$(target_pids "$procs")"
  [[ -n "$pids" ]] || return 0
  die "Beacon is still running (pid$pids) after a quit and a SIGTERM. Quit it, then re-run. Nothing was installed."
}

# Step 5. Not for a BEACON_INSTALL_DIR install (install-guard-smoke's temp dir):
# registering a bundle that is about to be deleted leaves a stale record behind.
# Found 2026-10-05: 28 such records from smoke runs, now removed.
refresh_launchservices() {
  local lsreg="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"
  local status=0
  if [[ -n "${BEACON_INSTALL_DIR:-}" ]]; then
    echo "==> LaunchServices left alone: BEACON_INSTALL_DIR is set"
    return 0
  fi
  echo "==> refreshing LaunchServices"
  # The status, not just that it failed: 126 is "not allowed to run it" (the
  # smoke's sandbox), 127 "no such file". errexit is off around the call because
  # under set -e bash 3.2 reports a refused exec as 1, which lsregister itself
  # also returns. The app is installed either way.
  set +e
  "$lsreg" -f "$INSTALL_DIR/$APP_NAME" >/dev/null 2>&1
  status=$?
  set -e
  if [[ "$status" != 0 ]]; then
    echo "    (lsregister exited $status; the app is installed, LaunchServices will catch up)"
  fi
}

# Sourced (install-guard-smoke drives stop_running_beacon this way, against stub
# ps and osascript): the functions above are loaded, and nothing below runs.
[[ "${BASH_SOURCE[0]}" == "$0" ]] || return 0

[[ "$(uname -s)" == "Darwin" ]] || die "macOS only (this packages a .app bundle)"

# ── Locate the built app ────────────────────────────────────────────────────
#
# ⚠ THIS PREFERENCE ROTTED ONCE AND INSTALLED A 16-DAY-OLD BUILD.
#
# The original loop took the FIRST existing candidate, with dist/mac-arm64 at the
# head — correct when this was written (2026-08-01), because that is what the
# build emitted. #47 changed the mac target to `arch: [universal]` on 2026-08-15
# and the output moved to dist/mac-universal. The arm64 directory stayed on disk
# as a leftover and kept winning, so on 2026-08-17 this installed an Aug-1 bundle
# and printed "installed:" as if nothing were wrong.
#
# So preference order is NOT the fix — a reordering would rot the same way the
# next time the target changes. Freshness is the property that actually matters,
# so freshness is what is checked. Every candidate is collected, the choice is
# LOGGED when there is more than one, and a build older than HEAD is refused
# outright rather than silently installed.
CANDIDATES=()
for arch in mac-universal mac-arm64 mac-x64 mac; do
  [[ -d "$DIST_ROOT/$arch/$APP_NAME" ]] && CANDIDATES+=("$DIST_ROOT/$arch/$APP_NAME")
done
(( ${#CANDIDATES[@]} > 0 )) || die "no built app under $DIST_ROOT — run: npm run dist"

mtime_of() { stat -f %m "$1"; }

BUILT="${CANDIDATES[0]}"
for c in "${CANDIDATES[@]}"; do
  (( $(mtime_of "$c") > $(mtime_of "$BUILT") )) && BUILT="$c"
done

# Never pick silently. Two build directories on disk is exactly the ambiguity
# that produced the stale install, so if there is a choice, it is shown.
if (( ${#CANDIDATES[@]} > 1 )); then
  echo "==> MULTIPLE builds on disk — choosing the newest:"
  for c in "${CANDIDATES[@]}"; do
    marker="   "; [[ "$c" == "$BUILT" ]] && marker=" ->"
    echo "   $marker $(date -r "$(mtime_of "$c")" '+%Y-%m-%d %H:%M')  $c"
  done
  echo "    (delete the ones you do not want: they are rebuildable from dist/)"
fi

# ── Refuse a build older than the code it claims to be ──────────────────────
#
# A bundle built before the current HEAD commit CANNOT contain HEAD's code. That
# is a fact about time, not a heuristic, and it is the check that would have
# caught the Aug-1 install immediately.
BUILT_EPOCH="$(mtime_of "$BUILT")"
HEAD_EPOCH="$(git -C "$REPO_ROOT" log -1 --format=%ct 2>/dev/null || echo 0)"
if [[ "$HEAD_EPOCH" != "0" ]] && (( BUILT_EPOCH < HEAD_EPOCH )); then
  AGE_MIN=$(( (HEAD_EPOCH - BUILT_EPOCH) / 60 ))
  echo "error: the built app PREDATES the current commit — it cannot contain this code." >&2
  echo "         build: $(date -r "$BUILT_EPOCH" '+%Y-%m-%d %H:%M')  $BUILT" >&2
  echo "         HEAD:  $(date -r "$HEAD_EPOCH" '+%Y-%m-%d %H:%M')  $(git -C "$REPO_ROOT" rev-parse --short HEAD)" >&2
  echo "         older by ${AGE_MIN} minute(s)." >&2
  echo "       run: npm run dist" >&2
  echo "       (deliberate? BEACON_ALLOW_STALE_INSTALL=1 — it will say so loudly)" >&2
  [[ -n "${BEACON_ALLOW_STALE_INSTALL:-}" ]] || exit 1
  echo "==> ⚠ INSTALLING A STALE BUILD ON PURPOSE (BEACON_ALLOW_STALE_INSTALL=1)"
fi

# ── Say what is going in, BEFORE it goes in ─────────────────────────────────
#
# The old script announced the artifact only on the way out, and reported the
# INSTALLED copy's mtime — which cp sets to now, so it always looked fresh. It
# was measuring the copy, not the build, and could never have surfaced this.
BUILT_VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$BUILT/Contents/Info.plist" 2>/dev/null || echo '?')"
echo "==> installing from: $BUILT"
echo "    built:   $(date -r "$BUILT_EPOCH" '+%Y-%m-%d %H:%M')"
echo "    version: $BUILT_VERSION"
echo "    HEAD:    $(git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null || echo '?')"

if [[ -n "$DRY_RUN" ]]; then
  stop_running_beacon # lists what step 1 would quit; quits nothing
  echo "==> dry run — resolved and validated, nothing installed"
  exit 0
fi

# ── Refuse a bundle that carries what it must not ────────────────────────────
#
# The packager reads disk, not git, so a gitignored file with a real address in it ships
# unless something reads the ARTIFACT. This does. Found 2026-09-07: three design prototypes
# with tailnet addresses, and a 17 MB stale worktree, inside every build since Sept 3.
echo "==> auditing the bundle"
node "$REPO_ROOT/scripts/check-bundle.mjs" "$BUILT/Contents/Resources/app.asar" || die "the built bundle failed audit:bundle — not installing it"


# 1. Quit the running instance, and only it (see "Step 1's targets" at the top).
#    Replacing a bundle underneath a live process is what produces the "it
#    reverted after relaunch" symptom.
stop_running_beacon

# 2. Install to /Applications — the copy LaunchServices prefers.
echo "==> installing to $INSTALL_DIR"
rm -rf "${INSTALL_DIR:?}/$APP_NAME"
cp -R "$BUILT" "$INSTALL_DIR/"

# 3. Remove duplicate FULL COPIES elsewhere. Two bundles with one id is the
#    ambiguity itself. Aliases/symlinks are fine and are left alone.
for dup in "${DUPLICATE_BUNDLES[@]}"; do
  if [[ -d "$dup" && ! -L "$dup" ]]; then
    echo "==> removing duplicate copy: $dup (rebuildable from dist/)"
    rm -rf "$dup"
  fi
done

# 4. Desktop alias — the icon keeps working, without being a second app.
#
# ⚠ THIS GUARD CHECKED A NAME THAT IS NEVER CREATED, AND MINTED AN ALIAS A RUN.
#
# The condition was `! -e "$DESKTOP/$APP_NAME"` — i.e. ~/Desktop/Beacon.app. But
# `make alias file` names the alias after the original's display name, so what
# lands on the Desktop is "Beacon", not "Beacon.app". The guard therefore never
# matched, and Finder's collision handling renamed each new one: observed
# 2026-08-19 as Beacon, "Beacon alias", "Beacon alias 2" … "Beacon alias 5",
# six pointers to one app, one per install since 2026-08-01.
#
# So the guard now tests the name that actually appears, and the alias is given
# that name EXPLICITLY rather than inheriting whatever Finder picks — a rename
# upstream would otherwise start the pile over.
if [[ ! -e "$DESKTOP/$ALIAS_NAME" ]]; then
  echo "==> creating Desktop alias"
  osascript >/dev/null 2>&1 <<OSA || echo "    (alias skipped — Finder declined; the app is still installed)"
tell application "Finder"
  set newAlias to make alias file to POSIX file "$INSTALL_DIR/$APP_NAME" at POSIX file "$DESKTOP"
  set name of newAlias to "$ALIAS_NAME"
end tell
OSA
fi

# Strays from before the fix. Deleting things off someone's Desktop is not this
# script's call, so it says what it found and leaves them there.
STRAYS=("$DESKTOP/$ALIAS_NAME alias"*)
if [[ -e "${STRAYS[0]}" ]]; then
  echo "==> ${#STRAYS[@]} leftover Desktop alias(es) — safe to drag to the Trash:"
  for s in "${STRAYS[@]}"; do echo "      $s"; done
fi

# 5. Re-register so LaunchServices forgets the copies we just deleted.
refresh_launchservices

# 6. Report what is actually installed, so a stale result is visible immediately
#    rather than after another round of doubt.
echo
echo "installed: $INSTALL_DIR/$APP_NAME"
# The SOURCE build's time, not the copy's: cp stamps the copy with now, so the
# old line reported every install as fresh — including the 16-day-old one.
echo "  built:   $(date -r "$BUILT_EPOCH" '+%Y-%m-%d %H:%M')  (source build, not the copy)"
echo "  bundle:  $BUNDLE_ID"
REMAINING=$(find "$HOME/Desktop" "$HOME/Downloads" "$INSTALL_DIR" -maxdepth 1 -name "$APP_NAME" -type d 2>/dev/null | wc -l | tr -d ' ')
echo "  full copies on disk: $REMAINING (want 1)"
[[ "$REMAINING" == "1" ]] || echo "  WARNING: more than one copy — LaunchServices may still pick the wrong one"
echo
echo "open it with:  open -b $BUNDLE_ID"
