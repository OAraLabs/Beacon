/**
 * window-chrome-probe — does the SHIPPED window config actually keep the window buttons?
 *
 * THE CLAIM BEING TESTED. On Linux the main window was `{ frame: false }`, which removes minimize /
 * maximize / close outright. The fix is `titleBarStyle: 'hidden'` + `titleBarOverlay`, and the
 * branch now lives in @shared/window-chrome's `windowChromeOptions()`. This probe builds a REAL
 * window FROM THAT FUNCTION — not from a copy of it — so what it measures is what ships. If the two
 * ever diverge, main's config and this probe's assertions are testing different windows, and the
 * smoke (`windowChromeOptions('linux')` must not carry `frame: false`) is what catches that.
 *
 * WHY NOT CDP. `Browser.getWindowForTarget` — the way to read window state over the debugger —
 * is not registered in this Electron build (it answers -32601 while `Browser.getVersion` beside it
 * works), so window state cannot be driven or read from the page socket. Driving `win.minimize()`
 * and reading `win.isMinimized()` back from main is the same measurement and needs no debugger.
 *
 * Run: npm run probe:window-chrome   (Linux: DISPLAY=:1 electron scripts/window-chrome-probe.mjs)
 * (a display is required — an unrealized window reports WCO unavailable for every configuration,
 *  which is how the first draft of wco-probe.cjs concluded Linux had no WCO at all)
 *
 * WHY IT LIVES IN scripts/ AND NOT src/main/. It opens a page and reads WCO state from it with
 * executeJavaScript — exactly what the browser-pane invariant (R1) forbids anywhere in src/main,
 * because src/main is what ships. As a src/main entry it also WOULD have shipped: the packager
 * excludes only out/main/*-smoke.js. Here it is never bundled and never packaged, and it still
 * builds its window from the REAL windowChromeOptions(): @shared/window-chrome imports nothing, so
 * it is transpiled with the real compiler at run time (the drafts-smoke / context-meter idiom).
 */
import { app, BrowserWindow } from 'electron'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import ts from 'typescript'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const shared = ts.transpileModule(readFileSync(join(ROOT, 'src/shared/window-chrome.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 }
}).outputText
const sharedPath = join(mkdtempSync(join(tmpdir(), 'beacon-window-chrome-')), 'window-chrome.mjs')
writeFileSync(sharedPath, shared)
const { windowChromeOptions, usesWindowControlsOverlay, TITLEBAR_OVERLAY_HEIGHT, INITIAL_OVERLAY_COLORS } = await import(pathToFileURL(sharedPath).href)

let failures = 0
function check(name, cond, detail = '') {
  if (cond) console.log(`  ✓ ${name}`)
  else {
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`)
    failures++
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  const platform = process.platform
  console.log(`window-chrome-probe — Electron ${process.versions.electron} on ${platform}\n`)
  const opts = windowChromeOptions(platform)
  console.log('shipped options for this platform: ' + JSON.stringify(opts) + '\n')

  const win = new BrowserWindow({ width: 900, height: 600, show: true, ...opts })
  await win.loadURL('about:blank')
  // The WM must realize the window before WCO visibility and the titlebar area are meaningful.
  await sleep(1200)

  console.log('The window is still a window (the whole point of the fix):')
  check('minimizable', win.isMinimizable())
  check('maximizable', win.isMaximizable())
  check('closable', win.isClosable())
  check('the native frame is NOT disabled outright', opts.frame !== false, JSON.stringify(opts))

  console.log('\nWindow state actually changes, read back from the WM:')
  check('starts normal', !win.isMinimized() && !win.isMaximized())
  win.minimize()
  await sleep(600)
  check('minimize() → isMinimized()', win.isMinimized())
  win.restore()
  await sleep(600)
  check('restore() → not minimized', !win.isMinimized())
  win.maximize()
  await sleep(600)
  check('maximize() → isMaximized()', win.isMaximized())
  win.unmaximize()
  await sleep(600)
  check('unmaximize() → not maximized', !win.isMaximized())

  if (usesWindowControlsOverlay(platform)) {
    console.log('\nThe OS button strip is reserved over the page:')
    const r = await win.webContents.executeJavaScript(`(() => {
      const w = navigator.windowControlsOverlay
      const rect = w && w.getTitlebarAreaRect ? w.getTitlebarAreaRect() : null
      return { visible: Boolean(w && w.visible), areaW: rect ? rect.width : null, inner: window.innerWidth }
    })()`)
    check('WCO visible', r.visible, JSON.stringify(r))
    check('a real strip is reserved (titlebar area narrower than the window)', r.areaW !== null && r.areaW < r.inner, JSON.stringify(r))
    check('the overlay height matches AppChrome', TITLEBAR_OVERLAY_HEIGHT === 38, String(TITLEBAR_OVERLAY_HEIGHT))
    // setTitleBarOverlay must ACCEPT what the renderer will send. The renderer converts
    // color(srgb …) → rgb() precisely because Electron rejects the computed form; assert the
    // accepted form works and that a repainted overlay does not throw.
    try {
      win.setTitleBarOverlay({ color: 'rgb(13, 15, 21)', symbolColor: 'rgb(236, 227, 204)', height: TITLEBAR_OVERLAY_HEIGHT })
      check('setTitleBarOverlay accepts the CONVERTED rgb() form the renderer sends', true)
    } catch (e) {
      check('setTitleBarOverlay accepts the CONVERTED rgb() form the renderer sends', false, e.message)
    }
    // The form Chromium computes for a color-mix custom property. Rejected — which is why
    // toOverlayColor exists. Asserted here so the reason lives next to the engine that refuses it.
    let threw = false
    try {
      win.setTitleBarOverlay({ color: 'color(srgb 0.0505882 0.0607059 0.0843137)', symbolColor: INITIAL_OVERLAY_COLORS.symbolColor, height: TITLEBAR_OVERLAY_HEIGHT })
    } catch {
      threw = true
    }
    check('setTitleBarOverlay REJECTS the raw color(srgb …) form — the conversion is load-bearing, not caution', threw)
  } else {
    console.log('\n(not a WCO platform — overlay assertions skipped, as they would be vacuous here)')
    check('no overlay in the shipped options', opts.titleBarOverlay === undefined, JSON.stringify(opts))
  }

  win.destroy()
  console.log(failures === 0 ? '\nPASS — the shipped config keeps real, working window buttons' : `\nFAIL ${failures}`)
}

app.whenReady().then(async () => {
  try {
    await main()
  } catch (e) {
    console.error('probe threw: ' + String(e?.message ?? e))
    failures++
  }
  app.exit(failures === 0 ? 0 : 1)
})
