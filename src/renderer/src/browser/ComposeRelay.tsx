import { useEffect } from 'react'

// When the pane is popped out, its Send-to-chat click is routed by MAIN to this window (the one
// with a composer). This is the only listener for that channel, and it lives here — under
// src/renderer/src/browser/ — because the invariant smoke confines the beacon.browser bridge to
// this directory. Main sends it only from inside the extract handler (R8); the text is the page
// block the user clicked to bring over, and it goes into the composer as their draft.

export function ComposeRelay({ onInsert }: { onInsert: (text: string) => void }) {
  useEffect(() => {
    const b = window.beacon
    if (!b) return
    return b.browser.onComposeInsert((text) => {
      if (typeof text === 'string' && text.trim()) onInsert(text)
    })
  }, [onInsert])
  return null
}
