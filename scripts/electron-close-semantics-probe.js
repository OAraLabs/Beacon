// Pins the Electron fact both satellite panes (terminal, browser) rest on — measured 2026-09-03
// on Electron 33.4.11 after the terminal probe found its "close the window" step was destroying
// the satellite instead of hiding it:
//
//   renderer window.close()  → NO cancelable 'close' event; only 'closed'. The window is DESTROYED.
//   BrowserWindow.close()    → 'close' fires; preventDefault() holds; the window can hide instead.
//
// popout-window.ts hides on 'close' and is measured leak-free through BrowserWindow.close() (the
// red button / ⌘W path). A satellite-hosted surface that calls window.close() therefore bypasses
// the whole design — and for a window hosting a WebContentsView that is the teardown that hung
// main. Run this after an Electron upgrade; if the first line ever grows a 'close', the guard in
// terminal-smoke / browser-invariant-smoke is stricter than it needs to be, and if the second
// line ever loses it, popout-window.ts is broken.
//
// Run: node_modules/.bin/electron scripts/electron-close-semantics-probe.js   (exit 0 = pinned)
const { app, BrowserWindow } = require('electron')
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n')
let failures = 0
const check = (ok, what) => { out({ [ok ? 'PASS' : 'FAIL']: what }); if (!ok) failures++ }

app.on('window-all-closed', () => { /* the first experiment closes its only window; stay alive to report */ })
app.whenReady().then(() => {
  const seen = []
  const win = new BrowserWindow({ show: false, width: 300, height: 200, webPreferences: { sandbox: true, contextIsolation: true } })
  win.on('close', (e) => { seen.push('close'); e.preventDefault(); win.hide() })
  win.on('closed', () => seen.push('closed'))
  win.loadURL('data:text/html,<script>setTimeout(()=>window.close(),300)</script>')
  win.once('ready-to-show', () => win.show())
  setTimeout(() => {
    out({ rendererWindowClose: seen, destroyed: win.isDestroyed(), electron: process.versions.electron })
    check(!seen.includes('close') && seen.includes('closed') && win.isDestroyed(), "renderer window.close() bypasses the cancelable 'close' and destroys the window")
    const seen2 = []
    const w2 = new BrowserWindow({ show: true, width: 300, height: 200 })
    w2.on('close', (e) => { seen2.push('close'); e.preventDefault(); w2.hide() })
    w2.on('closed', () => seen2.push('closed'))
    w2.close()
    setTimeout(() => {
      out({ browserWindowClose: seen2, destroyed: w2.isDestroyed(), visible: w2.isDestroyed() ? null : w2.isVisible() })
      check(seen2.includes('close') && !seen2.includes('closed') && !w2.isDestroyed() && !w2.isVisible(), "BrowserWindow.close() fires 'close'; preventDefault holds; the window hides")
      out({ result: failures === 0 ? 'PINNED' : `${failures} FAILURE(S)` })
      app.exit(failures === 0 ? 0 : 1)
    }, 500)
  }, 1500)
})
