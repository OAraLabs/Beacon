/**
 * Headless smoke: no window, view or webview has Chromium's built-in spellchecker on outside macOS
 * (@shared/spellcheck). On Linux that spellchecker downloads dictionaries from Google's CDN unasked, and
 * Beacon's terms say it connects only to the daemon and services you configure, the sites you open in
 * its browser pane, and GitHub for updates.
 *
 * Fails when:
 *   - the model says anything but "macOS only";
 *   - any `new BrowserWindow(` / `new WebContentsView(` / `new BrowserView(` in shipped source has no
 *     webPreferences, no `spellcheck`, or a `spellcheck` other than `builtinSpellcheck(process.platform)`.
 *     A missing key fails too: Electron's default is ON;
 *   - the construction sites are not exactly the pinned ones (a new window must be looked at);
 *   - anything enables `webviewTag`, the renderer has a <webview>, or the browser pane stops refusing
 *     will-attach-webview: a webview is a page this smoke could not see;
 *   - main stops switching the spellchecker off on every session outside macOS (the backstop).
 *
 * WHAT THIS CANNOT PROVE: what a running Linux build does. It reads the source every build compiles, and
 * evaluates each site's setting for 'linux'. The release run builds Linux from the same source.
 *
 *   npm run build && npm run smoke:spellcheck
 */
import { readdirSync, readFileSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { builtinSpellcheck } from '@shared/spellcheck'
import { DICTIONARY_URL_NOWHERE, quietSpellchecker } from './quiet-spellchecker'

let failures = 0
let checks = 0
function assert(cond: boolean, what: string, detail = ''): void {
  checks++
  console.log(`[smoke] ${cond ? 'PASS' : 'FAIL'}  ${what}${detail && !cond ? `\n        ${detail}` : ''}`)
  if (!cond) failures++
}
const MIN_CHECKS = 26
process.on('exit', (code) => {
  if (code === 0 && (failures > 0 || checks < MIN_CHECKS)) process.exitCode = 1
  console.log(`\n[smoke] outcome: ${failures === 0 && checks >= MIN_CHECKS ? 'PASS ✓' : `FAIL ✗ (${failures} failed, ${checks} of at least ${MIN_CHECKS} checks ran)`}`)
})

console.log('\n[smoke] === 1. the model: macOS only ===')
assert(builtinSpellcheck('darwin') === true, 'macOS keeps the OS spellchecker')
for (const p of ['linux', 'win32', 'freebsd', 'openbsd', '']) assert(builtinSpellcheck(p) === false, `off on ${JSON.stringify(p)}`)

const outMain: unknown = import.meta.mainOutDir
const repo = typeof outMain === 'string' && isAbsolute(outMain) ? resolve(outMain, '../..') : null
assert(repo !== null, 'import.meta.mainOutDir locates the checkout', String(outMain))
if (repo) {
  /** Comments out (they mention `new BrowserWindow` and spellcheck freely), `://` kept. */
  const strip = (t: string): string => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\])\/\/.*$/gm, '$1')
  /** String and template-literal contents blanked to spaces, same length: a message that MENTIONS
   *  `new BrowserWindow(` is not a construction site, and positions still line up with the real text. */
  const mask = (t: string): string => {
    let out = ''
    for (let i = 0; i < t.length; i++) {
      const ch = t[i]
      if (ch !== "'" && ch !== '"' && ch !== '`') { out += ch; continue }
      let j = i + 1
      while (j < t.length && t[j] !== ch && !(ch !== '`' && t[j] === '\n')) j += t[j] === '\\' ? 2 : 1
      out += ch + t.slice(i + 1, j).replace(/[^\n]/g, ' ') + (t[j] ?? '')
      i = j
    }
    return out
  }
  const files: { path: string; text: string; code: string }[] = []
  for (const dir of ['src/main', 'src/preload', 'src/shared', 'src/renderer/src']) {
    for (const f of readdirSync(join(repo, dir), { recursive: true }) as string[]) {
      if (!/\.(ts|tsx)$/.test(f) || /-smoke\.ts$/.test(f) || /\.d\.ts$/.test(f)) continue
      const path = join(dir, f)
      const text = strip(readFileSync(join(repo, path), 'utf8'))
      files.push({ path, text, code: mask(text) })
    }
  }
  /** From the `(` at `open`, the text up to its matching `)`, skipping string and template literals. */
  const balanced = (text: string, open: number, o = '(', c = ')'): string | null => {
    let depth = 0
    for (let i = open; i < text.length; i++) {
      const ch = text[i]
      if (ch === "'" || ch === '"' || ch === '`') {
        for (i++; i < text.length && text[i] !== ch; i++) if (text[i] === '\\') i++
        continue
      }
      if (ch === o) depth++
      else if (ch === c && --depth === 0) return text.slice(open + 1, i)
    }
    return null
  }

  console.log('\n[smoke] === 2. every window and view sets spellcheck from the model ===')
  const PINNED: Record<string, number> = { 'src/main/index.ts': 3, 'src/main/popout-window.ts': 1, 'src/main/browser-pane.ts': 1, 'src/main/session-windows.ts': 1 }
  const tally = new Map<string, number>()
  for (const f of files) {
    for (const m of f.code.matchAll(/new (BrowserWindow|WebContentsView|BrowserView)\(/g)) {
      tally.set(f.path, (tally.get(f.path) ?? 0) + 1)
      const line = f.text.slice(0, m.index).split('\n').length
      const where = `${f.path}:~${line} new ${m[1]}`
      const args = balanced(f.text, m.index! + m[0].length - 1) ?? ''
      const at = args.search(/webPreferences:\s*\{/)
      const prefs = at < 0 ? null : balanced(args, args.indexOf('{', at), '{', '}')
      const keys = prefs ? [...prefs.matchAll(/\bspellcheck:\s*([^,\n}]+)/g)].map((k) => k[1].trim()) : []
      const ok = keys.length === 1 && keys[0] === 'builtinSpellcheck(process.platform)'
      assert(ok, `${where}: spellcheck is builtinSpellcheck(process.platform), so off on Linux`, prefs === null ? 'no webPreferences: Electron defaults spellcheck ON' : keys.length === 0 ? 'webPreferences has no spellcheck: Electron defaults it ON' : `spellcheck: ${keys.join(' / ')}`)
    }
  }
  for (const [path, want] of Object.entries(PINNED)) assert(tally.get(path) === want, `${path} constructs ${want} window/view(s)`, `found ${tally.get(path) ?? 0}`)
  const others = [...tally.keys()].filter((p) => !(p in PINNED))
  assert(others.length === 0, 'no other file constructs a window or view', others.join(', '))

  console.log('\n[smoke] === 3. no webview a scan could miss ===')
  const webviewOn = files.flatMap((f) => [...f.code.matchAll(/webviewTag:\s*([^\s,}]+)/g)].filter((m) => m[1] !== 'false').map((m) => `${f.path} (webviewTag: ${m[1]})`))
  assert(webviewOn.length === 0, 'nothing sets webviewTag to anything but false (Electron defaults it off)', webviewOn.join(', '))
  const webviewEl = files.filter((f) => f.path.startsWith('src/renderer') && /<webview\b/i.test(f.code)).map((f) => f.path)
  assert(webviewEl.length === 0, 'the renderer has no <webview> element', webviewEl.join(', '))
  const pane = files.find((f) => f.path === 'src/main/browser-pane.ts')?.text ?? ''
  assert(/on\('will-attach-webview',\s*\(e\)\s*=>\s*e\.preventDefault\(\)\)/.test(pane), 'the browser pane refuses will-attach-webview')

  console.log('\n[smoke] === 4. outside macOS, main switches it off on every session (backstop) ===')
  const main = files.find((f) => f.path === 'src/main/index.ts')?.text ?? ''
  assert(/if \(!builtinSpellcheck\(process\.platform\)\) \{\s*app\.on\('web-contents-created', \(_e, wc\) => wc\.session\.setSpellCheckerEnabled\(false\)\)\s*\}/.test(main),
    "index.ts: if (!builtinSpellcheck(process.platform)) app.on('web-contents-created', … setSpellCheckerEnabled(false))")
  assert(!files.some((f) => /setSpellCheckerEnabled\(\s*true/.test(f.text)), 'nothing switches a session spellchecker back on')

  console.log('\n[smoke] === 5. outside macOS, every session has nothing to download from the moment it exists ===')
  // A Linux capture of 0.4.4 saw the en-US dictionary fetched from redirector.gvt1.com and rr4---…gvt1.com at startup: the session starts
  // the download when it is created, so switching pages off (section 4) is too late.
  const calls: string[] = []
  quietSpellchecker({
    setSpellCheckerEnabled: (on: boolean) => void calls.push(`enabled:${on}`),
    setSpellCheckerLanguages: (langs: string[]) => void calls.push(`languages:${JSON.stringify(langs)}`),
    setSpellCheckerDictionaryDownloadURL: (url: string) => void calls.push(`url:${url}`)
  } as never)
  const nowhere = new URL(DICTIONARY_URL_NOWHERE)
  assert(
    calls.includes('languages:[]') && calls.includes(`url:${DICTIONARY_URL_NOWHERE}`) && calls.includes('enabled:false') && nowhere.hostname === '127.0.0.1',
    'quietSpellchecker: no languages (nothing to download), the download address on this computer (never Google), and the checker off',
    JSON.stringify({ calls, url: DICTIONARY_URL_NOWHERE })
  )
  assert(/if \(!builtinSpellcheck\(process\.platform\)\) \{[^}]*app\.on\('session-created', quietSpellchecker\)/.test(main),
    "index.ts: outside macOS, app.on('session-created', quietSpellchecker), so every session is quiet as it is created (registered before ready)")
  assert(files.length > 50 && files.some((f) => f.path === 'src/main/index.ts'), `scanned the shipped source (${files.length} files)`, relative(repo, repo))
}
