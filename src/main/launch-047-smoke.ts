/**
 * Headless smoke: three things filming Path B on 0.4.6 found (owner decision, 2026-10-18, for 0.4.7).
 *   1. Settings: a new person never meets the connection address or "The token authenticates both transports: the REST bearer header
 *      and the WebSocket first-frame handshake." The address and the key sit under a collapsed Advanced section, in plain words, and
 *      "Make this Beacon an owner" opens a sheet with the owner section only.
 *   2. Mission (and Config › Telemetry) on a fresh daemon: zero tool calls read "No tool calls yet", never a red "0%".
 *   3. Chat's markdown: a plain list is plain bullets; a task list (- [ ] / - [x]) is checkboxes with no bullet beside them (the first
 *      reply showed both on every item: the renderer's own ul/li dropped the task-list classes, so the bullet stayed).
 * The source checks hold the wiring; scripts/owner-only-app-probe.mjs and scripts/markdown-lists-app-probe.mjs paint it.
 *
 *   npm run build && npm run smoke:launch-047
 */
import { readFileSync } from 'node:fs'
import { toolCallsReading } from '@shared/daemon-api'

let failures = 0
let checks = 0
function assert(cond: boolean, label: string, detail?: string): void {
  checks++
  console.log(`[launch-047-smoke] ${cond ? 'PASS' : 'FAIL'}  ${label}${!cond && detail ? `  — ${detail}` : ''}`)
  if (!cond) failures++
}
const EXPECTED = 6
process.on('exit', () => {
  if (checks !== EXPECTED) {
    console.error(`[launch-047-smoke] FAIL — ran ${checks} checks, expected exactly ${EXPECTED}`)
    process.exitCode = 1
  } else if (failures > 0) {
    console.error(`[launch-047-smoke] FAIL — ${failures}/${checks} checks failed`)
    process.exitCode = 1
  } else console.log(`[launch-047-smoke] OK — ${checks} checks passed`)
})
const strip = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1')
const src = (p: string): string => strip(readFileSync(p, 'utf8'))

// 2. the reading
const none = [toolCallsReading(0, 0), toolCallsReading(0, null), toolCallsReading(undefined, 0), toolCallsReading(null, undefined)]
assert(none.every((r) => r.kind === 'none'), 'no tool calls (0, or none reported) is "none": no rate, nothing to colour', JSON.stringify(none))
const some = toolCallsReading(12, 0.75)
const failing = toolCallsReading(4, 0)
assert(
  some.kind === 'calls' && some.calls === 12 && some.pct === 75 && failing.kind === 'calls' && failing.pct === 0,
  'calls made: the count and the rate (a real 0% is still 0% when there were calls)',
  JSON.stringify([some, failing])
)
const mission = src('src/renderer/src/components/MissionControl.tsx')
const config = src('src/renderer/src/components/ConfigPanel.tsx')
assert(/toolCallsReading\(/.test(mission) && /toolCallsReading\(/.test(config) && /No tool calls yet/.test(mission), 'Mission and Config › Telemetry read through it, and Mission says "No tool calls yet"')

// 1. Settings
const settings = src('src/renderer/src/components/ConnectionSettings.tsx')
assert(
  !/authenticates both transports|REST bearer header|first-frame handshake/.test(settings) && /Advanced/.test(settings),
  'Settings: the transport sentence is gone (plain words instead), under an Advanced section'
)
assert(/ownerOnly|only === 'make-owner'|at === 'make-owner'/.test(settings) && /<OwnerSection/.test(settings), '"Make this Beacon an owner" has a sheet of its own: the owner section only')

// 3. lists
const md = src('src/renderer/src/components/MessageRenderer.tsx')
const css = src('src/renderer/src/styles.css')
assert(
  /ul: \(\{ className, children \}\)/.test(md) && /li: \(\{ className, children \}\)/.test(md) && /\.contains-task-list\s*\{[^}]*list-style:\s*none/.test(css),
  "chat's ul and li keep react-markdown's task-list classes, and a task list draws no bullet"
)
