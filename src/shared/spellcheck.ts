// Chromium's built-in spellchecker, per platform.
//
// macOS: Electron uses the OS spellchecker (NSSpellChecker) and downloads nothing. Everywhere else it
// uses Hunspell, and on first use it downloads dictionaries from the Chromium (Google) CDN, unasked.
// Beacon's terms say it connects only to the daemon and services you configure, the sites you open in
// its browser pane, and GitHub for updates. So the built-in spellchecker is macOS only: every window and
// the browser pane pass this as webPreferences.spellcheck, and on other platforms main also switches the
// spellchecker off on every session a page is created in (src/main/index.ts, web-contents-created).
// smoke:spellcheck fails a window or view that does not.

export function builtinSpellcheck(platform: string): boolean {
  return platform === 'darwin'
}
