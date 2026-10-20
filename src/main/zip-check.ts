// Read a zip's table of contents (its central directory) and refuse it BEFORE anything is extracted, when an entry could land
// outside the folder it is unpacked into: an absolute path, a ".." segment, a backslash or a drive letter, anything not under
// the one top folder Beacon expects, or a symbolic link whose target leaves that folder. ditto is the extractor, and it is not
// trusted to refuse these: what reaches it has already been read here, entry by entry.
//
// Only what the format needs is read: the end-of-central-directory record (and its zip64 form), every central-directory
// header, and the data of each symbolic link (its target, stored or deflated). Nothing is written.
import { open, type FileHandle } from 'node:fs/promises'
import { posix } from 'node:path'
import { inflateRawSync } from 'node:zlib'

const EOCD = 0x06054b50
const EOCD64 = 0x06064b50
const EOCD64_LOCATOR = 0x07064b50
const CENTRAL = 0x02014b50
const LOCAL = 0x04034b50
const MAX_COMMENT = 0xffff
const MAX_ENTRIES = 200_000
const MAX_CENTRAL_BYTES = 64 * 1024 * 1024
const MAX_LINK_BYTES = 4096
const S_IFMT = 0o170000
const S_IFLNK = 0o120000

export type ZipVerdict = { ok: true; entries: number; links: number } | { ok: false; why: string }

/** Why an entry's name is not one that stays under `top/`, or null when it is. */
export function unsafeEntryName(name: string, top: string): string | null {
  if (name.length === 0) return 'an entry with no name'
  if (name.includes('\0')) return `"${printable(name)}" has a NUL in its name`
  if (name.includes('\\')) return `"${printable(name)}" has a backslash in its name`
  if (name.startsWith('/')) return `"${printable(name)}" is an absolute path`
  if (/^[A-Za-z]:/.test(name)) return `"${printable(name)}" starts with a drive letter`
  if (name.split('/').some((seg) => seg === '..')) return `"${printable(name)}" climbs out with ".."`
  if (!(name === `${top}/` || name.startsWith(`${top}/`))) return `"${printable(name)}" is not inside ${top}`
  return null
}

/** Why a symbolic link at `name` pointing at `target` leaves `top/`, or null when it stays inside. */
export function unsafeLinkTarget(name: string, target: string, top: string): string | null {
  if (target.length === 0 || target.includes('\0')) return `the link "${printable(name)}" has no usable target`
  if (target.startsWith('/')) return `the link "${printable(name)}" points at an absolute path`
  const resolved = posix.normalize(posix.join(posix.dirname(name), target))
  if (resolved === '..' || resolved.startsWith('../') || !(resolved === top || resolved.startsWith(`${top}/`))) return `the link "${printable(name)}" points outside ${top} (${printable(target)})`
  return null
}

const printable = (s: string): string => s.replace(/[^\x20-\x7e]/g, '?').slice(0, 160)

/** Every entry of the zip at `path` stays inside `top/` (the app's folder), with no link leading out of it. */
export async function checkZipEntries(path: string, top: string): Promise<ZipVerdict> {
  let fh: FileHandle | null = null
  try {
    fh = await open(path, 'r')
    const size = (await fh.stat()).size
    const tailLen = Math.min(size, 22 + MAX_COMMENT + 20)
    const tail = await read(fh, size - tailLen, tailLen)
    let at = -1
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === EOCD) {
        at = i
        break
      }
    }
    if (at < 0) return { ok: false, why: 'it is not a zip (no end of central directory)' }
    let count = tail.readUInt16LE(at + 10)
    let cdSize = tail.readUInt32LE(at + 12)
    let cdOffset = tail.readUInt32LE(at + 16)
    if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
      // zip64: the locator sits just before the end record and says where the zip64 end record is.
      if (at < 20 || tail.readUInt32LE(at - 20) !== EOCD64_LOCATOR) return { ok: false, why: 'a zip64 archive without its locator' }
      const recOffset = Number(tail.readBigUInt64LE(at - 20 + 8))
      const rec = await read(fh, recOffset, 56)
      if (rec.readUInt32LE(0) !== EOCD64) return { ok: false, why: 'a zip64 archive whose end record is missing' }
      count = Number(rec.readBigUInt64LE(32))
      cdSize = Number(rec.readBigUInt64LE(40))
      cdOffset = Number(rec.readBigUInt64LE(48))
    }
    if (count > MAX_ENTRIES || cdSize > MAX_CENTRAL_BYTES || cdOffset + cdSize > size) return { ok: false, why: `a table of contents Beacon will not read (${count} entries, ${cdSize} bytes)` }
    const cd = await read(fh, cdOffset, cdSize)
    let p = 0
    let links = 0
    for (let n = 0; n < count; n++) {
      if (p + 46 > cd.length || cd.readUInt32LE(p) !== CENTRAL) return { ok: false, why: `entry ${n + 1} of ${count} is not where the table of contents says` }
      const flags = cd.readUInt16LE(p + 8)
      const method = cd.readUInt16LE(p + 10)
      const compressed = cd.readUInt32LE(p + 20)
      const nameLen = cd.readUInt16LE(p + 28)
      const extraLen = cd.readUInt16LE(p + 30)
      const commentLen = cd.readUInt16LE(p + 32)
      const madeBy = cd.readUInt16LE(p + 4) >> 8
      const external = cd.readUInt32LE(p + 38)
      const localOffset = cd.readUInt32LE(p + 42)
      const raw = cd.subarray(p + 46, p + 46 + nameLen)
      // UTF-8 when the flag says so; otherwise the bytes as they are, which is enough to see "/", "." and "\".
      const name = flags & 0x800 ? raw.toString('utf8') : raw.toString('latin1')
      const bad = unsafeEntryName(name, top)
      if (bad) return { ok: false, why: bad }
      // A symbolic link carries its target as its data. The unix mode is in the high half of the external attributes when the
      // entry was made on unix (3) or macOS (19).
      const mode = madeBy === 3 || madeBy === 19 ? external >>> 16 : 0
      if ((mode & S_IFMT) === S_IFLNK) {
        links++
        if (compressed > MAX_LINK_BYTES || localOffset === 0xffffffff) return { ok: false, why: `the link "${printable(name)}" is larger than a link` }
        const lh = await read(fh, localOffset, 30)
        if (lh.readUInt32LE(0) !== LOCAL) return { ok: false, why: `the link "${printable(name)}" has no local header` }
        const data = await read(fh, localOffset + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28), compressed)
        let target: string
        try {
          target = (method === 0 ? data : method === 8 ? inflateRawSync(data, { maxOutputLength: MAX_LINK_BYTES }) : Buffer.alloc(0)).toString('utf8')
        } catch {
          return { ok: false, why: `the link "${printable(name)}" cannot be read` }
        }
        const out = unsafeLinkTarget(name, target, top)
        if (out) return { ok: false, why: out }
      }
      p += 46 + nameLen + extraLen + commentLen
    }
    return { ok: true, entries: count, links }
  } catch (err) {
    return { ok: false, why: `it cannot be read as a zip (${(err as Error).message})` }
  } finally {
    await fh?.close().catch(() => undefined)
  }
}

async function read(fh: FileHandle, position: number, length: number): Promise<Buffer> {
  const buf = Buffer.alloc(length)
  const { bytesRead } = await fh.read(buf, 0, length, position)
  if (bytesRead !== length) throw new Error(`short read at ${position}`)
  return buf
}
