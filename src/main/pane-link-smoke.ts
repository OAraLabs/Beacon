/**
 * Headless smoke for the local-link → browser-pane rule. The pure decision (which hosts are local,
 * which clicks count) plus the wiring that makes it live. The real click in the real app is
 * scripts/pane-link-probe.mjs; the structural guarantee that nothing ELSE can reach the pane is
 * browser-invariant-smoke (R9). This pins the model both of them lean on.
 *
 * Run: npm run smoke:pane-link
 */
import { isLocalHost, isPaneLink, shouldOpenInPane, type ClickLike } from '@shared/pane-link'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

let failures = 0
function assert(cond: boolean, what: string): void {
  console.log(`[smoke] ${cond ? 'PASS' : 'FAIL'}  ${what}`)
  if (!cond) failures++
}

console.log('[smoke] === 1. which hosts are local ===')
// A Tailscale-range address is built, never written: the pre-commit guard refuses a literal one in
// source (the same helper plain-lan-smoke uses), and the examples here are range edges, not addresses.
const TS = (b: number, c = 0, d = 1): string => `100.${b}.${c}.${d}`
const LOCAL = [
  TS(101, 102, 103), TS(64), TS(127, 255, 254), 'localhost', 'LOCALHOST', 'localhost.', '127.0.0.1', '127.9.9.9', '10.0.0.1', '10.255.255.255',
  '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.10.10',
  '[::1]', '[fd12:3456:789a::1]', '[fc00::1]', '[fe80::1]', '[fd7a:115c:a1e0::1]', '[::ffff:7f00:1]',
  'mini', 'mac-mini', 'mini.local', 'host.tail1a2b3.ts.net' // precommit:allow-example-host
]
for (const h of LOCAL) assert(isLocalHost(h), `local: ${h}`)
const PUBLIC = [
  '', 'example.com', 'github.com', 'www.google.com', '8.8.8.8', '1.2.3.4', '172.15.255.255', '172.32.0.1', '192.169.1.1', '192.167.1.1',
  TS(63, 255, 255), TS(128), '11.0.0.1', '[2001:db8::1]', 'ts.net.evil.com', 'mini.local.evil.com',
  'notlocalhost.com', '127.0.0.1.evil.com', 'evil.com', 'a.b'
]
for (const h of PUBLIC) assert(!isLocalHost(h), `NOT local: ${JSON.stringify(h)}`)

console.log('[smoke] === 2. which links qualify ===')
assert(isPaneLink(`http://${TS(101, 102, 103)}:8077/`), 'a tailnet address with a port — the case that started this — qualifies')
assert(isPaneLink('https://mini.tail1a2b3.ts.net/report.html'), 'a MagicDNS https URL qualifies') // precommit:allow-example-host
assert(isPaneLink('http://localhost:3000/x?y=1#z'), 'localhost with a port, path, query and fragment qualifies')
assert(isPaneLink('HTTP://LOCALHOST:3000/'), 'scheme and host are case-insensitive')
assert(isPaneLink('  http://127.0.0.1:8077/  '), 'surrounding whitespace is trimmed, not a bypass in either direction')
assert(isPaneLink('http://2130706433/'), 'a decimal-spelled loopback is normalised by URL and still local')
assert(!isPaneLink('https://github.com/OAraLabs/Prometheus/pull/1'), 'a public site does NOT — it stays in the system browser, where the person is logged in')
assert(!isPaneLink('http://10.0.0.1@evil.com/'), 'userinfo cannot smuggle a public host behind a private-looking prefix')
assert(!isPaneLink('http://evil.com/10.0.0.1'), 'a private address in the PATH is not the host')
assert(!isPaneLink('http://127.0.0.1.evil.com/'), 'a private address as a subdomain label is not local')
assert(!isPaneLink('file:///etc/passwd'), 'file: never')
assert(!isPaneLink('javascript:alert(1)'), 'javascript: never')
assert(!isPaneLink('data:text/html,<script>1</script>'), 'data: never')
assert(!isPaneLink('beacon-artifact://render/abc?kind=html'), "the app's own privileged scheme never")
assert(!isPaneLink('mailto:a@b.c'), 'mailto: never (it opens a mail client, not a page)')
assert(!isPaneLink('/relative/path'), 'a relative href never')
assert(!isPaneLink('http://'), 'a malformed URL is false, not a throw')
assert(!isPaneLink(undefined as unknown as string) && !isPaneLink(42 as unknown as string), 'a non-string is false, not a throw')

console.log('[smoke] === 3. which clicks count ===')
const click = (over: Partial<ClickLike> = {}): ClickLike => ({ button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, isTrusted: true, ...over })
const LOCAL_LINK = `http://${TS(101, 102, 103)}:8077/`
assert(shouldOpenInPane(click(), LOCAL_LINK), 'a trusted plain left click on a local link opens the pane')
assert(!shouldOpenInPane(click({ isTrusted: false }), LOCAL_LINK), 'an UNTRUSTED click (script-dispatched) does not — this is what makes "an agent cannot" true')
assert(!shouldOpenInPane(click({ isTrusted: undefined as unknown as boolean }), LOCAL_LINK), 'a click with no isTrusted at all does not (strictly === true)')
assert(!shouldOpenInPane(click({ metaKey: true }), LOCAL_LINK), '⌘-click keeps the old behaviour: system browser')
assert(!shouldOpenInPane(click({ ctrlKey: true }), LOCAL_LINK), 'Ctrl-click keeps the old behaviour')
assert(!shouldOpenInPane(click({ shiftKey: true }), LOCAL_LINK), 'Shift-click keeps the old behaviour')
assert(!shouldOpenInPane(click({ altKey: true }), LOCAL_LINK), 'Alt-click keeps the old behaviour')
assert(!shouldOpenInPane(click({ button: 1 }), LOCAL_LINK), 'a middle click does not')
assert(!shouldOpenInPane(click({ button: 2 }), LOCAL_LINK), 'a right click does not')
assert(!shouldOpenInPane(click(), 'https://example.com/'), 'a trusted plain click on a PUBLIC link does not')
assert(!shouldOpenInPane(click(), undefined), 'an anchor with no href does not')
assert(!shouldOpenInPane(click(), ''), 'a blanked href (markdownUrlTransform refuses it to "") does not')

console.log('[smoke] === 4. the model is WIRED, not just defined ===')
// A pure model with nothing calling it is dead code that passes every test above. These read the
// sources to pin the wiring half — the same source-regex approach artifacts-smoke uses.
{
  const read = (p: string): string => readFileSync(join(process.cwd(), p), 'utf8')
  const mr = read('src/renderer/src/components/MessageRenderer.tsx')
  const mv = read('src/renderer/src/components/MainView.tsx')
  const relay = read('src/renderer/src/browser/PaneLinkRelay.tsx')
  assert(/e\.preventDefault\(\)/.test(mr) && /requestPaneLink\(href as string\)\) e\.preventDefault\(\)/.test(mr), 'a link the pane TOOK has its default stopped — otherwise it would ALSO open the system browser')
  assert(/target="_blank"/.test(mr), 'the anchor still opens the system browser when the pane declines (public link, modifier, no pane in this window)')
  assert(/<PaneLinkRelay onShow=\{showBrowserForLink\} \/>/.test(mv), 'MainView mounts the relay with its dock-aware show')
  assert(/if \(!canDock\(viewRef\.current\)\) return false/.test(mv), 'a surface the dock cannot sit beside DECLINES, so the link opens in the system browser instead of yanking the person to the chat view')
  assert(/showPane\('browser'\)/.test(mv), 'taking a link shows the browser pane first, so the page is never alive and invisible')
  assert(/onShow\(\)/.test(relay) && /\.browser\.navigate\(url\)/.test(relay), 'the relay shows the pane, then navigates to the url it was handed')
  const main = read('src/main/browser-pane.ts')
  assert(!/pane-link|link-open|PaneLink/.test(main), 'src/main/browser-pane.ts knows nothing of chat links — main only ever sees the same NAVIGATE the URL bar sends')
}

console.log('')
console.log('[smoke] ===================== RESULT =====================')
console.log(`[smoke] outcome: ${failures === 0 ? 'PASS ✓' : `FAIL ✗ (${failures})`} (hosts, links, clicks, wiring)`)
console.log('[smoke] ===================================================')
process.exit(failures === 0 ? 0 : 1)
