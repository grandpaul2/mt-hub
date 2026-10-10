# Hub backlog

The hub's to-do list: what we're doing now, and everything deferred ("later"). Add deferred ideas
here as they come up, so nothing lives only in a session handoff.

**Order (Paul, S43):**
1. A written style guide (what we decided, and why): `~/mt-hub/docs/style-guide.md`. **Agreed
   S43** (Paul accepted every recommendation). Phones stay chat-only: no mobile development
   work, ever (Paul).
2. The basics below, built to the guide.
3. A pass to bring everything else into line with the guide: its last section lists 19 places
   where the code breaks it. **DONE (S44): all 19, in three batches (mt-hub `966ad62`, `280c91d`).**
4. Then the fun part: bots and mod integration. Plan agreed S46 (see the next section).

**Voice chats (S45, inserted before 4):** DONE. Research, the voice lab, the design and the
build are in `docs/voice/` (start with `README.md` and `rooms-design.md`); mt-hub
`64df87e`…`b6f2282`.

## Bots and mod integration: the plan (Paul, S46; redone S47)

**The spec is `mt-hub-mod-spec.md`.** One **MT Hub** mod, one jar for servers and players.

- **The model (Paul, S47):** our Minecraft server talks to the hub with one server token,
  like BotSpawner did with Discord. Players on our server need no login or setup.
  Schematics and screenshots travel through the server.
- **`/b`:** BotSpawner reading `commands/botspawner.md` from the hub, `/player` lines only.
  Built and tested S47.
- **Schematics:** an **MT Hub** folder in Litematica's Load Schematics screen lists every hub
  schematic; picking one downloads it.
- **Screenshots:** after F2, an **[Upload to hub]** link on the chat line. No hotkey, no
  auto-upload (Paul). Posted under the player's Minecraft name.
- **Hub side:**
  - **Server tokens:** they get the schematics and screenshot routes.
  - **Game tokens (built S46):** removed.
  - **Narrow, not full access (Paul, S46):** this still applies. A token reaches only the
    routes its mod needs (`tokenAllow`).
- **Status (S47):** all three built. Live on Creative; Survival switches when it moves to
  DatHost (it still runs BotSpawner from Discord until then).
- **Not doing: posting schematics from the game (Paul, S47).** Uploads stay on the hub's
  Schematic Manager, which takes photos and descriptions. It's rare, and not worth the
  upkeep.

## Now: the basics (Paul's picks, S43)

The numbers refer to the stocktake below.

**Order (Paul, S43):** the style guide is written FIRST (`~/mt-hub/docs/style-guide.md`), so the
new elements below (popups, dividers, dialogs, sidebar sections) are built to it once, not
reworked later. Build each item to the guide. Each change gets a test that fails on the old
code. Styling changes also get `make firefox-check` (ask Paul first: it opens a window).

- **2 Per-chat drafts: DONE (S43, mt-hub `1e8fbe2`).**
  - Drafts are kept per chat in the browser (`mt-drafts`), survive a reload, and follow a
    rename. The test is `test/browser/drafts.mjs`.
  - This was a bug: a half-written message followed you into the next chat.

- **1 Message formatting: DONE (S43, mt-hub `88b7484`).** `web/src/markdown.ts`; test `test/browser/formatting.mjs`. The copy button on code blocks (item 10) came with it. The original notes follow.
  - `**bold**`, `*italic*`/`_italic_`, `__underline__`, `~~strike~~`, `` `code` ``,
    ```` ```code blocks``` ```` (with a language), `> quote` / `>>> quote the rest`,
    `||spoiler||` (click to reveal), `# / ## / ###` headings, `-`/`1.` lists, and
    `[text](url)` masked links.
  - Not rendered: tables, images, HTML. A backslash escapes.
  - Must keep working: `#path` and `#[path]` file links, previews, @mention highlights,
    Twemoji, `<url>` no-preview links.
  - Where: `renderText`/`emojify` in `web/src/chat.ts`. Code blocks use the mono font. Copy
    button on code blocks (item 10) if it's cheap.
  - Reply quotes, the pins list, search results and forwarded copies: show the formatting, or
    strip it to plain text? The guide decides.
  - Messages are stored as typed; only the rendering changes. The server keeps the raw text,
    so search matches the typed text.

- **3 @mention autocomplete: DONE (S44).** `web/src/autocomplete.ts`; test `test/browser/autocomplete.mjs`. The popup sits just above the box at the caret (Discord's place) rather than over the box's top edge. The original notes follow.
  - Typing `@` in a message box (and in the edit box) pops up the matching accounts plus
    `@everyone`/`@here`. ↑/↓ choose; Enter or Tab inserts `@name `; Esc closes.
  - Names come from `accounts` (util.ts) and anyone who has posted (`knownNames`). The popup
    sits above the caret; the style is the guide's popup pattern.

- **4 Emoji: DONE (S44).** `web/src/emoji.ts` and `autocomplete.ts`; tests `autocomplete.mjs` and `chat-actions.mjs`.
  - **Data:** emojibase 15.3.2 (dev dependency), turned into `emoji/data.json` by `build.mjs`. That's 1,869 emoji, the ones Twemoji draws, with Slack/Discord names first. It's 28 KB gzipped and fetched on first use.
  - **Also built:** a whole `:name:` typed out turns into its emoji; the message box has a smiley button that opens the picker; Shift+click in the picker picks without closing; the footer names the emoji under the pointer.
  - **Left for later:** skin tones, custom emoji.
  - The original notes follow.
  - **Autocomplete:** `:` plus 2 letters pops up matches (`:fire` → 🔥), same keys as 3.
  - **Picker:** search, categories and Recently used (kept in the browser), drawn as Twemoji.
    It replaces the fixed list of about 150 (`EMOJI` in chat.ts).
  - **Data:** short names plus categories. Use an npm emoji dataset matching Twemoji's
    version (Twemoji is `@twemoji/svg`); it gets bundled, so mind its size.

- **5 New-messages line and Jump to present: DONE (S44).** `newAfter`/`firstNew`/`showJump` in `web/src/chat.ts`; test `test/browser/new-line.mjs`.
  - **How it behaves:**
    - The line stays while the chat is open and goes when you send something (Discord).
    - A message arriving unseen (you're scrolled up, or the tab is in the background) starts a line.
    - A chat never opened in this browser gets no line.
    - The chat counts as read once you reach the bottom (unchanged).
  - **The pill** shows when you're more than a screen up from the newest message.
  - The original notes follow.
  - **New line:** opening a chat with unread messages shows a "NEW" line above the first
    unread one (from `lastRead`, which is per browser) and scrolls to it, not to the bottom.
  - **Jump to present:** when scrolled up far from the bottom, a floating button jumps back.
  - These are read markers only: no pings, counts or sounds (notifications are out of scope).

- **12 Media-only rule in chat: DONE (S44)** (except the private-chat warning, which comes with 13). `addToFiles` in `web/src/chat.ts`, `uploadInto` in `main.ts`; test `test/browser/add-to-files.mjs`.
  - **The picker:** it lists every folder, starting at the tree's selected one; typing narrows the list or names a new folder.
  - **Names and sizes:** a name already there gets " (2)", and nothing is replaced. Files over 50 MB go in `large/`, and the dialog says so.
  - **Esc cancels.**
  - **Mixed drops:** pictures go to `media/<chat>/` as before, and the rest get the question.
  - The original notes follow.
  - **Now:** a refused file (dropped, pasted or picked; anything not a picture, video or
    sound) is only a toast (`attach` in chat.ts).
  - **Wanted:** offer "Add to Files and link it". A folder picker (default: the folder the
    tree has selected) uploads it there and inserts the `#[path]` link in the box.
  - **Several files:** one question for all of them.
  - **Private chat or DM (13):** warn that Files is visible to everyone. **Done with 13.**

- **13 Private chats and DMs: DONE (S44).**
  - **Where:** `internal/chat` (meta.json, OpenDM, Hide, MediaFile) and `internal/server/private.go` (`inChat` on every chat route, `publishChat`, setKind, openDM, hide, media). The page is in `web/src/chat.ts`.
  - **Tests:** `TestPrivateAndDM`, `TestPrivateChats` (it fails if the event filter is removed) and `test/browser/private.mjs`.
  - **How it's built:**
    - Private chats are made from "+" (admins: New Private Chat…) or by right-clicking a chat (Make Private…, Members…, Make Public).
    - **DMs are in the CHATS list** (Paul, S44, after trying the first version), under the chats; "+" → New Direct Message….
    - Admins have no moderator powers in a DM; either person may pin there.
  - **Left for later:**
    - Deleting a message doesn't offer to delete its private media (that media isn't in Files).
    - Read markers are per browser, so two accounts in one browser share them.
  - The original design notes follow.
  - **Leaks to fix first.**
    - The event stream (`bus.publish` in `internal/server/chat.go`) sends every message,
      edit, delete and chat change to EVERY logged-in browser. It must filter per person.
    - Chat media lives in `media/<chat>/` inside Files, where everyone can see it.
  - **Kinds of chat:**
    - **public:** today's behaviour.
    - **private:** a member list. Admins create them and manage the members. Admins can see
      every private chat, like Discord's Administrator.
    - **DM:** 1:1 or a group (up to 10). Anyone can start one; only its people see it, not
      even admins.
  - **Honest caveat, to say in the UI or docs:** the owner (Paul) can read everything on disk.
    "Private" means private from other players in the hub, not encrypted.
  - **Media in private chats and DMs** is stored with the chat, outside Files, and served
    only to its members. It doesn't show in Files or folder views (accepted).
  - **Checks everywhere:** the channels list, messages, post/edit/delete, react, pin, pins,
    forward (allowed out of a private chat: the forwarder chooses), Copy Link, search (only
    chats you're in), orphans, thumbnails and previews of private media, and the event
    stream.
  - **Lifecycle:** admins can delete private chats. A DM can't be deleted, only hidden from
    your list; it comes back on a new message.
  - **Layout:**
    - Private chats sit in the CHATS list with a lock icon.
    - A **DIRECT MESSAGES** section sits under CHATS.
    - A DM starts from the "+" on that section (pick names). Later, from the name card
      (item 6).
  - **Storage:** channel metadata (kind, members) is new: a meta file per chat directory
    under `~/hub/chat/`. DMs need a stable id that isn't a name; their display name is the
    members.
  - **Size:** a solid afternoon. Bots will need the same permission checks, so it's worth
    doing before them.

- **15 Back and Forward: DONE (S43, mt-hub `9a375ed`).** `go()` in util.ts adds history
  entries; the test is `test/browser/history.mjs`. Back to a chat or folder keeps unsaved edits
  without asking (as before); Back to another file asks. The original notes follow.
  - **Now:** every navigation uses `history.replaceState` (none use `pushState`), so the
    browser's Back button leaves the hub.
  - **Wanted:** opening a file, folder, chat, post or the board pushes a history entry, and
    Back/Forward (browser, mouse buttons, Alt+←/→) move through them. `openHash` already
    opens any address.
  - **Careful:**
    - Scrolling, selection and re-renders must not push entries.
    - A file with unsaved edits must still ask before Back leaves it (`leaveOK`).
    - Back from a search-opened result should land on where you were.

- **Chat reordering by drag and drop: DONE (S44).**
  - **The order:** one shared order, set by admins, as on Discord (Paul). It's stored in `~/hub/chat/order.json` and set through `PUT /api/channel-order`.
  - **Moving a chat:** drag the row (a blue line shows where it lands), or right-click → Move Up / Move Down.
  - **DMs:** always at the bottom, the most recent message first (Paul).
  - **Code and test:** `moveChat`/`draggableChat` in `chat.ts`; test `chat-order.mjs`.

## Later

- **Firefox check: views for the S64 pieces.** Its 25 views don't include the folder bar's
  open sort menu, the search box slid out, the screenshots filters out, or a schematic post
  being edited; those are covered by the headless suites only.
- **DONE (S63) Faster tests:** browser suites 99 s to 29 s (`settle()` in
  `test/browser/lib.mjs`), Firefox check 93 s to 50 s (waits for the page and each popup).
  The Firefox check's 0.9 s before each screenshot stays: the screen needs about a second to
  catch up on most views (retrying until it matched saved 3 s and failed one view by a pixel).

- **Top-bar wiring (S51, paused):** PCB traces as a subtle texture behind the logo. Paul wants
  to find better reference examples first ("not tonight"). Mockup with the router:
  `docs/topbar/wiring-mockup.html` (open in Firefox; Shuffle re-rolls). Where it got to:
  - **Colour:** one grey (#2a2b2d) with a lighter rim (#404143), plus at most one red wire.
    No black or dark grey; the bar stays `--top` grey.
  - **Wires:** 6 px with rounded corners, 13 px apart, 45° turns, never crossing.
  - **Layout:** a crop of a bigger board. Wires drop in from above or below, turn, run along
    and leave, so you rarely see a whole wire. At most 2–3 vias visible.
  - **Rejected on the way:** thin edge dashes, a darker bar, radiating from the logo.
- **From the stocktake:** (6 avatars: tried and dropped S51, see below) 7 chat categories and topics (the order
  was done in S44), 8 chat shortcuts, 9 big emoji, 11 mark unread,
  14 threads, 16 recently deleted, 17 several files open / recent files, 18 multi-select in the
  tree, 19 copy/paste/duplicate in the tree, 20 clickable path, 21 recent changes,
  22 Markdown side by side, 23 Ctrl+P.
- **Notifications, presence, status:** unread pings, online dots, typing. Maybe never.
  - **DONE (S49) Message sound:** three soft glass notes, picked by ear with Paul over nine
    rounds (`web/src/sounds/make-message.py`; `ding.ts`).
    - **When:** a new message from someone else, unless a focused hub tab is showing its
      chat; at most once in 3 s across tabs. **Sound Settings** in the name menu: a switch, volume and Test for it and for the voice chat sounds.
    - **Limit:** a browser plays sound only after a click or key press in the page, so a tab
      opened and never touched stays silent. Phones pause background tabs, so there's no
      sound there either. Real push notifications would be a separate, bigger job.
- **DONE (S48) Lazy-load the editor and LiveKit:** loaded on first use (`loadBundle` in
  util.ts). A first visit went from 1.58 MB to 0.18 MB over the wire (`test/perf/phone-load.mjs`).
  Left: the file-icon map (46 KB) still loads on phones; immutable caching of the static files.
- **Carried from handoffs:**
  - Both chat panes can show #general at once.
  - The name box shows a special-folder icon while you type a new name.
  - Rewrite the Discord schematics import (the old import script is stale).
  - Off-site copy of `~/hub`.
  - The 7th-tab hang on the LAN address (HTTP/1.1).
  - Delete the #general test import (when Paul says).
  - **Guides refresh** (one dedicated session before new players arrive; leave the guides
    alone until then): every `dist/` guide says to get mods from the hub, not Discord zips.
    Rebuild or drop the `dist/` zips, which may still hold Nvidium. (Nvidium itself left the
    guides in S44.)
- **Left over from the basics (S44):**
  - Emoji skin tones and custom emoji (4).
  - Deleting a message in a private chat or DM doesn't offer to delete its pictures, which
    aren't in Files (13).
  - Read markers are per browser, so two accounts in one browser share them (13).
- **Voice, deferred (S45):**
  - A TURN relay on 443 for players on networks that block UDP and port 7881. It clashes
    with Caddy, so it's left out until someone can't connect.
  - **DONE (S49)** Per-person volume: right-click someone in your voice chat (User Volume 0–200%, Mute for you; admins: Mute for Everyone, Disconnect).
  - Screen share.
  - Auto levelling for quiet mics.
  - A fallback to RNNoise when DeepFilterNet3 overloads the CPU.
  - The voice lab's DeepFilterNet3 drawing quirk.
  - Wireless headset wake-up glitch: Paul's BH300 garbles the first sound (a pluck, or the
    first word) after a silence while it wakes up. A quiet lead-in and a constant hum didn't
    fix it reliably. It's the headset, not the hub; only worth chasing if others hear it too.

---

# Stocktake (S43): what Discord and a file explorer have that we don't

Taken stock before bots and mod integration.

Out of scope here: notifications, presence and status (online dots, typing indicators, unread
pings). Those come later, if at all.

How this was made: a read of the hub's frontend (`~/mt-hub/web/src`) against Discord's and VS
Code's everyday features. "(code)" marks something found by reading the code, not by trying it.

## Already covered

**Chat:**
- reply (click the quote to jump), forward, edit (↑ edits your last message), delete (Shift
  skips the question), reactions, pins, Copy Link to a message, "(edited)" with the time;
- the full date on hovering a time, day dividers, grouped messages;
- paste, drop or upload pictures, video and sound; link previews (YouTube, images, pages);
- #path links to files; @mention highlights; Twemoji;
- unread dots per chat, Mark as read, and the unread count in the tab title;
- older messages load as you scroll up; search with `in:`, `from:`, `mentions:` and `has:`;
- two panes (main and side) on different chats.

**Files:**
- File tree: icons, F2 rename, Delete, drag to move, right-click menus,
  Collapse Folders, Download as Zip;
- every change in git: History with Restore this version; moves followed by old links;
- conflict handling; a folder view; the full-window viewer; the Schematic Manager.

## Chat (Discord)

1. **Message formatting.** Today `**bold**` shows the stars. Discord renders bold, italic,
   underline, strikethrough, `inline code`, code blocks, `> quotes`, `||spoilers||`, headings,
   lists and `[masked](links)`. This is the most visible gap; everyone uses it without thinking.
2. **Per-chat drafts (code).** The message box keeps its text when you switch chats, so a
   half-written message follows you to the next chat and can go to the wrong place. Discord keeps
   a draft per chat.
3. **@mention autocomplete.** Typing `@` should pop up the names (arrows and Enter/Tab). Today
   you type the name exactly and hope it highlights.
4. **Emoji: `:shortcode:` autocomplete, and a picker with search, categories and recent ones.**
   The picker is a fixed set of about 150 with no search. Typing `:fire` → 🔥 is Discord muscle
   memory.
5. **A "New messages" line and Jump to present.**
   - On opening a chat with unread messages: a red "NEW" line above the first unread, and a bar
     to jump to it.
   - When scrolled up: a "Jump to present" button.
   - These are read markers, not notifications.
6. **Avatars and a name card: NO (S51, Paul).**
   - Built and tried live: the linked Minecraft face (or a coloured initial) small on the
     message name line, in pins, the @ popup, voice rows, DMs and the account button, plus an
     opt-in switch and Update button in Minecraft Name.
   - Paul: too busy in chat and voice; the hub's quieter, more focused look than Discord's is
     the line to hold. Reverted; the code is on mt-hub's `archive/avatars` branch. Style guide
     1.8 records it. The name card went with it.
7. **Chat order, groups and topics.**
   - Chats are alphabetical today. Discord lets admins drag the order, group chats under
     collapsible categories, and give each a one-line topic shown in its header.
8. **Chat keyboard shortcuts:**
   - Alt+↑/↓: previous or next chat. Alt+Shift+↑/↓: next unread chat.
   - Esc: mark the chat read and scroll to the bottom.
   - Ctrl+K: jump to a chat by name. Our search box could take `#gen` → Enter.
9. **Big emoji.** A message that's only emoji shows them large ("jumbo").
10. **Copy button on code blocks** (comes with 1).
11. **Mark unread from here** (Alt+click a message), to come back to it later.

**Decisions, not gaps:**

12. **Files other than media in chat: DONE (S56, Paul).** Every chat keeps its own files
    (`chat/<chat>/media/`), any kind up to 50 MB; other files show as a card; Save to Files…
    copies one into Files; a chat's paperclip lists its files. `media/` left Files (mt-hub
    `e60debb`). The S38 rule ("no media lives in chat") and the S44 split (public chats in
    Files, private ones with the chat) are gone.
13. **Private chats** (admins only, or DMs). Discord basics, but they would bring permissions
    into the hub.
14. **Threads.** Discord has them; we have replies. Probably later, if ever.

## Files

15. **Back and Forward (code).**
    - The hub never adds browser history: the browser's Back button leaves the site instead of
      going to the last file, chat or folder.
    - VS Code has Alt+←/→. Both should work, and so should the mouse's back button.
16. **Recently deleted / restore a deleted file.**
    - Everything outside `large/` and `media/` is still in git, but there's no way to find a
      deleted file and bring it back from the page.
    - VS Code has the system trash, plus Timeline in the explorer.
17. **Several files open (tabs), or at least recent files.** One file at a time today. Tabs are
    a code editor's thing; a simpler "Recent" list may suit non-technical people better.
18. **Multi-select in the tree** (Ctrl/Shift+click), to move, delete or download several at once.
19. **Copy, paste and duplicate in the tree** (Ctrl+C/Ctrl+V, Duplicate). Today a copy means
    download then upload.
20. **Clickable path (breadcrumbs)** in the file bar: click a folder in `boards/handheld/` to go
    there.
21. **Recent changes.** One list of what changed lately across all files (who, what, when). It's
    VS Code's Timeline, but workspace-wide: "what did people do while I was away".
22. **Markdown side by side.** Edit on the left, rendered on the right. That's VS Code's preview;
    we switch between them.
23. **Ctrl+P: open a file by name** (our search box does this; the shortcut is VS Code habit).
