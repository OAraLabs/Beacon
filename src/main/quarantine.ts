// A file that came from another computer (a reference file saved from a Prometheus) is marked the way a browser marks a download, so macOS
// asks before it opens an app, a script or an installer that was saved this way. Nothing else changes about the file.

import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'

/**
 * Mark `path` as downloaded: `com.apple.quarantine`, flags 0081 (the same "downloaded, not yet opened" a browser sets), the time, the
 * agent that saved it, and an id. A no-op where there is no such flag (not macOS). A file system that cannot hold the flag (a share, a
 * FAT disk) refuses it, and macOS does not quarantine there either: that is not a failure of the save, so it is not thrown.
 */
export function markDownloaded(path: string, platform: string = process.platform, nowMs: number = Date.now()): Promise<boolean> {
  if (platform !== 'darwin') return Promise.resolve(false)
  const value = `0081;${Math.floor(nowMs / 1000).toString(16)};Beacon;${randomUUID().toUpperCase()}`
  return new Promise((resolve) => {
    execFile('/usr/bin/xattr', ['-w', 'com.apple.quarantine', value, '--', path], { timeout: 10_000 }, (err) => resolve(!err))
  })
}
