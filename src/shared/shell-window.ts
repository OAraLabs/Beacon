// Beacon's own windows: the pure half of "only the shell page may hold the bridge".
//
// Every Beacon window (main, quick-capture, the tray HUD, the terminal and browser pop-outs) loads
// the preload, and the preload hands `window.beacon` to WHATEVER document sits in the window's top
// frame. Measured on the built app (scripts/window-guard-probe.mjs, 2026-09-24, before this module):
// a page-initiated navigation to a foreign http page landed in all five windows, the foreign page
// had `window.beacon`, and the terminal's sender guard accepted it, because that guard asked only
// "does a BrowserWindow own this sender, and is it the top frame". A window Beacon never created
// was accepted the same way.
//
// Two decisions close that, and both live here so shell-window-smoke can test them with no window:
//
//   mayShellWindowNavigate: where a Beacon window's top frame may go ON ITS OWN (will-navigate /
//     will-redirect: a link, a drop, `location =`, a server redirect). Main's own loadURL/loadFile
//     do not raise those events and are not governed by this.
//   shellSenderRefusal: whether a privileged IPC handler may trust a sender. It must be a window
//     Beacon created, its top frame, and showing the shell page.
//
// Electron glue (the window registry, the listeners, reading the IPC event) is src/main/shell-windows.ts.
import { isWebUrl } from './browser-pane'

/** The document a URL names: scheme, host and path. The hash is the shell's ROUTE (#capture, #hud,
 *  #terminal, #browser) and the query is unused, so neither makes it a different page. The path is
 *  compared decoded, so `%20` and a space are the same file. null when the URL does not parse. */
function documentOf(url: string): string | null {
  try {
    const u = new URL(url)
    return `${u.protocol}//${u.host}${decodeURIComponent(u.pathname)}`
  } catch {
    return null
  }
}

/** Is `url` the shell page, on any route? `shellUrl` is where Beacon loads its renderer: the built
 *  `file://…/out/renderer/index.html`, or the Vite dev server under `npm run dev`. null means Beacon
 *  cannot name its page (a build without the out/main anchor), and then nothing is the shell page. */
export function isShellDocument(url: string, shellUrl: string | null): boolean {
  if (typeof url !== 'string' || typeof shellUrl !== 'string') return false
  const doc = documentOf(url)
  return doc !== null && doc === documentOf(shellUrl)
}

/** May a Beacon window's top frame navigate to `url` on its own?
 *
 *  - `about:blank`: yes. Kept from the #120 guard, whose comment allows it so the renderer's own
 *    startup is never blocked. It carries no content a foreign party controls, and it is not the
 *    shell page, so a sender there fails shellSenderRefusal anyway.
 *  - The shell page: ONLY when the shell is served over http, i.e. the dev server. Vite's full
 *    reload is a `location.reload()`, which raises will-navigate, and #120 allowed it as a web URL.
 *    The BUILT shell's own `file://` page stays refused, as #120 and #186 decided: a link or
 *    redirect to it is indistinguishable from a reload, and nothing in the app navigates there.
 *  - Everything else: no. That includes every web page. #120 admitted http(s) here, which let a
 *    foreign page take over the top frame of a window that has the bridge. A link in the shell is
 *    an EXTERNAL link. It goes through setWindowOpenHandler to the OS browser, never into this
 *    window.
 */
export function mayShellWindowNavigate(url: string, shellUrl: string | null): boolean {
  if (url === 'about:blank') return true
  return shellUrl !== null && isWebUrl(shellUrl) && isShellDocument(url, shellUrl)
}

/** What a privileged IPC handler knows about the sender. */
export interface ShellSenderFacts {
  /** The sender's webContents belongs to a window Beacon created (adoptShellWindow). */
  known: boolean
  /** The message came from that page's top frame, not an iframe. */
  mainFrame: boolean
  /** The URL of the frame that sent it; null when the frame is already gone. */
  frameUrl: string | null
  /** Where Beacon loads its renderer, or null when it cannot say (see isShellDocument). */
  shellUrl: string | null
}

/** Why a sender is refused, or null when it is the shell. Each condition closes a different door:
 *  `known` a window Beacon did not make (it can still load the shell page with the same preload);
 *  `mainFrame` an iframe; the URL a foreign document at the top of a real Beacon window. */
export function shellSenderRefusal(f: ShellSenderFacts): string | null {
  if (!f.known) return 'not a Beacon window'
  if (!f.mainFrame) return 'not the top frame'
  if (f.frameUrl === null || !isShellDocument(f.frameUrl, f.shellUrl)) return 'not the shell page'
  return null
}
