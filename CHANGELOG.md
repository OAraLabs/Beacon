# Changelog

Beacon's releases, newest first. Installers for each published version are on the
[Releases](https://github.com/OAraLabs/beacon/releases) page, which is also the update feed: Beacon 0.3.0 and
later update themselves.

## Unreleased

- **Each Prometheus keeps its own conversations.** Pointing Beacon at a different Prometheus (Settings → Connection, or Set up again and join another) used to leave the old one's conversations in the sidebar, send messages queued for the old one to the new one, and let Approve on an old notification answer the new one. Beacon now keeps a folder per Prometheus (conversations, queued messages, drafts, groups), told apart by the Prometheus's own fingerprint, and a notification's buttons only answer the Prometheus that asked while it is still the one connected. On the first launch Beacon backs up its cache, then moves it into the folder of the Prometheus it is connected to. Your theme, window and notification choices stay Beacon's own.
- **Spec: one Beacon, several Prometheus.** [docs/MULTI-PROMETHEUS.md](docs/MULTI-PROMETHEUS.md) says how Beacon will hold more than one Prometheus at once: a folder and a key per Prometheus, a list in the sidebar, one approvals inbox, and the PRs that build it, red tests first.
- **Computer use: start the next desktop task.** After a desktop task ended, the progress pane showed only that task and offered no way to start another in the same conversation. The start form now comes back under an ended task. It still never shows while a task runs.

## 0.4.9 (2026-10-20)

Beacon's source is public, under the [MIT License](LICENSE). This release also carries the work of 0.4.6 to
0.4.8, which were never published.

- **Open source.** The license is MIT, the same as Prometheus. Settings → About and the About box say "Free ·
  open source (MIT) · beta". The disk image no longer asks you to agree to a license before it opens, and
  the AppImage no longer asks on its first run. See [PRIVACY.md](PRIVACY.md) for what Beacon connects to,
  and [TRADEMARKS.md](TRADEMARKS.md) for the names.
- **Plain words for an approved device.** A Beacon that another Beacon approved sees short explanations
  instead of Prometheus's refusals.
- **No plain http to the internet.** Beacon refuses an unencrypted connection to an address that is not this
  computer, your home network or Tailscale, saved connections included, and says to use https or Tailscale.
- **"Make this Beacon an owner"** is offered at the end of joining another computer, and opens only the owner
  section. Settings keeps the address and key under Advanced.
- **Task lists in chat** show their checkboxes, without bullets as well.
- **Zero tool calls** read "No tool calls yet", without a red 0%.
- **Model rows read UP or DOWN** from a fresh check, never "stale" a minute after Prometheus starts, and a
  stopped local server reads DOWN. A cloud default model is named by its model, not "Local".

## 0.4.5 (2026-10-17)

Includes 0.4.4, which was not published on its own.

- **Prometheus on the same Mac:** approve this Beacon with Prometheus's own `oara pair approve`, with no other
  Beacon needed. The download is about 71 MB.
- **Several conversations at once:** side by side in the main window, with a divider you can drag, or popped
  out into their own windows.
- **Projects in the sidebar:** file sessions into projects by drag or right-click, with suggestions from the
  paths your assistant worked in. The sessions list can be resized.
- **Pages, SVGs and PDFs in chat** can be viewed, not only downloaded, and a plain click on a link to a local
  address opens it in the browser pane.
- **"Tidying up the conversation…"** shows inline, with a progress bar, while a long conversation is compacted.
- **Fixes:** a wiki page's YAML frontmatter is no longer shown as page text; refused tasks read "refused" on
  Mission; the dock and panes fit inside the window; on Linux, no spellchecker dictionary is downloaded from
  Google; the voice port is 8012 by default and set in config.

## 0.4.3 (2026-10-12)

- **Pairing codes for iPhone are encrypted when Prometheus is.** With home network on, the code from Config →
  Devices → Enrol carries Prometheus's key, so a Beacon for iPhone connects over TLS, and only to that
  Prometheus. Beacon first checks that Prometheus answers on the iPhone ports (8006 and 8011) with that key,
  and makes no code if it doesn't. Phones paired before home network was turned on need a new code.

## 0.4.2 (2026-10-12)

- **Change which AI your assistant uses, from Beacon:** Config → Models → Main model. Beacon checks a key
  before saving it; "Restart now" restarts Prometheus to apply it (Prometheus 0.9.7 or later).
- **Make a Beacon on another computer an owner** with a one-time code from `oara pair --owner`.
- **More ways in** when Prometheus is already on this Mac: look for another computer, or type its address.
- **Fixes:** the approval card is solid over every page; a worker request this Beacon can't approve says so
  once and explains how to approve it; the address example is generic.

## 0.4.1 (2026-10-11)

- **Setting up Prometheus on a new Mac works:** 0.4.0 asked for the download at the wrong address.
- **A Mac too old for Prometheus** is told so before anything downloads.
- **"We couldn't find Prometheus" says why:** macOS isn't allowing the search, the Prometheus found needs
  updating, or nothing answered (and you can type the address).

## 0.4.0 (2026-10-11)

- **A new first run:** set Prometheus up on this Mac in one click (Beacon downloads the notarized app, checks
  it, installs it, starts it and connects), or join a computer that already runs it.
- **Sign in with OpenRouter**, with no key to copy.
- **More than one computer, over TLS.** Beacon holds each home-network Prometheus to the key it first met.
- **Encrypted-only home-network joins.** Tailscale and this Mac work as before.
- **Worker cards:** approve a worker's step once, and pick the worker model in Settings.

## 0.3.1 (2026-10-07)

- Setup picks up where you left off, and always offers a way out when Prometheus can't be reached.
- Setup links open in your browser.
- The license window shows clean paragraphs.

## 0.3.0 (2026-10-07)

- The first public build: a signed and notarized macOS app, and Linux AppImage and deb, with an update feed
  on this repository.
