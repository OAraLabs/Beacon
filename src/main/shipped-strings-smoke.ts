/**
 * Headless smoke: what ships says nothing personal or raw (the 0.4.5 raw-error sweep, E1–E4 and M1).
 *   - E1: no personal path (/home/<name>/…, /Users/<name>/…) in anything the app ships: every built file under out/ except the smoke
 *     entry points (electron-builder.yml packs out/** minus out/main/*-smoke.js). And Coding › Run's heading is plain.
 *   - E2: Config › Devices says why a phone cannot use 127.0.0.1 (or another bare IP) in plain words.
 *   - E3: Workspace › Integrations' empty state is plain and has a next step.
 *   - E4: "Make this Beacon an owner" says what happened without a key the person never typed.
 *   - M1: "You're all set" renders the first reply's markdown (chat's own renderer), not the raw text.
 *
 *   npm run build && npm run smoke:shipped-strings
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { ipHostRefusal } from '@shared/devices'
import { OWNER_SETTINGS_COPY } from '@shared/owner-promotion'

let failures = 0
let checks = 0
function assert(cond: boolean, label: string, detail?: string): void {
  checks++
  console.log(`[shipped-strings-smoke] ${cond ? 'PASS' : 'FAIL'}  ${label}${!cond && detail ? `  — ${detail}` : ''}`)
  if (!cond) failures++
}
const EXPECTED = 6
process.on('exit', () => {
  if (checks !== EXPECTED) {
    console.error(`[shipped-strings-smoke] FAIL — ran ${checks} checks, expected exactly ${EXPECTED}`)
    process.exitCode = 1
  } else if (failures > 0) {
    console.error(`[shipped-strings-smoke] FAIL — ${failures}/${checks} checks failed`)
    process.exitCode = 1
  } else console.log(`[shipped-strings-smoke] OK — ${checks} checks passed`)
})
const strip = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1')

// ── E1: personal paths in what ships ──
const shipped: string[] = []
const walk = (d: string): void => {
  for (const n of readdirSync(d)) {
    const p = join(d, n)
    if (statSync(p).isDirectory()) walk(p)
    else if (!/^out\/main\/[^/]+-smoke\.js$/.test(p) && !p.endsWith('.map')) shipped.push(p)
  }
}
walk('out')
const PERSONAL = /\/(?:home|Users)\/[A-Za-z][A-Za-z0-9._-]*\/[A-Za-z0-9._-]/g
const hits: string[] = []
for (const f of shipped) {
  if (!/\.(js|mjs|cjs|html|css|json)$/.test(f)) continue
  const text = readFileSync(f, 'utf8')
  for (const m of text.matchAll(PERSONAL)) hits.push(`${f}: …${text.slice(Math.max(0, (m.index ?? 0) - 30), (m.index ?? 0) + 50)}…`)
}
// Self-test: the pattern catches the path the sweep found, and leaves a bare "/Users/" (no name) alone.
const selfTest = '"/home/demo/bakeoff-harness/fixture-marshmallow"'.match(PERSONAL) !== null && '"/Users/"'.match(PERSONAL) === null
assert(shipped.length > 20 && selfTest && hits.length === 0, `E1: no personal path (/home/<name>/…, /Users/<name>/…) in the ${shipped.length} built files that ship`, hits.slice(0, 4).join(' | ') || `selfTest ${selfTest}, files ${shipped.length}`)
const coding = strip(readFileSync('src/renderer/src/components/CodingPanel.tsx', 'utf8'))
assert(
  // Visible words only: the panel's own requests go to /api/code, which is code and not something it says.
  !/altitude|\/api\/code engine|engine at|daemon host|on the daemon/.test(coding) && !/placeholder="\/(home|Users)\//.test(coding),
  "E1: Coding › Run's heading, description and placeholder are plain (no route, no \"altitude\", no \"daemon host\", no one's home folder)"
)

// ── E2–E4 ──
const JARGON = /plain-http|iOS matches|exceptions by name|gateway|daemon|QR built on one|integrations\.json|user-data|pure-Prometheus|owner key|typed in/i
const devices = [ipHostRefusal('127.0.0.1'), ipHostRefusal('192.168.1.20')]
assert(devices.every((t) => t.length > 40 && !JARGON.test(t)) && /this computer|this Mac/.test(devices[0]), 'E2: Config › Devices says in plain words why a phone cannot use 127.0.0.1 (only this computer can) or a bare network address, and what to do', JSON.stringify(devices))
const integ = strip(readFileSync('src/renderer/src/components/IntegrationsPanel.tsx', 'utf8'))
assert(
  !/integrations\.json<\/span> in the app|user-data folder|pure-Prometheus|generic control surfaces/.test(integ) && /No integrations yet\./.test(integ) && /integrations\.reveal\(/.test(integ),
  "E3: Workspace › Integrations says what an integration is in plain words, names no folder or \"pure-Prometheus\", and its next step is a button that shows the file"
)
assert(!JARGON.test(OWNER_SETTINGS_COPY.done) && /owner/.test(OWNER_SETTINGS_COPY.done), 'E4: after "Make owner" it says this Beacon is now an owner, with no key the person never typed', OWNER_SETTINGS_COPY.done)

// ── M1 ──
const hello = strip(readFileSync('src/renderer/src/components/onboarding/Hello.tsx', 'utf8'))
assert(/<TextBlock\s+text=\{s\.reply\}/.test(hello), '"You\'re all set" renders the first reply with chat\'s markdown renderer (TextBlock), not as raw text')
