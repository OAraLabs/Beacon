import { basename, resolve, sep } from 'node:path'

// Pure path guards for Loop Manager project files — a fast CLIENT-side pre-check before the daemon
// round-trip. The daemon's /api/project-file is the AUTHORITY for the actual read/write (it lives on
// the host with the repos); these guards just give instant feedback on obvious mistakes. Two guards:
// (1) a basename allowlist (only the loop files), and (2) root confinement (the path must resolve
// inside a registered project root; no `..` escape).

/** The only files the board reads/writes inside a project. */
export const LOOP_FILES = ['TASKS.md', 'LOOP.md', 'PROGRESS.md'] as const

/** True if `target` is `root` or nested inside it, after resolving both to absolute normalized paths
 * (so `root/../etc/passwd` fails the check). Pure. */
export function isWithinRoot(root: string, target: string): boolean {
  const r = resolve(root)
  const t = resolve(target)
  return t === r || t.startsWith(r + sep)
}

/** A path is an allowed project file iff its basename is in LOOP_FILES AND it resolves under some
 * registered root. Pure — the fast pre-check before the daemon (the authority) re-validates. */
export function isAllowedProjectFile(roots: string[], path: string): boolean {
  if (!(LOOP_FILES as readonly string[]).includes(basename(path))) return false
  return roots.some((root) => isWithinRoot(root, path))
}
