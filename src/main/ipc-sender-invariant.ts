// The IPC sender invariant, as a SOURCE checker (pure: no fs, no Electron; the smoke feeds it files).
//
// THE INVARIANT: every IPC handler in main answers only the shell page in the top frame of a window
// Beacon created (isShellSender, src/main/shell-windows.ts), and decides that BEFORE it does anything
// else. A refused invoke gets an empty value, a refused send is dropped. The one exception is a
// channel on OPEN_CHANNELS below, each with its reason.
//
// Until 2026-09-24 only the terminal's handlers checked. The rest (daemon writes carrying the bearer
// token, settings, setup and pairing, the gateway address, ~/Downloads writes, chat, approvals, the
// updater token) answered any sender, and the navigation guard was the only thing between them and a
// foreign document at the top of a Beacon window (scripts/window-guard-probe.mjs).
//
// A registration passes in one of two ways:
//
//   helper  handleFromShell(channel, fn) / onFromShell(channel, fn). The check is inside the helper,
//           in front of fn, so fn cannot run first. The helpers themselves are raw registrations in
//           shell-windows.ts and are held to the raw rule, plus a pin on their exact shape (S3).
//   raw     ipcMain.handle / .on / .once / …, or webContents.ipc.*. The handler must be an inline
//           function whose FIRST call is a sender check on its own event parameter, used so that a
//           refused sender stops right there:
//             { if (!CHECK(e) [|| more]) return [empty] … }      the first statement
//             { const w = CHECK(e); if (!w) return [empty] … }   the first two statements
//             CHECK(e) ? value : empty                           the whole expression body
//             CHECK(e) && value                                  the whole expression body
//           "empty" means the returned expression makes no call: null, false, [], a literal object.
//           CHECK is isShellSender, or a DELEGATE: a function declared in, or imported into, the
//           same file whose own first act is one of the forms above on isShellSender (the
//           terminal's isBeaconWindowFrame, the browser pane's paneHost).
//
// Violations, by rule:
//   S1  a registration that does not reach a sender check before anything else runs
//   S2  ipcMain used any other way (an alias, bracket access, removeHandler…): a path S1 cannot see
//   S3  the helpers are missing, duplicated, defined outside shell-windows.ts, or changed shape
//   S4  an OPEN_CHANNELS entry that is stale (no such raw registration, or it is guarded anyway)
//   S5  a raw 'ipc-message' listener on a webContents, which bypasses ipcMain entirely
//
// ipc-sender-smoke.ts runs this over the real tree (clean, with exact counts) AND over mutations of
// it that each remove or weaken one check (each must be flagged). Its predicates are tested against
// embedded fixtures first.

export interface SourceFile {
  /** repo-relative posix path, e.g. src/main/ipc.ts */
  path: string
  text: string
}

/** Channels that deliberately answer ANY sender. Key: the channel expression exactly as the
 *  registration writes it (e.g. 'IPC.SYSTEM_THEME_GET'); value: why it must stay open.
 *
 *  Empty on purpose. Every channel main registers is called only by the shell page, and every window
 *  that shows it (main, quick-capture, the HUD, the terminal and browser pop-outs) passes
 *  isShellSender. The bar for an entry: a caller that CANNOT be the shell page, and a reason in this
 *  file saying who it is and why answering everyone is safe. "It only reads" is not a reason: a read
 *  from a foreign page is a disclosure. */
export const OPEN_CHANNELS: Readonly<Record<string, string>> = {}

export interface Registration {
  file: string
  line: number
  /** helper: handleFromShell/onFromShell. raw: ipcMain.* or webContents.ipc.* */
  via: 'helper' | 'raw'
  /** The call as written: handleFromShell, ipcMain.on, ipc.handle, … */
  api: string
  channel: string
  /** The check that guards it: 'helper', the CHECK name for a raw one, 'open' when allowlisted, or
   *  null when it has none. */
  guard: string | null
}

export interface Report {
  registrations: Registration[]
  violations: string[]
  /** Delegate checks found, as 'file: name'. */
  delegates: string[]
}

// ── the lexer: two views of a file, the same length as the source ────────────────────────────────
// `code`: comments blanked. `masked`: comments AND the insides of strings, template text and regex
// literals blanked. Offsets line up across all three, so a match in `masked` (where a ')' or a
// 'ipcMain.handle(' inside a string cannot fool the parser) reads its text from `code`.
const REGEX_AFTER_WORD = new Set(['return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'void', 'yield', 'await', 'delete', 'instanceof', 'new', 'throw'])

export function lex(src: string): { code: string; masked: string } {
  const code = src.split('')
  const masked = src.split('')
  const blank = (arr: string[], i: number): void => { if (arr[i] !== '\n') arr[i] = ' ' }
  const braceStack: number[] = [] // one entry per open `${`: the `{` depth inside it
  let i = 0
  let lastSig = '' // last significant code character, for the regex-or-division decision
  let lastWord = ''
  const n = src.length
  type Mode = 'code' | 'template'
  let mode: Mode = 'code'
  while (i < n) {
    const c = src[i]
    const d = src[i + 1]
    if (mode === 'template') {
      if (c === '\\') { blank(masked, i); blank(masked, i + 1); i += 2; continue }
      if (c === '`') { mode = 'code'; lastSig = '`'; lastWord = ''; i++; continue }
      if (c === '$' && d === '{') { braceStack.push(0); mode = 'code'; lastSig = '{'; lastWord = ''; i += 2; continue }
      blank(masked, i); i++; continue
    }
    // code
    if (c === '/' && d === '/') {
      while (i < n && src[i] !== '\n') { blank(code, i); blank(masked, i); i++ }
      continue
    }
    if (c === '/' && d === '*') {
      const end = src.indexOf('*/', i + 2)
      const stop = end === -1 ? n : end + 2
      for (; i < stop; i++) { blank(code, i); blank(masked, i) }
      continue
    }
    if (c === "'" || c === '"') {
      i++
      while (i < n && src[i] !== c && src[i] !== '\n') {
        if (src[i] === '\\') { blank(masked, i); i++ }
        blank(masked, i); i++
      }
      i++; lastSig = c; lastWord = ''; continue
    }
    if (c === '`') { mode = 'template'; i++; continue }
    if (c === '/') {
      const regexAllowed = lastSig === '' || '(,=:[!&|?{};+-*%<>~^'.includes(lastSig) || REGEX_AFTER_WORD.has(lastWord)
      if (regexAllowed) {
        i++
        let inClass = false
        while (i < n && src[i] !== '\n') {
          if (src[i] === '\\') { blank(masked, i); blank(masked, i + 1); i += 2; continue }
          if (src[i] === '[') inClass = true
          else if (src[i] === ']') inClass = false
          else if (src[i] === '/' && !inClass) break
          blank(masked, i); i++
        }
        i++ // closing slash
        while (i < n && /[a-z]/.test(src[i])) i++ // flags
        lastSig = '/'; lastWord = ''; continue
      }
    }
    if (c === '{' && braceStack.length) braceStack[braceStack.length - 1]++
    if (c === '}' && braceStack.length) {
      if (braceStack[braceStack.length - 1] === 0) { braceStack.pop(); mode = 'template'; i++; continue }
      braceStack[braceStack.length - 1]--
    }
    if (/[A-Za-z_$]/.test(c)) {
      let j = i
      while (j < n && /[\w$]/.test(src[j])) j++
      lastWord = src.slice(i, j); lastSig = 'a'; i = j; continue
    }
    if (!/\s/.test(c)) { lastSig = c; lastWord = '' }
    i++
  }
  return { code: code.join(''), masked: masked.join('') }
}

// ── small parsing helpers, all on `masked` ───────────────────────────────────────────────────────
const OPEN: Record<string, string> = { '(': ')', '[': ']', '{': '}' }
/** Index of the bracket that closes the one at `at`, or -1. */
function matching(s: string, at: number): number {
  const stack: string[] = []
  for (let i = at; i < s.length; i++) {
    const c = s[i]
    if (c in OPEN) stack.push(OPEN[c])
    else if (c === ')' || c === ']' || c === '}') {
      if (stack.pop() !== c) return -1
      if (stack.length === 0) return i
    }
  }
  return -1
}
/** Top-level [start, end) ranges of a comma-separated list between `from` and `to`. */
function splitTop(s: string, from: number, to: number): Array<[number, number]> {
  const out: Array<[number, number]> = []
  let depth = 0
  let start = from
  for (let i = from; i < to; i++) {
    const c = s[i]
    if (c in OPEN) depth++
    else if (c === ')' || c === ']' || c === '}') depth--
    else if (c === ',' && depth === 0) { out.push([start, i]); start = i + 1 }
  }
  if (s.slice(start, to).trim()) out.push([start, to])
  return out
}
/** Does `s` contain, at bracket depth 0, a `&&`, `||`, `??`, a ternary `?`, or a comma? */
function topLevelOps(s: string): { and: boolean; or: boolean; nullish: boolean; ternary: boolean; comma: boolean } {
  const r = { and: false, or: false, nullish: false, ternary: false, comma: false }
  let depth = 0
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (c in OPEN) depth++
    else if (c === ')' || c === ']' || c === '}') depth--
    if (depth !== 0) continue
    if (c === '&' && s[i + 1] === '&') { r.and = true; i++ }
    else if (c === '|' && s[i + 1] === '|') { r.or = true; i++ }
    else if (c === '?' && s[i + 1] === '?') { r.nullish = true; i++ }
    else if (c === '?' && s[i + 1] !== '.') r.ternary = true
    else if (c === ',') r.comma = true
  }
  return r
}
const KEYWORDS = new Set(['if', 'return', 'await', 'typeof', 'void', 'async', 'while', 'for', 'switch', 'catch', 'function', 'new', 'throw', 'else', 'do', 'in', 'of', 'instanceof', 'const', 'let', 'var'])
/** The first call in `s` (an identifier followed by '('), skipping keywords. */
function firstCall(s: string): { name: string; at: number; open: number } | null {
  const re = /([A-Za-z_$][\w$]*)\s*\(/g
  for (let m = re.exec(s); m; m = re.exec(s)) {
    if (KEYWORDS.has(m[1])) continue
    return { name: m[1], at: m.index, open: m.index + m[0].length - 1 }
  }
  return null
}
/** Is the statement that starts at `s` (just after `return`) an empty value: nothing, or an
 *  expression that makes no call? */
function returnsEmpty(s: string): boolean {
  const t = s.replace(/^[ \t]*/, '')
  if (t === '' || /^[\n;}]/.test(t)) return true
  let end: number
  if (t[0] === '{' || t[0] === '[' || t[0] === '(') {
    end = matching(t, 0)
    if (end === -1) return false
    end++
  } else {
    const m = /[\n;}]/.exec(t)
    end = m ? m.index : t.length
  }
  return !/[\w$\])]\s*\(/.test(t.slice(0, end))
}

/** The handler function at `masked[from, to)`: its first parameter's name and its body. */
function parseFunction(masked: string, from: number, to: number): { param: string | null; body: string; expression: boolean } | null {
  const h = masked.slice(from, to)
  let i = h.search(/\S/)
  if (i === -1) return null
  const asyncM = /^async\b\s*/.exec(h.slice(i))
  if (asyncM) i += asyncM[0].length
  let params: string
  let after: number
  const fnM = /^function\b\s*[\w$]*\s*/.exec(h.slice(i))
  if (fnM) {
    i += fnM[0].length
    if (h[i] !== '(') return null
    const close = matching(h, i)
    if (close === -1) return null
    params = h.slice(i + 1, close)
    const brace = h.indexOf('{', close)
    if (brace === -1) return null
    return { param: firstParam(params), body: h.slice(brace), expression: false }
  }
  if (h[i] === '(') {
    const close = matching(h, i)
    if (close === -1) return null
    params = h.slice(i + 1, close)
    after = close + 1
  } else {
    const idM = /^[A-Za-z_$][\w$]*/.exec(h.slice(i))
    if (!idM) return null
    params = idM[0]
    after = i + idM[0].length
  }
  const arrow = h.indexOf('=>', after)
  if (arrow === -1 || !/^\s*(:[^=]*)?$/.test(h.slice(after, arrow))) return null
  const body = h.slice(arrow + 2)
  return { param: firstParam(params), body, expression: !/^\s*\{/.test(body) }
}
function firstParam(params: string): string | null {
  const p = params.split(',')[0].trim().split(':')[0].trim()
  return /^[A-Za-z_$][\w$]*$/.test(p) ? p : null
}

/** Why a function body does not stop a refused sender first, or null when it does. `checks` are the
 *  names that count as a sender check; `param` is the event parameter the check must be given. */
export function gateRefusal(body: string, expression: boolean, param: string | null, checks: ReadonlySet<string>): string | null {
  if (!param) return 'the handler takes no event parameter, so it cannot check its sender'
  const call = firstCall(body)
  if (!call) return 'no call at all, so no sender check'
  if (call.name === 'isShellSender' && !checks.has(call.name)) return 'this isShellSender is not the one shell-windows.ts declares'
  if (!checks.has(call.name)) return `the first call is ${call.name}(…), not a sender check`
  const close = matching(body, call.open)
  if (close === -1) return 'unbalanced call'
  if (body.slice(call.open + 1, close).trim() !== param) return `${call.name}(…) is not given the handler's own event (${param})`
  const pre = body.slice(0, call.at)
  const post = body.slice(close + 1)
  if (expression) {
    // The whole expression body must be the check gating a value: CHECK(e) ? v : empty, or CHECK(e) && v.
    if (!/^\s*\(*\s*$/.test(pre)) return 'the check is not the whole expression body'
    const q = /^\s*\?(?![.?])/.exec(post)
    if (q) {
      // Find the ':' that belongs to THIS '?', skipping nested ternaries and brackets.
      const rest = post.slice(q[0].length)
      let depth = 0
      let nest = 0
      for (let i = 0; i < rest.length; i++) {
        const c = rest[i]
        if (c in OPEN) depth++
        else if (c === ')' || c === ']' || c === '}') depth--
        if (depth !== 0) continue
        if (c === '?' && rest[i + 1] !== '.' && rest[i + 1] !== '?' && rest[i - 1] !== '?') nest++
        else if (c === ':') {
          if (nest === 0) {
            const orElse = rest.slice(i + 1)
            return /^\s*(null|undefined|false|\[\]|\{\s*\}|''|""|``)\s*\)*\s*$/.test(orElse)
              ? null
              : "the refused branch of CHECK(e) ? … : … is not an empty value"
          }
          nest--
        }
      }
      return 'a ternary with no else branch'
    }
    const a = /^\s*&&/.exec(post)
    if (a) {
      const ops = topLevelOps(post.slice(a[0].length).replace(/\)\s*$/, ''))
      return ops.or || ops.nullish || ops.ternary || ops.comma ? 'CHECK(e) && … is followed by an operator that runs when it is false' : null
    }
    return 'the check result does not gate the value'
  }
  // A block body: the check is the first statement.
  const ifM = /^\s*\{\s*if\s*\(\s*!\s*$/.exec(pre)
  if (ifM) {
    const ifOpen = pre.lastIndexOf('(')
    const ifClose = matching(body, ifOpen)
    if (ifClose === -1) return 'unbalanced if'
    const cond = body.slice(close + 1, ifClose)
    const ops = topLevelOps(cond)
    if (ops.and || ops.nullish || ops.ternary || ops.comma) return 'the if joins the check with an operator that lets a refused sender through'
    const then = /^\s*(\{\s*)?return\b/.exec(body.slice(ifClose + 1))
    if (!then) return 'if (!CHECK(e)) does not return'
    return returnsEmpty(body.slice(ifClose + 1 + then[0].length)) ? null : 'the refusal returns something that makes a call'
  }
  const constM = /^\s*\{\s*(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*$/.exec(pre)
  if (constM) {
    const v = constM[1]
    const next = new RegExp(`^\\s*;?\\s*if\\s*\\(\\s*!\\s*${v.replace(/\$/g, '\\$')}\\s*\\)\\s*(\\{\\s*)?return\\b`).exec(post)
    if (!next) return `${v} = ${call.name}(…) is not followed by if (!${v}) return`
    return returnsEmpty(post.slice(next[0].length)) ? null : 'the refusal returns something that makes a call'
  }
  const retM = /^\s*\{\s*return\s+$/.exec(pre)
  if (retM) {
    // `return CHECK(e)`: a delegate that hands back the answer itself. Only valid for delegates.
    return /^\s*;?\s*\}\s*$/.test(post) ? null : 'return CHECK(e) with more after it'
  }
  return 'the check is not the first statement, or its result does not stop the handler'
}

const RAW_RE = /\b(ipcMain|ipc)\s*\.\s*(handle|handleOnce|on|once|addListener|prependListener|prependOnceListener)\s*\(/g
const HELPER_RE = /\b(handleFromShell|onFromShell)\s*\(/g
const HELPERS = ['handleFromShell', 'onFromShell'] as const
/** The exact bodies of the two helpers (on `code`: indentation dropped, line breaks kept, since the
 *  bare `return` in onFromShell ends its statement at the line break). */
const HELPER_SHAPES: Record<(typeof HELPERS)[number], string> = {
  handleFromShell: '{\nipcMain.handle(channel, (e, ...args) => (isShellSender(e) ? handler(e, ...args) : null))\n}',
  onFromShell: '{\nipcMain.on(channel, (e, ...args) => {\nif (!isShellSender(e)) return\nlistener(e, ...args)\n})\n}'
}
const SHELL_WINDOWS = 'src/main/shell-windows.ts'

const lineOf = (s: string, at: number): number => s.slice(0, at).split('\n').length

interface Lexed { path: string; code: string; masked: string }

/** A relative import specifier, resolved against the importing file to a repo path ending in .ts. */
function resolveRel(fromFile: string, spec: string): string | null {
  if (!spec.startsWith('./') && !spec.startsWith('../')) return null
  const parts = fromFile.split('/').slice(0, -1)
  for (const seg of spec.split('/')) {
    if (seg === '.' || seg === '') continue
    if (seg === '..') parts.pop()
    else parts.push(seg)
  }
  return `${parts.join('/')}.ts`
}

/** Names imported into a file from a relative module: local name → { from (resolved path), name }. */
function importsOf(f: Lexed): Map<string, { from: string; name: string }> {
  const out = new Map<string, { from: string; name: string }>()
  const re = /\bimport\s+(?:type\s+)?\{([^}]*)\}\s*from\s*(['"])\s*\2/g
  for (let m = re.exec(f.masked); m; m = re.exec(f.masked)) {
    const spec = /['"]([^'"]*)['"]\s*$/.exec(f.code.slice(m.index, m.index + m[0].length))
    const from = spec ? resolveRel(f.path, spec[1]) : null
    if (!from) continue
    for (const part of m[1].split(',')) {
      const [name, alias] = part.trim().replace(/^type\s+/, '').split(/\s+as\s+/)
      if (name) out.set((alias ?? name).trim(), { from, name: name.trim() })
    }
  }
  return out
}

/** Function declarations in a file: name → { param, body }, or null when the name is declared more
 *  than once (which one runs depends on scope; neither is trusted). */
function functionsOf(f: Lexed): Map<string, { param: string | null; body: string } | null> {
  const out = new Map<string, { param: string | null; body: string } | null>()
  const re = /\bfunction\s+([A-Za-z_$][\w$]*)\s*\(/g
  for (let m = re.exec(f.masked); m; m = re.exec(f.masked)) {
    const open = m.index + m[0].length - 1
    const close = matching(f.masked, open)
    if (close === -1) continue
    const brace = f.masked.indexOf('{', close)
    if (brace === -1) continue
    const end = matching(f.masked, brace)
    if (end === -1) continue
    out.set(m[1], out.has(m[1]) ? null : { param: firstParam(f.masked.slice(open + 1, close)), body: f.masked.slice(brace, end + 1) })
  }
  return out
}

export function checkIpcSenders(files: SourceFile[], allow: Readonly<Record<string, string>> = OPEN_CHANNELS): Report {
  const violations: string[] = []
  const registrations: Registration[] = []
  const lexed: Lexed[] = files.map((f) => ({ path: f.path, ...lex(f.text) }))
  const byPath = new Map(lexed.map((f) => [f.path, f]))
  const fns = new Map(lexed.map((f) => [f.path, functionsOf(f)]))

  // The sender checks each file may use. isShellSender is the root: real only where shell-windows.ts
  // declares it, and in a file that imports it from there. A DELEGATE is a function declared in a
  // file whose own first act gates on that root (gateRefusal with the root as the only check), or the
  // same function imported from the file that declares it. One level only: a delegate of a delegate
  // is not recognised, which fails closed.
  const imports = new Map(lexed.map((f) => [f.path, importsOf(f)]))
  const rootsIn = (path: string): Set<string> => {
    const s = new Set<string>()
    if (path === SHELL_WINDOWS && fns.get(path)?.get('isShellSender')) s.add('isShellSender')
    const imp = imports.get(path)?.get('isShellSender')
    if (imp && imp.from === SHELL_WINDOWS && imp.name === 'isShellSender' && fns.get(SHELL_WINDOWS)?.get('isShellSender')) s.add('isShellSender')
    return s
  }
  const localDelegates = new Map<string, Set<string>>()
  for (const f of lexed) {
    const roots = rootsIn(f.path)
    const own = new Set<string>()
    for (const [name, fn] of fns.get(f.path) ?? []) {
      if (!fn || name === 'isShellSender' || HELPERS.includes(name as (typeof HELPERS)[number])) continue
      if (roots.size && gateRefusal(fn.body, false, fn.param, roots) === null) own.add(name)
    }
    localDelegates.set(f.path, own)
  }
  const checkNamesFor = (path: string): Set<string> => {
    const out = new Set<string>([...rootsIn(path), ...(localDelegates.get(path) ?? [])])
    for (const [local, imp] of imports.get(path) ?? []) if (localDelegates.get(imp.from)?.has(imp.name)) out.add(local)
    return out
  }

  for (const f of lexed) {
    const checks = checkNamesFor(f.path)
    const claimed = new Set<number>() // offsets of ipcMain tokens that are registrations

    // raw registrations
    for (let m = RAW_RE.exec(f.masked); m; m = RAW_RE.exec(f.masked)) {
      // `.ipc.` only as a member (webContents.ipc / frame.ipc), never a bare `ipc` variable
      if (m[1] === 'ipc' && !/\.\s*$/.test(f.masked.slice(0, m.index))) continue
      if (m[1] === 'ipcMain') claimed.add(m.index)
      const open = m.index + m[0].length - 1
      const close = matching(f.masked, open)
      const line = lineOf(f.masked, m.index)
      const api = `${m[1]}.${m[2]}`
      if (close === -1) { violations.push(`S1 ${f.path}:${line} ${api}(: unbalanced call`); continue }
      const args = splitTop(f.masked, open + 1, close)
      const channel = args[0] ? f.code.slice(args[0][0], args[0][1]).trim() : '?'
      const reg: Registration = { file: f.path, line, via: 'raw', api, channel, guard: null }
      registrations.push(reg)
      if (Object.prototype.hasOwnProperty.call(allow, channel)) {
        const fn = args[1] ? parseFunction(f.masked, args[1][0], args[1][1]) : null
        if (fn && gateRefusal(fn.body, fn.expression, fn.param, checks) === null) {
          violations.push(`S4 ${f.path}:${line} ${channel} is on OPEN_CHANNELS but checks its sender anyway; drop the entry`)
        }
        reg.guard = 'open'
        continue
      }
      if (!args[1]) { violations.push(`S1 ${f.path}:${line} ${api}(${channel}) has no handler`); continue }
      const fn = parseFunction(f.masked, args[1][0], args[1][1])
      if (!fn) { violations.push(`S1 ${f.path}:${line} ${api}(${channel}): the handler is not an inline function, so its sender check cannot be seen`); continue }
      const why = gateRefusal(fn.body, fn.expression, fn.param, checks)
      if (why) { violations.push(`S1 ${f.path}:${line} ${api}(${channel}): ${why}`); continue }
      reg.guard = firstCall(fn.body)!.name
    }

    // helper registrations (not the helpers' own declarations)
    for (let m = HELPER_RE.exec(f.masked); m; m = HELPER_RE.exec(f.masked)) {
      if (/\bfunction\s+$/.test(f.masked.slice(0, m.index))) continue
      const open = m.index + m[0].length - 1
      const close = matching(f.masked, open)
      const line = lineOf(f.masked, m.index)
      const args = close === -1 ? [] : splitTop(f.masked, open + 1, close)
      const channel = args[0] ? f.code.slice(args[0][0], args[0][1]).trim() : '?'
      registrations.push({ file: f.path, line, via: 'helper', api: m[1], channel, guard: 'helper' })
      const imp = imports.get(f.path)?.get(m[1])
      if (f.path !== SHELL_WINDOWS && (!imp || imp.from !== SHELL_WINDOWS || imp.name !== m[1])) {
        violations.push(`S3 ${f.path}:${line} ${m[1]} is not the one imported from shell-windows.ts`)
      }
      if (Object.prototype.hasOwnProperty.call(allow, channel)) {
        violations.push(`S4 ${f.path}:${line} ${channel} is on OPEN_CHANNELS but registered through ${m[1]}; drop the entry`)
      }
    }

    // any other use of ipcMain
    const importRanges: Array<[number, number]> = []
    const impRe = /\bimport\s+(?:type\s+)?\{[^}]*\}\s*from\s*(['"])[^'"]*\1/g
    for (let m = impRe.exec(f.masked); m; m = impRe.exec(f.masked)) importRanges.push([m.index, m.index + m[0].length])
    const useRe = /\bipcMain\b/g
    for (let m = useRe.exec(f.masked); m; m = useRe.exec(f.masked)) {
      if (claimed.has(m.index)) continue
      if (importRanges.some(([a, b]) => m!.index >= a && m!.index < b)) continue
      violations.push(`S2 ${f.path}:${lineOf(f.masked, m.index)} ipcMain used other than to register a handler: ${f.code.slice(m.index, m.index + 40).split('\n')[0]}`)
    }

    // raw webContents 'ipc-message' listeners (the event name lives in a string, so read `code`)
    const ipcMsg = /\.\s*(on|once|addListener|prependListener)\s*\(\s*['"]ipc-message(-sync)?['"]/g
    for (let m = ipcMsg.exec(f.code); m; m = ipcMsg.exec(f.code)) {
      violations.push(`S5 ${f.path}:${lineOf(f.code, m.index)} a raw 'ipc-message' listener bypasses ipcMain and every check on it`)
    }

    // helper declarations: only in shell-windows.ts, exactly one each, exactly this shape
    for (const h of HELPERS) {
      const decl = fns.get(f.path)?.get(h)
      if (decl && f.path !== SHELL_WINDOWS) violations.push(`S3 ${f.path} declares its own ${h}; the only one is in shell-windows.ts`)
    }
  }

  const sw = byPath.get(SHELL_WINDOWS)
  if (!sw) violations.push(`S3 ${SHELL_WINDOWS} is missing`)
  else {
    for (const h of HELPERS) {
      const count = (sw.masked.match(new RegExp(`\\bfunction\\s+${h}\\s*\\(`, 'g')) ?? []).length
      if (count !== 1) { violations.push(`S3 shell-windows.ts declares ${h} ${count}×, need exactly 1`); continue }
      const re = new RegExp(`\\bfunction\\s+${h}\\s*\\(`)
      const at = re.exec(sw.masked)!.index
      const open = sw.masked.indexOf('(', at)
      const close = matching(sw.masked, open)
      const brace = sw.masked.indexOf('{', close)
      const end = matching(sw.masked, brace)
      const body = sw.code.slice(brace, end + 1).replace(/[ \t]*\n\s*/g, '\n').replace(/[ \t]+/g, ' ')
      if (body !== HELPER_SHAPES[h]) violations.push(`S3 shell-windows.ts: ${h} no longer has its pinned shape (check first, handler only when it passes): ${body.slice(0, 120)}`)
    }
  }

  for (const channel of Object.keys(allow)) {
    if (!registrations.some((r) => r.via === 'raw' && r.channel === channel)) {
      violations.push(`S4 OPEN_CHANNELS names ${channel}, which no raw registration uses; drop the entry`)
    }
  }

  const delegates = [...localDelegates].flatMap(([path, names]) => [...names].map((n) => `${path}: ${n}`)).sort()
  return { registrations, violations, delegates }
}
