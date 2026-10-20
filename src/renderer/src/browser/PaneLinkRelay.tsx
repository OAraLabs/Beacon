import { useEffect } from 'react'
import { isPaneLink } from '@shared/pane-link'
import { onPaneLink } from '../link-open'

// The receiving end of a clicked chat link (see src/shared/pane-link.ts for the rule and
// src/renderer/src/link-open.ts for the hand-off). Lives under src/renderer/src/browser/ because
// the invariant smoke confines the beacon.browser bridge to this directory.
//
// It checks the address AGAIN (isPaneLink) rather than trusting the caller: the click handler
// already approved it, but this is the one place that can reach the pane, so it does not rely on
// who is upstream. It asks the owner to show the pane first — navigating a pane nobody can see
// would leave a page alive and invisible — and only then navigates. `onShow` returns false on a
// surface the dock cannot sit beside; the link is then declined and opens in the system browser.
// Main still normalises and refuses anything but http(s), and still requires the shell sender.

export function PaneLinkRelay({ onShow }: { onShow: () => boolean }) {
  useEffect(
    () =>
      onPaneLink((url) => {
        const b = window.beacon
        if (!b || !isPaneLink(url) || !onShow()) return false
        void b.browser.navigate(url).catch(() => undefined)
        return true
      }),
    [onShow]
  )
  return null
}
