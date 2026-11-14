# Changelog

Beacon's releases, newest first. Installers for each published version are on the
[Releases](https://github.com/OAraLabs/beacon/releases) page, which is also the update feed: Beacon 0.3.0 and
later update themselves.

## Unreleased

- **An approval card says when it isn't showing you the whole call.** The arguments on an approval card are the assistant's own words, and Prometheus already cuts long ones, masks some, and leaves some out when there are many. The card now says so above the arguments, in the error colour: "Prometheus cut or hid part of this. You are not seeing the whole call, and what is missing may be the part that matters." Each affected line carries a word you can read as well as see: CUT (Prometheus cut it short and says by how much), PART HIDDEN (it masked part of it), LEFT OUT (it left arguments out and says how many). It never says anything was kept safe, because what is missing may be the part that does the thing. The text is otherwise Prometheus's, in its order, with nothing re-cut. A Prometheus that says it cut the arguments itself (`arguments_cut`) is believed, in the card and in the notification, which then offers no buttons; none does yet. Nothing was needed from Prometheus.
- **Approval cards write out text that doesn't show.** A direction override that makes `notes/txt.sh` read as another name, a zero-width space, a stray line break, a no-break or wide space, or one of the characters that draw as blank is written out as ⟨U+202E⟩ where it was, and the card says so; a run of the same one is written once with its length (⟨U+3164 ×140⟩), so a wall of blanks can't push `; rm -rf ~` out of sight. An argument with a very long name wraps in its own column and no longer pushes its value out of view, and an argument named `__proto__` (or `constructor`) is no longer dropped from the card.

## 0.5.0 (2026-11-13)

Beacon 0.5.0 is for everyday use as well as for running an assistant: a Today home, saved prompts, files and screenshots in quick capture, tool servers at an address, and a folder to work in. Adding a phone is now a scan and an approval, Beacon keeps several Prometheus side by side, and approvals are harder to answer by accident.

### Safety improvements

Three things in 0.4.9 are fixed here. Each is also described under Approvals or Links and files below.

- **The `A` key could approve a request nobody had read.** In 0.4.9, pressing `A` anywhere in the window except a text field approved the first pending approval card, so a letter typed at a list or a button could approve a command. `A` and `D` now answer only the card you have clicked or Tabbed to.
- **A blocked link could put its own words in a notification.** When Beacon refused a `beacon://` link, the notification showed the link's first 80 characters, so whoever made the link chose text that appeared as a Beacon notification. It now says only that a link was blocked.
- **A `beacon://open` link could carry extra parameters that Beacon ignored.** It opened the conversation it named and dropped everything else in the link. A link that carries anything besides which conversation to open is now refused whole.

### Everyday use

- **Everyday mode, and a Today home.** A new install opens on the everyday views: Today, Chats, Workspace (Documents, Artifacts, Wiki, Files) and Config with the settings you change. Today shows what needs you (an approval, a message with no reply, messages that could not be sent), what happened since you last looked (replies by conversation, tasks that finished or failed), and what is coming up. Settings → Views → Show everything brings back Mission, Coding, Activity, the Board and the rest, and the command palette has the same switch. An install that already exists keeps everything, and nothing changes for it until that switch is turned off.
- **Starters and saved prompts.** The new-chat screen has a row of starters under the message box (Plan my day, Summarise this, Draft a reply, Research a topic, and any prompt you save). Clicking one puts its text in the message box; nothing is sent until you send it. Save as a prompt… keeps what you have typed under a name, and Edit prompts… changes or removes them. A saved prompt is also in the command palette (Use prompt: …) and in a conversation's message box: type `/` and its name. Prompts are kept on this computer, the same whichever Prometheus you are on. Holding Enter no longer sends a message: only the first press does.
- **Quick capture takes files and screenshots.** The ⌘⇧Space box now carries more than text: ⌘V adds a copied file or image, the paperclip picks files, and the camera takes a screenshot of a screen or a window, with the box itself stepping out of the picture. Each shows as a chip you can remove before sending, and a file over 20 MB is refused with its size. Send to lists New conversation first, then your recent conversations by title. If a send doesn't go out, the text and the files that didn't go are put back in the box, and the box says how far it got. Quick Capture is also in the app menu, for when another app holds the shortcut.
- **Open files with Beacon.** On a Mac, Beacon is in Finder's Open With list for common documents and pictures (never as the app they open in by default), and a file can be dropped on Beacon's icon; on Linux, a file's path can be given on the command line. Beacon then shows a confirmation with each file's name, kind and folder, and reads none of them until you answer. Adding takes a click with the mouse or trackpad; the keyboard can only say Don't add. Nothing is sent until you send it. Not added, each with its reason: links to other files, hidden files and anything in a hidden folder, Beacon's own files, files in your Library (other than a cloud drive's folders) or inside an application, system folders, folders, empty files, and files over 20 MB.
- **Work in a folder.** A conversation's header always shows the folder your assistant is working in, or No folder. When Prometheus shares this computer's disk, Choose a folder… opens the system's folder picker, and Beacon lists in plain words what your assistant will do in that folder before you confirm. Stop using this folder takes it back and leaves the files alone. A link that leads to your whole home folder, a whole disk, a system folder, or the folders that hold keys and settings is refused. On another computer, or through a tunnel or a container, the chip still shows the folder and explains how to set one. An approved device doesn't get the chip.
- **Add a tool server at an address.** Config → Connectors → Add server now takes a server at an https:// address (Streamable HTTP or the older SSE) and the token it signs in with, as well as a command that runs on the Prometheus computer. The token goes to Prometheus, which keeps it; Beacon does not keep it or show it again. An http:// address is accepted only where Prometheus reaches it privately: on its own computer, its home network or Tailscale. A Beacon that signs in with a device key is told plainly that adding or changing servers needs Prometheus's main key (Settings → Connection → Advanced), and isn't offered buttons Prometheus would refuse.

### Phones, and more than one Prometheus

- **Add a phone.** The title bar's switcher and Config → Devices offer Add a phone…: a QR the phone scans to ask that Prometheus to let it join, which you then approve in Beacon. There is no password in it, only the name the phone reaches the Prometheus by and the computer key Beacon checked for it, so the phone can check it too before sending anything. It always uses a name the iPhone app accepts (a short Tailscale name, never a number address like 100.x or localhost), and when it can't make one it says what to do.
- **Approving a phone says what it grants.** The "Approve new device?" prompt's button is Approve as chat-only, which is what an approval gives. Make it an owner… shows how owner powers are granted (only from the computer Prometheus runs on): the steps, and the exact command, `oara pair --owner`, with a Copy button. Config → Devices lists the devices waiting to join, with Review to bring the prompt back after Not now. When a device asks while Beacon isn't in front, a notification says so, without the requester's own device name.
- **Devices errors in plain words.** Config → Devices no longer shows raw errors like "HTTP 401: minting a device token requires the global token": each says what to do (for a phone, use Add a phone).
- **The pairing code carries the Prometheus's computer key.** The code in Devices → Enrol now ends with `node=`, the key Beacon pinned for that Prometheus, for the phone to pin. A Prometheus too old to have one gets the code as before.
- **Add a Prometheus from the title bar.** Click the name in the title bar and choose Add a Prometheus…: a short form takes its address, socket and key, Test asks who answers there without sending any key, and Add keeps it beside the others and switches to it. The Prometheus you're on is never touched. An address Beacon already keeps says so, and nothing is added. Settings → Connection → Advanced edits only the one you're on.
- **Your Prometheus, in the sidebar and the title bar.** With two or more, "Your Prometheus" at the top of the Chats sidebar has one line for each: its dot, its name and a short muted detail (the model it's on, or its state in words). Click a row to switch; Beacon stays in Chats. The name in the title bar is a button that opens the same list from any view, with the arrow keys, Home, End, Enter and Escape. A Prometheus that fails the identity check is never sent a key. The name of the one you're on is in the title bar, the window title, the composer and the can't-reach banner. With one Prometheus nothing changes.
- **Prometheus that can't prove who it is yet.** A Prometheus 0.9.18 that hasn't made its computer key yet now connects, as an older Prometheus does, and one that proved who it is before and now doesn't is refused, with nothing sent. A Prometheus that hasn't adopted its vault yet is no longer taken for a different one: its computer key is what proves it.

### Approvals

- **Critical approvals are answered in Beacon.** A newer Prometheus marks some approval requests critical: ones that can't be judged from a notification's one line, or are too consequential to approve with one tap. For those, Beacon's notification has no Approve or Deny button and says to answer it in Beacon, where the whole request is shown. Prometheus decides which requests these are; Beacon never guesses. With a Prometheus that doesn't mark requests, notifications are unchanged.
- **A critical request is approved only from its card.** The `A` key does not approve it, its row on Mission and Today offers "Answer on the card" in place of Approve once, and so does its line in the desktop-prompt pane. Deny is unchanged everywhere. Beacon's main process also refuses a critical approve that did not come from the card's button, and refuses to send an approval answer through its general "write to Prometheus" call at all. When it refuses, the card comes straight back and says why. Beacon takes a Prometheus's silence to mean "it doesn't mark requests" only while its live socket is connected, and silence never withdraws a yes.
- **No stray keystroke.** `A` and `D` used to answer the first approval card from anywhere in the window that wasn't a text field. They now answer only the card focus is on (click a card, or Tab to one of its buttons), a held key does nothing, and each card says so.
- **A click on Approve doesn't miss.** An approval card used to change height the moment it took focus, so the button moved between pressing and releasing the mouse. The card now keeps its size, including when what Prometheus supports changes under your click, and an approve given within half a second of its card appearing or moving up the stack is ignored, so the second half of a double-click can't approve the request that slid under the pointer. An ordinary card is one line taller than before.

### Links and files from outside Beacon

- **Links say where to go and nothing else.** A `beacon://open` link that carries anything besides which conversation to open (text, a prompt, any other parameter) is refused whole, and opens only a conversation this Beacon already has. No link can put words in a message box or send anything. When Beacon refuses a link, its notification says only that a link was blocked.
- **Files handed to Beacon are looked at by a helper process.** A file on a disk that has stopped answering, such as a network share whose server went away, can no longer freeze every Beacon window: it costs a wait of a few seconds and a line saying Beacon could not look at it.

### Fixes

- **A dialog over a view's header can be clicked.** While any dialog, menu or popover is open, nothing under it drags the window, in every view.
- **Connection Settings keeps the keyboard.** Tab and Shift-Tab stay inside the dialog, Esc closes it, and focus goes back where it was.
- **Setup says the right download size, read from the release itself,** and keeps the size built into Beacon if it can't be read within a few seconds.
- **A part-way setup with a pairing Prometheus no longer accepts goes back to pairing,** saying to pair again, instead of resuming at a step that can't work.
- **Try again connects once.** Pressing it while Beacon was still retrying could connect twice and drop the first connection.
- **When Settings opens, Beacon notes what changed the view,** in `logs/view-trail.log` in Beacon's profile folder (the view on screen, the last few changes of view and the click or shortcut before each; typing is never recorded), to explain a view that jumps when Settings opens.

## 0.4.9 (2026-10-20)

Beacon's source is public, under the [MIT License](LICENSE). This release also carries the work of 0.4.6 to
0.4.8, which were never published.

- **Open source.** The license is MIT, the same as Prometheus. Settings → About and the About box say "Free ·
  open source (MIT) · beta". The disk image no longer asks you to agree to a license before it opens, and
  the AppImage no longer asks on its first run. See [PRIVACY.md](PRIVACY.md) for what Beacon connects to,
  and [TRADEMARKS.md](TRADEMARKS.md) for the names.
- **Plain words for an approved device.** A Beacon that another Beacon approved sees short explanations
  instead of Prometheus's refusals.
- **No plain http to the internet.** Beacon refuses an unencrypted connection to an address that is not this
  computer, your home network or Tailscale, saved connections included, and says to use https or Tailscale.
- **"Make this Beacon an owner"** is offered at the end of joining another computer, and opens only the owner
  section. Settings keeps the address and key under Advanced.
- **Task lists in chat** show their checkboxes, without bullets as well.
- **Zero tool calls** read "No tool calls yet", without a red 0%.
- **Model rows read UP or DOWN** from a fresh check, never "stale" a minute after Prometheus starts, and a
  stopped local server reads DOWN. A cloud default model is named by its model, not "Local".

## 0.4.5 (2026-10-17)

Includes 0.4.4, which was not published on its own.

- **Prometheus on the same Mac:** approve this Beacon with Prometheus's own `oara pair approve`, with no other
  Beacon needed. The download is about 71 MB.
- **Several conversations at once:** side by side in the main window, with a divider you can drag, or popped
  out into their own windows.
- **Projects in the sidebar:** file sessions into projects by drag or right-click, with suggestions from the
  paths your assistant worked in. The sessions list can be resized.
- **Pages, SVGs and PDFs in chat** can be viewed, not only downloaded, and a plain click on a link to a local
  address opens it in the browser pane.
- **"Tidying up the conversation…"** shows inline, with a progress bar, while a long conversation is compacted.
- **Fixes:** a wiki page's YAML frontmatter is no longer shown as page text; refused tasks read "refused" on
  Mission; the dock and panes fit inside the window; on Linux, no spellchecker dictionary is downloaded from
  Google; the voice port is 8012 by default and set in config.

## 0.4.3 (2026-10-12)

- **Pairing codes for iPhone are encrypted when Prometheus is.** With home network on, the code from Config →
  Devices → Enrol carries Prometheus's key, so a Beacon for iPhone connects over TLS, and only to that
  Prometheus. Beacon first checks that Prometheus answers on the iPhone ports (8006 and 8011) with that key,
  and makes no code if it doesn't. Phones paired before home network was turned on need a new code.

## 0.4.2 (2026-10-12)

- **Change which AI your assistant uses, from Beacon:** Config → Models → Main model. Beacon checks a key
  before saving it; "Restart now" restarts Prometheus to apply it (Prometheus 0.9.7 or later).
- **Make a Beacon on another computer an owner** with a one-time code from `oara pair --owner`.
- **More ways in** when Prometheus is already on this Mac: look for another computer, or type its address.
- **Fixes:** the approval card is solid over every page; a worker request this Beacon can't approve says so
  once and explains how to approve it; the address example is generic.

## 0.4.1 (2026-10-11)

- **Setting up Prometheus on a new Mac works:** 0.4.0 asked for the download at the wrong address.
- **A Mac too old for Prometheus** is told so before anything downloads.
- **"We couldn't find Prometheus" says why:** macOS isn't allowing the search, the Prometheus found needs
  updating, or nothing answered (and you can type the address).

## 0.4.0 (2026-10-11)

- **A new first run:** set Prometheus up on this Mac in one click (Beacon downloads the notarized app, checks
  it, installs it, starts it and connects), or join a computer that already runs it.
- **Sign in with OpenRouter**, with no key to copy.
- **More than one computer, over TLS.** Beacon holds each home-network Prometheus to the key it first met.
- **Encrypted-only home-network joins.** Tailscale and this Mac work as before.
- **Worker cards:** approve a worker's step once, and pick the worker model in Settings.

## 0.3.1 (2026-10-07)

- Setup picks up where you left off, and always offers a way out when Prometheus can't be reached.
- Setup links open in your browser.
- The license window shows clean paragraphs.

## 0.3.0 (2026-10-07)

- The first public build: a signed and notarized macOS app, and Linux AppImage and deb, with an update feed
  on this repository.
