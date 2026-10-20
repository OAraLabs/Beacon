// What this device calls itself when it asks to join: the name its owner gave the computer (macOS "Computer Name"), else the host
// name, else a plain word. Run through the daemon's own rules (@shared/join cleanDeviceName), so what is sent is never refused for
// its name.
import { execFile } from 'node:child_process'
import { hostname } from 'node:os'
import { cleanDeviceName } from '@shared/join'

const FALLBACK: Record<string, string> = { darwin: 'This Mac', win32: 'This PC', linux: 'This computer' }

async function computerName(platform: string): Promise<string | null> {
  if (platform !== 'darwin') return null
  return new Promise((resolve) => {
    execFile('/usr/sbin/scutil', ['--get', 'ComputerName'], { timeout: 1500 }, (err, out) => resolve(err ? null : String(out)))
  })
}

export async function defaultDeviceName(platform: string = process.platform, host: () => string = hostname): Promise<string> {
  const candidates = [await computerName(platform), host().replace(/\.local$/i, ''), FALLBACK[platform] ?? 'This device']
  for (const c of candidates) {
    const n = c === null ? null : cleanDeviceName(c)
    if (n) return n
  }
  return 'This device'
}
