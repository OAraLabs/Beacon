#!/usr/bin/env bash
# Notarization-readiness audit: what notarytool checks statically, run locally.
# Every Mach-O in the bundle must be signed by the Developer ID, with hardened runtime and a
# secure timestamp; the bundle must pass --deep --strict. Prints a table + a summary line.
set -u
APP="$1"
bad=0; total=0
while IFS= read -r -d '' f; do
  if file -b "$f" | grep -q "Mach-O"; then
    total=$((total+1))
    info=$(codesign -dvv "$f" 2>&1)
    flags=$(echo "$info" | grep -o 'flags=0x[0-9a-f]*([^)]*)' | head -1)
    auth=$(echo "$info" | grep '^Authority=' | head -1 | sed 's/Authority=//')
    ts=$(echo "$info" | grep -c '^Timestamp=')
    archs=$(lipo -archs "$f" 2>/dev/null)
    ok=yes
    echo "$flags" | grep -q runtime || ok=NO-RUNTIME
    echo "$auth" | grep -q "Developer ID Application" || ok=NOT-DEVID
    [[ "$ts" == "1" ]] || ok=NO-TIMESTAMP
    [[ "$ok" == "yes" ]] || bad=$((bad+1))
    printf '%-14s %-10s %-22s %s\n' "$ok" "$archs" "$flags" "${f#$APP/}"
  fi
done < <(find "$APP" -type f -print0)
echo "---"
codesign --verify --deep --strict --verbose=1 "$APP" 2>&1 | tail -2
echo "deep-strict exit=$?"
echo "mach-o files: $total, failing: $bad"
[[ $bad == 0 ]]
