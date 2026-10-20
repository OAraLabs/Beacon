/// <reference types="vite/client" />
import type { BeaconBridge } from '@shared/ipc'

declare global {
  interface Window {
    /** The allowlisted bridge exposed by the preload (spec §3.5). */
    beacon: BeaconBridge
  }

  /**
   * Window Controls Overlay. Not in this TypeScript's DOM lib (5.9.3, lib DOM), so the surface we
   * use is declared here rather than the whole spec. `visible` is the load-bearing bit: it says
   * whether the OS reserved a strip of window buttons over the page, which is how the renderer
   * learns it is on a Linux/Windows build WITHOUT platform sniffing — macOS reports false and keeps
   * its traffic lights. `getTitlebarAreaRect()` is the reserved strip; the CSS reaches the same
   * numbers through `env(titlebar-area-*)`, which needs no declaration.
   */
  interface WindowControlsOverlay extends EventTarget {
    visible: boolean
    getTitlebarAreaRect(): DOMRectReadOnly
  }
  interface Navigator {
    readonly windowControlsOverlay?: WindowControlsOverlay
  }
}

export {}
