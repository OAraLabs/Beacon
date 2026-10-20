/**
 * Headless smoke: the words for the computer Beacon runs on follow the platform (@shared/this-computer). A Linux user saw the
 * connection banner say "It turned down the key saved on this Mac." Fails when:
 *   - macOS stops saying "this Mac", or any other platform says "Mac";
 *   - the banner or Settings' "Forget and set up again" hard-code "this Mac" again instead of asking the platform;
 *   - the bridge stops carrying the platform the page reads.
 *
 *   npm run build && npm run smoke:this-computer
 */
import { readFileSync } from 'node:fs'
import { rejectedKeyLine, thisComputer } from '@shared/this-computer'

let failures = 0
let checks = 0
function assert(cond: boolean, label: string, detail?: string): void {
  checks++
  console.log(`[this-computer-smoke] ${cond ? 'PASS' : 'FAIL'}  ${label}${!cond && detail ? `  — ${detail}` : ''}`)
  if (!cond) failures++
}
const EXPECTED = 4
process.on('exit', () => {
  if (checks !== EXPECTED) {
    console.error(`[this-computer-smoke] FAIL — ran ${checks} checks, expected exactly ${EXPECTED}`)
    process.exitCode = 1
  } else if (failures > 0) {
    console.error(`[this-computer-smoke] FAIL — ${failures}/${checks} checks failed`)
    process.exitCode = 1
  } else console.log(`[this-computer-smoke] OK — ${checks} checks passed`)
})
const strip = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1')

const others = ['linux', 'win32', 'freebsd']
assert(
  thisComputer('darwin') === 'this Mac' && others.every((p) => thisComputer(p) === 'this computer'),
  'words: "this Mac" on macOS, "this computer" on Linux, Windows and anything else',
  JSON.stringify(['darwin', ...others].map((p) => [p, thisComputer(p)]))
)
assert(
  rejectedKeyLine('darwin') === 'It turned down the key saved on this Mac. Change the connection to enter a new one.' &&
    rejectedKeyLine('linux') === 'It turned down the key saved on this computer. Change the connection to enter a new one.' && !/Mac/.test(rejectedKeyLine('linux')),
  'the banner\'s line for a key Prometheus turned down: "…saved on this computer…" on Linux, unchanged on macOS',
  JSON.stringify([rejectedKeyLine('darwin'), rejectedKeyLine('linux')])
)
const banner = strip(readFileSync('src/renderer/src/components/UnreachableBanner.tsx', 'utf8'))
const settings = strip(readFileSync('src/renderer/src/components/ConnectionSettings.tsx', 'utf8'))
assert(
  !/saved on this Mac/.test(banner) && /rejectedKeyLine\(\s*PLATFORM\s*\)/.test(banner) && !/saved on this Mac/.test(settings) && /thisComputer\(\s*PLATFORM\s*\)/.test(settings),
  'the banner and Settings\' "Forget and set up again" ask the platform instead of saying "this Mac"'
)
const preload = strip(readFileSync('src/preload/index.ts', 'utf8'))
const ipc = strip(readFileSync('src/shared/ipc.ts', 'utf8'))
assert(/platform:\s*process\.platform/.test(preload) && /platform:\s*string/.test(ipc), 'the bridge carries the platform (window.beacon.platform, from preload\'s process.platform)')
