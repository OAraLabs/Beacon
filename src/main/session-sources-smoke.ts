/**
 * session-sources-smoke — readable labels, the conversation/machine split, and
 * THE SURFACE-PREFIX INVARIANT the Harness chip depends on.
 *
 * Live-box motivation (127 sessions): chips read `BA 69 · UN 31 · DT 13 · VO 9
 * · TG 1 · WE 1 · VE 1 · RE 1 · TH 1 · ME 1`. VE/RE/TH/ME were one-off
 * `verify:` / `restore-verify:` / `thinking-verify:` / `merge-verify:` test
 * sessions, and `bakeoff` alone (69) outnumbered every real conversation.
 *
 * Second live survey (173 sessions) found the next layer: 46 sessions carrying
 * HAND-TYPED ids — `walk-narrow`, `floor-live-1`, `telemetry-probe-2` — scripted
 * probes interleaved with real chats. They are classified by ID SHAPE, and that
 * classification rests on one claim:
 *
 *      EVERY SHIPPED SURFACE PREFIXES ITS SESSION IDS.
 *
 * "I looked and found no surface that doesn't" is weaker than "none can", so the
 * claim is pinned below and fails loudly if a surface ever posts a bare id.
 *
 * Run: npm run smoke:session-sources
 */
import {
  AUTOMATED_KEY,
  BEACON_GATEWAY,
  BEACON_SMOKE_GATEWAY,
  HARNESS_KEY,
  UNDECLARED_GATEWAY,
  buildSourceChips,
  chipKeyFor,
  isAutomatedSource,
  isDefaultVisible,
  isHarnessId,
  isUndeclaredApiSession,
  matchesChip,
  sourceLabel
} from '@shared/session-sources'

let failures = 0
function check(cond: boolean, label: string): void {
  if (cond) console.log(`  ok   ${label}`)
  else {
    console.error(`  FAIL ${label}`)
    failures += 1
  }
}

console.log('\n=== labels ===')
check(sourceLabel('desktop') === 'Desktop', 'known source gets its proper name')
check(sourceLabel('unknown') === 'Unlabelled', '"unknown" reads as Unlabelled, not UN')
check(sourceLabel('bakeoff') === 'Bakeoff', 'bakeoff labelled')
check(sourceLabel('restore-verify') === 'Restore Verify', 'unknown source title-cases instead of RE')
check(sourceLabel('thinking-verify') === 'Thinking Verify', 'no more TH/ME collisions')
check(sourceLabel('') === 'Unlabelled', 'empty source degrades safely')
check(sourceLabel(BEACON_GATEWAY) === 'Beacon', "Beacon's own gateway reads as Beacon")

console.log('\n=== automated classification (by gateway) ===')
check(isAutomatedSource('bakeoff'), 'bakeoff is automated')
check(isAutomatedSource('verify'), 'bare verify is automated')
check(isAutomatedSource('merge-verify'), '*-verify suffix is automated')
check(
  isAutomatedSource(BEACON_SMOKE_GATEWAY),
  "the setup wizard's leftover session is automated via the EXISTING -verify rule, no new rule"
)
check(
  !isAutomatedSource(BEACON_GATEWAY),
  'Beacon itself is a conversation — the -verify rule must not swallow the app it is named after'
)
check(isAutomatedSource('FOO-VERIFY'), 'case-insensitive')
check(!isAutomatedSource('desktop'), 'desktop is a conversation')
check(!isAutomatedSource('unknown'), 'unlabelled sessions are conversations, not machine runs')

// ── THE INVARIANT ───────────────────────────────────────────────────────────
//
// Every id a SHIPPED surface can mint. If a surface is ever changed to post a
// hand-written id, add it here and this block goes red — which is the point.
// Sources: POST /api/sessions mints `<gateway>:<uuid>` and rejects a gateway
// containing a colon; Telegram uses `telegram:<chat_id>`; the bakeoff harness
// `bakeoff:<task>:<run>:<ts>`; voice `voice:<label>`.
console.log('\n=== INVARIANT: every shipped surface prefixes its ids ===')
const SHIPPED_SURFACE_IDS: Array<[string, string]> = [
  ['beacon (MainView.createSession)', `${BEACON_GATEWAY}:4e9570bc-73bb-4d51-bde8-9f777528ae85`],
  ['beacon smoke (SetupWizard.runSmoke)', `${BEACON_SMOKE_GATEWAY}:26d3b9f2-1c4a-4f0e-9a77-2b1d3e5f8a90`],
  ['desktop (POST /api/sessions)', 'desktop:49b6955e-b93f-4dae-a62c-0416e0b5c9a1'],
  ['desktop (legacy literal)', 'desktop:s4-2332364.1786774889602'],
  ['telegram', 'telegram:8139235390'],
  ['voice', 'voice:handsfree-accept'],
  ['web', 'web:outcome-check-226'],
  ['slack', 'slack:C01234567'],
  ['discord', 'discord:998877'],
  ['coding', 'coding:run-17'],
  ['paperclip', 'paperclip:inbox-3'],
  ['bakeoff', 'bakeoff:t01_rename_private_helper:r2:1781187983'],
  ['verify family', 'restore-verify:1781234810']
]
for (const [surface, id] of SHIPPED_SURFACE_IDS) {
  check(
    !isHarnessId(id),
    `${surface} is NOT harness — if this fails, that surface stopped prefixing and its real sessions are being collapsed as debris`
  )
}

console.log('\n=== harness classification (by id shape) ===')
check(isHarnessId('walk-narrow'), 'hand-typed id is harness')
check(isHarnessId('floor-live-1'), 'hand-typed id with digits is harness')
check(isHarnessId('telemetry-probe-2'), 'probe id is harness')
check(isHarnessId('floor0fw'), 'single-word hand-typed id is harness')
check(
  !isHarnessId('3872cf88-4168-4f2b-9a9d-d5134b5199aa'),
  'a BARE UUID is not harness — a program minted it, plausibly a real client that just did not declare an origin'
)
check(!isHarnessId('3872CF88-4168-4F2B-9A9D-D5134B5199AA'), 'uuid check is case-insensitive')
check(!isHarnessId(''), 'empty id makes no claim about shape')
check(!isHarnessId('   '), 'whitespace-only id makes no claim either')

console.log('\n=== a row belongs to exactly ONE chip ===')
check(chipKeyFor({ id: 'bakeoff:t01:r1:1', gateway: 'bakeoff' }) === AUTOMATED_KEY, 'bakeoff → Automated')
check(chipKeyFor({ id: 'walk-narrow', gateway: 'unknown' }) === HARNESS_KEY, 'hand-typed id → Harness')
check(chipKeyFor({ id: 'desktop:abc', gateway: 'desktop' }) === 'desktop', 'desktop → its own chip')
check(
  chipKeyFor({ id: '3872cf88-4168-4f2b-9a9d-d5134b5199aa', gateway: 'unknown' }) === 'unknown',
  'bare uuid → Unlabelled, which now means what it says'
)
// Gateway wins over id shape, so a prefixed automated run cannot double-count.
check(
  chipKeyFor({ id: 'verify:claude-fix', gateway: 'verify' }) === AUTOMATED_KEY,
  'an automated gateway outranks id shape — no row lands in two buckets'
)

console.log('\n=== chips (second live-box distribution, 173 sessions) ===')
const live = [
  ...Array.from({ length: 69 }, (_, i) => ({ id: `bakeoff:t${i}:r1:1`, gateway: 'bakeoff' })),
  ...Array.from({ length: 46 }, (_, i) => ({ id: `probe-${i}`, gateway: undefined })),
  ...Array.from({ length: 18 }, (_, i) => ({
    id: `3872cf88-4168-4f2b-9a9d-d5134b5199${String(i).padStart(2, '0')}`,
    gateway: undefined
  })),
  ...Array.from({ length: 25 }, (_, i) => ({ id: `desktop:d${i}`, gateway: 'desktop' })),
  ...Array.from({ length: 9 }, (_, i) => ({ id: `voice:v${i}`, gateway: 'voice' })),
  { id: 'telegram:8139235390', gateway: 'telegram' },
  { id: 'web:outcome-check-226', gateway: 'web' },
  ...['verify', 'restore-verify', 'thinking-verify', 'merge-verify'].map((g) => ({ id: `${g}:1`, gateway: g }))
]
const chips = buildSourceChips(live)
console.log('  ' + chips.map((c) => `${c.label}:${c.count}`).join(' · '))

const automated = chips.find((c) => c.key === AUTOMATED_KEY)
const harness = chips.find((c) => c.key === HARNESS_KEY)
check(!!automated && automated.count === 73, 'Automated = bakeoff 69 + 4 verify one-offs')
check(!!harness && harness.count === 46, 'Harness = the 46 hand-typed probe ids')
check(
  chips.filter((c) => c.key === AUTOMATED_KEY || c.key === HARNESS_KEY).length === 2,
  'TWO machine chips, not one bag — you can find bakeoff runs without wading through probes'
)
check(
  chips[chips.length - 2].key === AUTOMATED_KEY && chips[chips.length - 1].key === HARNESS_KEY,
  'both machine chips sort last, Automated then Harness'
)
check(chips[0].label === 'Desktop' && chips[0].count === 25, 'busiest conversation source first')
check(
  chips.find((c) => c.label === 'Unlabelled')?.count === 18,
  'Unlabelled now holds only the 18 bare-uuid rows, not 64'
)

console.log('\n=== filtering + default visibility ===')
check(matchesChip('desktop', { id: 'desktop:a', gateway: 'desktop' }), 'a source chip selects its own source')
check(!matchesChip('desktop', { id: 'voice:a', gateway: 'voice' }), 'and nothing else')
check(matchesChip(AUTOMATED_KEY, { id: 'bakeoff:a', gateway: 'bakeoff' }), 'Automated chip selects bakeoff')
check(matchesChip(HARNESS_KEY, { id: 'walk-narrow' }), 'Harness chip selects hand-typed ids')
check(!matchesChip(HARNESS_KEY, { id: 'bakeoff:a', gateway: 'bakeoff' }), 'Harness chip excludes bakeoff')

check(!isDefaultVisible({ id: 'bakeoff:a', gateway: 'bakeoff' }), 'default view hides bakeoff — 69 rows of benchmark noise')
check(isDefaultVisible({ id: 'desktop:a', gateway: 'desktop' }), 'default view keeps desktop chats')
check(
  isDefaultVisible({ id: 'walk-narrow' }),
  'default view KEEPS harness rows — they collapse into a counted group rather than vanishing'
)

const visible = live.filter(isDefaultVisible).length
const hidden = live.length - visible
console.log(`  default view: ${visible} rows shown (46 of them inside the collapsed Harness group), ${hidden} automated folded away`)
check(visible === 100 && hidden === 73, 'the split matches the live distribution')

// ── `desktop` is the UNDECLARED DEFAULT, and Beacon no longer hides inside it ──
//
// The defect: `POST /api/sessions` defaults to `desktop`, Beacon's createSession
// sent no body, and a probe script sent none either — so the chip labelled for a
// human was populated by everything. 30 desktop rows on the live box: 17
// agent-driven, 13 real.
console.log('\n=== the undeclared-API default ===')
// Cast through `string` deliberately: both are `as const` literals, so comparing
// them directly is a compile error rather than a test. tsc catching it is the
// first line of defence; this keeps a RUNTIME assertion that goes red if anyone
// ever points Beacon back at the default.
check(
  (BEACON_GATEWAY as string) !== (UNDECLARED_GATEWAY as string),
  'Beacon declares something OTHER than the daemon default — if these are ever equal the whole fix is vacuous'
)
check(isUndeclaredApiSession({ id: 'desktop:abc', gateway: 'desktop' }), 'a desktop row is an undeclared caller')
check(
  !isUndeclaredApiSession({ id: `${BEACON_GATEWAY}:abc`, gateway: BEACON_GATEWAY }),
  "Beacon's own chat is NOT undeclared — this is the distinction the change exists to create"
)
check(!isUndeclaredApiSession({ id: 'voice:v1', gateway: 'voice' }), 'a declared gateway is not undeclared')
check(!isUndeclaredApiSession({ id: 'walk-narrow' }), 'a session with no gateway at all is Unlabelled, not desktop')
check(isUndeclaredApiSession({ id: 'DESKTOP:abc', gateway: 'DESKTOP' }), 'case-insensitive, like every other check here')

// Grouped, NOT hidden. Guards against someone "simplifying" this by dropping
// `desktop` into AUTOMATED_EXACT — one line, and it silently hides 13 real
// conversations with no header and no count.
check(
  isDefaultVisible({ id: 'desktop:abc', gateway: 'desktop' }),
  'desktop rows stay DEFAULT-VISIBLE — they collapse into a counted group, they are not excluded like bakeoff'
)
check(chipKeyFor({ id: 'desktop:abc', gateway: 'desktop' }) === 'desktop', 'desktop keeps its own chip with its own count')
check(
  chipKeyFor({ id: `${BEACON_GATEWAY}:abc`, gateway: BEACON_GATEWAY }) === BEACON_GATEWAY,
  'beacon gets its own conversational chip'
)
check(
  chipKeyFor({ id: `${BEACON_SMOKE_GATEWAY}:abc`, gateway: BEACON_SMOKE_GATEWAY }) === AUTOMATED_KEY,
  "the wizard's smoke session folds into Automated"
)
check(
  isDefaultVisible({ id: `${BEACON_GATEWAY}:abc`, gateway: BEACON_GATEWAY }),
  'and Beacon chats are default-visible'
)
check(
  !isDefaultVisible({ id: `${BEACON_SMOKE_GATEWAY}:abc`, gateway: BEACON_SMOKE_GATEWAY }),
  'while its setup debris is not'
)

// ── REAL desktop sessions are still not debris ───────────────────────────────
//
// The 13 real rows are moving into a collapsed group; they must not ALSO get
// reclassified as harness on the way. Both live shapes, plus the bare uuid that
// carries no colon-prefixed origin at all.
console.log('\n=== real sessions are not harness ===')
check(!isHarnessId('desktop:c43e4a50-3ecd-425f-abfa-81998adccf95'), 'the 563-message conversation is not harness')
check(!isHarnessId('desktop:s4-2332364.1786774889602'), 'a legacy `s4-` desktop conversation is not harness')

// ── the daemon's reserved machine namespace (Prometheus memory/session_kind.py) ──────────────
// These must fold behind the automated chip, not appear as live gateways. A session the daemon
// treats as disposable and Beacon files under `smoke` or `gym` is one the user watches retention
// delete out from under them.
for (const ns of ['bakeoff', 'coding', 'eval', 'gym', 'smoke']) {
  check(chipKeyFor({ id: `${ns}:probe-1`, gateway: ns }) === AUTOMATED_KEY, `${ns}: folds behind the automated chip`)
}
// The renamed probes specifically — these ids are what step2 and step4 now create.
check(chipKeyFor({ id: 'smoke:step2', gateway: 'smoke' }) === AUTOMATED_KEY, 'step2 probe is automated, not a desktop chat')
check(chipKeyFor({ id: 'smoke:s4-123.456', gateway: 'smoke' }) === AUTOMATED_KEY, 'step4 probe is automated, not a desktop chat')
// And the live namespaces must NOT be swallowed by that widening.
for (const live of ['beacon', 'desktop', 'ios', 'telegram', 'web', 'voice']) {
  check(chipKeyFor({ id: `${live}:abc`, gateway: live }) !== AUTOMATED_KEY, `${live}: stays a real conversation source`)
}
check(
  !isHarnessId('3872cf88-4168-4f2b-9a9d-d5134b5199aa'),
  'a real session with NO colon-prefixed origin is still not harness — a bare uuid is a program that did not declare, not a hand-typed probe'
)
check(
  chipKeyFor({ id: 'desktop:s4-2332364.1786774889602', gateway: 'desktop' }) === 'desktop',
  'and it routes to Desktop, not Harness'
)

// The daemon's own charset guard, restated client-side. `POST /api/sessions`
// rejects anything outside this with a 400, and the wizard's smoke test would
// fail on first run — a round trip we can pin here for free.
console.log('\n=== the gateways we declare are ones the daemon accepts ===')
const DAEMON_GATEWAY_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/i
for (const gw of [BEACON_GATEWAY, BEACON_SMOKE_GATEWAY]) {
  check(DAEMON_GATEWAY_RE.test(gw), `"${gw}" satisfies the daemon's [a-z0-9][a-z0-9_-]{0,31} guard`)
  check(!gw.includes(':'), `"${gw}" has no colon — the id is split on the first one`)
}

console.log(`\n${failures === 0 ? 'PASS' : `FAIL (${failures})`}\n`)
process.exit(failures === 0 ? 0 : 1)
