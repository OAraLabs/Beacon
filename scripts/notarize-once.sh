#!/usr/bin/env bash
# Notarize a build that already exists — the "run the gate once, now" script.
#
# RELEASE-CHECKLIST §2 names notarization as the ship gate, and as of 2026-09-03 it had NEVER been
# executed from this pipeline (no APPLE_* env, no notarytool profile; the installed app assessed as
# "Unnotarized Developer ID"). This runs the real thing against a throwaway build so the first
# failure — an entitlement, a stapling detail, an unsigned helper — happens on a quiet afternoon.
#
# One-time, by a human (it prompts for the app-specific password; nothing in this repo sees it):
#   xcrun notarytool store-credentials beacon --apple-id <apple-id> --team-id 53JM8W47RL
# Then:
#   npm run pack:mac && APPLE_KEYCHAIN_PROFILE=beacon bash scripts/notarize-once.sh
#
# Outcome is read off the machine, not off a success message: spctl must ACCEPT the stapled app
# as "Notarized Developer ID" at the end, or this exits non-zero.
set -euo pipefail
APP="${1:-dist/mac-arm64/Beacon.app}"
PROFILE="${APPLE_KEYCHAIN_PROFILE:?set APPLE_KEYCHAIN_PROFILE=<notarytool profile name>}"
[[ -d "$APP" ]] || { echo "no bundle at $APP — run: npm run pack:mac" >&2; exit 2; }

echo "==> pre-flight: every Mach-O signed + hardened (what notarytool checks first)"
bash "$(dirname "$0")/sign-audit.sh" "$APP" | tail -3

ZIP="$(mktemp -d)/$(basename "$APP" .app).zip"
echo "==> zipping for submission → $ZIP"
ditto -c -k --keepParent "$APP" "$ZIP"

echo "==> submitting (this waits for Apple; usually 1–5 min)"
LOG="$(mktemp)"
if ! xcrun notarytool submit "$ZIP" --keychain-profile "$PROFILE" --wait 2>&1 | tee "$LOG"; then
  echo "submit failed — see above" >&2; exit 1
fi
ID="$(grep -m1 '  id: ' "$LOG" | awk '{print $2}')"
STATUS="$(grep -m1 '  status: ' "$LOG" | awk '{print $2}')"
if [[ "$STATUS" != "Accepted" ]]; then
  echo "==> status=$STATUS — fetching Apple's log for $ID (the actual reasons)"
  xcrun notarytool log "$ID" --keychain-profile "$PROFILE" || true
  exit 1
fi

echo "==> stapling the ticket to $APP"
xcrun stapler staple "$APP"
xcrun stapler validate "$APP"

echo "==> Gatekeeper's verdict (the only line that matters):"
VERDICT="$(spctl -a -vv "$APP" 2>&1 || true)"
echo "$VERDICT"
grep -q "source=Notarized Developer ID" <<<"$VERDICT" || { echo "NOT accepted as notarized" >&2; exit 1; }
echo "==> notarized. submission id: $ID"
