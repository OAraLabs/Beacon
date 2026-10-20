// Which chat links open in the browser pane — pure, shared by the renderer, the relay and the smokes.
//
// THE RULE. A link in a chat message opens in the pane only when a PERSON clicks it, and only when
// it points somewhere local: this machine, a private network, a tailnet. That is the case the pane
// is for. An agent that serves a page for you on the mini hands you http://100.x.y.z:8077/; having
// to retype that into the URL bar is the whole bug. A public site stays in your real browser, where
// you are logged in — the pane's partition is in-memory by design, so a link to a site you use
// would arrive logged out.
//
// WHY THIS IS NOT A HOLE IN THE INVARIANT (see browser-pane.ts / browser-invariant.ts). The
// invariant exists so that model output can never steer the pane WITHOUT a person: a navigation
// that does not look like a tool call and so is not audited. A link the person chooses to click is
// the opposite of that — it is the URL bar with the text supplied by the message. What the rule
// must therefore guarantee, and what browser-invariant.ts R9 pins on the source:
//   - the gesture is a real one: `isTrusted === true`, which script cannot forge (a synthetic
//     `el.click()` from any page code is untrusted), a plain left click with no modifier;
//   - nothing happens on arrival, render or update of a message — only inside that click handler;
//   - the address is http(s) to a local host, checked again at the receiving end;
//   - there is exactly one caller, and it is the anchor's click handler.
// A modifier-click (⌘ / Ctrl / Shift / Alt) is the escape hatch: it keeps the old behaviour and
// opens the system browser.

import { isWebUrl } from './browser-pane'
import { hostScope } from './plain-lan'

/** The fields of a click that decide it. A DOM MouseEvent satisfies this structurally. */
export interface ClickLike {
  button: number
  metaKey: boolean
  ctrlKey: boolean
  shiftKey: boolean
  altKey: boolean
  isTrusted: boolean
}

/**
 * Is this hostname somewhere local — this machine, a private network, a tailnet?
 *
 * ONE opinion of where a host is: plain-lan.ts's hostScope, which already decides loopback /
 * Tailscale / home network for the "no plain HTTP to the home network" rule (private ranges,
 * link-local, unique-local, IPv4-mapped IPv6, 100.64/10, *.ts.net, *.local). Local here means
 * anything it places somewhere other than 'other'. A second table of what is local would drift from
 * it the first time either changed.
 *
 * One addition: a single-label name (`mini`, a MagicDNS short name, a machine's own hostname) can
 * only resolve on a local network — no public site has one — so it counts too.
 *
 * `hostname` is what URL.hostname returns. Anything not positively recognised is NOT local: a wrong
 * "no" sends a link to the system browser, as before; a wrong "yes" would open a public site in a
 * logged-out pane.
 */
export function isLocalHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, '')
  if (!h) return false
  if (hostScope(h) !== 'other') return true
  return !h.includes('.') && !h.includes(':') && !h.startsWith('[')
}

/** A web URL (http/https only) whose host is local. Everything else is false, never an error. */
export function isPaneLink(href: string): boolean {
  if (typeof href !== 'string') return false
  const s = href.trim()
  if (!isWebUrl(s)) return false
  let u: URL
  try {
    u = new URL(s)
  } catch {
    return false
  }
  return (u.protocol === 'http:' || u.protocol === 'https:') && isLocalHost(u.hostname)
}

/**
 * Should THIS click on THIS link open the pane? The one decision the anchor's click handler asks.
 *
 * `isTrusted` comes first on purpose and is spelled out: it is the line that makes "an agent cannot
 * do this" true rather than hoped for. Page script can dispatch a click, but only the browser can
 * mint a trusted one.
 */
export function shouldOpenInPane(e: ClickLike, href: string | undefined): boolean {
  if (e.isTrusted !== true) return false
  if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return false
  return typeof href === 'string' && isPaneLink(href)
}
