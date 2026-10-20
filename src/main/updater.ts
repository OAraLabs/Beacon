import { app } from 'electron'
import { autoUpdater } from 'electron-updater'
import type { UpdaterStatus } from '@shared/ipc'

/**
 * Auto-update via electron-updater. The feed provider is embedded by electron-builder at package
 * time (app-update.yml → GitHub releases, OAraLabs/beacon). Dev builds NEVER check: autoUpdater only
 * makes sense in a packaged app, and running it from source throws on the missing app-update.yml —
 * `initUpdater` gates on `app?.isPackaged` and reports 'disabled'.
 *
 * The feed is a PUBLIC repo that carries installers and nothing else (no source), so a check needs no
 * credential: electron-updater's public GitHubProvider reads releases.atom unauthenticated. No token
 * is shipped in the bundle, stored by the app, or read from the environment — `scripts/
 * check-update-feed.mjs` reads the PACKAGED app-update.yml and fails the release if one appears.
 * (Until 0.3.0 the feed was the private source repo and Settings asked for a GitHub PAT to read it.)
 *
 * Linux: both builds update themselves, through different electron-updater classes. The AppImage
 * (AppImageUpdater) replaces its own file on quit, so it needs a folder the user can write to. The .deb
 * carries resources/package-type = "deb" (electron-builder writes it for deb/rpm/pacman), so
 * electron-updater picks DebUpdater: it downloads the .deb that latest-linux.yml lists, and on quit installs
 * it with `dpkg -i` behind a graphical sudo prompt (pkexec, gksudo, kdesudo or beesu). With none of those it
 * cannot install, and Settings → Updates shows the error. Neither path has run on real Linux hardware yet,
 * only in CI builds.
 */

/**
 * The release feed, named once. MUST match the `publish:` block in electron-builder.yml — which is
 * what electron-builder bakes into app-update.yml — and updater-smoke pins the two together,
 * because a silent drift here would point the updater at the wrong repository.
 *
 * No `private` and no `token`, deliberately. providerFactory builds the PrivateGitHubProvider (the
 * authenticated API path) only when it sees a token, and with `private: true` it goes looking for
 * one in GH_TOKEN/GITHUB_TOKEN — neither of which a public feed should ever consult.
 */
export const FEED = { provider: 'github', owner: 'OAraLabs', repo: 'beacon' } as const

let current: UpdaterStatus = { state: 'idle' }

export function getUpdaterStatus(): UpdaterStatus {
  return current
}

/** Called from main after app.whenReady. Returns the event hook so main can broadcast/tray-update. */
export function initUpdater(onChange: (s: UpdaterStatus) => void): void {
  if (!app?.isPackaged) {
    current = { state: 'disabled', detail: 'development build — updates are packaged-app only' }
    onChange(current)
    return
  }

  const set = (s: UpdaterStatus): void => {
    current = s
    onChange(s)
  }

  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('checking-for-update', () => set({ state: 'checking' }))
  autoUpdater.on('update-available', (info) =>
    set({ state: 'available', version: info?.version ?? undefined })
  )
  autoUpdater.on('update-not-available', (info) =>
    set({ state: 'up-to-date', version: info?.version ?? undefined })
  )
  autoUpdater.on('download-progress', (p) =>
    set({ state: 'downloading', percent: Math.round(p?.percent ?? 0) })
  )
  autoUpdater.on('update-downloaded', (info) =>
    set({ state: 'ready', version: info?.version ?? undefined })
  )
  autoUpdater.on('error', (err: Error) =>
    set({ state: 'error', detail: describeError(err) })
  )

  // First check ~30s after boot (let the gateway connection settle first), then every 4h.
  setTimeout(() => checkForUpdates(), 30_000)
  setInterval(() => checkForUpdates(), 4 * 60 * 60 * 1000)
}

/** Manual or scheduled check. Swallowed into status 'error' — a failed feed check must never take
 * the app down. */
export function checkForUpdates(): void {
  if (!app?.isPackaged) return
  try {
    void autoUpdater.checkForUpdates()
  } catch (err) {
    current = { state: 'error', detail: describeError(err as Error) }
  }
}

/** Restart and install the downloaded update. No-op unless one is actually ready. */
export function installUpdate(): boolean {
  if (current.state !== 'ready') return false
  autoUpdater.quitAndInstall()
  return true
}

/** Hard cap on the error text that reaches the UI. Long enough to name the failure, short enough
 * that it can never grow the Settings dialog past its own controls. */
const MAX_DETAIL_CHARS = 180

/**
 * Cookies must never reach a user-visible surface. GitHub answers a failed unauthenticated feed
 * request (a 404 for a missing or private repo) with three Set-Cookie headers (`_gh_sess` alone is
 * ~412 bytes), and builder-util-runtime bakes the WHOLE header map into the HttpError message: its
 * `safeStringifyJson` redacts names ending in authorization/token/password, and `set-cookie`
 * matches none of them.
 *
 * Runs FIRST, before the message is reduced to its first line, so the cookies are neutralised
 * whatever shape the rest of the message turns out to have.
 */
function withoutCookies(msg: string): string {
  // Header-map form: `"set-cookie": [ "…", "…" ]` (Node always gives set-cookie as an array),
  // and the single-string form `set-cookie: _gh_sess=…`.
  return msg.replace(
    /("?\b(?:set-cookie|cookie)\b"?\s*[:=]\s*)(\[[^\]]*\]|"(?:[^"\\]|\\.)*"|[^\n,}]*)/gi,
    '$1<redacted>'
  )
}

/**
 * The ONE place an updater failure becomes user-visible text. Both error paths (the autoUpdater
 * 'error' event and the checkForUpdates catch) go through here, so the cookie and length
 * guarantees hold for every `UpdaterStatus.detail` the renderer can ever receive.
 *
 * Keeps the provider's own first line — it says WHY (404, rate-limited, ENOTFOUND) — and drops the
 * stack frames and dumps that followed it.
 */
export function describeError(err: Error | null): string {
  const raw = err?.message ?? 'update check failed'
  // Cookies go first, then the first line only: everything after it is stack frames and the
  // structured dumps electron-updater appends (`\nHeaders: {…}`, `,\nXML:\n<feed>…`), none of
  // which a person can act on.
  const summary =
    withoutCookies(raw).split('\n')[0].replace(/\s+/g, ' ').trim() || 'update check failed'

  return summary.length > MAX_DETAIL_CHARS
    ? `${summary.slice(0, MAX_DETAIL_CHARS - 1).trimEnd()}…`
    : summary
}
