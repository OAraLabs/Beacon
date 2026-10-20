// out/main from any chunk: the pure half of `import.meta.mainOutDir` (electron.vite.config.ts).
//
// Main builds to out/main/index.js (the app entry), the smoke entries beside it, and shared chunks in
// out/main/chunks/. A module's `__dirname` is the directory of whichever FILE rollup put it in, and
// that is decided by what OTHER build inputs import, not by the module. On 2026-09-24 a smoke's import
// moved shell-windows.ts into a chunk. `join(__dirname, '../renderer/index.html')` then named
// out/main/renderer/, the sender check refused Beacon's own page, and the app sat on "Loading…" while
// typecheck and every smoke passed.
//
// So a path to Beacon's own build output starts from out/main, and each chunk is told at build time
// how to get there from its own directory. electron-vite resolves its `?asset` imports the same way,
// for the same reason. smoke:shell-url evaluates this for several layouts, and against the real build.
import { posix } from 'path'

/** The CommonJS expression that evaluates to out/main inside the chunk rollup names `chunkFileName`
 *  (relative to out/main, forward slashes: 'index.js', 'chunks/shell-windows-Ab12.js'). A name that
 *  climbs out of out/main is not a chunk rollup can emit; it throws, which fails the build. */
export function mainOutDirExpression(chunkFileName: string): string {
  if (posix.isAbsolute(chunkFileName) || chunkFileName.split('/').includes('..')) {
    throw new Error(`mainOutDirExpression: ${JSON.stringify(chunkFileName)} is not a file name inside out/main`)
  }
  const up = posix.relative(posix.dirname(chunkFileName), '.')
  return up === '' ? '__dirname' : `require("path").join(__dirname, ${JSON.stringify(up)})`
}
