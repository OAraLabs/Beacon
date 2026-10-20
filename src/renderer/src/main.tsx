import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { ErrorBoundary } from './components/ErrorBoundary'
import { QuickCapture } from './components/QuickCapture'
import { TrayHud } from './components/TrayHud'
import { BrowserPopout } from './browser/BrowserPopout'
import { TerminalWindow } from './components/TerminalWindow'
import { SessionWindow } from './components/SessionWindow'
import { parseSessionWindowRoute } from '@shared/session-windows'
// Bundled variable fonts (OFL) — no network fetch, ever. Tokens load before styles so the
// legacy var names styles.css consumes resolve to the design-system palette.
import '@fontsource-variable/inter'
import '@fontsource-variable/jetbrains-mono'
// Codex re-skin (LVX/NOX): bundled OFL — Cormorant Garamond (display), EB Garamond (body),
// IBM Plex Mono (telemetry/labels). No network fetch; CSP-safe.
import '@fontsource/cormorant-garamond/400.css'
import '@fontsource/cormorant-garamond/500.css'
import '@fontsource/cormorant-garamond/600.css'
import '@fontsource/cormorant-garamond/500-italic.css'
import '@fontsource/eb-garamond/400.css'
import '@fontsource/eb-garamond/500.css'
import '@fontsource/eb-garamond/400-italic.css'
import '@fontsource/ibm-plex-mono/400.css'
import '@fontsource/ibm-plex-mono/500.css'
import './theme/tokens.css'
import './styles.css'

// Quick-capture window (Slice 10): the same renderer bundle, hash-routed — the mini window loads
// #capture and renders ONLY the spotlight composer (decided here, before any component mounts).
const isCapture = window.location.hash === '#capture'
// Tray HUD (harness sprint #8): same bundle, hash-routed like #capture — the tray popover window.
const isHud = window.location.hash === '#hud'
// Browser pop-out (Phase 3): the pane chrome as a whole window; main moves the web contents in.
const isBrowser = window.location.hash === '#browser'
// Terminal pop-out (claude/BEACON-TERMINAL-SCOPE.md Phase 2): the detached pane, same bundle, #terminal.
const isTerminal = window.location.hash === '#terminal'
// Session window (@shared/session-windows): one conversation in its own OS window, #session=<id>.
const sessionWindowId = parseSessionWindowRoute(window.location.hash)

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  /* The boundary is OUTSIDE StrictMode and wraps every hash route, not just <App />. Two reasons
     for the placement, both about what it has to survive:
       * outside StrictMode — a boundary inside it is itself subject to the double-render that is
         part of what StrictMode is checking, so the thing that catches a broken render would be
         rendered twice on the path that most needs it to work once;
       * around all five routes — #capture (quick-capture), #hud (tray popover), #browser and
         #terminal (the pop-outs) are the SAME bundle with a different root component, and an
         uncaught throw in any of them blanked that window with no recovery affordance either.
         Wrapping the expression covers all of them with one boundary.
     It is the ONLY `scope="window"` boundary: at the root there is nothing beside the fallback left
     to keep reachable. Every other boundary is a panel, whose fallback stays in its own slot. */
  <ErrorBoundary scope="window">
    <React.StrictMode>
      {isCapture ? (
        <QuickCapture />
      ) : isHud ? (
        <TrayHud />
      ) : isBrowser ? (
        <BrowserPopout />
      ) : isTerminal ? (
        <TerminalWindow />
      ) : sessionWindowId ? (
        <SessionWindow sessionId={sessionWindowId} />
      ) : (
        <App />
      )}
    </React.StrictMode>
  </ErrorBoundary>
)
