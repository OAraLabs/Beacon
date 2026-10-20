// The onboarding copy rule, in one dependency-free file: which banned words does a text contain?
//
// src/shared/onboarding-banned-words.json is the list. This is the matcher the probe applies to the
// rendered DOM (via probe-kit). src/main/onboarding-copy-smoke.ts applies its own TypeScript matcher
// to the strings module, then imports THIS one and requires the two to agree on every string it
// checks, so "the copy passes" and "the screen passes" cannot drift into two different rules.

/** Whole word, any case. Inflections are in the list on purpose: nothing here guesses plurals. */
export function bannedHits(text, words) {
  const hits = []
  for (const w of words) {
    const re = new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i')
    const m = re.exec(text)
    if (m) hits.push(m[0])
  }
  return hits
}
