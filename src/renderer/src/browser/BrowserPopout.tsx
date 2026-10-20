import { useEffect } from 'react'
import { BrowserPane } from './BrowserPane'
import { loadAndApplyTheme } from '../theme/apply-theme'

// The pop-out window's whole document (#browser, see main.tsx): the pane chrome filling the
// window, with the SAME web contents main moved over from the dock — no reload, history intact.
// Send to chat still works from here: main routes the block to the main window's composer.

export function BrowserPopout() {
  useEffect(() => {
    void loadAndApplyTheme()
    document.title = 'Beacon Browser'
  }, [])
  return (
    <div className="browser-popout-root">
      <BrowserPane mode="popout" onClose={() => window.beacon?.browser.reattach()} />
    </div>
  )
}
