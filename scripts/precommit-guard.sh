#!/usr/bin/env bash
# Pre-commit guard (spec §3.4/§8). Scans STAGED, added (+) lines in two categories:
#
#   • REAL SECRETS — ALWAYS enforced, NOT pragma-able: real Tailscale IPs (100.64.0.0/10),
#     SSH private keys, and provider keys/tokens (AWS AKIA, GitHub gh?_, Slack xox?-, real
#     `Bearer <token>` literals). You CANNOT pragma a real IP / key / token away.
#
#   • ILLUSTRATIVE HOSTS — a *.ts.net example in a test or placeholder. Exempt PER LINE with a
#     trailing  `precommit:allow-example-host`  comment. That pragma exempts ONLY this host
#     check on that one line — it does NOT touch any real-secret check above.
#
# The gateway ADDRESS lives in app-data (gateway_profiles); the API TOKEN in the OS keychain —
# never in source. Markdown and this scanner itself are exempt from scanning.
# Install:  ln -sf ../../scripts/precommit-guard.sh .git/hooks/pre-commit
set -uo pipefail

diff=$(git diff --cached --diff-filter=ACM -- . ':(exclude)*.md' ':(exclude)*.markdown' ':(exclude)scripts/precommit-guard.sh' 2>/dev/null || true)
added=$(printf '%s\n' "$diff" | grep -E '^\+' || true)
fail=0

# ── REAL SECRETS (never pragma-able) ──────────────────────────────────────────
if printf '%s\n' "$added" | grep -qE '100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.[0-9]+\.[0-9]+'; then
  echo "✗ pre-commit: a real Tailscale-range IP (100.64.0.0/10) is in staged source."
  fail=1
fi
if printf '%s\n' "$added" | grep -qE -e '-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|Bearer [A-Za-z0-9_-]{20,}'; then
  echo "✗ pre-commit: a real secret (SSH private key / API key / token) is in staged source."
  fail=1
fi
if git diff --cached --name-only | grep -qE 'api-credential\.bin$'; then
  echo "✗ pre-commit: the credential blob (api-credential.bin) must never be committed."
  fail=1
fi

# ── ILLUSTRATIVE *.ts.net HOSTS (pragma-able per line) ─────────────────────────
if printf '%s\n' "$added" | grep -E '[a-z0-9-]+\.ts\.net' | grep -vF 'precommit:allow-example-host' | grep -q .; then
  echo "✗ pre-commit: a *.ts.net hostname is in staged source."
  echo "  → If it's a sanctioned example (test/placeholder), append: // precommit:allow-example-host"
  fail=1
fi

if [ "$fail" -ne 0 ]; then
  echo "  → Gateway address belongs in app-data (gateway_profiles); token in the OS keychain."
  exit 1
fi
exit 0
