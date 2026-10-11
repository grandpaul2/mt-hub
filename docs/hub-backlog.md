# Hub backlog

Ideas that are not built, and what is known about them. Everything deferred goes here, so
nothing lives only in someone's head. How the hub looks and behaves today is
[`style-guide.md`](style-guide.md); how it is put together is
[`architecture.md`](architecture.md).

Any of these is fair game, and so is something not listed.

## Later

### From the stocktake

The numbers are from the stocktake below, so an idea keeps its number when others are done.

- **7 Chat groups and topics.** Group chats under collapsible categories, and a one-line topic
  in each header. (The order of the chat list is already set by admins.)
- **8 Chat shortcuts.** Alt+↑/↓ previous or next chat, Alt+Shift+↑/↓ next unread chat, Esc marks
  the chat read and scrolls down, Ctrl+K jumps to a chat by name (the search box could take
  `#gen` then Enter).
- **9 Big emoji.** A message that is only emoji shows them large.
- **11 Mark unread from here.** Alt+click a message, to come back to it later.
- **14 Threads.** Discord has them; the hub has replies. Probably never.
- **16 Recently deleted.** Everything outside `large/` is in git, but the page has no way to
  find a deleted file and bring it back.
- **17 Several files open, or recent files.** One file at a time today. Tabs are a code
  editor's thing; a "Recent" list may suit non-technical people better.
- **18 Multi-select in the tree** (Ctrl/Shift+click), to move, delete or download several.
- **19 Copy, paste and duplicate in the tree.** Today a copy means download then upload.
- **20 Clickable path (breadcrumbs)** in the file bar.
- **21 Recent changes.** One list of what changed lately across all files (who, what, when):
  "what did people do while I was away".
- **22 Markdown side by side.** Edit on the left, rendered on the right.
- **23 Ctrl+P: open a file by name.** The search box does this; the shortcut is a habit.

Tried and dropped: **6 avatars and a name card.** Built and tried live (the linked Minecraft
face or a coloured initial on messages, pins, voice rows and the account button); too busy in
chat and voice. The style guide records the decision.

### Other ideas

- **Notifications, presence, status:** unread pings, online dots, typing. Maybe never. A
  new-message sound exists (a new message from someone else, unless a focused tab shows that
  chat; at most once in 3 s across tabs; Sound Settings in the name menu). A browser plays
  sound only after a click or key press in the page, so a tab opened and never touched stays
  silent, and phones pause background tabs. Real push notifications would be a separate,
  bigger job.
- **Emoji skin tones and custom emoji.**
- **A message that mentions you is tinted** (Discord tints the whole row; the hub highlights
  only the `@name`).
- **Formatting keys in the message box:** Ctrl+B, Ctrl+I and Ctrl+U on selected text.
- **A sent message shows at once,** greyed until the hub answers and red with Retry if it
  fails. Today it appears when the hub answers; a failure is a toast and the text goes back
  in the box.
- **Rename a waiting file, or mark it a spoiler,** before sending (Discord's cards have both).
- **Read markers are per browser,** so two accounts in one browser share them.
- **Both chat panes can show the same chat at once.**
- **The name box shows a special-folder icon while you type a new name.**
- **Loading:** the file-icon map (46 KB) still loads on phones, and the static files are not
  cached as immutable. (The editor and LiveKit already load on first use; `test/perf/phone-load.mjs`
  measures a phone's first visit.)
- **The 7th-tab hang on a plain-http LAN address** (HTTP/1.1 allows six connections per host,
  and each tab holds an event stream open).
- **Firefox check:** its views do not include the folder bar's open sort menu, the search box
  slid out, the screenshots filters out, or a schematic post being edited; the headless
  suites cover those only.
- **Voice:**
  - A TURN relay on 443 for players on networks that block UDP and port 7881. It clashes with
    a reverse proxy on the same port, so it is left out until someone cannot connect.
  - Auto levelling for quiet microphones.
  - A fallback to RNNoise when DeepFilterNet3 overloads the CPU.
  - The voice lab's DeepFilterNet3 drawing quirk.
  - A wireless headset that garbles the first sound after a silence while it wakes up. A quiet
    lead-in and a constant hum did not fix it reliably. It is the headset, not the hub; only
    worth chasing if others hear it too.
- **Top-bar wiring (paused):** PCB traces as a subtle texture behind the logo. The mockup with
  the router is `topbar/wiring-mockup.html` (open it in Firefox; Shuffle re-rolls). Where it
  got to:
  - **Colour:** one grey (#2a2b2d) with a lighter rim (#404143), plus at most one red wire.
    No black or dark grey; the bar stays `--top` grey.
  - **Wires:** 6 px with rounded corners, 13 px apart, 45° turns, never crossing.
  - **Layout:** a crop of a bigger board. Wires drop in from above or below, turn, run along
    and leave, so you rarely see a whole wire. At most 2 to 3 vias visible.
  - **Rejected on the way:** thin edge dashes, a darker bar, radiating from the logo.

---

## Stocktake: what Discord and a file explorer have that the hub does not

Out of scope here: notifications, presence and status (online dots, typing indicators, unread
pings). Those come later, if at all.

It was made from a read of the hub's frontend against Discord's and VS Code's everyday
features. Items 1 to 5, 10, 12, 13 and 15 are built; the rest are in the list above.

### Already covered

**Chat:**
- reply (click the quote to jump), forward, edit (↑ edits your last message), delete (Shift
  skips the question), reactions, pins, Copy Link to a message, "(edited)" with the time;
- the full date on hovering a time, day dividers, grouped messages;
- paste, drop or upload any file, waiting as cards in the message box until the message is
  sent; link previews (YouTube, images, pages);
- `#path` links to files; @mention highlights; Twemoji;
- unread dots per chat, Mark as read, and the unread count in the tab title;
- older messages load as you scroll up; search with `in:`, `from:`, `mentions:` and `has:`;
- two panes (main and side) on different chats.

**Files:**
- file tree: icons, F2 rename, Delete, drag to move, right-click menus, Collapse Folders,
  Download as Zip;
- every change in git: History with Restore this version; moves followed by old links;
- conflict handling; a folder view; the full-window viewer; the Schematic Manager.

### Chat (Discord)

1. **Message formatting** (built; `web/src/markdown.ts`).
2. **Per-chat drafts** (built).
3. **@mention autocomplete** (built; `web/src/autocomplete.ts`).
4. **Emoji `:shortcode:` autocomplete and a picker** (built; `web/src/emoji.ts`).
5. **A "New messages" line and Jump to present** (built).
6. **Avatars and a name card.** No: see above.
7. **Chat order, groups and topics.** The order is built; groups and topics are not.
8. **Chat keyboard shortcuts.**
9. **Big emoji.**
10. **Copy button on code blocks** (built).
11. **Mark unread from here.**

Decisions, not gaps:

12. **Files other than media in chat** (built). Every chat keeps its own files, any kind up
    to 50 MB; other files show as a card; Save to Files… copies one into Files.
13. **Private chats** (built): admins make them, and anyone can start a DM.
14. **Threads.** Discord has them; the hub has replies. Probably later, if ever.

### Files

15. **Back and Forward** (built; `go()` in `util.ts` adds history entries).
16. **Recently deleted / restore a deleted file.** Everything outside `large/` is still in
    git, but there is no way to find a deleted file and bring it back from the page. VS Code
    has the system trash, plus Timeline in the explorer.
17. **Several files open (tabs), or at least recent files.**
18. **Multi-select in the tree.**
19. **Copy, paste and duplicate in the tree.**
20. **Clickable path (breadcrumbs)** in the file bar: click a folder in `boards/handheld/` to
    go there.
21. **Recent changes.** VS Code's Timeline, but workspace-wide.
22. **Markdown side by side.** VS Code's preview; the hub switches between the two.
23. **Ctrl+P: open a file by name.**
