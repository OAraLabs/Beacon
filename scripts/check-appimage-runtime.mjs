#!/usr/bin/env node
// AppImage runtime audit: does the AppImage start on a stock Ubuntu 22.04+ without `apt install libfuse2`?
//
// WHY. An AppImage is a small ELF program (the runtime) followed by a squashfs image of the app. Until
// 0.3.0, electron-builder's default (legacy) runtime dlopen'd libfuse.so.2, which Ubuntu 22.04 and later
// no longer install, so `chmod +x` and run failed with "dlopen(): error loading libfuse.so.2".
// electron-builder.yml now sets `toolsets.appimage: 1.0.3`, the static type2 runtime with FUSE linked in.
// This reads the runtime out of a built AppImage and checks that it is that runtime.
//
// What must hold, all fail-closed:
//   1. the file is an ELF with the AppImage type-2 magic ("AI\x02" at byte 8);
//   2. the runtime ends where the ELF section headers say, and a squashfs ("hsqs") starts right there.
//      That proves the bytes being checked are the runtime and nothing else;
//   3. the runtime never names libfuse.so.2, and it identifies as github.com/AppImage/type2-runtime.
//
//   node scripts/check-appimage-runtime.mjs --self-test       # fixtures only
//   node scripts/check-appimage-runtime.mjs <file.AppImage>…  # self-test, then each AppImage
import { closeSync, fstatSync, openSync, readSync } from 'node:fs'

const LEGACY = 'libfuse.so.2'
const STATIC = 'github.com/AppImage/type2-runtime'

/** Problems with one AppImage, given a reader `read(offset, length) → Buffer` and its size. */
export function auditRuntime(read, size, where) {
  if (size < 64) return [`${where}: too small to be an AppImage (${size} bytes)`]
  const h = read(0, 64)
  if (h.toString('latin1', 0, 4) !== '\x7fELF') return [`${where}: not an ELF file`]
  if (h.toString('latin1', 8, 11) !== 'AI\x02') return [`${where}: no AppImage type-2 magic at byte 8`]
  const runtime = Number(h.readBigUInt64LE(0x28)) + h.readUInt16LE(0x3a) * h.readUInt16LE(0x3c)
  if (runtime <= 64 || runtime + 4 > size) return [`${where}: the ELF section headers put the runtime's end at ${runtime}, outside the file`]
  if (read(runtime, 4).toString('latin1') !== 'hsqs') return [`${where}: no squashfs where the runtime ends (${runtime}); cannot tell which bytes are the runtime`]
  const text = read(0, runtime).toString('latin1')
  const p = []
  if (text.includes(LEGACY)) p.push(`${where}: the runtime loads ${LEGACY}, so it will not start on Ubuntu 22.04+ without libfuse2 (set toolsets.appimage in electron-builder.yml)`)
  if (!text.includes(STATIC)) p.push(`${where}: the runtime is not ${STATIC} (the static runtime)`)
  return p
}

function auditFile(path) {
  const fd = openSync(path, 'r')
  try {
    const read = (off, len) => { const b = Buffer.alloc(len); readSync(fd, b, 0, len, off); return b }
    return auditRuntime(read, fstatSync(fd).size, path)
  } finally {
    closeSync(fd)
  }
}

/** A minimal AppImage: an ELF header whose section table ends at `runtimeLen`, runtime text, then squashfs. */
function fixture({ runtimeText, magic = 'AI\x02', squash = 'hsqs', runtimeLen = 4096 }) {
  const b = Buffer.alloc(runtimeLen + 64)
  b.write('\x7fELF', 0, 'latin1')
  b.write(magic, 8, 'latin1')
  b.writeBigUInt64LE(BigInt(runtimeLen - 64 * 2), 0x28) // e_shoff
  b.writeUInt16LE(64, 0x3a) // e_shentsize
  b.writeUInt16LE(2, 0x3c) // e_shnum → ends at runtimeLen
  b.write(runtimeText, 128, 'latin1')
  b.write(squash, runtimeLen, 'latin1')
  return { read: (off, len) => b.subarray(off, off + len), size: b.length }
}

function selfTest() {
  const run = (f) => auditRuntime(f.read, f.size, 'x')
  const cases = [
    ['the static runtime passes', fixture({ runtimeText: `squashfuse 0.5.2 https://${STATIC}/commit/dd6cebe` }), true],
    ['the legacy runtime fails', fixture({ runtimeText: `squashfuse 0.1.100 dlopen(): error loading ${LEGACY}` }), false],
    ['a runtime naming both fails', fixture({ runtimeText: `${STATIC} ${LEGACY}` }), false],
    ['an unidentified runtime fails', fixture({ runtimeText: 'squashfuse' }), false],
    ['no type-2 magic fails', fixture({ runtimeText: STATIC, magic: 'AI\x01' }), false],
    ['no squashfs at the boundary fails', fixture({ runtimeText: STATIC, squash: 'xxxx' }), false],
    ['libfuse.so.2 AFTER the runtime (in the app) is not the runtime', (() => {
      const f = fixture({ runtimeText: STATIC })
      const b = Buffer.concat([f.read(0, f.size), Buffer.from(` ${LEGACY}`)])
      return { read: (off, len) => b.subarray(off, off + len), size: b.length }
    })(), true]
  ]
  let bad = 0
  for (const [name, f, shouldPass] of cases) {
    const problems = run(f)
    if ((problems.length === 0) !== shouldPass) {
      bad++
      console.error(`  ✗ self-test: ${name} — got ${problems.length ? problems.join('; ') : 'PASS'}`)
    }
  }
  if (bad) {
    console.error(`✗ check-appimage-runtime — self-test: ${bad} of ${cases.length} fixtures got the wrong verdict; refusing to check anything`)
    process.exit(3)
  }
  console.log(`✓ check-appimage-runtime — self-test: ${cases.length} fixtures, each with the right verdict`)
}

const args = process.argv.slice(2)
selfTest()
const files = args.filter((a) => a !== '--self-test')
if (args.includes('--self-test') && files.length === 0) process.exit(0)
if (files.length === 0) {
  console.error('✗ check-appimage-runtime — no AppImage given (a glob that matched nothing?)')
  process.exit(2)
}
let failed = 0
for (const f of files) {
  let problems
  try { problems = auditFile(f) } catch (e) { problems = [`${f}: could not be read (${e.message})`] }
  if (problems.length) {
    failed++
    console.error(`✗ ${f}\n    ${problems.join('\n    ')}`)
  } else {
    console.log(`✓ ${f} — the static type2 runtime; no libfuse.so.2, so it starts on Ubuntu 22.04+ without libfuse2`)
  }
}
process.exit(failed ? 1 : 0)
