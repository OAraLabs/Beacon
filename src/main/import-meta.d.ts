// Resolved at build time by the mainOutDir plugin in electron.vite.config.ts (main build only).
interface ImportMeta {
  /** out/main, from whichever chunk this module lands in. Use it, never `__dirname`, for a path to
   *  Beacon's own build output. src/shared/main-out-dir.ts says why. */
  readonly mainOutDir: string
}
