import { desktopCapturer, screen, shell, systemPreferences } from 'electron'
import { IPC } from '@shared/ipc'
import { CHAT_UPLOAD_SAFE_BYTES } from '@shared/attachments'
import {
  emptyGrabError,
  orderSources,
  transientGrabError,
  type CaptureGrabResult,
  type CaptureSourcesResult,
  type ScreenAccessState
} from '@shared/capture'
import { handleFromShell, onFromShell } from './shell-windows'

// Screenshot capture. Pixels are read IN MAIN via desktopCapturer and handed to
// the renderer as data — the renderer never gets a media stream or a raw display handle. A still
// is just a big thumbnail: getSources with a display-sized thumbnailSize IS the capture; no
// getUserMedia, no recording session.

const PICKER_THUMB = { width: 288, height: 180 }

function accessState(): ScreenAccessState {
  // TCC is a macOS concept; elsewhere capture simply works (or the OS shows its own picker).
  if (process.platform !== 'darwin') return 'granted'
  try {
    const s = systemPreferences.getMediaAccessStatus('screen')
    return s === 'granted' || s === 'denied' || s === 'restricted' || s === 'not-determined' ? s : 'unknown'
  } catch {
    return 'unknown'
  }
}

/**
 * Grab sizes to attempt, best first. On this Mac (and reproducibly — probe-a3-debug2), a
 * sufficiently large thumbnailSize makes EVERY source come back empty while 288×180 works fine —
 * so a single "ask for the biggest" size is a silent all-black failure mode, not a maximum.
 * The ladder walks down until a size actually yields pixels: physical pixels of the largest
 * display, then logical pixels, then a fixed 1920×1080 that is known-good at picker scale.
 */
function grabSizes(): Array<{ width: number; height: number }> {
  let lw = 0
  let lh = 0
  let scale = 1
  for (const d of screen.getAllDisplays()) {
    if (d.size.width * d.size.height > lw * lh) {
      lw = d.size.width
      lh = d.size.height
      scale = d.scaleFactor || 1
    }
  }
  const ladder: Array<{ width: number; height: number }> = []
  if (lw > 0 && scale > 1) ladder.push({ width: Math.round(lw * scale), height: Math.round(lh * scale) })
  if (lw > 0) ladder.push({ width: lw, height: lh })
  ladder.push({ width: 1920, height: 1080 })
  return ladder
}

/**
 * Shrink a capture until its bytes fit a chat_upload frame — the daemon refuses uploads over its
 * 20 MB guard, and past its 32 MiB frame limit the socket closes 1009 (see CHAT_UPLOAD_SAFE_BYTES),
 * so fitting here is what makes the capture deliver rather than bounce. PNG when it fits (at 20 MB
 * nearly every screenshot does); otherwise JPEG, then halving resolutions. A screenshot for a
 * vision model loses nothing that matters at these sizes.
 */
function fitToWire(img: Electron.NativeImage): CaptureGrabResult {
  const png = img.toPNG()
  const size = img.getSize()
  if (png.byteLength <= CHAT_UPLOAD_SAFE_BYTES)
    return { ok: true, base64: png.toString('base64'), width: size.width, height: size.height, mimeType: 'image/png' }
  let current = img
  for (let step = 0; step < 4; step++) {
    const jpeg = current.toJPEG(82)
    const s = current.getSize()
    if (jpeg.byteLength <= CHAT_UPLOAD_SAFE_BYTES && jpeg.byteLength > 0)
      return { ok: true, base64: jpeg.toString('base64'), width: s.width, height: s.height, mimeType: 'image/jpeg' }
    current = current.resize({ width: Math.max(2, Math.round(s.width / 2)) })
  }
  return { ok: false, error: 'could not shrink the capture to a sendable size' }
}

export function registerScreenshotHandlers(): void {
  handleFromShell(IPC.SCREENSHOT_SOURCES, async (): Promise<CaptureSourcesResult> => {
    const access = accessState()
    try {
      const raw = await desktopCapturer.getSources({
        types: ['screen', 'window'],
        thumbnailSize: PICKER_THUMB,
        fetchWindowIcons: false
      })
      const sources = orderSources(
        raw.map((s) => ({
          id: s.id,
          name: s.name,
          kind: (s.id.startsWith('screen') ? 'screen' : 'window') as 'screen' | 'window',
          thumbDataUrl: s.thumbnail.isEmpty() ? '' : s.thumbnail.toDataURL()
        }))
      )
      return { access, sources }
    } catch {
      // Enumeration failing outright reads as "nothing to capture" — the access state still lets
      // the picker say WHY when the cause is the TCC grant.
      return { access, sources: [] }
    }
  })

  handleFromShell(IPC.SCREENSHOT_GRAB, async (_e, sourceId: string): Promise<CaptureGrabResult> => {
    if (typeof sourceId !== 'string' || !sourceId) return { ok: false, error: 'no source id' }
    try {
      // Empirical (probe-a3-diag, 2026-08-28): capture at ANY size intermittently returns empty
      // images when getSources calls land close together — ScreenCaptureKit needs a beat between
      // enumerations, and the picker has just made one. So the grab RETRIES with a pause, and the
      // pause is the load-bearing part; the size ladder is the second-order fallback.
      // Enumerate ONLY the requested kind: at grab resolution every enumerated source is
      // thumbnailed, so asking for both kinds renders every open window at full size per attempt —
      // seconds of work per retry that the retry loop then multiplies.
      const types: Array<'screen' | 'window'> = [sourceId.startsWith('screen') ? 'screen' : 'window']
      let seen = false
      for (let attempt = 0; attempt < 4; attempt++) {
        if (attempt > 0) await new Promise((r) => setTimeout(r, 600))
        for (const thumbnailSize of grabSizes()) {
          const raw = await desktopCapturer.getSources({
            types,
            thumbnailSize,
            fetchWindowIcons: false
          })
          const src = raw.find((s) => s.id === sourceId)
          if (!src) continue // ids can churn between enumerations; a later pass may still find it
          seen = true
          const img = src.thumbnail
          if (img.isEmpty()) continue
          const { width, height } = img.getSize()
          if (width < 2 || height < 2) continue
          return fitToWire(img)
        }
      }
      if (!seen) return { ok: false, error: 'source is gone — it may have closed; reopen the picker' }
      // Every attempt came back empty. If access is granted this is the transient SCK blank-frame
      // window — do NOT send the user to System Settings for it; otherwise the un-granted TCC
      // case really is the likely cause.
      return { ok: false, error: accessState() === 'granted' ? transientGrabError() : emptyGrabError() }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  onFromShell(IPC.SCREENSHOT_OPEN_SETTINGS, () => {
    if (process.platform === 'darwin')
      void shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture')
  })
}
