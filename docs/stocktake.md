# Stocktake: what Discord and a file explorer have that the hub does not

Out of scope here: notifications, presence and status (online dots, typing indicators, unread
pings). Those come later, if at all.

It was made from a read of the hub's frontend against Discord's and VS Code's everyday
features. Items 1 to 5, 10, 12, 13, 15, 16, 18 and 19 are built; the rest are ideas in [`LATER.md`](../LATER.md) → From the stocktake.

## Already covered

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

## Chat (Discord)

1. **Message formatting** (built; `web/src/markdown.ts`).
2. **Per-chat drafts** (built).
3. **@mention autocomplete** (built; `web/src/autocomplete.ts`).
4. **Emoji `:shortcode:` autocomplete and a picker** (built; `web/src/emoji.ts`).
5. **A "New messages" line and Jump to present** (built).
6. **Avatars and a name card.** No: tried and dropped (`LATER.md`).
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

## Files

15. **Back and Forward** (built; `go()` in `util.ts` adds history entries).
16. **Recently deleted** (built: the Trash. Everything moved out of Files stays 30 days and
    can be restored from the tree's Trash row).
17. **Several files open (tabs), or at least recent files.**
18. **Multi-select** (built: Ctrl and Shift in the tree; Ctrl, Shift and a dragged box in the
    folder view; move, delete, zip and chat links for a selection).
19. **Cut, copy, paste and duplicate** (built, in the tree and the folder view; the hub's own
    clipboard, not the computer's).
20. **Clickable path (breadcrumbs)** in the file bar: click a folder in `boards/handheld/` to
    go there.
21. **Recent changes.** VS Code's Timeline, but workspace-wide.
22. **Markdown side by side.** VS Code's preview; the hub switches between the two.
23. **Ctrl+P: open a file by name.**
