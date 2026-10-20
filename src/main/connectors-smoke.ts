/**
 * Headless smoke for the Connectors tab's pure model (PARITY-PLAN B1) — the wire parser Beacon
 * expects from Prometheus#332, and above all the allowed_tools TOGGLE SEMANTICS, which are the
 * load-bearing part: null means "all", so unchecking one tool while at null must MATERIALIZE the
 * inventory minus that tool, and re-checking the last excluded one must collapse back to null so
 * "everything allowed" never silently pins today's inventory.
 *
 * Run: npm run smoke:connectors
 */
import {
  addServerProblem,
  healthLabel,
  MCP_SERVERS_PATH,
  parseMcpServers,
  capturedMcpServers,
  toggleTool,
  toolAllowed,
  type McpToolInfo
} from '@shared/connectors'
import { CONFIG_TABS, isAllowedDaemonPath } from '@shared/daemon-api'

let failures = 0
function assert(cond: boolean, what: string): void {
  console.log(`[smoke] ${cond ? 'PASS' : 'FAIL'}  ${what}`)
  if (!cond) failures++
}

console.log('[smoke] === 1. the wire parser — the SHIPPED Prometheus PR 342 shape ===')
const parsed = parseMcpServers(capturedMcpServers())
assert(parsed.length === 3, 'the captured fixture parses whole')
assert(parsed[0].id === 'context7' && parsed[0].name === 'context7', 'name IS the identity (no separate id on the wire)')
assert(parsed[0].readOnly === true, "source: 'config' (prometheus.yaml) marks the card READ-ONLY over REST")
assert(!parsed[1].readOnly, "source: 'store' cards are mutable")
assert(parsed[0].health === 'connected' && parsed[0].transport === 'stdio', 'health OBJECT parses: state + transport lifted out')
assert(parsed[2].health === 'failed' && (parsed[2].healthDetail ?? '').includes('ENOENT'), 'not_running maps to failed and the DETAIL survives')
assert(parsed[0].command === 'npx -y @upstash/context7-mcp', 'command + args join into one display line')
assert(parsed[0].tools.length === 2 && parsed[0].tools[0].name === 'resolve-library-id', 'tools[].tool_name parses as the name')
assert(parsed[0].tools[0].readOnlyHint === true && parsed[1].tools[1].readOnlyHint === false, 'read_only_hint carried both ways (a writes-tool is gate-approved)')
assert(parsed[0].allowedTools === null && parsed[1].allowedTools?.join(',') === 'query', 'absent allowed_tools = all; an array is authoritative')
assert(parseMcpServers(null).length === 0 && parseMcpServers('garbage').length === 0, 'garbage yields [], never a throw')
assert(parseMcpServers([{ tools: [] }, 42, null]).length === 0, 'rows without a name are dropped, not guessed at')
assert(parseMcpServers([{ id: 'legacy', health: 'connected', tools: ['a'] }])[0].health === 'connected', 'the pre-342 flat shape still parses (old fixtures stay honest)')

console.log('[smoke] === 2. allowed_tools semantics — the #331 control ===')
const INV: McpToolInfo[] = [{ name: 'a' }, { name: 'b' }, { name: 'c' }]
assert(toolAllowed(null, 'a'), 'null allowlist = everything allowed')
assert(!toolAllowed([], 'a'), 'an EMPTY allowlist is authoritative — it means none, not all')
const offOne = toggleTool(null, INV, 'b')
assert(Array.isArray(offOne) && offOne.length === 2 && !offOne.includes('b'), 'unchecking one tool at null MATERIALIZES inventory-minus-one')
const backOn = toggleTool(offOne, INV, 'b')
assert(backOn === null, 're-checking the last excluded tool collapses back to null (absent-field default)')
const offTwo = toggleTool(offOne, INV, 'c')
assert(Array.isArray(offTwo) && offTwo.join(',') === 'a', 'a second uncheck narrows the explicit list')
assert(toggleTool([], INV, 'a')?.join(',') === 'a', 'checking from empty grows the list')

console.log('[smoke] === 3. every card state says something ===')
for (const s of parsed) assert(healthLabel(s).length > 0, `${s.id}: health renders a sentence, never a bare enum`)
// parsed[1] is a CONNECTED server and healthLabel says 'unreachable', not 'refused' — this
// asserted the wrong index against wording that no longer exists, and had been red on main.
// What "says why" actually means: the failed card carries the DETAIL, not a bare enum.
assert(healthLabel(parsed[2]).includes('ENOENT'), 'a failed server SAYS WHY on the card (the detail reaches the label)')
assert(healthLabel(parsed[2]) !== 'failed', 'and never renders as a bare enum')

console.log('[smoke] === 4. the add form refuses before it writes ===')
assert(addServerProblem({ name: '', transport: 'stdio', command: 'x' }) !== '', 'no name → a named problem')
assert(addServerProblem({ name: 'n', transport: 'stdio' }) !== '', 'stdio without a command refuses')
assert(addServerProblem({ name: 'n', transport: 'http', url: 'ftp://x' }) !== '', 'a non-http url refuses')
assert(addServerProblem({ name: 'n', transport: 'http', url: 'https://x' }) === '', 'a sane http server passes')
assert(addServerProblem({ name: 'n', transport: 'stdio', command: 'uvx mcp-server' }) === '', 'a sane stdio server passes')

console.log('[smoke] === 5. registration ===')
const tab = CONFIG_TABS.find((t) => t.id === 'connectors')
assert(!!tab && tab.path === MCP_SERVERS_PATH, 'the Connectors tab is registered on the #332 path')
assert(isAllowedDaemonPath(MCP_SERVERS_PATH), 'the path passes the bridge allowlist')

console.log('')
console.log('[smoke] ===================== RESULT =====================')
console.log(`[smoke] outcome: ${failures === 0 ? 'PASS ✓' : `FAIL ✗ (${failures})`} (parser, allowlist semantics, card copy, add form, registration)`)
console.log('[smoke] ===================================================')
process.exit(failures === 0 ? 0 : 1)
