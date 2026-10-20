import { useEffect, useRef } from 'react'
import type { BrowserHost } from '@shared/browser-pane'

// When the web contents come BACK from the pop-out (the pop-out's Reattach, or its window being
// closed), they land in the main window — and the main window's browser chrome may not be on
// screen: the side panel can be collapsed, or showing the terminal. Without this the page would be
// alive and invisible (zero rect, nothing to open it), and the pop-out's own Reattach button
// would look like it did nothing. So the host transition popout → main asks the owner to show
// the browser pane. Lives here, under src/renderer/src/browser/, because the invariant smoke
// confines the beacon.browser bridge to this directory; it reads STATE only, never a URL.

export function BrowserHostRelay({ onReattached }: { onReattached: () => void }) {
  const prev = useRef<BrowserHost | null>(null)
  useEffect(() => {
    const b = window.beacon
    if (!b) return
    let alive = true
    void b.browser
      .state()
      .then((s) => {
        if (alive && prev.current === null) prev.current = s.host
      })
      .catch(() => undefined)
    const off = b.browser.onState((s) => {
      if (prev.current === 'popout' && s.host === 'main') onReattached()
      prev.current = s.host
    })
    return () => {
      alive = false
      off()
    }
  }, [onReattached])
  return null
}
