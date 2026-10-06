# Security policy

## Reporting a vulnerability

Please report security issues privately. Don't open a public issue, discussion or pull request for them.

1. **Preferred:** on this repository's **Security** tab, choose **Report a vulnerability**. This opens a private advisory that only you and the maintainers can see.
2. **If you can't use GitHub:** email **support@oara.ai** with a subject starting `SECURITY: Beacon`. Don't include working exploit code in the first message; we'll reply with a way to send details privately.

Please include:

- the Beacon version (macOS: **Beacon → About Beacon**; Linux: the version in the AppImage's file name, or `dpkg -s beacon-desktop` for the `.deb`), and your OS and its version;
- what an attacker can do, and what they need first (for example network access to the daemon, a local account, or a crafted link);
- steps to reproduce.

Leave out real API tokens, pairing codes, and your conversations. If something you need to show contains them, replace them with placeholders.

## What to expect

- We confirm we received your report within **[N] business days**.
- We keep you updated while we investigate and fix it, and agree a disclosure date with you.
- We credit you in the release notes for the fix, unless you'd rather we didn't.

## Scope

This policy covers the Beacon desktop application released from this repository, including its update feed. Vulnerabilities in the Prometheus daemon belong in [OAraLabs/Prometheus](https://github.com/OAraLabs/Prometheus/security).

## Supported versions

Only the latest release receives security fixes. Beacon updates itself, so make sure you're on the newest version before reporting.
