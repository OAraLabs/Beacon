#!/usr/bin/env node
// Design-token lint (Makeover Slice 2): no hardcoded colors outside theme/tokens.css.
// Scans the renderer for hex literals and rgb()/rgba() calls — every color must be a token
// (var(--…)) so the app stays one coherent palette. Run: npm run lint:tokens
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = join(process.cwd(), 'src', 'renderer', 'src')
const ALLOW = new Set(['theme/tokens.css']) // the single source of color truth
const COLOR = /#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)/g

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) yield* walk(p)
    else if (/\.(tsx?|css)$/.test(name)) yield p
  }
}

const offenders = []
for (const file of walk(ROOT)) {
  const rel = relative(ROOT, file).replace(/\\/g, '/')
  if (ALLOW.has(rel)) continue
  const lines = readFileSync(file, 'utf8').split('\n')
  lines.forEach((line, i) => {
    for (const m of line.matchAll(COLOR)) {
      offenders.push(`${rel}:${i + 1}  ${m[0]}`)
    }
  })
}

if (offenders.length > 0) {
  console.error(`✗ hardcoded colors found (use tokens from theme/tokens.css):\n  ${offenders.join('\n  ')}`)
  process.exit(1)
}
console.log('✓ lint:tokens — no hardcoded colors outside theme/tokens.css')
