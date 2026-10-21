// Screenshot capture — pure model shared by main, the renderer picker, and the
// headless smoke. Capture itself is main-only (desktopCapturer); everything decidable without
// Electron lives here so it is provable headless.
//
// The macOS reality this models: screen capture is a TCC grant. Un-granted, desktopCapturer does
// not throw — it hands back BLACK images, which is a silent-wrong-answer, not an error. So the
// access state travels with every sources listing, and the picker renders the hint INSTEAD OF a
// grid of convincing black rectangles.

export interface CaptureSource {
  /** desktopCapturer source id — opaque; round-tripped verbatim to grab. */
  id: string
  name: string
  kind: 'screen' | 'window'
  /** Small preview for the picker (data URL png). */
  thumbDataUrl: string
}

/** macOS systemPreferences.getMediaAccessStatus('screen'); other platforms report 'granted'. */
export type ScreenAccessState = 'granted' | 'denied' | 'restricted' | 'not-determined' | 'unknown'

export interface CaptureSourcesResult {
  access: ScreenAccessState
  sources: CaptureSource[]
}

export type CaptureGrabResult =
  | {
      ok: true
      base64: string
      width: number
      height: number
      /** image/png when the full capture fits the wire; image/jpeg when it had to shrink to fit
       * the daemon's upload cap (see CHAT_UPLOAD_SAFE_BYTES in @shared/attachments). */
      mimeType: 'image/png' | 'image/jpeg'
    }
  | { ok: false; error: string }

/** Screens first (what people usually want), then windows; alphabetical inside each group. */
export function orderSources<T extends { kind: 'screen' | 'window'; name: string }>(list: T[]): T[] {
  return [...list].sort((a, z) => {
    if (a.kind !== z.kind) return a.kind === 'screen' ? -1 : 1
    return a.name.localeCompare(z.name)
  })
}

/** screenshot-YYYYMMDD-HHMMSS.<ext> — sortable, collision-safe enough for a composer, no locale. */
export function screenshotFilename(epochMs: number, mimeType: 'image/png' | 'image/jpeg' = 'image/png'): string {
  const d = new Date(epochMs)
  const p = (n: number, w = 2): string => String(n).padStart(w, '0')
  const ext = mimeType === 'image/jpeg' ? 'jpg' : 'png'
  return `screenshot-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.${ext}`
}

/**
 * One sentence for the picker when capture cannot work yet. Empty string means "no hint — show
 * the grid". 'unknown' shows the grid too: it is the non-darwin answer, not a failure.
 */
export function screenAccessHint(state: ScreenAccessState): string {
  switch (state) {
    case 'granted':
    case 'unknown':
      return ''
    case 'not-determined':
      return 'macOS will ask for screen-recording access on the first capture — if previews come back black, grant Beacon in System Settings → Privacy & Security → Screen Recording, then relaunch.'
    case 'denied':
    case 'restricted':
      return 'macOS is blocking screen capture for Beacon. Grant it in System Settings → Privacy & Security → Screen Recording, then relaunch Beacon.'
  }
}

/** A grab that came back with no pixels is the un-granted TCC case wearing a success suit. */
export function emptyGrabError(): string {
  return 'capture came back empty — this is what a missing Screen Recording grant looks like; check System Settings → Privacy & Security → Screen Recording.'
}

/**
 * Same empty result while access IS granted: macOS ScreenCaptureKit intermittently serves blank
 * frames for a second or two (measured live: correlated bad windows, cleared by waiting).
 * Blaming the TCC grant here would send the user to System Settings for nothing.
 */
export function transientGrabError(): string {
  return 'capture came back empty — macOS sometimes serves a blank frame for a moment; click the source again.'
}
