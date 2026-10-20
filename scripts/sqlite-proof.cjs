// Headless proof that better-sqlite3 loads under Electron's Node ABI — no X server needed.
// Run via:  ELECTRON_RUN_AS_NODE=1 electron scripts/sqlite-proof.cjs   (npm run sqlite:proof)
//
// ELECTRON_RUN_AS_NODE runs this in Electron's bundled Node runtime (same V8/ABI as the
// main process) without spawning Chromium, so a successful native-module load here proves
// better-sqlite3 was rebuilt against Electron's ABI — the Step-1 acceptance check.
const Database = require('better-sqlite3')

const runtime = process.versions.electron
  ? `Electron ${process.versions.electron}`
  : `node ${process.versions.node}`

const db = new Database(':memory:')
try {
  const { v } = db.prepare('select sqlite_version() as v').get()
  console.log(
    `[sqlite-proof] OK — better-sqlite3 loaded under ${runtime} (Node ABI modules=${process.versions.modules}); sqlite ${v}`
  )
  if (!process.versions.electron) {
    console.warn('[sqlite-proof] WARNING: ran under plain node, not Electron — set ELECTRON_RUN_AS_NODE=1 and use the electron binary to prove the Electron ABI.')
    process.exit(2)
  }
} finally {
  db.close()
}
