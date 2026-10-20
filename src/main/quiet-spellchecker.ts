// Outside macOS, Chromium's built-in spellchecker (Hunspell) downloads a dictionary for the app's locale from Google's CDN as soon as a
// session exists, before any page: a Linux capture of Beacon 0.4.4 (2026-10-17) saw https://redirector.gvt1.com/edgedl/chrome/dict/
// en-us-10-1.bdic and its redirect to rr4---…gvt1.com, though every window had spellcheck off and every page's session was switched off
// (web-contents-created comes too late). Beacon's terms say it connects only to the daemon and services you configure, the sites you open
// in its browser pane, and GitHub for updates (@shared/spellcheck).
//
// Type-only import: smoke:spellcheck calls this with a recording stand-in for a session.
import type { Session } from 'electron'

/** Where a dictionary download would go instead of Google's CDN: the discard port on this computer, so nothing leaves it. */
export const DICTIONARY_URL_NOWHERE = 'http://127.0.0.1:9/'

export type SpellcheckerSession = Pick<Session, 'setSpellCheckerEnabled' | 'setSpellCheckerLanguages' | 'setSpellCheckerDictionaryDownloadURL'>

/** Give a session nothing to download and no checker. */
export function quietSpellchecker(s: SpellcheckerSession): void {
  s.setSpellCheckerLanguages([]) // no language, so no dictionary to fetch
  s.setSpellCheckerDictionaryDownloadURL(DICTIONARY_URL_NOWHERE) // and if one were asked for anyway, never from Google
  s.setSpellCheckerEnabled(false)
}
