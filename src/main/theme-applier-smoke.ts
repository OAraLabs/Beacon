/**
 * Headless smoke for @shared/theme-applier: the ORDER in which theme picks land.
 *
 * Picking SYSTEMA asks main whether the OS is dark (an IPC round trip); picking a plate does not.
 * So a SYSTEMA pick followed quickly by a plate pick finishes LAST, and whatever it does after its
 * await lands on top of the newer choice. These scenarios hold the isDark answer in a promise this
 * smoke resolves by hand, so the losing interleaving happens every run, not one run in a hundred.
 * Then proves the pickers read the plate back from the pick (the SYSTEMA preview was stale).
 *
 * WHAT THIS CANNOT PROVE: the real document and bridge. probe:system-theme drives the built app.
 *
 *   npm run build && npm run smoke:theme-applier
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { SYSTEM_CHOICE, type Theme, type ThemeChoice } from '@shared/theme'
import { createThemeApplier } from '@shared/theme-applier'

let failures = 0
let checks = 0
function assert(cond: boolean, what: string, detail = ''): void {
  checks++
  console.log(`[smoke] ${cond ? 'PASS' : 'FAIL'}  ${what}${detail && !cond ? `\n        ${detail}` : ''}`)
  if (!cond) failures++
}

/** A fake document + bridge. isDark() answers only when the test calls answer(). */
function rig(start: Theme = 'dark') {
  let worn: Theme = start
  const persisted: ThemeChoice[] = []
  const answers: Array<(dark: boolean) => void> = []
  const subs = new Set<(dark: boolean) => void>()
  const applier = createThemeApplier({
    wear: (t) => (worn = t),
    worn: () => worn,
    isDark: () => new Promise<boolean>((r) => answers.push(r)),
    onSystemChange: (cb) => {
      subs.add(cb)
      return () => subs.delete(cb)
    },
    persist: async (c) => {
      persisted.push(c)
    }
  })
  return {
    applier,
    worn: () => worn,
    persisted,
    subs,
    answer: (dark: boolean) => answers.shift()?.(dark),
    pending: () => answers.length,
    flip: (dark: boolean) => subs.forEach((cb) => cb(dark))
  }
}
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

async function main(): Promise<void> {
  console.log('[smoke] === one pick at a time (the baseline the race is measured against) ===')
  {
    const r = rig()
    const got = await r.applier.setThemeChoice('aervgo')
    assert(r.worn() === 'aervgo' && got === 'aervgo', `a plate pick wears that plate and resolves to it (worn ${r.worn()}, got ${got})`)
    assert(r.persisted.join() === 'aervgo' && !r.applier.following(), 'and persists it, following no OS flips')
    const sys = r.applier.setThemeChoice(SYSTEM_CHOICE)
    await tick()
    assert(r.pending() === 1, 'a SYSTEMA pick asks the OS (one isDark in flight)')
    r.answer(false)
    assert((await sys) === 'light' && r.worn() === 'light', `SYSTEMA under a light OS wears LVX (worn ${r.worn()})`)
    assert(r.persisted.at(-1) === SYSTEM_CHOICE && r.applier.following(), 'persists the sentinel and follows OS flips')
    r.flip(true)
    assert(r.worn() === 'dark', 'an OS flip re-skins while SYSTEMA is worn')
  }

  console.log('\n[smoke] === SYSTEMA, then a plate before the OS answers: the plate is the newer intent ===')
  {
    const r = rig('aervgo')
    const sys = r.applier.setThemeChoice(SYSTEM_CHOICE)
    await tick()
    assert(r.pending() === 1, 'SYSTEMA is waiting on the OS answer')
    const plate = await r.applier.setThemeChoice('aervgo')
    assert(plate === 'aervgo' && r.worn() === 'aervgo', 'the plate pick lands immediately')
    r.answer(false) // the OS answer for the OLDER pick arrives last
    const late = await sys
    assert(r.worn() === 'aervgo', `the late SYSTEMA answer does NOT re-skin over the newer pick (worn ${r.worn()})`)
    assert(r.persisted.at(-1) === 'aervgo', `and does NOT persist 'system' over it (persisted ${JSON.stringify(r.persisted)}) — the next launch would wear the wrong skin`)
    assert(r.applier.currentChoice() === 'aervgo', `the current choice stays the plate (got ${r.applier.currentChoice()})`)
    assert(!r.applier.following() && r.subs.size === 0, `and nothing is left following OS flips for a choice no longer worn (subs ${r.subs.size})`)
    assert(late === 'aervgo', `the superseded pick resolves to the plate actually worn, not its own resolution (got ${late}) — a picker reading it back shows the truth`)
    r.flip(true)
    assert(r.worn() === 'aervgo', 'an OS flip afterwards still leaves the plate alone')
  }

  console.log('\n[smoke] === a plate, then SYSTEMA: SYSTEMA is the newer intent and wins ===')
  {
    const r = rig('dark')
    void r.applier.setThemeChoice('aervgo')
    const sys = r.applier.setThemeChoice(SYSTEM_CHOICE)
    await tick()
    r.answer(true)
    assert((await sys) === 'dark' && r.worn() === 'dark', `SYSTEMA under a dark OS wears NOX (worn ${r.worn()})`)
    assert(r.persisted.at(-1) === SYSTEM_CHOICE && r.applier.following(), 'persists the sentinel and follows the OS')
  }

  console.log('\n[smoke] === two SYSTEMA picks in flight: one subscription, the newest answer ===')
  {
    const r = rig('aervgo')
    const a = r.applier.setThemeChoice(SYSTEM_CHOICE)
    const b = r.applier.setThemeChoice(SYSTEM_CHOICE)
    await tick()
    r.answer(true)
    r.answer(false)
    await Promise.all([a, b])
    assert(r.subs.size === 1, `exactly one OS-flip subscription (got ${r.subs.size})`)
    assert(r.worn() === 'light', `the worn plate is the NEWER pick's answer (worn ${r.worn()})`)
  }

  console.log('\n[smoke] === the pickers read the worn plate back from the pick ===')
  {
    // The SYSTEMA card previews `worn`. It was read on mount and on OS flips only, so right after
    // picking SYSTEMA it still showed the plate worn BEFORE the pick.
    for (const f of ['src/renderer/src/components/SkinTab.tsx', 'src/renderer/src/components/SkinPicker.tsx']) {
      const src = readFileSync(join(process.cwd(), f), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/[^\n]*/g, '')
      assert(/setThemeChoice\(c\)\.then\(setWorn\)/.test(src), `${f.split('/').pop()}: a pick sets the preview's plate from what setThemeChoice resolves to`)
    }
    const wiring = readFileSync(join(process.cwd(), 'src/renderer/src/theme/apply-theme.ts'), 'utf8')
    assert(/createThemeApplier\(/.test(wiring), 'apply-theme.ts wires the real document and bridge to this applier')
  }

  console.log(`\n[smoke] outcome: ${failures === 0 && checks >= 21 ? 'PASS ✓' : `FAIL ✗ (${failures} failed, ${checks} ran)`}`)
  process.exit(failures === 0 && checks >= 21 ? 0 : 1)
}

main().catch((e) => {
  console.log(`[smoke] FAIL  threw: ${e?.stack ?? e}`)
  process.exit(1)
})
