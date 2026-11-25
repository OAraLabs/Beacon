/**
 * theme-instance-smoke — the skin per Prometheus (@shared/theme-instance, src/main/instance-skin.ts), headless.
 *
 *   1. which skin a Prometheus opens on: its own, else the one showing, and what it stored is never replaced;
 *   2. the one-time seeding: an existing Beacon's skin becomes every Prometheus's own, once, and a Prometheus added later does not get it;
 *   3. the real DaemonFolders: a skin picked on one never reaches another, two may share one, and the skin follows the
 *      Prometheus's identity when its address changes;
 *   4. the applier wears a plate in the same call when the OS appearance is already known (no flash on a switch);
 *   5. wiring: main sends the new folder's skin with the switch, the window wears it before it remounts.
 *
 * Run: npm run build && npm run smoke:theme-instance
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { classifiedScope } from '@shared/daemon-profiles'
import { DEFAULT_THEME, SYSTEM_CHOICE, THEMES, THEME_KEY, effectiveTheme, type Theme, type ThemeChoice } from '@shared/theme'
import { createThemeApplier } from '@shared/theme-applier'
import { THEME_INSTANCE_KEY, THEME_SEEDED_KEY, isThemeChoice, parseFolderChange, seedPlan, skinForInstance } from '@shared/theme-instance'
import { DaemonFolders } from './cache/daemon-folders'
import { ensureInstanceSkin, seedInstanceSkins, type SkinStore } from './instance-skin'

const MIN_CHECKS = 60
let checks = 0
let failures = 0
function check(cond: boolean, name: string, detail = ''): void {
  checks++
  if (cond) console.log(`  ✓ ${name}`)
  else {
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`)
    failures++
  }
}
process.on('exit', () => {
  console.log('===================== RESULT =====================')
  if (failures === 0 && checks < MIN_CHECKS) {
    console.error(`theme-instance smoke: FAIL ✗ (only ${checks} of at least ${MIN_CHECKS} checks ran)`)
    process.exitCode = 1
  } else if (failures > 0) {
    console.error(`theme-instance smoke: FAIL ✗ (${failures} of ${checks})`)
    process.exitCode = 1
  } else console.log(`theme-instance smoke: PASS ✓ (${checks} checks: which skin, seeding, real folders, no flash, wiring)`)
})

console.log('1. which skin a Prometheus opens on')
check(isThemeChoice('light') && isThemeChoice('system') && THEMES.every((t) => isThemeChoice(t)), 'every plate and SYSTEMA is a skin')
check(!isThemeChoice('') && !isThemeChoice('purple') && !isThemeChoice(null) && !isThemeChoice(undefined) && !isThemeChoice(3) && !isThemeChoice({}) && !isThemeChoice('LIGHT'), 'anything else is not')
check(skinForInstance('avrvm', 'light').choice === 'avrvm' && !skinForInstance('avrvm', 'light').adopt, 'its own skin wins over the one showing, and is not adopted again')
check(skinForInstance('system', 'light').choice === 'system', 'SYSTEMA can be its own')
check(skinForInstance(null, 'light').choice === 'light' && skinForInstance(null, 'light').adopt, 'with none of its own it starts on the one showing, and adopts it')
check(skinForInstance(undefined, 'vmbra').choice === 'vmbra' && skinForInstance(undefined, 'vmbra').adopt, 'undefined is "none" too')
check(skinForInstance('garbage', 'aervgo').choice === 'aervgo' && skinForInstance('garbage', 'aervgo').adopt, 'a stored value Beacon does not know is "none", not NOX')
check(skinForInstance(null, null).choice === DEFAULT_THEME && skinForInstance(null, null).adopt, 'nothing showing yet: the default plate')
check(skinForInstance(7, system()).choice === 'system', 'SYSTEMA showing is adopted as SYSTEMA')
function system(): ThemeChoice {
  return SYSTEM_CHOICE
}
for (const t of THEMES) check(skinForInstance(t, 'dark').choice === t, `${t}: kept as chosen`)
const fc = parseFolderChange({ theme: 'light', dark: false })
check(fc.theme === 'light' && fc.dark === false, 'a folder change carries the skin and the OS appearance')
check(parseFolderChange(null).theme === null && parseFolderChange(null).dark === true, 'nothing sent: no skin, dark')
check(parseFolderChange({ theme: 5, dark: 'x' }).theme === null && parseFolderChange({ theme: 5, dark: 'x' }).dark === true, 'junk is read as no skin')
check(parseFolderChange({ dark: false }).theme === null, 'a Prometheus with no skin sends null')

console.log('2. the one-time seeding')
check(JSON.stringify(seedPlan(false, 'light', ['a', 'b'], () => false)) === '{"ids":["a","b"],"value":"light"}', 'first launch: every Prometheus gets the skin this Beacon wore')
check(seedPlan(false, 'light', ['a', 'b'], (id) => id === 'a').ids.join() === 'b', 'one that already has its own keeps it')
check(seedPlan(true, 'light', ['a', 'b'], () => false).ids.length === 0, 'once done, a Prometheus with none is left alone (it adopts what is showing)')
check(seedPlan(false, null, ['a'], () => false).value === DEFAULT_THEME, 'no skin ever chosen: NOX is written')
check(seedPlan(false, 'junk', ['a'], () => false).value === DEFAULT_THEME, 'a garbage legacy value seeds NOX')
check(seedPlan(false, 'light', [], () => false).ids.length === 0, 'no Prometheus: nothing to write')
class FakeStore implements SkinStore {
  readonly appRows = new Map<string, string>()
  readonly rows = new Map<string, Map<string, string>>()
  writes: string[] = []
  crashAfter = -1
  readonly app = {
    getSetting: (k: string): string | null => this.appRows.get(k) ?? null,
    setSetting: (k: string, v: string): void => void this.appRows.set(k, v)
  }
  getSettingFor(id: string, k: string): string | null {
    return this.rows.get(id)?.get(k) ?? null
  }
  setSettingFor(id: string, k: string, v: string): void {
    if (this.crashAfter >= 0 && this.writes.length >= this.crashAfter) throw new Error('crash')
    this.writes.push(`${id}=${v}`)
    if (!this.rows.has(id)) this.rows.set(id, new Map())
    this.rows.get(id)?.set(k, v)
  }
}
{
  const s = new FakeStore()
  s.appRows.set(THEME_KEY, 'avrvm')
  check(seedInstanceSkins(s, ['x', 'y', 'z']) === 3, 'three Prometheus seeded')
  check(['x', 'y', 'z'].every((id) => s.getSettingFor(id, THEME_INSTANCE_KEY) === 'avrvm'), 'each wears the skin this Beacon had: nothing changes on screen')
  check(s.appRows.get(THEME_SEEDED_KEY) === '1', 'and it is marked done')
  check(s.appRows.get(THEME_KEY) === 'avrvm', 'the skin last worn is untouched')
  s.setSettingFor('x', THEME_INSTANCE_KEY, 'light')
  s.appRows.set(THEME_KEY, 'light')
  check(seedInstanceSkins(s, ['x', 'y', 'z', 'new']) === 0 && s.getSettingFor('new', THEME_INSTANCE_KEY) === null, 'run again: nothing is written, and a Prometheus added later has none (it will adopt what is showing)')
  check(s.getSettingFor('y', THEME_INSTANCE_KEY) === 'avrvm', 'one Prometheus changing its skin did not change another\'s')
}
{
  const s = new FakeStore()
  s.appRows.set(THEME_KEY, 'vmbra')
  s.crashAfter = 1
  let threw = false
  try {
    seedInstanceSkins(s, ['x', 'y', 'z'])
  } catch {
    threw = true
  }
  check(threw && s.appRows.get(THEME_SEEDED_KEY) === undefined, 'a crash part-way leaves it not marked done')
  s.crashAfter = -1
  check(seedInstanceSkins(s, ['x', 'y', 'z']) === 2 && ['x', 'y', 'z'].every((id) => s.getSettingFor(id, THEME_INSTANCE_KEY) === 'vmbra'), 'and the next launch finishes it without redoing the first')
}
{
  const s = new FakeStore()
  s.rows.set('own', new Map([[THEME_INSTANCE_KEY, 'caervla']]))
  s.appRows.set(THEME_KEY, 'light')
  seedInstanceSkins(s, ['own', 'other'])
  check(s.getSettingFor('own', THEME_INSTANCE_KEY) === 'caervla' && s.getSettingFor('other', THEME_INSTANCE_KEY) === 'light', 'a skin a Prometheus already had is not overwritten by the seeding')
}

console.log('3. the real folders')
check(classifiedScope(THEME_INSTANCE_KEY) === 'prometheus', 'the per-Prometheus skin is kept in that Prometheus\'s folder')
check(classifiedScope(THEME_KEY) === 'beacon' && classifiedScope(THEME_SEEDED_KEY) === 'beacon', 'the skin last worn and the seeding marker are this Beacon\'s')
const root = mkdtempSync(join(tmpdir(), 'beacon-theme-instance-'))
try {
  const folders = new DaemonFolders(root)
  const A = { apiBase: 'http://127.0.0.1:18201', fp: 'a'.repeat(16) }
  const B = { apiBase: 'http://127.0.0.1:18202', fp: 'b'.repeat(16) }
  const C = { apiBase: 'http://127.0.0.1:18203', fp: 'c'.repeat(16) }
  const a = folders.open(A).id
  folders.saveInstance({ name: 'A', apiBase: A.apiBase, wsUrl: 'ws://127.0.0.1:18201' }, a)
  const b = folders.open(B).id
  folders.saveInstance({ name: 'B', apiBase: B.apiBase, wsUrl: 'ws://127.0.0.1:18202' }, b)
  const c = folders.open(C).id
  folders.saveInstance({ name: 'C', apiBase: C.apiBase, wsUrl: 'ws://127.0.0.1:18203' }, c)
  folders.app.setSetting(THEME_KEY, 'light')
  check(new Set([a, b, c]).size === 3, 'three Prometheus, three folders')
  check(seedInstanceSkins(folders, folders.listInstances().map((i) => i.id)) === 3, 'seeded: all three')
  for (const id of [a, b, c]) check(folders.getSettingFor(id, THEME_INSTANCE_KEY) === 'light', `${id}: starts on the skin this Beacon had`)
  folders.open(A)
  folders.setSetting(THEME_INSTANCE_KEY, 'avrvm') // a pick while on A (the routed write the window makes)
  check(folders.getSetting(THEME_INSTANCE_KEY) === 'avrvm', 'on A: A\'s skin is what was picked')
  folders.open(B)
  check(folders.getSetting(THEME_INSTANCE_KEY) === 'light', 'switch to B: B\'s own skin, not A\'s')
  folders.setSetting(THEME_INSTANCE_KEY, 'avrvm')
  folders.open(C)
  folders.setSetting(THEME_INSTANCE_KEY, 'system')
  folders.open(A)
  check(folders.getSetting(THEME_INSTANCE_KEY) === 'avrvm', 'back on A: the skin last chosen there')
  folders.open(B)
  check(folders.getSetting(THEME_INSTANCE_KEY) === 'avrvm', 'two Prometheus may share a skin')
  folders.open(C)
  check(folders.getSetting(THEME_INSTANCE_KEY) === 'system', 'and one can follow the OS')
  check(folders.getSettingFor(a, THEME_INSTANCE_KEY) === 'avrvm' && folders.getSettingFor(c, THEME_INSTANCE_KEY) === 'system', 'read by folder id, while another is open')
  // A new Prometheus: its folder has no skin of its own.
  const D = { apiBase: 'http://127.0.0.1:18204', fp: 'd'.repeat(16) }
  const d = folders.open(D).id
  check(folders.getSetting(THEME_INSTANCE_KEY) === null, 'a Prometheus added later has none: the window adopts what is showing')
  // Same Prometheus, new address: the folder (and its skin) are the one bound to its fingerprint.
  const A2 = { apiBase: 'http://127.0.0.1:19999', fp: A.fp }
  check(folders.open(A2).id === a, 'the same Prometheus at another address is the same folder')
  check(folders.getSetting(THEME_INSTANCE_KEY) === 'avrvm', 'and keeps its skin: keyed by who it is, not where')
  // Another Prometheus at A's old address is a different folder with its own skin.
  const X = { apiBase: A.apiBase, fp: 'e'.repeat(16) }
  const x = folders.open(X).id
  check(x !== a && folders.getSetting(THEME_INSTANCE_KEY) === null, 'a different Prometheus answering at A\'s old address does not inherit A\'s skin')
  check(d !== x, 'folders stay apart')
  // The skin last worn is Beacon-wide: unaffected by which folder is open.
  folders.open(A)
  check(folders.getSetting(THEME_KEY) === 'light', 'the skin last worn does not follow the folder')
  folders.app.setSetting(THEME_KEY, 'aether')
  folders.open(B)
  check(folders.getSetting(THEME_KEY) === 'aether', '…it is one value, whichever is open')
} finally {
  rmSync(root, { recursive: true, force: true })
}

console.log('3b. settled in main')
{
  const w: string[] = []
  check(ensureInstanceSkin('avrvm', 'light', (v) => void w.push(v)) === 'avrvm' && w.length === 0, 'a Prometheus with its own skin keeps it, and nothing is written')
  check(ensureInstanceSkin(null, 'vmbra', (v) => void w.push(v)) === 'vmbra' && w.join() === 'vmbra', 'a new one starts on the skin last worn, and keeps it as its own')
  check(ensureInstanceSkin('garbage', 'light', (v) => void w.push(v)) === 'light' && w[w.length - 1] === 'light', 'a stored value Beacon does not know is replaced by it')
  check(ensureInstanceSkin(null, null, (v) => void w.push(v)) === DEFAULT_THEME, 'nothing ever worn: the default plate')
  check(ensureInstanceSkin(null, 'system', (v) => void w.push(v)) === 'system' && w[w.length - 1] === 'system', 'SYSTEMA is carried as SYSTEMA')
}

console.log('4. no flash')
function applier(): { worn: Theme[]; asks: number; a: ReturnType<typeof createThemeApplier> } {
  const w: Theme[] = []
  const state = { asks: 0 }
  const a = createThemeApplier({
    wear: (t) => void w.push(t),
    worn: () => w[w.length - 1] ?? 'dark',
    isDark: async () => {
      state.asks++
      return true
    },
    onSystemChange: () => () => undefined,
    persist: async () => undefined
  })
  return { worn: w, get asks() { return state.asks }, a }
}
{
  const t = applier()
  void t.a.applyChoice('avrvm')
  check(t.worn.join() === 'avrvm', 'a plate is worn before applyChoice returns (no await in the way)')
  void t.a.applyChoice(SYSTEM_CHOICE, false)
  check(t.worn.join() === 'avrvm,' + effectiveTheme(SYSTEM_CHOICE, false) && t.asks === 0, 'SYSTEMA with the OS appearance given is worn at once, with no question to main')
  void t.a.applyChoice(SYSTEM_CHOICE, true)
  check(t.worn[t.worn.length - 1] === effectiveTheme(SYSTEM_CHOICE, true) && t.asks === 0, 'light or dark as given')
  void t.a.applyChoice(SYSTEM_CHOICE)
  check(t.worn.length === 3, 'with no appearance given it still has to ask (nothing worn until the answer)')
}

console.log('5. wiring')
const src = (rel: string): string => readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8')
const main = src('src/main/index.ts')
const apply = src('src/renderer/src/theme/apply-theme.ts')
const app = src('src/renderer/src/App.tsx')
const preload = src('src/preload/index.ts')
check(/seedInstanceSkins\(folders, folders\.listInstances\(\)\.map/.test(main), 'and seeds each Prometheus once at launch')
check(/onFolderChanged\(\(change\) => \{\s*wearInstanceTheme\(change\)[^\n]*\n\s*onChanged\(\)/.test(app), 'the window wears it, then remounts, in the one handler')
check(/parseFolderChange\(change\)/.test(preload), 'the bridge hands over a checked value')
check(/applier\.applyChoice\(choice, change\.dark\)/.test(apply), 'worn without waiting on the OS')
check(/settings\.set\(THEME_INSTANCE_KEY, choice\)/.test(apply) && /settings\.set\(THEME_KEY, choice\)/.test(apply), 'a pick is kept for this Prometheus and as the skin last worn')
check(!/settings\.set\(THEME_INSTANCE_KEY[^)]*\)[\s\S]{0,40}adopt/.test(apply) && (apply.match(/settings\.set\(THEME_INSTANCE_KEY/g) ?? []).length === 1, 'the window writes a Prometheus\'s skin only when a pick is made (persist), never to adopt one: a late write cannot land in another folder')
check(/ensureInstanceSkin\(folder\.repo\.getSetting\(THEME_INSTANCE_KEY\), folders!?\.app\.getSetting\(THEME_KEY\), \(v\) => folder\.repo\.setSetting\(THEME_INSTANCE_KEY, v\)\)/.test(main), 'main settles a new Prometheus\'s skin in its own folder when it opens (launch and switch alike)')
check(/theme: skin, dark: nativeTheme/.test(main), 'and sends that skin with the switch')
