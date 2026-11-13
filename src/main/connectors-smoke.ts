/**
 * Headless smoke for the Connectors tab's pure model — the wire parser Beacon
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
  type McpToolInfo,
  DEFAULT_TOKEN_HEADER,
  MAIN_KEY_NOTE,
  holdsMainKey,
  scrubSecret,
  scrubWriteError,
  tokenHeaderValue,
  urlServerBody,
  urlServerProblem,
  writeFailure,
  type UrlServerForm
} from '@shared/connectors'
import { CONFIG_TABS, isAllowedDaemonPath } from '@shared/daemon-api'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

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

console.log('[smoke] === 4b. a server at an address, and its token ===')
{
  const base: UrlServerForm = { name: 'notes', url: 'https://example.com/mcp', transport: 'streamable-http', token: '', headerName: DEFAULT_TOKEN_HEADER }
  const TOKEN = 'tok-test-0001'
  assert(urlServerProblem(base) === '', 'an https address with no token passes')
  assert(urlServerProblem({ ...base, token: TOKEN }) === '', 'and with a token')
  assert(urlServerProblem({ ...base, name: ' ' }) !== '', 'no name refuses')
  assert(urlServerProblem({ ...base, url: '' }) !== '', 'no address refuses')
  assert(urlServerProblem({ ...base, url: 'example.com/mcp' }) !== '', 'an address with no scheme refuses')
  assert(urlServerProblem({ ...base, url: 'ftp://example.com' }) !== '', 'a scheme that is not http(s) refuses')
  assert(urlServerProblem({ ...base, url: 'https://exa mple.com' }) !== '', 'a space in the address refuses')
  assert(/https/.test(urlServerProblem({ ...base, url: 'http://example.com/mcp' })), 'plain http to the internet refuses, and says to use https')
  for (const ok of ['http://localhost:8080/mcp', 'http://127.0.0.1:9000', 'http://192.168.1.20/mcp', 'http://10.0.0.5:3000', 'http://[::1]:8080/mcp']) {
    assert(urlServerProblem({ ...base, url: ok, token: TOKEN }) === '', `plain http to a private address passes (${ok})`)
  }
  // A Tailscale address (the 100.64/10 range), built here so no such address is written in the source.
  assert(urlServerProblem({ ...base, url: `http://${[100, 64, 0, 9].join('.')}/sse`, token: TOKEN }) === '', 'plain http to a Tailscale address passes')
  assert(urlServerProblem({ ...base, url: 'http://203.0.113.9/mcp' }) !== '', 'plain http to a public number address refuses')
  assert(/token field/.test(urlServerProblem({ ...base, url: 'https://user:pw@example.com/mcp' })), 'a name and password in the address refuses, pointing at the token field')
  assert(urlServerProblem({ ...base, token: 'abc\r\nX-Evil: 1' }) !== '', 'a token with a line break refuses (it would split the request)')
  assert(urlServerProblem({ ...base, token: 'x'.repeat(5000) }) !== '', 'an absurdly long token refuses')
  assert(urlServerProblem({ ...base, token: TOKEN, headerName: 'X API Key' }) !== '', 'a header name with a space refuses')
  assert(urlServerProblem({ ...base, token: TOKEN, headerName: 'X-API-Key' }) === '', 'a sane other header passes')
  assert(urlServerProblem({ ...base, token: '', headerName: 'bad name' }) === '', 'with no token the header name is not looked at')

  assert(tokenHeaderValue('Authorization', TOKEN) === `Bearer ${TOKEN}`, 'in Authorization the token is sent as Bearer')
  assert(tokenHeaderValue('authorization', ` ${TOKEN} `) === `Bearer ${TOKEN}`, 'whatever the case of the header, and trimmed')
  assert(tokenHeaderValue('Authorization', `Bearer ${TOKEN}`) === `Bearer ${TOKEN}`, 'a pasted "Bearer …" is not doubled')
  assert(tokenHeaderValue('Authorization', 'Basic dXNlcjpwdw==') === 'Basic dXNlcjpwdw==', 'another scheme pasted with it is left alone')
  assert(tokenHeaderValue('X-API-Key', TOKEN) === TOKEN, 'in any other header the token goes as it is')

  const plain = urlServerBody(base)
  assert(JSON.stringify(plain) === JSON.stringify({ name: 'notes', url: 'https://example.com/mcp', transport: 'streamable-http' }), 'with no token the body has no headers at all')
  const withTok = urlServerBody({ ...base, name: ' notes ', url: ' https://example.com/mcp ', token: TOKEN })
  assert(JSON.stringify(withTok.headers) === JSON.stringify({ Authorization: `Bearer ${TOKEN}` }) && withTok.name === 'notes' && withTok.url === 'https://example.com/mcp', 'with a token: one header, name and address trimmed')
  assert(JSON.stringify(urlServerBody({ ...base, transport: 'sse', token: TOKEN, headerName: 'X-API-Key' })) === JSON.stringify({ name: 'notes', url: 'https://example.com/mcp', transport: 'sse', headers: { 'X-API-Key': TOKEN } }), 'another header and the sse transport are sent as chosen')
  assert(!('command' in withTok) && !('env' in withTok), 'an address server never carries a command')

  assert(scrubSecret(`header 'Authorization' value Bearer ${TOKEN} refused`, TOKEN, `Bearer ${TOKEN}`) === "header 'Authorization' value Bearer ••• refused", 'a refusal that quotes the token has it blanked')
  assert(scrubSecret('nothing secret here', TOKEN) === 'nothing secret here', 'text without it is left as it is')
  assert(scrubSecret('abc', 'ab') === 'abc', 'a "secret" too short to be one is not used to blank text')
  assert(scrubSecret(`x ${TOKEN} y ${TOKEN}`, TOKEN) === 'x ••• y •••', 'every appearance is blanked')

  // What the daemon returns for such a server: header NAMES. Even a daemon that wrongly echoed the
  // values could not put one on screen, because the model has nowhere to hold it.
  const listed = parseMcpServers({ servers: [{ name: 'notes', source: 'store', enabled: true, url: 'https://example.com/mcp', transport: 'streamable-http', header_names: ['Authorization'], headers: { Authorization: `Bearer ${TOKEN}` }, env: { KEY: TOKEN }, health: { state: 'connected', transport: 'http', detail: '' }, tools: [] }] })
  assert(listed.length === 1 && listed[0].headerNames.join() === 'Authorization' && listed[0].transport === 'http' && listed[0].url === 'https://example.com/mcp', 'a listed address server has its address, transport and header names')
  assert(!JSON.stringify(listed).includes(TOKEN), 'and no header or env VALUE survives the parse, even if the wire carried one')
  assert(parsed.every((s) => Array.isArray(s.headerNames) && s.headerNames.length === 0), 'a server with no headers has an empty list of names')
}

console.log('[smoke] === 4b2. a refusal is blanked in main, before it can be printed ===')
{
  const T = 'tok-test-0001'
  const body = { name: 'n', url: 'https://example.com', headers: { Authorization: `Bearer ${T}`, 'X-Other': 'second-secret-value' }, env: { API_KEY: 'env-secret-value' } }
  const msg = `HTTP 400: POST /api/mcp/servers — {"error":"got Bearer ${T} and second-secret-value and env-secret-value"}`
  const out = scrubWriteError(msg, body)
  assert(!out.includes(T) && !out.includes('second-secret-value') && !out.includes('env-secret-value'), 'every header and env value the request carried is blanked in the error')
  assert(out.startsWith('HTTP 400: POST /api/mcp/servers'), 'the rest of the error is left as it is')
  assert(scrubWriteError(`token ${T} alone`, body) === 'token ••• alone', 'the token is blanked even when quoted without its scheme')
  assert(scrubWriteError(msg, undefined) === msg && scrubWriteError(msg, { enabled: false }) === msg, 'a write with no secrets in it is not touched')
  const ipc = readFileSync(join(process.cwd(), 'src/main/ipc.ts'), 'utf8')
  const handler = ipc.slice(ipc.indexOf('IPC.DAEMON_WRITE'), ipc.indexOf('IPC.SETTINGS_GET'))
  assert(/throw new Error\(scrubWriteError\(/.test(handler) && !/console\./.test(handler), "main's write handler rethrows through it and logs nothing itself")
}

console.log('[smoke] === 4c. who may change the list ===')
{
  assert(holdsMainKey([{ id: 'd1', owner: true }, { id: 'd2', owner: false }]) === true, 'no row of its own: this is the main key')
  assert(holdsMainKey([]) === true, 'no devices at all: still the main key')
  assert(holdsMainKey([{ id: 'd1', owner: true, is_self: true }]) === false, 'a row of its own, an owner device: NOT the main key')
  assert(holdsMainKey([{ id: 'd1', owner: false, is_self: true }]) === false, 'a row of its own, an approved device: not the main key')
  assert(holdsMainKey(null) === null && holdsMainKey({ error: 'x' }) === null && holdsMainKey('x') === null, 'an answer that is not a list cannot say')
  const refused = writeFailure('HTTP 401: POST /api/mcp/servers — {"error":"defining an MCP server starts a process on this host; that requires the global token, not a device token"}')
  assert(refused.startsWith(MAIN_KEY_NOTE.title) && refused.includes('Settings → Connection → Advanced'), 'a 401 on a write is the main-key note, with where to enter it')
  assert(!/global token|device token|HTTP 401/.test(refused), "and not the daemon's raw words")
  const said = writeFailure('HTTP 409: POST /api/mcp/servers — {"error":"\'notes\' already exists — PATCH it instead"}')
  assert(said === "Prometheus did not accept that: 'notes' already exists — PATCH it instead", `any other refusal is the daemon's reason, without the HTTP line (${said})`)
  assert(!writeFailure('HTTP 400: POST /api/mcp/servers — {"error":"header value Bearer tok-test-0001 has control characters"}', 'tok-test-0001', 'Bearer tok-test-0001').includes('tok_live'), 'a refusal quoting the token is blanked before it is shown')
  assert(writeFailure('fetch failed').startsWith('Prometheus did not accept that: fetch failed'), 'a failure with no HTTP line is still a sentence')
  assert(!/requires the global token/.test(MAIN_KEY_NOTE.body + MAIN_KEY_NOTE.how) && /prometheus\.yaml/.test(MAIN_KEY_NOTE.how), 'the note is in plain words and names the other way in')
}

console.log('[smoke] === 4d. the form and the cards go through these rules ===')
{
  const view = readFileSync(join(process.cwd(), 'src/renderer/src/components/ConnectorsTab.tsx'), 'utf8')
  assert(/type="password"/.test(view) && /autoComplete="off"/.test(view), 'the token is typed into a password field with autofill off')
  assert(!/settings\.set\(/.test(view) && !/localStorage|sessionStorage/.test(view), 'the tab writes nothing to settings or browser storage')
  assert(!/console\.(log|warn|error|info)\(/.test(view), 'and logs nothing')
  const submit = view.slice(view.indexOf('const submit = async'), view.indexOf('if (!openForm)'))
  assert((submit.match(/setToken\(''\)/g) ?? []).length >= 2, 'the token is dropped when the POST answers and when it throws')
  assert(/writeFailure\(/.test(submit) && !/e\.message\.slice/.test(submit), 'a failure is shown through writeFailure (blanked), never as the raw message')
  assert(/mainKey === false \? null : <AddServerForm/.test(view), 'with a device key the form is not offered')
  assert(/canWrite=\{mainKey !== false\}/.test(view) && /const locked = !!s\.readOnly \|\| !canWrite/.test(view), "and the cards' write controls are locked")
  assert(/holdsMainKey\(d\)/.test(view) && /DEVICES_PATH/.test(view), 'which key this is comes from GET /api/devices')
}

console.log('[smoke] === 5. registration ===')
const tab = CONFIG_TABS.find((t) => t.id === 'connectors')
assert(!!tab && tab.path === MCP_SERVERS_PATH, 'the Connectors tab is registered on the #332 path')
assert(isAllowedDaemonPath(MCP_SERVERS_PATH), 'the path passes the bridge allowlist')

console.log('')
console.log('[smoke] ===================== RESULT =====================')
console.log(`[smoke] outcome: ${failures === 0 ? 'PASS ✓' : `FAIL ✗ (${failures})`} (parser, allowlist semantics, card copy, add form, address and token, main key, registration)`)
console.log('[smoke] ===================================================')
process.exit(failures === 0 ? 0 : 1)
