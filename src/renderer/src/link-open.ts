// The hand-off from a chat link click to the browser pane's owner. Deliberately tiny and deliberately
// neutral: it imports nothing, so it can sit between two worlds the browser-pane invariant keeps
// apart — the chat renderer (which may not touch the pane) and src/renderer/src/browser/ (which may
// not touch chat).
//
// There is ONE sanctioned caller of requestPaneLink — the anchor's click handler in
// MessageRenderer, after shouldOpenInPane (src/shared/pane-link.ts) has approved the click — and ONE
// subscriber, PaneLinkRelay under browser/. browser-invariant.ts R9 pins both on the source, so a
// second caller (a message arriving, an effect, a frame) is a failing smoke, not a code review.
//
// The boolean answers "did someone take it?". With no subscriber mounted (a window that has no
// browser pane) the caller leaves the click alone and the link opens in the system browser as it
// always did, instead of becoming a dead anchor.

type PaneLinkHandler = (url: string) => boolean

let handler: PaneLinkHandler | null = null

/** Subscribe as the pane's owner. One owner: a later subscriber replaces an earlier one. */
export function onPaneLink(cb: PaneLinkHandler): () => void {
  handler = cb
  return () => {
    if (handler === cb) handler = null
  }
}

/** Offer a link to the pane. true = the pane took it (the caller must stop the default open). */
export function requestPaneLink(url: string): boolean {
  return handler ? handler(url) : false
}
