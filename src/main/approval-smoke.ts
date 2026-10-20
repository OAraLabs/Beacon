/**
 * Exec-approval smoke (headless / ELECTRON_RUN_AS_NODE). Proves the REST layer the desktop
 * approval card rides on — no display, no live daemon. Overrides globalThis.fetch (model: step5-smoke).
 *
 * SCOPE OF THIS FILE: it pins the WIRE FORMAT — what Beacon maps in and what it sends out. It does
 * NOT prove that an approved scope produces the grant its extent described; that is a live-daemon
 * outcome check (read the created grant back and compare its describes string to the one the card
 * displayed) and it deliberately does not live in a fetch stub, where both halves would be fiction.
 *
 * Asserts:
 *   - listApprovals() maps snake_case PendingAction → camelCase ApprovalRequest
 *     (request_id→requestId, tool_name→toolName, description, created_at[s]→createdAt[ms]);
 *   - `extents` is carried through VERBATIM as an OBJECT, and a missing/wrong-shaped one becomes
 *     `{}` — the "no grant on offer" case — never a fabricated set of options;
 *   - `arguments` — THE THING BEING APPROVED — is carried through VERBATIM (daemon-scrubbed,
 *     daemon-truncated, daemon-ordered), `null`/`{}`/absent all collapse to "nothing to show",
 *     and an off-contract non-string value is still SHOWN rather than silently dropped;
 *   - approve POSTs `{"scope": <verb>}`; deny POSTs NO body;
 *   - the scope string is forwarded UNTOUCHED — Beacon holds no verb list, so a verb the daemon
 *     would reject still goes out and comes back a visible 400 rather than being filtered locally;
 *   - a non-2xx rejects on both paths, and the RESPONSE BODY reaches the thrown Error so the
 *     operator can be shown the daemon's own reason.
 */
import { RestClient } from './connection/rest'
import type { ApprovalDecision } from '@shared/ipc'
import { rawToApproval, type RawApprovalPush } from '@shared/approval-push'

/**
 * MIN_CHECKS — the count guard.
 *
 * This harness counts FAILURES. A section that never runs therefore reports zero failures and the
 * file exits 0: a smoke that silently stopped testing is indistinguishable from one that passed.
 * An early return, a throw swallowed upstream, a fixture that stops matching so a loop iterates
 * zero times — each of those turns this file green while proving nothing.
 *
 * So the count is pinned as well as the failures. Raise it when you add assertions; a DROP means
 * assertions stopped running and is exactly the event this guard exists to make loud.
 */
const MIN_CHECKS = 73

let failures = 0
let checks = 0
function assert(cond: boolean, label: string): void {
  checks++
  console.log(`[smoke] ${cond ? 'PASS' : 'FAIL'}  ${label}`)
  if (!cond) failures++
}

interface Captured {
  url: string
  method: string
  headers: Record<string, string>
  body?: string
}

async function main(): Promise<void> {
  const origFetch = globalThis.fetch
  let cap: Captured = { url: '', method: 'GET', headers: {} }
  const stub = (payload: string, status = 200): void => {
    globalThis.fetch = (async (
      url: unknown,
      init?: { method?: string; headers?: Record<string, string>; body?: string }
    ) => {
      cap = { url: String(url), method: init?.method ?? 'GET', headers: init?.headers ?? {}, body: init?.body }
      return new Response(payload, { status, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch
  }

  // ── 1. listApprovals: snake→camel + created_at s→ms + bearer attached ────────
  console.log('[smoke] === 1. listApprovals mapping ===')
  stub(JSON.stringify([{ request_id: 'abc123', tool_name: 'bash', description: 'git push origin main', created_at: 1_700_000_000 }]))
  const list = await new RestClient('http://gw', 'tok-APV').listApprovals()
  assert(list.length === 1, 'one approval returned')
  const a = list[0]
  assert(a.requestId === 'abc123', `request_id → requestId (got ${a.requestId})`)
  assert(a.toolName === 'bash', `tool_name → toolName (got ${a.toolName})`)
  assert(a.description === 'git push origin main', 'description carried through')
  assert(a.createdAt === 1_700_000_000_000, `created_at (s) → createdAt (ms) (got ${a.createdAt})`)
  assert(cap.url === 'http://gw/api/approvals', `GET hits /api/approvals (got ${cap.url})`)
  assert(cap.headers.Authorization === 'Bearer tok-APV', `bearer attached (got ${cap.headers.Authorization})`)

  // ── 1b. missing created_at → 0 (defensive; never NaN) ───────────────────────
  stub(JSON.stringify([{ request_id: 'x', tool_name: 't', description: 'd' }]))
  const l2 = await new RestClient('http://gw', null).listApprovals()
  assert(l2[0].createdAt === 0, 'missing created_at → 0 (not NaN)')
  assert(!('Authorization' in cap.headers), 'tokenless GET → no Authorization header')

  // ── 1c. extents: an OBJECT keyed by verb, carried through verbatim ───────────
  //
  // FIXTURE PROVENANCE — every capture dated, with the daemon it came from:
  //   2026-08-16 ~16:04  daemon 1c3fc46  target /home/demo/probe.txt          (parent EXISTS)
  //   2026-08-16 ~17:30  daemon fb73b28  target /home/demo/expiry-probe/x.txt (parent ABSENT)
  //   2026-08-16 ~18:26  daemon e5d5f48  target …/recapture-existing.txt      (parent EXISTS)  ← in use
  //
  // A CAPTURED FIXTURE IS NOT AUTOMATICALLY A CORRECT ONE, and this file has now
  // been wrong in both available directions, which is why each capture is dated.
  //
  // A hand-written fixture pins the author's ASSUMPTIONS. A captured one pins
  // whatever the system DID at capture time — defects included. Neither is
  // self-correcting.
  //
  // The fb73b28 capture recorded "on exactly <dir>" for BOTH widening verbs. That
  // was the observed payload and it was also a DEFECT: pre-#238 the daemon worded
  // widening from a filesystem stat, `Path(value).is_dir()`, and that target's
  // parent did not exist yet, so a grant covering an entire subtree described
  // itself as a single exact path. Pinning those bytes would have made this smoke
  // green against a string the daemon must never emit again.
  //
  // The 1c3fc46 capture read correctly — but by luck of its target, not by design:
  // /home/demo/ happens to exist, so the same stat answered True.
  //
  // Prometheus #238 removed the stat (extent is carried on the Grant), so the
  // wording no longer depends on what is on disk when you capture. The values
  // below are the e5d5f48 recapture, verified live against both an existing and a
  // NON-EXISTENT parent — see the walk notes in PR #49.
  //
  // `once` is deliberately absent: it creates no grant, so the daemon does not
  // describe it. Beacon supplies once/deny itself.
  console.log('\n[smoke] === 1c. extents passthrough ===')
  const realExtents = {
    'until-restart': 'write_file on exactly /home/demo/recapture-existing.txt — until the daemon restarts',
    always: 'write_file on exactly /home/demo/recapture-existing.txt — permanently, until revoked',
    'until-restart here': 'write_file on anything under /home/demo/ — until the daemon restarts',
    'always here': 'write_file on anything under /home/demo/ — permanently, until revoked'
  }
  stub(JSON.stringify([{ request_id: 'e1', tool_name: 'write_file', description: 'd', created_at: 1, extents: realExtents }]))
  const l3 = await new RestClient('http://gw', null).listApprovals()
  assert(JSON.stringify(l3[0].extents) === JSON.stringify(realExtents), 'extents carried through VERBATIM (no re-wording)')
  assert(Object.keys(l3[0].extents).length === 4, `four scope verbs offered (got ${Object.keys(l3[0].extents).length})`)
  assert(!('once' in l3[0].extents), 'once is NOT in extents — Beacon supplies it (it creates no grant)')

  stub(JSON.stringify([{ request_id: 'e2', tool_name: 'gepa', description: 'd', created_at: 1, extents: {} }]))
  const l4 = await new RestClient('http://gw', null).listApprovals()
  assert(Object.keys(l4[0].extents).length === 0, 'empty extents {} survives as {} — no grant on offer')

  stub(JSON.stringify([{ request_id: 'e3', tool_name: 't', description: 'd', created_at: 1 }]))
  const l5 = await new RestClient('http://gw', null).listApprovals()
  assert(Object.keys(l5[0].extents).length === 0, 'ABSENT extents → {} (never undefined at the card)')

  // ── 1c-bis. arguments: THE THING BEING APPROVED, carried through VERBATIM ────
  //
  // FIXTURE PROVENANCE — not hand-written. Every string below was produced by
  // running Prometheus bf4e1fe's OWN `redact_arguments` (permissions/argument_view.py)
  // on 2026-09-19, in a worktree of feat/computer-use-m1, and printing the result of
  // `ApprovalQueue.serialize_pending`. A hand-written fixture would pin this author's
  // idea of the format; these bytes pin the producer's.
  //
  // WHY IT MATTERS THAT THEY SURVIVE UNTOUCHED: for `type_text` the arguments ARE the
  // decision. The daemon has already scrubbed (`api_key` → `***`), truncated with the
  // amount named ("… (+391 more chars)"), collapsed newlines to " ⏎ " and sorted the
  // keys. Beacon re-doing any of that is a second surface computing one truth — and a
  // second truncation would be a SILENT one, since only the daemon's says how much it
  // cut.
  console.log('\n[smoke] === 1c-bis. arguments passthrough ===')
  const realArgs = {
    app: 'firefox',
    delivery: 'background',
    text: 'transfer 500 to account 9'
  }
  stub(JSON.stringify([{ request_id: 'g1', tool_name: 'computer_type_text', description: 'd', created_at: 1, extents: {}, arguments: realArgs }]))
  const g1 = (await new RestClient('http://gw', null).listApprovals())[0]
  assert(JSON.stringify(g1.arguments) === JSON.stringify(realArgs), 'arguments carried through VERBATIM')
  assert(
    Object.keys(g1.arguments ?? {}).join(',') === 'app,delivery,text',
    `the daemon's key ORDER survives — Beacon does not hoist the "important" one (got ${Object.keys(g1.arguments ?? {}).join(',')})`
  )
  assert(g1.arguments?.text === 'transfer 500 to account 9', 'the payload — the value the decision turns on — is intact')

  // The daemon's redactor already ran; Beacon must neither undo nor duplicate it.
  const maskedArgs = { api_key: '***', app: 'firefox', text: 'hunter2' }
  stub(JSON.stringify([{ request_id: 'g2', tool_name: 'computer_type_text', description: 'd', created_at: 1, arguments: maskedArgs }]))
  const g2 = (await new RestClient('http://gw', null).listApprovals())[0]
  assert(g2.arguments?.api_key === '***', 'a daemon-masked value arrives masked, and is still SHOWN (a dropped row is a hidden argument)')

  // The cut says how much it cut. Beacon must not shorten it further — its own cut
  // would carry no such statement.
  const longText = 'Dear Alex, the quick brown fox jumps over the lazy dog. the quick brown fox jumps over the lazy dog. the quick brown fox jumps over the lazy dog. the quick brow… (+391 more chars)'
  stub(JSON.stringify([{ request_id: 'g3', tool_name: 'computer_type_text', description: 'd', created_at: 1, arguments: { text: longText } }]))
  const g3 = (await new RestClient('http://gw', null).listApprovals())[0]
  assert(g3.arguments?.text === longText, 'a truncated value survives at full length, ITS ellipsis and char count included')

  // The overflow row is a normal row. Beacon knows nothing about the "…" marker, so a
  // daemon that changed it cannot silently stop matching a Beacon-side special case.
  stub(JSON.stringify([{ request_id: 'g4', tool_name: 't', description: 'd', created_at: 1, arguments: { field_00: 'v', '…': '(13 more argument(s) not shown)' } }]))
  const g4 = (await new RestClient('http://gw', null).listApprovals())[0]
  assert(g4.arguments?.['…'] === '(13 more argument(s) not shown)', 'the overflow row rides through as an ordinary argument row')

  // `null` is the daemon's ONLY empty form (`redact_arguments` ends `return out or None`,
  // verified against bf4e1fe), and absent is an older daemon. Both mean "nothing to show",
  // and the card renders no block — never an empty "With" heading implying it saw something.
  for (const [label, payload] of [['null', null], ['{}', {}], ['absent', undefined]] as [string, unknown][]) {
    const row: Record<string, unknown> = { request_id: 'g5', tool_name: 't', description: 'd', created_at: 1 }
    if (payload !== undefined) row.arguments = payload
    stub(JSON.stringify([row]))
    const g5 = (await new RestClient('http://gw', null).listApprovals())[0]
    assert(g5.arguments === undefined, `${label} arguments → undefined (no block, no empty heading)`)
  }

  // Wrong shapes degrade to "nothing to show" rather than reaching the card as something
  // .map-able — the same rule extents follows one section above.
  for (const bad of [['a', 'b'], 'text', 42] as unknown[]) {
    stub(JSON.stringify([{ request_id: 'g6', tool_name: 't', description: 'd', created_at: 1, arguments: bad }]))
    const g6 = (await new RestClient('http://gw', null).listApprovals())[0]
    assert(g6.arguments === undefined, `wrong-shaped arguments ${JSON.stringify(bad)} → undefined`)
  }

  // OFF-CONTRACT VALUE. The daemon emits strings only; anything else is drift. It must be
  // SHOWN, not dropped — a silently missing argument is the exact defect this path removes,
  // and it would leave no trace on the card for anyone to notice.
  stub(JSON.stringify([{ request_id: 'g7', tool_name: 't', description: 'd', created_at: 1, arguments: { n: 5, ok: true, list: ['a'], nested: { k: 1 }, nil: null } }]))
  const g7 = (await new RestClient('http://gw', null).listApprovals())[0]
  assert(Object.keys(g7.arguments ?? {}).length === 5, `every off-contract value is still rendered (got ${Object.keys(g7.arguments ?? {}).length} of 5)`)
  assert(g7.arguments?.n === '5' && g7.arguments?.ok === 'true', 'a number/boolean renders faithfully')
  assert(g7.arguments?.nested === '{"k":1}', `a nested object renders faithfully (got ${g7.arguments?.nested})`)

  // ── 1d. expires_at — the daemon states the window; Beacon never computes it ──
  // Live values from daemon e5d5f48 (2026-08-16): created_at 1786921774.256,
  // expires_at 1786923574.256 — epoch SECONDS, exactly 1800s apart.
  console.log('\n[smoke] === 1d. expires_at ===')
  stub(JSON.stringify([{ request_id: 'x1', tool_name: 'write_file', description: 'd',
    created_at: 1_786_921_774.256, expires_at: 1_786_923_574.256 }]))
  const l7 = await new RestClient('http://gw', null).listApprovals()
  assert(l7[0].expiresAt === 1_786_923_574_256, `expires_at (s) → expiresAt (ms) (got ${l7[0].expiresAt})`)
  assert(
    (l7[0].expiresAt as number) - l7[0].createdAt === 1_800_000,
    'the window comes from the daemon, intact — 1800s as sent'
  )

  stub(JSON.stringify([{ request_id: 'x2', tool_name: 'write_file', description: 'd', created_at: 1 }]))
  const l8 = await new RestClient('http://gw', null).listApprovals()
  assert(
    l8[0].expiresAt === undefined,
    'ABSENT expires_at → undefined, NOT createdAt+1800 — the card then renders no countdown ' +
      'rather than a computed one (older daemons omit the field)'
  )

  // An array is the WRONG shape (the brief assumed one); it must degrade to "no options offered"
  // rather than reaching the card as something .map-able that renders fabricated buttons.
  stub(JSON.stringify([{ request_id: 'e4', tool_name: 't', description: 'd', created_at: 1, extents: ['always'] }]))
  const l6 = await new RestClient('http://gw', null).listApprovals()
  assert(Object.keys(l6[0].extents).length === 0, 'array-shaped extents → {} (wrong shape offers nothing)')

  // ── 1d. expires_at: epoch SECONDS float → ms, absent stays UNDEFINED ─────────
  // Values are the real captured row (daemon fb73b28): created_at 1786913676.553194,
  // expires_at 1786915476.553194, delta exactly 1800.0. The unit was READ, not inferred —
  // a wrong unit renders a confidently wrong countdown, which is worse than none.
  console.log('\n[smoke] === 1d. expires_at mapping ===')
  stub(JSON.stringify([{ request_id: 'x1', tool_name: 'write_file', description: 'd',
    created_at: 1786913676.553194, expires_at: 1786915476.553194 }]))
  const e1 = (await new RestClient('http://gw', null).listApprovals())[0]
  assert(e1.expiresAt === 1786915476553.194, `expires_at (s) → expiresAt (ms) (got ${e1.expiresAt})`)
  assert(e1.expiresAt! - e1.createdAt === 1_800_000, `window survives as 1800s in ms (got ${e1.expiresAt! - e1.createdAt})`)

  // ABSENT must be undefined, NOT 0. created_at collapses to 0 defensively, but the same trick
  // here would render "expired" on every card from a daemon too old to send the field.
  stub(JSON.stringify([{ request_id: 'x2', tool_name: 't', description: 'd', created_at: 1 }]))
  const e2 = (await new RestClient('http://gw', null).listApprovals())[0]
  assert(e2.expiresAt === undefined, `absent expires_at → undefined, not 0 (got ${e2.expiresAt})`)

  // Malformed shapes must also degrade to undefined rather than NaN — NaN would render nothing
  // by luck rather than by rule, and the rule is what has to hold.
  for (const bad of ['soon', null, [], {}, Number.NaN] as unknown[]) {
    stub(JSON.stringify([{ request_id: 'x3', tool_name: 't', description: 'd', created_at: 1, expires_at: bad }]))
    const e3 = (await new RestClient('http://gw', null).listApprovals())[0]
    assert(e3.expiresAt === undefined, `malformed expires_at ${JSON.stringify(bad)} → undefined (got ${e3.expiresAt})`)
  }

  // ── 1e. ONE MAPPER: the poll path IS rawToApproval ──────────────────────────
  //
  // WHAT THIS SECTION EXISTS TO CATCH. shared/approval-push.ts and approval-push-smoke.ts both
  // claimed "one mapper covers both transports". That was false: listApprovals() mapped the same
  // serialize_pending dict inline, with weaker rules. Two docstrings asserted an invariant that
  // nothing enforced, so the drift they promised was impossible had in fact already happened.
  //
  // A DOCSTRING CANNOT PIN THIS — only a test that runs BOTH paths over the SAME input and
  // compares can. If someone re-inlines a mapper in rest.ts, the equivalence assertion below goes
  // red; the prose in the two headers would not.
  console.log('\n[smoke] === 1e. one mapper: REST poll === WS push ===')
  const shapes: RawApprovalPush[] = [
    { request_id: 'ok1', tool_name: 'bash', description: 'git push', created_at: 1_700_000_000, extents: { always: 'a' } },
    { request_id: 'ok2', tool_name: 'write_file', description: 'd', created_at: 1.5, expires_at: 2.5 },
    { request_id: 'ok3' },                                     // every optional field absent
    { request_id: 'ok4', tool_name: 42, description: null },   // wrong-typed, not just missing
    { request_id: 'ok5', created_at: 'soon', expires_at: [], extents: ['nope'] },
    // `arguments` IS the field whose duplication motivated unifying these mappers: it was added
    // to both by hand, and carrying it on the REST mapper alone would have left the pushed card —
    // the one that lands first and that `A` answers in one key — showing no arguments for up to a
    // poll interval. So the equivalence must cover it, not just the fields that predate it.
    { request_id: 'ok6', tool_name: 'computer_type_text', description: 'd', created_at: 1,
      arguments: { app: 'firefox', text: 'transfer 500 to account 9' } },
    { request_id: 'ok7', arguments: null },        // the daemon's only empty form
    { request_id: 'ok8', arguments: ['not', 'a', 'dict'] }  // wrong shape
  ]
  stub(JSON.stringify(shapes))
  const viaRest = await new RestClient('http://gw', null).listApprovals()
  const viaPush = shapes.map((r) => rawToApproval(r))
  assert(
    JSON.stringify(viaRest) === JSON.stringify(viaPush),
    'the REST poll produces EXACTLY what the WS push mapper produces, field for field'
  )
  assert(viaRest.length === 8, `all eight well-identified rows survive (got ${viaRest.length})`)
  assert(
    viaRest[5].arguments?.text === 'transfer 500 to account 9',
    `the PAYLOAD reaches the poll path through the shared mapper, with no rest.ts code of its own (got ${viaRest[5].arguments?.text})`
  )
  assert(viaRest[6].arguments === undefined && viaRest[7].arguments === undefined, 'null and wrong-shaped arguments degrade identically on both transports')

  // The three rules the poll path did NOT have before, now inherited. Each of these previously
  // reached the approval card as `undefined` and rendered as the literal string "undefined".
  assert(viaRest[2].toolName === 'tool', `absent tool_name → 'tool', not undefined (got ${viaRest[2].toolName})`)
  assert(viaRest[2].description === '', `absent description → '', not undefined (got ${JSON.stringify(viaRest[2].description)})`)
  assert(viaRest[3].toolName === 'tool', `non-string tool_name → 'tool' (got ${viaRest[3].toolName})`)
  assert(viaRest[3].description === '', `non-string description → '' (got ${JSON.stringify(viaRest[3].description)})`)
  assert(viaRest[4].createdAt === 0, `non-numeric created_at → 0, never NaN (got ${viaRest[4].createdAt})`)

  // ── 1f. the null-drop, and the fact that it is NOT silent ───────────────────
  //
  // DELIBERATE BEHAVIOUR CHANGE, re-pinned here. The old inline mapper emitted a row with
  // `requestId: undefined` for a request carrying no id. That row is UNANSWERABLE — resolve POSTs
  // to /api/approvals/undefined/approve and 404s, while the 3s poll re-renders the card forever —
  // and it inflates the OS dock badge with a count the operator cannot clear. It is dropped now.
  //
  // A drop on the RECONCILING path is its own hazard (the poll is what clears ghosts, so what it
  // discards no surface mentions again), which is exactly why the drop is logged rather than
  // merely filtered. These assertions pin the log, not just the filter: without them "dropped" and
  // "dropped silently" are indistinguishable, and only one of those was the decision.
  console.log('\n[smoke] === 1f. unanswerable rows are dropped, and said out loud ===')
  const warnings: string[] = []
  const origWarn = console.warn
  console.warn = (...args: unknown[]): void => { warnings.push(args.join(' ')) }

  const client = new RestClient('http://gw', null)
  stub(JSON.stringify([
    { request_id: 'keep', tool_name: 'bash', description: 'd', created_at: 1 },
    { tool_name: 'no-id', description: 'd', created_at: 1 },     // absent request_id
    { request_id: '', tool_name: 'empty-id', created_at: 1 },    // empty request_id
    { request_id: 7, tool_name: 'num-id', created_at: 1 }        // non-string request_id
  ]))
  const mixed = await client.listApprovals()
  assert(mixed.length === 1, `three unanswerable rows dropped, the valid one kept (got ${mixed.length})`)
  assert(mixed[0].requestId === 'keep', `the survivor is the answerable row (got ${mixed[0].requestId})`)
  assert(warnings.length === 1, `the drop is LOGGED, not silent (got ${warnings.length} warnings)`)
  assert((warnings[0] ?? '').includes('dropped 3'), `the log states how many were dropped (got ${warnings[0]})`)
  assert(
    (warnings[0] ?? '').includes('request_id'),
    'the log names the reason, so the operator is not left guessing what the daemon sent'
  )

  // Deduped on the count: the poll runs every 3s for the life of the process, so an unconditional
  // warn would emit ~1200 identical lines an hour and bury the signal it exists to carry.
  stub(JSON.stringify([
    { request_id: 'keep', tool_name: 'bash', description: 'd', created_at: 1 },
    { tool_name: 'no-id', description: 'd', created_at: 1 },
    { request_id: '', tool_name: 'empty-id', created_at: 1 },
    { request_id: 7, tool_name: 'num-id', created_at: 1 }
  ]))
  await client.listApprovals()
  assert(warnings.length === 1, `an unchanged drop count does NOT re-log (still ${warnings.length})`)

  // Recovery is a transition too. Without this line the log could show a problem starting and
  // never show it stopping, which is the same defect as not logging it at all.
  stub(JSON.stringify([{ request_id: 'keep', tool_name: 'bash', description: 'd', created_at: 1 }]))
  const recovered = await client.listApprovals()
  assert(recovered.length === 1, 'recovery: the clean poll returns its row')
  assert(warnings.length === 2, `recovery is logged too (got ${warnings.length} warnings)`)
  assert(
    (warnings[1] ?? '').includes('no longer dropping'),
    `the recovery line says the condition ended (got ${warnings[1]})`
  )
  console.warn = origWarn

  // ── 2. approve → POST .../approve with {"scope": verb} ───────────────────────
  console.log('\n[smoke] === 2. resolveApproval approve carries scope ===')
  stub(JSON.stringify({ ok: true }))
  await new RestClient('http://gw', 'tok-APV').resolveApproval('abc123', { kind: 'approve', scope: 'once' })
  assert(cap.method === 'POST', `approve uses POST (got ${cap.method})`)
  assert(cap.url === 'http://gw/api/approvals/abc123/approve', `approve URL (got ${cap.url})`)
  assert(cap.headers.Authorization === 'Bearer tok-APV', 'approve carries bearer')
  assert(cap.body === JSON.stringify({ scope: 'once' }), `approve sends {"scope":"once"} (got ${cap.body})`)
  assert(cap.headers['Content-Type'] === 'application/json', 'approve sets Content-Type: application/json')

  stub(JSON.stringify({ ok: true }))
  await new RestClient('http://gw', null).resolveApproval('abc123', { kind: 'approve', scope: 'until-restart here' })
  assert(
    cap.body === JSON.stringify({ scope: 'until-restart here' }),
    `the widening verb reaches the wire intact, spaces and all (got ${cap.body})`
  )

  // The daemon's normalise_scope is the SOLE authority. Beacon must not filter against a local
  // list — if the vocabularies drift, this is what turns silence into a visible 400.
  stub(JSON.stringify({ ok: true }))
  await new RestClient('http://gw', null).resolveApproval('abc123', { kind: 'approve', scope: 'not-a-real-verb' })
  assert(cap.body === JSON.stringify({ scope: 'not-a-real-verb' }), 'an unknown verb is forwarded UNTOUCHED, not filtered locally')

  // ── 3. deny → POST .../deny, id encoded, NO body, no-auth mode ───────────────
  console.log('\n[smoke] === 3. resolveApproval deny ===')
  stub(JSON.stringify({ ok: true }))
  const deny: ApprovalDecision = { kind: 'deny' }
  await new RestClient('http://gw', null).resolveApproval('req 9', deny)
  assert(cap.url === 'http://gw/api/approvals/req%209/deny', `deny URL encodes the id (got ${cap.url})`)
  assert(cap.body === undefined, 'deny sends NO body (denial creates no grant, so it carries no scope)')
  assert(!('Authorization' in cap.headers), 'tokenless POST → no Authorization header')

  // ── 4. non-2xx rejects, and the daemon's reason survives into the Error ──────
  console.log('\n[smoke] === 4. error propagation (surfaced, not swallowed) ===')
  let threw = false
  stub('nope', 500)
  try {
    await new RestClient('http://gw', null).listApprovals()
  } catch {
    threw = true
  }
  assert(threw, 'GET non-2xx → throws')

  let msg = ''
  stub(JSON.stringify({ error: "scope must be one of ['once', 'until-restart', 'always']" }), 400)
  try {
    await new RestClient('http://gw', null).resolveApproval('z', { kind: 'approve', scope: 'always here' })
  } catch (e) {
    msg = e instanceof Error ? e.message : String(e)
  }
  assert(msg.length > 0, 'POST non-2xx → throws')
  assert(msg.includes('400'), `the status reaches the operator (got ${msg})`)
  assert(
    msg.includes('scope must be one of'),
    `the daemon's OWN reason reaches the operator — the only signal a vocabulary drift would give (got ${msg})`
  )

  globalThis.fetch = origFetch
}

/**
 * The verdict runs on process EXIT as well as on the normal path — never only at the end of
 * main().
 *
 * WHY, CONCRETELY. It used to be main()'s last statement, so any early exit — a `return`, a
 * rethrow, a section that bails — skipped the verdict AND the MIN_CHECKS guard with it, and node
 * exited 0. Both of the sessions that touched this file proved it independently with a mutation:
 * a `return` placed before a section ran a fraction of the assertions, printed no RESULT block,
 * and exited GREEN. A count guard that only runs when nothing went wrong cannot report the case
 * it was written for.
 *
 * `process.exitCode` and NOT `process.exit()` — the latter is a no-op once an exit handler is
 * running, so the failure would be printed and then not acted on. `reported` keeps the verdict to
 * one printing when the normal path has already run it.
 */
let reported = false
function report(): void {
  if (reported) return
  reported = true
  console.log('\n[smoke] ===================== RESULT =====================')
  if (checks < MIN_CHECKS) {
    failures++
    console.log(
      `[smoke] FAIL  only ${checks} of ${MIN_CHECKS} expected assertions RAN — a section stopped ` +
        'executing, so a green result here would have proved nothing'
    )
  }
  console.log(`[smoke] assertions run: ${checks} (floor ${MIN_CHECKS})`)
  console.log(
    `[smoke] outcome: ${failures === 0 ? `PASS \u2713 (${checks} checks: one mapper for both transports, extents + arguments passthrough, scope on the wire, deny bodiless, error surfaced)` : `FAIL \u2717 (${failures})`}`
  )
  console.log('[smoke] ===================================================')
  if (failures > 0) process.exitCode = 1
}

// EVERY path out prints the verdict, including the ones that reach here having run nothing.
process.on('exit', report)

main()
  .then(report)
  .catch((err) => {
    console.error('[smoke] FAILED:', err)
    failures++
    report()
  })
