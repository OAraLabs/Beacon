import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import type { BrowserWindow, Rectangle } from 'electron'

// Window-state persistence (Makeover Slice 5): bounds + maximized survive restarts via a small
// JSON file in userData. Position is validated against the current displays at load (a monitor
// that vanished must not strand the window offscreen) — drop x/y and let Electron center instead.

export interface WindowState {
  x?: number
  y?: number
  width: number
  height: number
  maximized?: boolean
  /** webContents zoom LEVEL (not factor): 0 = 100%, +1 ≈ 120%, -1 ≈ 83%. Persists ⌘+ / ⌘- / ⌘0
   * across restarts — Electron otherwise resets zoom to 100% on every launch. Clamped to [-3, 3]. */
  zoom?: number
}

export const DEFAULT_WINDOW_STATE: WindowState = { width: 1100, height: 760 }

/**
 * The smallest window that still lays out, in DIPs.
 *
 * EXPORTED, and that is the fix. These were module-private, so the only code that could see them was
 * `sanitizeWindowState` — which means they applied to a RESTORED size (read from the file at launch)
 * and not to the LIVE window a person drags. The two halves of one invariant lived in different
 * places, and the dragging half had no floor at all.
 *
 * One constant, two consumers: the sanitizer, and `minWidth`/`minHeight` on the BrowserWindow. If
 * they ever disagree, a size that is accepted on restore can be one the window refuses to be dragged
 * to (or the reverse), and the disagreement is invisible until someone resizes.
 */
export const MIN_WINDOW_WIDTH = 480
export const MIN_WINDOW_HEIGHT = 360

/** Pure: sanitize a parsed state — sane size, and x/y kept only if visible on some display. */
export function sanitizeWindowState(raw: unknown, displays: Rectangle[]): WindowState {
  if (!raw || typeof raw !== 'object') return DEFAULT_WINDOW_STATE
  const s = raw as Partial<WindowState>
  const width = typeof s.width === 'number' && s.width >= MIN_WINDOW_WIDTH ? Math.round(s.width) : DEFAULT_WINDOW_STATE.width
  const height = typeof s.height === 'number' && s.height >= MIN_WINDOW_HEIGHT ? Math.round(s.height) : DEFAULT_WINDOW_STATE.height
  const out: WindowState = { width, height, maximized: s.maximized === true }
  if (typeof s.zoom === 'number' && Number.isFinite(s.zoom)) {
    out.zoom = Math.max(-3, Math.min(3, s.zoom))
  }
  if (typeof s.x === 'number' && typeof s.y === 'number') {
    // Keep the position only if the window's top strip intersects a display work area.
    const visible = displays.some(
      (d) => s.x! + width > d.x + 40 && s.x! < d.x + d.width - 40 && s.y! >= d.y - 8 && s.y! < d.y + d.height - 40
    )
    if (visible) {
      out.x = Math.round(s.x)
      out.y = Math.round(s.y)
    }
  }
  return out
}

export function loadWindowState(file: string, displays: Rectangle[]): WindowState {
  try {
    if (!existsSync(file)) return DEFAULT_WINDOW_STATE
    return sanitizeWindowState(JSON.parse(readFileSync(file, 'utf8')), displays)
  } catch {
    return DEFAULT_WINDOW_STATE
  }
}

/** Attach debounced persistence to a window: resize/move/(un)maximize → write ~300ms later. */
export function trackWindowState(win: BrowserWindow, file: string): void {
  let timer: ReturnType<typeof setTimeout> | null = null
  const save = (): void => {
    try {
      const maximized = win.isMaximized()
      // Normal (restored) bounds are what we persist — restoring a maximized window uses them.
      const b = maximized ? win.getNormalBounds() : win.getBounds()
      const state: WindowState = {
        x: b.x,
        y: b.y,
        width: b.width,
        height: b.height,
        maximized,
        zoom: win.webContents.getZoomLevel(),
      }
      writeFileSync(file, JSON.stringify(state))
    } catch {
      // best-effort — never let persistence break the window
    }
  }
  const schedule = (): void => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(save, 300)
  }
  win.on('resize', schedule)
  win.on('move', schedule)
  win.on('maximize', schedule)
  win.on('unmaximize', schedule)
  win.webContents.on('zoom-changed', schedule) // wheel zoom; menu ⌘+/-/0 is captured by the save-on-close
  win.on('close', () => {
    if (timer) clearTimeout(timer)
    if (!win.isDestroyed()) save()
  })
}
