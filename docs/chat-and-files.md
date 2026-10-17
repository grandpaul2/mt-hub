# Chat and Files: how they behave

Chats are stored as described in [`storage.md`](storage.md). The rules for how things look
are in [`style-guide.md`](style-guide.md).

- **Two chat panes:**
  - the right-hand panel has a channel dropdown, hides with », and resizes by dragging its
    left edge (double-click resets the width)
  - clicking a channel in the left list opens it in the main panel instead of the file
  - so you can have two channels open at once; a file you had open keeps its unsaved edits
    while a channel is showing
  - `#chan=<name>` in the address opens a channel in the main panel
- **Delivery:** messages arrive live over Server-Sent Events (`/api/events`). The same
  stream tells pages about file changes, including edits made over ssh.
- **Links:** `#path/to/file` (or `#[path with spaces]`; the bracket form is also needed for a
  name with a `+`) becomes a link that opens the file.
  A link to a schematic post's folder (`#[schematics/<title>]`) shows as the post's card and
  opens it in the Schematic Manager.
- **One rule for what goes into a chat:** anything dragged or pasted onto a chat becomes a
  card in its message box, never text: a file from the computer (uploaded on send), a file
  or folder from the tree or a folder (any selection), a card from the Manager, a picture or
  file card (or file link) out of a message. Things already on the hub are linked where they
  are; a file posted in a private chat or DM dropped into another chat is copied instead
  (`take`, `sortDropped` in `chat.ts`). A message being edited takes drops into its own
  cards. A drop anywhere else on the page goes to the chat that is showing, and the page
  never opens a dropped file in the tab (`catchStrayDrops`); the tree, a folder view, the
  Trash and the Schematic Manager keep their own drops.
- **How links show:** every link to a file, folder or schematic post gets a card under the
  message (up to 10); its text is hidden when it stands alone (a line of its own, or after
  the last words), and stays a link inside a sentence or a quote, list or heading line
  (`aloneLinks`, `hideAlone`). A line left empty goes with its line break. Messages are
  stored as before: plain text with `#path` links.
- **Sending:** the page draws your message at once and posts it with a `nonce`; the hub puts
  the nonce on the message it answers with and on the live event (it is never stored), so
  whichever arrives first replaces the waiting copy (`unsent` and `deliver` in `chat.ts`).
- **Files posted in chat:** anything dropped or pasted on a chat (or picked with its +
  button), up to 50 MB, is kept with the chat (`<data>/chat/<chat>/media/`, outside Files and
  its history). It waits in the message box as a card and is uploaded when the message is
  sent; the stored message links it as `#media/<chat>/<file>`, which the page adds on send
  and hides wherever it shows the message's words when it stands alone (`splitFiles` /
  `joinFiles` in `chat.ts`).
  Only people who can see the chat can fetch it. A file no message links (an upload whose
  message never went) is moved to the trash by a daily sweep once it is a day old
  (`sweepMedia`), and so is a file an edit takes out of its last message. Pictures, videos and sounds show as previews under the message
  (pictures as thumbnails), anything else as a file card (name, size, Download), instead of
  as links. A file over 50 MB is offered a place in `large/` instead. **Save to Files…**
  (message toolbar and menu, the viewer, the chat's file list) copies one into a Files
  folder. The 📎 button in a chat's header lists its files, newest first. A chat rename takes
  its files along (old links follow). A message that links a file from another chat (pasted
  or forwarded, when posted or edited) gets its own copy in its chat, so its people can see
  it and it outlives the original; only from chats the poster can see. Deleting the last
  message that links a file asks whether to move the file to Trash too (ticked; from a public
  chat it then shows in the Trash, from a private chat or a DM it is kept but never shown);
  a file another message still
  links is never deleted. Deleting a chat keeps its files with it in `chat/.deleted/`.
  `media/` is not a Files folder: Files refuses the name.
- **Pictures full size:** clicking a picture anywhere (chat, files, folder views,
  schematic posts) opens the full-window viewer: forward, download, open in a
  new tab, close; a click on the picture zooms; ←/→ step through the set. Opened from chat, it also has Open folder (a
  picture in Files: shows it there) or Save to Files… (a picture posted in chat).
- **Folder view:** clicking any folder (or a `#path` link to it) opens it as a grid of its
  folders and files, with one bar: Upload, a name search, Size (`#folder=<path>`). Ctrl+V
  pastes pictures in. Pictures and videos show as thumbnails, other files as their tree icon.
  `screenshots/` opens at its newest;
  everything is folders first, then by name (`x.png` before `x (2).png`). A README is just
  a file in it. The folder stays the selected row and isn't expanded. A nested folder has
  `← Back to <parent>/` (and Esc) to go up.
- **Screenshots and map art** are ordinary folders that keep no history (like `large/`). A
  screenshot is named `<date> <time> <poster>.png`, which its tile shows as the poster and time;
  any folder with such names gets who/from/to filters. Anything uploaded,
  dropped or pasted into `screenshots/` is named that way (taken time, your name); a pasted
  picture anywhere gets the same kind of name. Map art is named by its title
  (`MA-001 MacroTech Logo.png`). The `#shots` and `#mapart` addresses open the folders.
- **One item on its own** (a picture or video file, one schematic post) gets the same bar:
  back and the name on the left; on the right the text buttons (a post's blue Edit, as on a
  text file), the icon buttons (forward, download, open in a new tab, move to Trash, red on hover),
  previous/next (also ←/→, Esc goes back) and full window last. A text file has its Size
  slider in that last place. The folder's own bar (filters, search, size) hides
  meanwhile.
  Any other file opened on its own (text, Markdown, binaries) gets `← Back to <folder>/` and
  Esc too (Esc works from the tree as well, which keeps only its arrow keys; with a menu open,
  Esc just closes the menu).
- **Schematic Manager** (the Schematic Manager button in `schematics/`' folder bar):
  `schematics/` in Files shown as a board of big cards, newest first, with search and a
  card-height slider (`#schems`). Each post is a
  folder, `schematics/<title>/`: its schematic file(s), its renders (`1.png`, `2.png`…; the
  first is the card picture) and a `README.md` the card is read from:

      # 260x260 8gt Floor Placer

      Design by Eldridge · posted 2025-07-09

      For placing a floor of a single block type…

  (`Posted <date>` alone when there's no credit; everything under that line is the
  description.) A post opens on its own (`#schem=<folder>`) with the single-item bar, Open
  folder, Edit and Delete. A post is edited in place: Edit turns its page's title, credit and
  description into boxes where they sit and puts move/remove buttons on its pictures, with
  Save and Cancel in the bar (leaving with changes asks). New post is the same page, empty.
  Both write those files; a title that's taken offers
  the file to that post as a new version (same name: replaces it, history keeps the old).
  Anything changed in Files shows on the board, and a post's folder view has Open post.
  `schematics/` keeps history like the rest of Files.
- **Mentions:** `@name` (anyone who has posted) and `@everyone`/`@here` get Discord's purple
  highlight. There are no notifications.
- **Message actions** (hover toolbar, or right-click): react, reply, forward (a copy, which
  survives the original changing), edit your own, copy, delete your own (admins: any; Shift
  skips the question), copy a link to the message (`#chan=<name>&msg=<id>`), and for admins,
  pin. The 📌 button in a chat's header lists its pins.
- **Emoji** are drawn with Twemoji images (`/emoji/<codepoints>.svg`, graphics CC-BY 4.0), so
  they look the same in every browser, including Linux ones with no emoji font.
- **Editing:** Arrow-Up in an empty box edits your last message.
- **Unread markers:** kept per browser (the last message you saw in each chat), not on the
  account.
- **Phones:** under 700 px wide the page shows chat only, and a file link downloads the file.
