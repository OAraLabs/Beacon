# Contributing to Beacon

Beacon is small on purpose. It is the desktop window onto
[Prometheus](https://github.com/OAraLabs/Prometheus), and most of what it can do comes from the daemon.

## What's welcome

- **Bug reports.** Open an issue with the Beacon version, your OS, what you did, what you expected and what
  happened. Leave out API tokens, pairing codes and your conversations.
- **Security reports.** Never in a public issue: see [SECURITY.md](SECURITY.md).
- **Fixes for reported bugs.** Link the issue in the pull request.

## Feature pull requests

They are read, but most are declined. Beacon's surface is kept small so it stays easy to trust and easy to
maintain. **Open an issue first** and describe what you want to change and why, before you write code.
Extras usually belong in a Prometheus plugin, a skill or an MCP server, not in Beacon itself.

## Working on the code

```bash
npm ci
npm run dev            # the app, against your own Prometheus
npm run verify         # typecheck, lints, build and every smoke: run it before you open a pull request
```

Each change comes with the smoke or lint that would have caught it: a test that fails without the change and
passes with it.

## Sign-off (DCO)

Every commit must be signed off under the [Developer Certificate of Origin](https://developercertificate.org/):

```bash
git commit -s
```

This adds `Signed-off-by: Your Name <you@example.com>` and certifies that you wrote the change, or have the
right to submit it, under the project's [MIT License](LICENSE).
