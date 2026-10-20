/**
 * Headless smoke: an approved (scoped) device is told, in plain words, that a view is the owner's, instead of Prometheus's refusal
 * (the 0.4.5 raw-error sweep, S1–S9). @shared/device-role reads the role from GET /api/devices as Prometheus really answers it
 * (src/main/fixtures/device_roles.json, recorded by scripts/record-device-roles.mjs from Prometheus 0.9.13).
 *
 * Fails when: the role is misread for a scoped device, an owner device or the global token; the owner-only lists stop matching
 * the views and tabs that read owner routes; the note says anything raw (a status code, a route, "daemon", "too old",
 * "redeploy", a placeholder reading); or the app stops wiring it (main asks GET /api/devices; MainView, ConfigPanel and
 * MissionControl hold back owner-only reads and show the note; Devices keeps the device's own row; chat drops a model chip it
 * cannot read). WHAT THIS CANNOT PROVE: what the running app shows; the real-app
 * probe (scripts/owner-only-app-probe.mjs) walks it against a real Prometheus.
 *
 *   npm run build && npm run smoke:owner-only
 */
import { readFileSync } from 'node:fs'
import { OWNER_ONLY_CONFIG_TABS, OWNER_ONLY_COPY, OWNER_ONLY_VIEWS, ownerOnlyText, roleFromDevices } from '@shared/device-role'

let failures = 0
let checks = 0
function assert(cond: boolean, label: string, detail?: string): void {
  checks++
  console.log(`[owner-only-smoke] ${cond ? 'PASS' : 'FAIL'}  ${label}${!cond && detail ? `  — ${detail}` : ''}`)
  if (!cond) failures++
}
const EXPECTED = 9
process.on('exit', () => {
  if (checks !== EXPECTED) {
    console.error(`[owner-only-smoke] FAIL — ran ${checks} checks, expected exactly ${EXPECTED}`)
    process.exitCode = 1
  } else if (failures > 0) {
    console.error(`[owner-only-smoke] FAIL — ${failures}/${checks} checks failed`)
    process.exitCode = 1
  } else console.log(`[owner-only-smoke] OK — ${checks} checks passed`)
})
const strip = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1')
const src = (p: string): string => strip(readFileSync(p, 'utf8'))

const F = JSON.parse(readFileSync('src/main/fixtures/device_roles.json', 'utf8')) as { answers: Record<string, { status: number; body: unknown }> }
const A = F.answers
const read = (k: string): unknown => roleFromDevices(A[k].status, A[k].body)
assert(
  read('scoped_device') === 'limited' && read('owner_device') === 'owner' && read('global_token') === 'owner',
  'role (recorded from Prometheus 0.9.13): a scoped device is limited; an owner device and the global token are the owner',
  JSON.stringify({ scoped: read('scoped_device'), owner: read('owner_device'), global: read('global_token') })
)
assert(
  roleFromDevices(401, { error: 'unauthorized' }) === null && roleFromDevices(200, { devices: [] }) === null && roleFromDevices(200, 'nope') === null && roleFromDevices(500, null) === null &&
    // A refusal is never read as "no row of its own" (which is the global token, the owner), whatever its body.
    roleFromDevices(403, []) === null && roleFromDevices(404, A.scoped_device.body) === null &&
    roleFromDevices(200, [{ id: 'x', is_self: true }]) === null,
  'role: an answer it cannot read says nothing (Beacon then shows everything, as before), including an own row with no owner flag',
  JSON.stringify([roleFromDevices(401, {}), roleFromDevices(200, { devices: [] }), roleFromDevices(200, [{ id: 'x', is_self: true }])])
)
// What reads only owner routes, by the id the app routes it by. Not the sweep's screenshots (sweep-045/SWEEP.md, which judged a screen by
// what it showed) but Prometheus's own list of what a scoped device may use (web/route_access.py SCOPED_ALLOWED, 0.9.13): its device,
// chat, its own sessions and their fork, events and activity, search, and its own approvals. So Artifacts (/api/artifacts), Checkpoints
// (/api/sessions/{id}/checkpoints), Workspace › Skills (/api/learning/skill-drafts), Coding and Loop Manager (/api/code), Grants
// (/api/approvals/grants) and Config › Config are the owner's too: on an approved device they showed "No artifacts yet", "No pending
// skill drafts", "No remembered grants" and "{}", empty readings that are really refusals.
const VIEWS = ['artifacts', 'board', 'checkpoints', 'coding', 'documents', 'files', 'loop-manager', 'skills', 'status', 'wiki']
const TABS = ['config', 'connectors', 'cron', 'grants', 'memory', 'models', 'profiles', 'sentinel', 'skills', 'telemetry', 'usage', 'wiki']
assert(
  JSON.stringify([...OWNER_ONLY_VIEWS].sort()) === JSON.stringify(VIEWS) && JSON.stringify([...OWNER_ONLY_CONFIG_TABS].sort()) === JSON.stringify(TABS),
  'owner-only: Coding (Run, Loop Manager); Workspace › Files, Artifacts, Board, Documents, Wiki, Checkpoints, Skills; Activity › Status; Config › Models, Connectors, Skills, Profiles, Grants, Telemetry, Usage, Memory, Sentinel, Wiki, Cron, Config (and nothing an approved device may use: Chats, Integrations, Live, Tool Feed, Devices, Skin)',
  JSON.stringify({ views: OWNER_ONLY_VIEWS, tabs: OWNER_ONLY_CONFIG_TABS })
)
const RAW = /\b[45]\d\d\b|\/api\/|operator|daemon|too old|redeploy|HTTP|error|refused|forbidden|— · —|up 0s|Prometheus issue|\bnull\b|undefined/i
const notes = ['mission', 'enrol', ...VIEWS, ...TABS].map((a) => [a, ownerOnlyText(a)] as const)
assert(
  notes.every(([, t]) => t.length > 30 && /owner of this Prometheus/.test(t) && !RAW.test(t)) && OWNER_ONLY_COPY.button === 'Make this Beacon an owner',
  'the note: plain words for every owner-only area ("… is for the owner of this Prometheus …"), no code, route or jargon, and the button "Make this Beacon an owner"',
  JSON.stringify(notes.filter(([, t]) => !(t.length > 30 && /owner of this Prometheus/.test(t) && !RAW.test(t))))
)
const main = src('src/main/connection/index.ts') + src('src/main/index.ts')
assert(/DEVICES_PATH/.test(main) && /roleFromDevices\(/.test(main) && /role/.test(src('src/shared/ipc.ts').match(/export interface ConnectionStatus \{[\s\S]*?\n\}/)?.[0] ?? ''), 'main asks GET /api/devices once connected and puts the role on the connection status')
const mv = src('src/renderer/src/components/MainView.tsx')
const cp = src('src/renderer/src/components/ConfigPanel.tsx')
assert(/OwnerOnlyNote/.test(mv) && /OWNER_ONLY_VIEWS|isOwnerOnlyView/.test(mv) && /OwnerOnlyNote/.test(cp) && /OWNER_ONLY_CONFIG_TABS|isOwnerOnlyConfigTab/.test(cp), 'MainView and Config show the note in place of an owner-only view or tab on an approved device (the panel never mounts, so nothing is asked)')
const mc = src('src/renderer/src/components/MissionControl.tsx')
assert(/OwnerOnlyNote/.test(mc) && /limited/.test(mc), 'Mission keeps what an approved device may see (needs you, activity) and shows the note for the rest, asking for none of it')
const dv = src('src/renderer/src/components/DevicesPanel.tsx')
const chat = src('src/renderer/src/components/ChatShell.tsx') + src('src/renderer/src/components/ChatHome.tsx')
assert(
  /OwnerOnlyNote/.test(dv) && /limited/.test(dv) && /limited/.test(chat),
  'Config › Devices keeps its own row on an approved device and says adding one is the owner\'s (no Enrol that is refused); chat shows no model chip it cannot read ("· offline")'
)
// The end of path B (an approved device's "You're all set"): offer "Make this Beacon an owner" once, there, and only to an approved
// device (an owner has nothing to become). Its words are onboarding copy, so smoke:onboarding-copy holds them to the plain-words list.
const hello = src('src/renderer/src/components/onboarding/Hello.tsx')
const copy = src('src/shared/onboarding-strings.ts')
assert(
  /limited/.test(hello) && /openMakeOwner\(/.test(hello) && /done\.owner\./.test(hello) && /owner:\s*\{[^}]*button:\s*'Make this Beacon an owner'/.test(copy),
  '"You\'re all set" on an approved device offers "Make this Beacon an owner" (once: the end of path B), and finishing that way opens Settings at it'
)
