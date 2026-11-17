// How a project's instructions and reference files are told to the person (src/renderer/src/components/ProjectSettings.tsx), kept here so a
// smoke can pin the words. No Node/Electron imports.

import type { InstructionsFile, ProjectFile } from './chat-projects-content'

/** 1.2 MB, 340 KB, 18 bytes: the size of a file, in the units a person reads. */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return ''
  if (n < 1000) return `${n} byte${n === 1 ? '' : 's'}`
  if (n < 1_000_000) return `${n < 10_000 ? Math.round(n / 100) / 10 : Math.round(n / 1000)} KB`
  return `${Math.round(n / 100_000) / 10} MB`
}

/** The line under a file's name: its size, its kind, and when it was added or changed. */
export function describeFile(f: ProjectFile, now: number = Date.now()): string {
  const parts = [formatBytes(f.size)]
  if (f.mime && f.mime !== 'application/octet-stream') parts.push(f.mime)
  if (f.modified > 0) {
    const days = Math.floor((now - f.modified) / 86_400_000)
    parts.push(days <= 0 ? 'today' : days === 1 ? 'yesterday' : new Date(f.modified).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }))
  }
  return parts.filter(Boolean).join(' · ')
}

/** What the loader does with one instructions file in the folder, when it is not simply read. Empty when it is. */
export function effectiveNote(f: InstructionsFile): string {
  if (f.shadowedBy) return `(not read: ${f.shadowedBy} is read instead)`
  if (f.omitted) return '(not read for a conversation here: the instructions together are too long)'
  if (f.truncated) return '(only the start is read: it is longer than one file may be)'
  if (f.symlink) return '(a link to another file)'
  return ''
}
