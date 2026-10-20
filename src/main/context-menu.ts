// Main-side half of the right-click menu: turn the pure model's items into a real Electron Menu and
// pop it, then do what each item means.
//
// The CONTENT — which items, in what order, enabled or not — is pure and lives in
// @shared/context-menu, provable headless. This file owns the two things that need Electron: building
// the Menu from those items, and the click handlers that only make sense in a real window.
//
// WHY ONE SHARED FUNCTION AND NOT PER-WINDOW. Every BrowserWindow in Beacon (main, quick-capture,
// HUD, the browser/terminal pop-outs) has the same expectation: right-click in a field lets you
// paste, right-click on a selection lets you copy. Wiring it per-window is how one window ends up
// without it. `installContextMenu(win)` is called once per window and attaches the same handler.
import { clipboard, Menu, shell } from 'electron'
import type { BrowserWindow } from 'electron'
import { safeExternalUrl } from '@shared/browser-pane'
import { buildContextMenu, shouldShowMenu, type ContextMenuItem } from '@shared/context-menu'

/**
 * Attach the context menu to one window's webContents.
 *
 * Spelled as a function taking the window (rather than reaching for a global `mainWindow`) because
 * the pop-outs and quick-capture are separate windows with their own webContents, and each should get
 * the menu. Idempotent per window in the sense that it adds one listener; calling it twice on the
 * same window would double-fire, so it is called exactly once where each window is created.
 */
export function installContextMenu(win: BrowserWindow): void {
  win.webContents.on('context-menu', (_event, params) => {
    const items = buildContextMenu({
      selectionText: params.selectionText ?? '',
      isEditable: !!params.isEditable,
      linkURL: params.linkURL ?? '',
      misspelledWord: params.misspelledWord ?? '',
      dictionarySuggestions: params.dictionarySuggestions ?? []
    })

    // An empty menu — or one that is only separators — is not popped. An empty popup is a blank
    // rectangle that reads as a rendering bug; doing nothing is the honest answer when no action
    // applies where the user clicked.
    if (!shouldShowMenu(items)) return

    const template = items.map((item) => toElectronItem(item, win))
    const menu = Menu.buildFromTemplate(template)
    menu.popup({ window: win })
  })
}

/**
 * One model item → one Electron MenuItemConstructorOptions, with its click behaviour attached.
 *
 * Roles (cut/copy/paste/selectAll) are passed through as roles: Electron implements them, localises
 * them, and wires them to the focused field, which is strictly better than hand-rolling each. Only
 * the spelling and link items need explicit handlers, because they carry a payload (the replacement
 * word, the URL) that no role covers.
 */
function toElectronItem(item: ContextMenuItem, win: BrowserWindow): Electron.MenuItemConstructorOptions {
  if (item.type === 'separator') return { type: 'separator' }

  if (item.role) {
    return {
      role: item.role as Electron.MenuItemConstructorOptions['role'],
      ...(item.enabled === false ? { enabled: false } : {})
    }
  }

  // A spelling suggestion: replace the flagged word in the focused editable.
  if (item.replacement !== undefined) {
    const word = item.replacement
    return {
      label: item.label ?? word,
      click: () => {
        // replaceMisspelling operates on the focused editable in this window's webContents and swaps
        // the word Chromium flagged — which is why the model only offers suggestions when
        // misspelledWord is non-empty. There is no "select the word" step; the field must still be
        // focused, which it is, since the menu was invoked from it.
        if (!win.isDestroyed()) win.webContents.replaceMisspelling(word)
      }
    }
  }

  // "Open link": external, gated by the SAME safeExternalUrl the rest of the shell uses, so a
  // javascript: or file: href in model-authored markdown cannot be opened from here either.
  if (item.link !== undefined) {
    const raw = item.link
    return {
      label: item.label ?? 'Open link',
      click: () => {
        const safe = safeExternalUrl(raw)
        if (safe) void shell.openExternal(safe)
        else console.warn('[context-menu] refused to open a non-web URL (see safeExternalUrl)')
      }
    }
  }

  // "Copy link address": the raw href onto the clipboard, unfiltered — copying a string is not the
  // same risk as opening it, and the person can see exactly what they copied before using it.
  if (item.copyLink !== undefined) {
    const raw = item.copyLink
    return { label: item.label ?? 'Copy link address', click: () => clipboard.writeText(raw) }
  }

  // A disabled informational line ("No spelling suggestions").
  return { label: item.label ?? '', enabled: item.enabled !== false ? true : false }
}
