/**
 * The release-hardening guard that runs on every PR. probe:hardening proves the BUILT bundles
 * (fuses read back, every door launched), but it needs a signing identity and two packages, so CI
 * cannot run it. This smoke holds the line between packages: it checks the inputs that produce a
 * hardened build, and the decision main makes at startup.
 *
 *   1. the decision (src/shared/release-gate.ts): which flag + packaging state refuses which switch;
 *   2. the real inputs: electron-builder.yml's fuses and flag, electron-builder.probe.yml differing
 *      in exactly what it may, the entitlements plist, the gate's place in main, audit:bundle's
 *      idea of a release fuse set agreeing with the config's, and DevTools gated on every window
 *      and view main creates and in the View menu;
 *   3. the checker can SEE each regression: every mutation below plants one in a copy of the real
 *      text and must be flagged. A guard that cannot detect the regression it exists for is a note.
 *
 * Structural, not executed: section 2 reads files. What the files produce is probe:hardening's job.
 * Run: npm run smoke:release-gate   (from the repo root)
 */
import { readFileSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { REMOTE_DEBUGGING_SWITCHES, buildFlavorOf, debuggingAllowed, refusedSwitches } from '@shared/release-gate'

let failures = 0
let passes = 0
function assert(cond: boolean, what: string, detail = ''): void {
  console.log(`[smoke] ${cond ? 'PASS' : 'FAIL'}  ${what}${detail ? `\n         ${detail}` : ''}`)
  if (cond) passes++
  else failures++
}

const ROOT = process.cwd()
const read = (p: string): string => readFileSync(join(ROOT, p), 'utf8')
// The YAML parser electron-builder itself loads its config with, so this reads what it reads.
const yaml = createRequire(join(ROOT, 'package.json'))('js-yaml') as { load(text: string): unknown }
type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)

// ── the checkers: text in, violations out ────────────────────────────────────────────────────
const RELEASE_FUSE_CONFIG = {
  runAsNode: false,
  // One-way once shipped: turning it off deletes every cookie of any domain holding an encrypted
  // one (measured; docs/DECISIONS.md D1). This line is what makes turning it off fail CI.
  enableCookieEncryption: true,
  enableNodeOptionsEnvironmentVariable: false,
  enableNodeCliInspectArguments: false,
  onlyLoadAppFromAsar: true,
  enableEmbeddedAsarIntegrityValidation: true,
  resetAdHocDarwinSignature: true
}
/** electron-builder.yml: the release fuses (cookie encryption included, never to be turned off:
 *  docs/DECISIONS.md D1) and the release flag. */
function checkReleaseConfig(text: string): string[] {
  const v: string[] = []
  const c = yaml.load(text)
  if (!isObj(c)) return ['electron-builder.yml is not a mapping']
  const fuses = isObj(c.electronFuses) ? c.electronFuses : {}
  for (const [k, want] of Object.entries(RELEASE_FUSE_CONFIG)) if (fuses[k] !== want) v.push(`electronFuses.${k} is ${JSON.stringify(fuses[k])}, must be ${want}`)
  if (!isObj(c.extraMetadata) || c.extraMetadata.beaconBuild !== 'release') v.push(`extraMetadata.beaconBuild must be 'release' (got ${JSON.stringify(isObj(c.extraMetadata) ? c.extraMetadata.beaconBuild : undefined)})`)
  const mac = isObj(c.mac) ? c.mac : {}
  if (mac.entitlements !== 'build/entitlements.mac.plist' || mac.entitlementsInherit !== 'build/entitlements.mac.plist') v.push('mac.entitlements and mac.entitlementsInherit must both be build/entitlements.mac.plist (the file this smoke checks)')
  return v
}
const PROBE_KEYS = ['afterPack', 'appId', 'directories', 'electronFuses', 'extends', 'extraMetadata']
/** electron-builder.probe.yml: the release config plus exactly the probe flag and the inspector
 *  fuse, under its own identity. Anything else it overrode would make a probe prove something
 *  about a build that is not the release. */
function checkProbeConfig(text: string, baseText: string): string[] {
  const v: string[] = []
  const c = yaml.load(text), base = yaml.load(baseText)
  if (!isObj(c) || !isObj(base)) return ['a builder config is not a mapping']
  if (c.extends !== 'electron-builder.yml') v.push(`extends must be electron-builder.yml (got ${JSON.stringify(c.extends)})`)
  const extra = Object.keys(c).filter((k) => !PROBE_KEYS.includes(k))
  if (extra.length) v.push(`overrides keys a probe build may not: ${extra.join(', ')}`)
  if (!same(c.electronFuses, { enableNodeCliInspectArguments: true })) v.push(`electronFuses must be exactly { enableNodeCliInspectArguments: true } (got ${JSON.stringify(c.electronFuses)})`)
  if (!same(c.extraMetadata, { name: 'beacon-desktop-probe', beaconBuild: 'probe' })) v.push(`extraMetadata must be exactly { name: beacon-desktop-probe, beaconBuild: probe } (got ${JSON.stringify(c.extraMetadata)})`)
  if (typeof c.appId !== 'string' || !c.appId || c.appId === base.appId) v.push(`appId must be its own (got ${JSON.stringify(c.appId)}, release ${JSON.stringify(base.appId)})`)
  if (!same(c.directories, { output: 'dist-probe' })) v.push(`directories must be exactly { output: dist-probe } (got ${JSON.stringify(c.directories)})`)
  // beacon:// stays with the release. A probe build that declared it and ran took LaunchServices'
  // handler for it on 2026-10-06. The config cannot drop the release's `protocols`: arrays merge across
  // `extends` by union and the schema rejects null. So an afterPack hook strips the Info.plist.
  if (c.afterPack !== STRIP_HOOK) v.push(`afterPack must be ${STRIP_HOOK}, which strips beacon:// from the probe build's Info.plist (got ${JSON.stringify(c.afterPack)}; a \`protocols\` override cannot remove it)`)
  return v
}
const STRIP_HOOK = 'scripts/probe-strip-url-schemes.cjs'
/** The hook itself: it refuses any bundle id but the probe's (a release keeps its deep links), removes
 *  CFBundleURLTypes, and throws if any remain. */
function checkStripHook(text: string): string[] {
  const t = text.replace(/\/\/.*$/gm, '')
  const v: string[] = []
  if (!t) return [`${STRIP_HOOK} is missing`]
  if (!/if\s*\(\s*id\s*!==\s*PROBE_ID\s*\)\s*\{\s*throw/.test(t) || !/PROBE_ID\s*=\s*'com\.oaralabs\.beacon\.probe'/.test(t)) v.push(`${STRIP_HOOK} does not refuse bundles other than com.oaralabs.beacon.probe`)
  if (!/'-remove',\s*'CFBundleURLTypes'/.test(t)) v.push(`${STRIP_HOOK} does not remove CFBundleURLTypes`)
  if (!/if\s*\(\s*left\s*!==\s*undefined\s*\)\s*throw/.test(t)) v.push(`${STRIP_HOOK} does not fail when URL types remain`)
  return v
}
/** src/main/index.ts: only a release claims beacon:// at startup (setAsDefaultProtocolClient writes
 *  LaunchServices' stored handler for the scheme). A probe build that claimed it took the scheme over. */
function checkSchemeClaim(text: string): string[] {
  const t = stripComments(text)
  const calls = [...t.matchAll(/setAsDefaultProtocolClient\(/g)]
  if (calls.length === 0) return ['main never claims beacon:// (setAsDefaultProtocolClient): a release would lose its deep links']
  return calls
    .filter((m) => !/if\s*\(\s*buildFlavor\(\)\s*===\s*'release'\s*\)\s*(app\.)?$/.test(t.slice(Math.max(0, (m.index ?? 0) - 80), m.index)))
    .map(() => "setAsDefaultProtocolClient runs outside `if (buildFlavor() === 'release')`, so a probe or unflagged build claims beacon://")
}
const FORBIDDEN_ENTITLEMENTS = ['com.apple.security.cs.allow-dyld-environment-variables', 'com.apple.security.cs.disable-library-validation']
const NEEDED_ENTITLEMENTS = ['com.apple.security.cs.allow-jit', 'com.apple.security.cs.allow-unsigned-executable-memory', 'com.apple.security.device.audio-input']
function checkEntitlements(text: string): string[] {
  const keys = [...text.replace(/<!--[\s\S]*?-->/g, '').matchAll(/<key>([^<]+)<\/key>\s*<true\/>/g)].map((m) => m[1])
  return [
    ...FORBIDDEN_ENTITLEMENTS.filter((k) => keys.includes(k)).map((k) => `entitlement ${k} must not be granted`),
    ...NEEDED_ENTITLEMENTS.filter((k) => !keys.includes(k)).map((k) => `entitlement ${k} is missing`)
  ]
}
const stripComments = (t: string): string => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1')
/** src/main/index.ts: the gate runs before anything else in main's module body, decides from the
 *  build's flag (build-flavor.ts) on Chromium's own parsed command line, and exits. */
function checkGate(text: string): string[] {
  const v: string[] = []
  const t = stripComments(text)
  const gate = t.indexOf('refusedSwitches(')
  if (gate < 0) return ['main never calls refusedSwitches()']
  const block = t.slice(gate, gate + 600)
  if (!/refusedSwitches\(\s*buildFlavor\(\)\s*,\s*app\.isPackaged/.test(block)) v.push('the gate does not decide from buildFlavor() and app.isPackaged')
  if (!block.includes('app.commandLine.hasSwitch')) v.push("the gate does not ask Chromium's parsed command line (app.commandLine.hasSwitch)")
  if (!block.includes('process.exit(')) v.push('the gate does not exit')
  for (const later of ['requestSingleInstanceLock(', 'registerArtifactRenderScheme()', 'app.on(', 'app.whenReady(']) {
    const at = t.indexOf(later)
    if (at >= 0 && at < gate) v.push(`${later} runs before the gate`)
  }
  return v
}
/** src/main/build-flavor.ts: the flag comes from the app's own package.json (app.asar in a packaged
 *  build), through buildFlavorOf, and the debugging decision is the shared one. */
function checkFlavorSource(text: string): string[] {
  const t = stripComments(text)
  const v: string[] = []
  if (!/readFileSync\(\s*join\(\s*app\.getAppPath\(\)\s*,\s*'package\.json'\s*\)/.test(t)) v.push("build-flavor.ts does not read package.json from app.getAppPath() (the asar's own)")
  if (!t.includes('buildFlavorOf(')) v.push('build-flavor.ts does not parse the flag with buildFlavorOf')
  if (!/return\s+debuggingAllowed\(\s*buildFlavor\(\)\s*,\s*app\.isPackaged\s*\)/.test(t)) v.push('debuggingAllowedHere() is not debuggingAllowed(buildFlavor(), app.isPackaged)')
  if (/process\.env/.test(t)) v.push('build-flavor.ts reads an environment variable (the flag must not be settable at run time)')
  return v
}

/** The text of the call starting at `open` (the index of its '('), up to the matching ')'. */
function callText(t: string, open: number): string {
  let depth = 0
  for (let i = open; i < t.length; i++) {
    if (t[i] === '(') depth++
    else if (t[i] === ')' && --depth === 0) return t.slice(open, i + 1)
  }
  return t.slice(open)
}
/** DevTools in a release: every window and view main creates passes webPreferences.devTools from
 *  debuggingAllowedHere() (Electron defaults it to true, so a window that says nothing has DevTools),
 *  and the View menu offers Toggle Developer Tools only behind the same decision. */
function checkDevTools(sources: Array<{ path: string; text: string }>, indexText: string): string[] {
  const v: string[] = []
  let made = 0
  for (const f of sources) {
    const t = stripComments(f.text)
    for (const m of t.matchAll(/new (BrowserWindow|WebContentsView|BaseWindow)\(/g)) {
      // Text inside a string on the same line is not a construction (browser-invariant.ts quotes
      // `new WebContentsView({ … })` in an error message): an odd count of quote marks before it.
      const lineStart = t.lastIndexOf('\n', m.index ?? 0) + 1
      const prefix = t.slice(lineStart, m.index).replace(/\\./g, '')
      if (['\'', '"', '`'].some((q) => prefix.split(q).length % 2 === 0)) continue
      made++
      const call = callText(t, (m.index ?? 0) + m[0].length - 1)
      if (!/devTools:\s*debuggingAllowedHere\(\)/.test(call)) v.push(`${f.path}: new ${m[1]}(…) does not set webPreferences.devTools: debuggingAllowedHere()`)
    }
  }
  if (made === 0) v.push('found no new BrowserWindow / WebContentsView in src/main at all (the scan is reading the wrong files)')
  const idx = stripComments(indexText)
  if (/role:\s*'viewMenu'/.test(idx)) v.push("index.ts uses role: 'viewMenu', whose default items include Toggle Developer Tools")
  for (const m of idx.matchAll(/role:\s*'toggleDevTools'/g)) {
    const before = idx.slice(Math.max(0, (m.index ?? 0) - 120), m.index)
    if (!/debuggingAllowedHere\(\)\s*\?\s*\(?\s*\[\s*\{\s*$/.test(before)) v.push("index.ts offers role: 'toggleDevTools' without debuggingAllowedHere() ? […] around it")
  }
  return v
}

const FUSE_NAME: Record<string, string> = {
  runAsNode: 'RunAsNode',
  enableCookieEncryption: 'EnableCookieEncryption',
  enableNodeOptionsEnvironmentVariable: 'EnableNodeOptionsEnvironmentVariable',
  enableNodeCliInspectArguments: 'EnableNodeCliInspectArguments',
  onlyLoadAppFromAsar: 'OnlyLoadAppFromAsar',
  enableEmbeddedAsarIntegrityValidation: 'EnableEmbeddedAsarIntegrityValidation'
}
/** audit:bundle (scripts/bundle-facts.mjs) must want the fuses the config sets, or install-local
 *  would pass a bundle the config never meant, or refuse every one it did. */
function checkAuditAgrees(releaseText: string, probeText: string, facts: { RELEASE_FUSES: Obj; PROBE_FUSES: Obj }): string[] {
  const asStates = (cfg: unknown): Obj => {
    const out: Obj = {}
    if (isObj(cfg)) for (const [k, n] of Object.entries(FUSE_NAME)) if (typeof cfg[k] === 'boolean') out[n] = cfg[k] ? 'enabled' : 'disabled'
    return out
  }
  const rel = yaml.load(releaseText), pro = yaml.load(probeText)
  const relFuses = isObj(rel) ? rel.electronFuses : undefined
  const proFuses = { ...(isObj(relFuses) ? relFuses : {}), ...(isObj(pro) && isObj(pro.electronFuses) ? pro.electronFuses : {}) }
  const v: string[] = []
  const sorted = (o: Obj): Obj => Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)))
  if (!same(sorted(asStates(relFuses)), sorted(facts.RELEASE_FUSES))) v.push(`bundle-facts RELEASE_FUSES ${JSON.stringify(sorted(facts.RELEASE_FUSES))} != electron-builder.yml ${JSON.stringify(sorted(asStates(relFuses)))}`)
  if (!same(sorted(asStates(proFuses)), sorted(facts.PROBE_FUSES))) v.push(`bundle-facts PROBE_FUSES ${JSON.stringify(sorted(facts.PROBE_FUSES))} != the probe build's merged fuses ${JSON.stringify(sorted(asStates(proFuses)))}`)
  return v
}

async function main(): Promise<void> {
  // ── 1. the decision ────────────────────────────────────────────────────────────────────────
  console.log('[smoke] === 1. the decision (src/shared/release-gate.ts) ===')
  const flavors: Array<[string | null, string | null]> = [
    ['{"name":"beacon-desktop","beaconBuild":"release"}', 'release'],
    ['{"beaconBuild":"probe"}', 'probe'],
    ['{"name":"beacon-desktop"}', null],
    ['{"beaconBuild":true}', null],
    ['null', null],
    ['not json', null],
    [null, null]
  ]
  for (const [text, want] of flavors) assert(buildFlavorOf(text) === want, `buildFlavorOf(${JSON.stringify(text)}) is ${JSON.stringify(want)}`, `got ${JSON.stringify(buildFlavorOf(text))}`)
  const table: Array<[string | null, boolean, boolean, string]> = [
    ['release', true, false, 'a packaged release refuses'],
    ['release', false, false, 'a release refuses even when isPackaged reads false (a renamed binary)'],
    ['probe', true, true, 'a packaged probe build allows'],
    [null, false, true, 'a dev run (electron ., no flag) allows'],
    [null, true, false, 'a packaged build with no flag refuses: forgetting the flag is not a debuggable release'],
    ['Release', true, false, 'an unknown spelling refuses'],
    ['', false, false, 'an empty flag refuses']
  ]
  for (const [flavor, packaged, want, why] of table) assert(debuggingAllowed(flavor, packaged) === want, `${why} (${JSON.stringify(flavor)}, packaged=${packaged} → ${want ? 'allow' : 'refuse'})`)
  assert(same([...REMOTE_DEBUGGING_SWITCHES].sort(), ['remote-debugging-pipe', 'remote-debugging-port']), 'the gated switches are remote-debugging-port and remote-debugging-pipe', JSON.stringify(REMOTE_DEBUGGING_SWITCHES))
  const has = (...names: string[]) => (n: string) => names.includes(n)
  assert(same(refusedSwitches('release', true, has('remote-debugging-port', 'remote-debugging-pipe')), ['remote-debugging-port', 'remote-debugging-pipe']), 'a release given both switches refuses both')
  assert(same(refusedSwitches('release', true, has('remote-debugging-pipe')), ['remote-debugging-pipe']), 'a release given only the pipe refuses the pipe')
  assert(same(refusedSwitches('release', true, has('inspect', 'user-data-dir')), []), 'a release given no debugging switch starts (the inspector is the fuse\'s job)')
  assert(same(refusedSwitches('probe', true, has('remote-debugging-port')), []), 'a probe build given the port starts')
  assert(same(refusedSwitches(null, false, has('remote-debugging-port')), []), 'a dev run given the port starts')

  // ── 2. the real inputs ─────────────────────────────────────────────────────────────────────
  console.log('[smoke] === 2. the real inputs ===')
  const files = {
    release: read('electron-builder.yml'),
    probe: read('electron-builder.probe.yml'),
    plist: read('build/entitlements.mac.plist'),
    index: read('src/main/index.ts'),
    flavor: read('src/main/build-flavor.ts'),
    stripHook: ((): string => { try { return read(STRIP_HOOK) } catch { return '' } })()
  }
  const mainSources = readdirSync(join(ROOT, 'src/main'))
    .filter((n) => n.endsWith('.ts') && !n.endsWith('-smoke.ts'))
    .map((n) => ({ path: `src/main/${n}`, text: read(`src/main/${n}`) }))
  const facts = (await import(pathToFileURL(join(ROOT, 'scripts/bundle-facts.mjs')).href)) as { RELEASE_FUSES: Obj; PROBE_FUSES: Obj }
  assert(Object.keys(facts.RELEASE_FUSES ?? {}).length === 6, `read scripts/bundle-facts.mjs from ${ROOT} (${Object.keys(facts.RELEASE_FUSES ?? {}).length} release fuses)`)
  const real: Array<[string, string[]]> = [
    ['electron-builder.yml sets the release fuses and beaconBuild: release', checkReleaseConfig(files.release)],
    ['electron-builder.probe.yml differs from the release in exactly the probe flag, the inspector fuse, its identity and its output dir', checkProbeConfig(files.probe, files.release)],
    ['the entitlements grant neither dyld variables nor foreign libraries, and keep JIT and the mic', checkEntitlements(files.plist)],
    ["main's first act is the gate, on Chromium's command line, and it exits", checkGate(files.index)],
    ["the flag is read from the app's own package.json, never the environment (build-flavor.ts)", checkFlavorSource(files.flavor)],
    [`DevTools follows the flag: every window and view in src/main (${mainSources.length} files) and the View menu`, checkDevTools(mainSources, files.index)],
    ['only a release claims beacon:// (setAsDefaultProtocolClient behind buildFlavor() === \'release\')', checkSchemeClaim(files.index)],
    [`the probe build's Info.plist is stripped of URL schemes, and only the probe's (${STRIP_HOOK})`, checkStripHook(files.stripHook)],
    ['audit:bundle wants exactly the fuses the configs set', checkAuditAgrees(files.release, files.probe, facts)]
  ]
  for (const [what, v] of real) assert(v.length === 0, what, v.join('\n         '))

  // ── 3. the checker can see each regression ─────────────────────────────────────────────────
  console.log('[smoke] === 3. the guard can see the regression (each mutation must be flagged) ===')
  const once = (t: string, anchor: string | RegExp, replacement: string): string => {
    const n = typeof anchor === 'string' ? t.split(anchor).length - 1 : (t.match(new RegExp(anchor.source, anchor.flags.includes('g') ? anchor.flags : anchor.flags + 'g')) ?? []).length
    if (n !== 1) throw new Error(`anchor found ${n}× (need exactly 1): ${String(anchor).slice(0, 60)}`)
    return t.replace(anchor, replacement)
  }
  const editSource = (fs: Array<{ path: string; text: string }>, path: string, anchor: string | RegExp, replacement: string): Array<{ path: string; text: string }> => {
    const hit = fs.find((f) => f.path === path)
    if (!hit) throw new Error(`mutation target missing: ${path}`)
    return fs.map((f) => (f === hit ? { ...f, text: once(f.text, anchor, replacement) } : f))
  }
  const GATE = /\{\n {2}const refused = refusedSwitches[\s\S]*?\n\}\n/
  const gateBlock = (files.index.match(GATE) ?? [''])[0]
  type Mutation = { name: string; run: () => string[]; flag: RegExp }
  const mutations: Mutation[] = [
    { name: 'RunAsNode back on', flag: /runAsNode/, run: () => checkReleaseConfig(once(files.release, '  runAsNode: false', '  runAsNode: true')) },
    { name: 'cookie encryption turned off (rollback deletes users\' cookies)', flag: /enableCookieEncryption is false, must be true/, run: () => checkReleaseConfig(once(files.release, /^ {2}enableCookieEncryption: true$/m, '  enableCookieEncryption: false')) },
    { name: 'cookie encryption line deleted (Electron\'s default is off)', flag: /enableCookieEncryption is undefined, must be true/, run: () => checkReleaseConfig(once(files.release, /^ {2}enableCookieEncryption: true\n/m, '')) },
    { name: 'NODE_OPTIONS fuse line deleted', flag: /enableNodeOptionsEnvironmentVariable/, run: () => checkReleaseConfig(once(files.release, '  enableNodeOptionsEnvironmentVariable: false\n', '')) },
    { name: 'inspector fuse back on in the release', flag: /enableNodeCliInspectArguments/, run: () => checkReleaseConfig(once(files.release, '  enableNodeCliInspectArguments: false', '  enableNodeCliInspectArguments: true')) },
    { name: 'asar integrity off', flag: /enableEmbeddedAsarIntegrityValidation/, run: () => checkReleaseConfig(once(files.release, '  enableEmbeddedAsarIntegrityValidation: true', '  enableEmbeddedAsarIntegrityValidation: false')) },
    { name: 'onlyLoadAppFromAsar deleted', flag: /onlyLoadAppFromAsar/, run: () => checkReleaseConfig(once(files.release, '  onlyLoadAppFromAsar: true\n', '')) },
    { name: 'resetAdHocDarwinSignature deleted (unsigned arm64 build would not launch)', flag: /resetAdHocDarwinSignature/, run: () => checkReleaseConfig(once(files.release, '  resetAdHocDarwinSignature: true\n', '')) },
    { name: 'the release config writes the probe flag', flag: /beaconBuild/, run: () => checkReleaseConfig(once(files.release, '  beaconBuild: release', '  beaconBuild: probe')) },
    { name: 'the whole electronFuses block deleted', flag: /electronFuses\.runAsNode/, run: () => checkReleaseConfig(once(files.release, /electronFuses:\n(?: {2}\w+: \w+\n)+/, '')) },
    { name: 'the probe build also turns RunAsNode on', flag: /electronFuses must be exactly/, run: () => checkProbeConfig(once(files.probe, /^ {2}enableNodeCliInspectArguments: true$/m, '  enableNodeCliInspectArguments: true\n  runAsNode: true'), files.release) },
    { name: "the probe build takes the release's bundle id", flag: /appId must be its own/, run: () => checkProbeConfig(once(files.probe, 'appId: com.oaralabs.beacon.probe', 'appId: com.oaralabs.beacon'), files.release) },
    { name: "the probe build takes the release's package name (and so its Keychain item)", flag: /extraMetadata must be exactly/, run: () => checkProbeConfig(once(files.probe, '  name: beacon-desktop-probe\n', ''), files.release) },
    { name: 'the probe build writes into dist/ (install-local reads it)', flag: /directories must be exactly/, run: () => checkProbeConfig(once(files.probe, '  output: dist-probe', '  output: dist'), files.release) },
    { name: 'the probe build overrides something else (entitlements)', flag: /may not: mac/, run: () => checkProbeConfig(files.probe + '\nmac:\n  entitlements: build/other.plist\n', files.release) },
    { name: 'disable-library-validation granted again', flag: /disable-library-validation must not/, run: () => checkEntitlements(once(files.plist, '</dict>', '\t<key>com.apple.security.cs.disable-library-validation</key>\n\t<true/>\n</dict>')) },
    { name: 'allow-dyld-environment-variables granted again', flag: /allow-dyld-environment-variables must not/, run: () => checkEntitlements(once(files.plist, '</dict>', '\t<key>com.apple.security.cs.allow-dyld-environment-variables</key>\n\t<true/>\n</dict>')) },
    { name: 'the mic entitlement dropped with them', flag: /audio-input is missing/, run: () => checkEntitlements(once(files.plist, /\t<key>com\.apple\.security\.device\.audio-input<\/key>\n\t<true\/>\n/, '')) },
    { name: 'the gate deleted from main', flag: /never calls refusedSwitches/, run: () => checkGate(once(files.index, gateBlock, '')) },
    { name: 'the gate moved after the single-instance lock', flag: /requestSingleInstanceLock\( runs before the gate/, run: () => checkGate(once(once(files.index, gateBlock, ''), 'const singleInstance = app.requestSingleInstanceLock()\n', 'const singleInstance = app.requestSingleInstanceLock()\n' + gateBlock)) },
    { name: 'the gate scans process.argv instead of Chromium (misses -remote-debugging-port)', flag: /app\.commandLine\.hasSwitch/, run: () => checkGate(once(files.index, '(name) => app.commandLine.hasSwitch(name)', "(name) => process.argv.includes('--' + name)")) },
    { name: 'the gate logs but does not exit', flag: /does not exit/, run: () => checkGate(once(files.index, '    process.exit(1)\n', '')) },
    { name: 'the flag read from an environment variable instead', flag: /environment variable/, run: () => checkFlavorSource(once(files.flavor, "text = readFileSync(join(app.getAppPath(), 'package.json'), 'utf8')", "text = process.env.BEACON_BUILD_JSON ?? readFileSync(join(app.getAppPath(), 'package.json'), 'utf8')")) },
    { name: 'the flag read from the working directory, not the app', flag: /app\.getAppPath/, run: () => checkFlavorSource(once(files.flavor, "join(app.getAppPath(), 'package.json')", "join(process.cwd(), 'package.json')")) },
    { name: 'debuggingAllowedHere ignores the flag', flag: /debuggingAllowedHere\(\) is not/, run: () => checkFlavorSource(once(files.flavor, 'return debuggingAllowed(buildFlavor(), app.isPackaged)', 'return !app.isPackaged')) },
    { name: 'the probe build loses its strip hook (afterPack line deleted)', flag: /afterPack must be/, run: () => checkProbeConfig(once(files.probe, /^afterPack: scripts\/probe-strip-url-schemes\.cjs\n/m, ''), files.release) },
    { name: 'the probe build tries protocols: [] instead (merged by union: beacon:// stays)', flag: /may not: protocols/, run: () => checkProbeConfig(files.probe + '\nprotocols: []\n', files.release) },
    { name: 'the strip hook stops refusing non-probe bundles (a release would lose its deep links)', flag: /does not refuse bundles/, run: () => checkStripHook(once(files.stripHook, 'if (id !== PROBE_ID) {', 'if (false) {')) },
    { name: 'the strip hook no longer fails when URL types remain', flag: /does not fail when URL types remain/, run: () => checkStripHook(once(files.stripHook, 'if (left !== undefined) throw', 'if (false) throw')) },
    { name: 'the scheme claim goes back to every packaged build (if (!isDev))', flag: /outside `if \(buildFlavor\(\) === 'release'\)`/, run: () => checkSchemeClaim(once(files.index, "if (buildFlavor() === 'release') app.setAsDefaultProtocolClient('beacon')", "if (!isDev) app.setAsDefaultProtocolClient('beacon')")) },
    { name: "the pop-out window drops its devTools line (Electron's default is DevTools on)", flag: /popout-window\.ts: new BrowserWindow/, run: () => checkDevTools(editSource(mainSources, 'src/main/popout-window.ts', /^ {6}devTools: debuggingAllowedHere\(\),\n/m, ''), files.index) },
    { name: 'the browser pane view hard-codes devTools: true', flag: /browser-pane\.ts: new WebContentsView/, run: () => checkDevTools(editSource(mainSources, 'src/main/browser-pane.ts', 'devTools: debuggingAllowedHere()', 'devTools: true'), files.index) },
    { name: 'a new window file with no webPreferences at all', flag: /devtools-new-window\.ts: new BrowserWindow/, run: () => checkDevTools([...mainSources, { path: 'src/main/devtools-new-window.ts', text: "import { BrowserWindow } from 'electron'\nexport const w = () => new BrowserWindow({ width: 400, height: 300 })\n" }], files.index) },
    { name: "the View menu goes back to role: 'viewMenu'", flag: /role: 'viewMenu'/, run: () => checkDevTools(mainSources, once(files.index, /\{\n {6}label: 'View',[\s\S]*?\n {4}\},\n/, "{ role: 'viewMenu' },\n")) },
    { name: 'Toggle Developer Tools offered unconditionally', flag: /without debuggingAllowedHere/, run: () => checkDevTools(mainSources, once(files.index, "...(debuggingAllowedHere() ? ([{ role: 'toggleDevTools' }] as Electron.MenuItemConstructorOptions[]) : []),", "{ role: 'toggleDevTools' },")) },
    { name: 'audit:bundle stops requiring OnlyLoadAppFromAsar', flag: /RELEASE_FUSES/, run: () => checkAuditAgrees(files.release, files.probe, { ...facts, RELEASE_FUSES: { ...facts.RELEASE_FUSES, OnlyLoadAppFromAsar: 'disabled' } }) },
    { name: 'the config turns a fuse off that audit:bundle still wants on', flag: /RELEASE_FUSES/, run: () => checkAuditAgrees(once(files.release, '  onlyLoadAppFromAsar: true', '  onlyLoadAppFromAsar: false'), files.probe, facts) }
  ]
  assert(gateBlock.includes('refusedSwitches('), 'the gate block was found in main (the gate mutations have something to move)', gateBlock.slice(0, 80))
  for (const m of mutations) {
    let v: string[]
    try {
      v = m.run()
    } catch (e) {
      assert(false, `mutation applies: ${m.name}`, String(e))
      continue
    }
    assert(v.some((x) => m.flag.test(x)), `flagged: ${m.name}`, v.length ? v.join(' | ') : 'NOT FLAGGED — the guard is blind to this')
  }

  // A false positive the DevTools scan once hit, kept as a fixture so the guard cannot turn noisy
  // without failing here: browser-invariant.ts quotes `new WebContentsView({ … })` in a message.
  // Standalone (not mixed with the real tree), so it reports on the false positive alone.
  const quoted = checkDevTools([
    { path: 'src/main/fixture-window.ts', text: 'export const w = () => new BrowserWindow({ webPreferences: { devTools: debuggingAllowedHere() } })\n' },
    { path: 'src/main/fixture-quoted.ts', text: "export const msg = (v: string[]) => v.push('no `new BrowserWindow({ … })` here')\n" }
  ], '')
  assert(quoted.length === 0, 'not flagged: a quoted `new BrowserWindow(` in a message is not a window (false-positive fixture)', quoted.join(' | '))

  // Counted, so a section that silently ran nothing cannot read as a pass.
  const EXPECTED = 7 + 7 + 1 + 5 + 1 + 9 + 1 + mutations.length + 1
  const ran = failures + passes
  console.log(failures === 0 && ran === EXPECTED ? `\n[smoke] release-gate: ALL PASS (${ran})` : `\n[smoke] release-gate: ${failures} FAIL, ${ran} of ${EXPECTED} checks ran`)
  process.exit(failures === 0 && ran === EXPECTED ? 0 : 1)
}

main().catch((e) => {
  console.log(`[smoke] FAIL  threw: ${e?.stack ?? e}`)
  process.exit(1)
})
