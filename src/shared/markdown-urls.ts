// The URL filter for MODEL-AUTHORED markdown. Pure — no React, no DOM — so it can be asserted
// headlessly without a packaged build, which is the only place the defect it closes can reproduce.
//
// THE DEFECT. react-markdown's default urlTransform allows a scheme it recognises
// (https?|ircs?|mailto|xmpp) and BLANKS anything else — but a href with NO COLON at all is treated
// as *relative* and passed through unchanged:
//
//     if (colon === -1 || ...) return value      // "If there is no protocol, it's relative."
//
// In a packaged build the renderer is loaded with loadFile, so the document base is
// `file:///…/out/renderer/index.html`. A model-authored `[the report](/Users/me/Downloads/r.bat)`
// therefore resolves to `file:///Users/me/Downloads/r.bat`. That anchor's click reaches the shell
// window's setWindowOpenHandler → shell.openExternal → the OS opens it. Artifact downloads land in
// Downloads under an agent-chosen name with no extension policy and no mark-of-the-web, which
// supplies the other half on Windows.
//
// It cannot reproduce under `npm run dev`, where the base is http://localhost — which is why it
// survived. So this module's contract is stated in terms of the PACKAGED build.
//
// WHAT THIS CHANGES. Relative and root-relative hrefs are refused outright: there is no such thing
// as a relative link to a real web page in chat output, and "relative" is exactly the shape that
// resolved against file://. An absolute http(s) URL still works. Everything else becomes '' (which
// react-markdown renders as a dead anchor), matching the library's own refusal convention.
//
// This is the renderer half of a two-part close; the main-process half is safeExternalUrl in
// browser-pane.ts. Both derive from isWebUrl, so there is ONE opinion of what a web URL is.

import { isWebUrl } from './browser-pane'

/** Protocols that are not web pages but are legitimate in chat output, and open a mail or chat
 *  client rather than executing anything locally. react-markdown's default allows these; so do we.
 *  Deliberately NOT included: file, javascript, data, vbscript, and every custom app scheme
 *  (beacon-artifact:// is the app's own privileged render surface and must not be reachable from
 *  message text). */
const SAFE_NON_WEB_PROTOCOL = /^(mailto|ircs?|xmpp):/i

/**
 * A react-markdown `urlTransform`. Receives the href/src string, the attribute key and the node;
 * returns the URL to use, or '' to blank it.
 *
 * Blank rather than drop the element: react-markdown renders `href=""` as an anchor that goes
 * nowhere, which keeps the message text readable (the operator still sees the link's label and can
 * tell something was refused) instead of silently deleting content from a model reply.
 */
export function markdownUrlTransform(value: string): string {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim()
  if (!trimmed) return ''

  // A real web page: allowed unchanged.
  if (isWebUrl(trimmed)) return trimmed

  // mailto:/irc:/xmpp: open a client; they cannot resolve against file:// or execute locally.
  if (SAFE_NON_WEB_PROTOCOL.test(trimmed)) return trimmed

  // No colon at all → react-markdown would treat it as RELATIVE, and in a packaged build relative
  // means relative to file://. This is the defect. Refuse it.
  // A colon present but not an allowed protocol (file:, javascript:, data:, beacon-artifact:,
  // chrome:, …) → refuse it too.
  return ''
}
