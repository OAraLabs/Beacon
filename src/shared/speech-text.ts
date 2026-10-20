// What the read-aloud toggle actually says.
//
// A reply is markdown written for the eye. Handed to a speech synthesiser verbatim it reads
// punctuation out loud — "asterisk asterisk important asterisk asterisk" — and then recites a
// forty-line code block character by character, which is both useless and impossible to stop
// listening to. So the text is prepared: structure that exists for LAYOUT is dropped, and content
// that cannot be spoken usefully is ANNOUNCED rather than read.
//
// The rule throughout: never silently delete something the listener would want to know is there.
// A code block becomes "code block", not nothing — otherwise the spoken reply and the written one
// disagree about what the agent said.
//
// Pure, so a smoke can pin it without a speech engine.

/** A fenced block becomes a short spoken announcement, keeping its language when it declared one. */
function announceFence(lang: string): string {
  const l = lang.trim().split(/\s+/)[0]
  return l ? `. ${l} code block. ` : '. Code block. '
}

/**
 * Markdown → something worth listening to.
 *
 * Order matters: fences are removed FIRST, because their contents may hold anything (a line of
 * asterisks, a table, a URL) and running the inline rules over code would mangle the announcement.
 */
export function speechText(markdown: string): string {
  let t = markdown ?? ''
  t = t.replace(/```([^\n`]*)\n[\s\S]*?```/g, (_m, lang: string) => announceFence(lang))
  // An unterminated fence — a reply still streaming — is the same announcement, not a recital.
  t = t.replace(/```([^\n`]*)\n[\s\S]*$/g, (_m, lang: string) => announceFence(lang))
  t = t.replace(/`([^`]+)`/g, '$1')
  t = t.replace(/!\[([^\]]*)\]\([^)]*\)/g, (_m, alt: string) => (alt ? `. Image: ${alt}. ` : '. Image. '))
  // A link is read as its TEXT. Reading a URL aloud is thirty seconds of slashes and hyphens.
  t = t.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
  t = t.replace(/^\s{0,3}#{1,6}\s+/gm, '')
  t = t.replace(/^\s{0,3}>\s?/gm, '')
  // A bullet becomes a sentence break, so the listener hears the list as a list.
  t = t.replace(/^\s*[-*+]\s+/gm, '. ')
  t = t.replace(/^\s*\d+\.\s+/gm, '. ')
  t = t.replace(/^\s{0,3}([-*_])\s*(\1\s*){2,}$/gm, '')
  t = t.replace(/(\*\*|__)(.*?)\1/g, '$2')
  t = t.replace(/(\*|_)(.*?)\1/g, '$2')
  t = t.replace(/~~(.*?)~~/g, '$2')
  t = t.replace(/\|/g, ' ')
  t = t.replace(/[ \t]+/g, ' ')
  t = t.replace(/\s*\.\s*(\.\s*)+/g, '. ')
  t = t.replace(/\n{2,}/g, '. ')
  t = t.replace(/\n/g, ' ')
  // A leading `. ` is an artifact of a reply that OPENS with a fence or a bullet — the
  // announcement is joined with a sentence break that has nothing before it. Harmless to a
  // synthesiser, but it is not text anyone wrote, so it goes.
  return t.replace(/\s+/g, ' ').replace(/^[.\s]+/, '').trim()
}

/** Nothing worth speaking — a reply that was only a code block still has its announcement. */
export function speakable(markdown: string): boolean {
  return speechText(markdown).replace(/[.\s]/g, '').length > 0
}
