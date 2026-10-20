/**
 * wco-probe — does the Window Controls Overlay actually work on Linux Electron 44?
 *
 * WHY THIS EXISTS BEFORE ANY PRODUCT CODE. `titleBarOverlay` is documented
 * `@platform win32,linux` in electron.d.ts, but it only enables WCO when the
 * window ALSO has a `titleBarStyle` that keeps the standard controls — and
 * `titleBarStyle: 'hidden'` is a macOS/Windows construct in Electron. If Linux
 * does not honour it, `frame: false` + `titleBarOverlay: true` yields a
 * frameless window with NO controls and a `navigator.windowControlsOverlay`
 * reporting `visible: false`, i.e. exactly the defect we are fixing.
 *
 * This measures it instead of reasoning about it. Read off the real engine, on
 * this platform, with this Electron version. env(titlebar-area-*) is only
 * readable from CSS, so we measure the rect it implies via a positioned div.
 *
 * Run: DISPLAY=:1 electron --disable-dev-shm-usage --no-sandbox scripts/wco-probe.cjs
 */
const { app, BrowserWindow } = require('electron')
const path = require('path')
const os = require('os')
const fs = require('fs')

// A writable userData + cache: the sandbox's HOME dirs are read-only and Electron
// hard-fails disk cache creation otherwise. This is probe plumbing, not product.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wco-probe-'))
app.setPath('userData', tmp)

const PAGE = 'file://' + path.join(__dirname, 'wco-probe-page.html')

// The comparison that matters. Measured on Electron 44.4.1 / Linux (GNOME, X11):
//   frame:false      + overlay -> wcoVisible FALSE, no titlebar area  (no controls: the bug)
//   titleBarStyle:'hidden' + overlay -> wcoVisible TRUE, area x0 w287 h38  (controls present)
// `titleBarOverlay` is documented `@platform win32,linux`, but on Linux it needs the window to keep
// its standard controls, and `frame: false` removes them outright — so the pairing silently yields
// a frameless window with NO window buttons. `titleBarStyle: 'hidden'` is the one that works.
const CASES = [
  { name: 'frameless + overlay obj', opts: { frame: false, titleBarOverlay: { color: '#0b0d12', symbolColor: '#ffffff', height: 38 } } },
  { name: 'frameless + overlay true', opts: { frame: false, titleBarOverlay: true } },
  { name: 'titleBarStyle hidden + overlay', opts: { titleBarStyle: 'hidden', titleBarOverlay: { color: '#0b0d12', symbolColor: '#ffffff', height: 38 } } }
]

// ONE CASE PER PROCESS. `frame: false` + `titleBarOverlay` does not merely report WCO unavailable
// on Linux Electron 44 — it can take the whole process down (ERR_FAILED / SIGTRAP), so looping over
// the cases in one process loses every result after the first failure. Run one:
//   WCO_CASE='frameless + overlay obj' DISPLAY=:1 electron --disable-dev-shm-usage --no-sandbox scripts/wco-probe.cjs
async function run() {
  const want = process.env.WCO_CASE
  const picked = want ? CASES.filter((c) => c.name === want) : CASES
  if (want && picked.length === 0) {
    console.log(JSON.stringify({ error: 'unknown WCO_CASE', want, known: CASES.map((c) => c.name) }))
    return
  }
  const results = []
  for (const c of picked) {
    // show: true is NOT incidental. Measured both ways on Electron 44/Linux: with `show: false` the
    // window is never realized by the WM, WCO reports `visible: false` and the titlebar-area env()
    // variables resolve to nothing — so EVERY configuration looks unsupported. The first run of this
    // probe did exactly that and concluded WCO was unavailable on Linux, which is false and would
    // have sent the fix down the wrong path. A probe that cannot see its subject reports the absence
    // of the subject, not the absence of the feature.
    const win = new BrowserWindow({ width: 800, height: 500, show: true, ...c.opts })
    await win.loadURL('about:blank')
    // Let the WM realize the window before reading: WCO visibility and the titlebar-area env()
    // variables are set by the toolkit when the window is mapped, not at construction. Reading
    // immediately gives `visible: false` for a configuration that does support it.
    await new Promise((r) => setTimeout(r, 1000))
    await win.webContents.executeJavaScript(
      `document.body.innerHTML = '<div id="envprobe"></div>'; document.body.style.margin='0';`
    )
    const read = await win.webContents.executeJavaScript(
      `(() => {
         const wco = navigator.windowControlsOverlay
         const probe = document.createElement('div')
         probe.style.cssText = 'position:fixed;top:env(titlebar-area-y,-1px);left:env(titlebar-area-x,-1px);width:env(titlebar-area-width,0px);height:0;'
         document.body.appendChild(probe)
         const r = probe.getBoundingClientRect()
         return {
           wcoExists: !!wco,
           wcoVisible: wco ? wco.visible : null,
           titlebarAreaX: r.left,
           titlebarAreaWidth: r.width,
           hasGetTitlebarAreaRect: typeof wco?.getTitlebarAreaRect === 'function'
         }
       })()`
    )
    results.push({ case: c.name, ...read })
    win.destroy()
  }
  console.log(JSON.stringify({ platform: process.platform, electron: process.versions.electron, results }, null, 2))
}

app.whenReady().then(async () => {
  try {
    await run()
  } catch (e) {
    console.log('PROBE ERROR: ' + e.message)
  }
  app.exit(0)
})
