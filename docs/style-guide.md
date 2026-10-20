# MacroTech hub: style guide

How the hub looks, behaves and talks, and why. New UI is built to this guide. When the code and
the guide disagree, the guide wins and the code is fixed, unless the guide is wrong. Then change
the guide first, with the reason.

**Status: agreed by the maintainers.**
- Each rule is either a decision on record or plain description of what's built.
- Phones stay chat-only, with no mobile work.
- Section 15 is where gaps between the code and the guide are listed as they are found.

---

## 1. Principles

1. **Discord for talking, a file explorer for files.**
   - **Chat** follows Discord: layout, keys, wording, Markdown.
   - **Files** borrow the file explorer from VS Code and nothing more: tree, menus, inline
     rename, history. The hub is a place to keep and share files, with a plain text editor. It
     is not a code editor or an IDE.
   - **Where the two meet,** the hub has one shared style: dialogs, menus, toasts, buttons,
     popups.
   - A Discord regular's chat habits and a VS Code regular's file-tree habits should work. The
     hub doesn't invent a third way where one of them already has an answer.
2. **For non-technical players first.**
   - A non-technical member needs only the address. They never see git, a terminal, a security
     warning or a code-editor feature they didn't ask for.
   - When a Discord or VS Code feature only makes sense to programmers, leave it out (the plain
     editor).
3. **Files are the truth.**
   - Galleries, the Schematic Manager and search are views of folders and file names, not
     separate stores.
   - Every folder opens the same folder view.
   - The one exception: files posted in a chat live with the chat (in every chat, so private
     chats and DMs stay private). Save to Files… copies one into Files.
4. **Fewest layers.** No feature, setting or abstraction before there's a real need. A
   simple rule beats a configurable one.
5. **Nothing moves under the pointer.**
   - Controls keep their place when something appears or changes: reserved space for Save, the fixed-width count on the board.
   - The chat holds its scroll place when panels resize.
6. **Never let the system decide how it looks.**
   - The hub ships its own fonts (Noto Sans, JetBrains Mono) and its own emoji (Twemoji).
   - Nothing depends on what's installed on the viewer's machine.
7. **What you see on screen is the test.**
   - Styling is checked on a real screen (`make firefox-check`) as well as in tests.
   - What the maintainer sees on screen beats theories.
8. **Not in scope:** notifications, pings, presence and typing indicators. Sounds are not a
   feature to grow: a new-message sound exists and is optional (see Message sound and Sound
   Settings in 8). Read markers (unread dots, the NEW line) are fine: they're about what you've
   read, not about pulling you back.
   - **No avatars.** They were tried (Minecraft faces, or initials) and made the chat and voice
     lists too busy; the hub's quieter, more focused look than Discord's is worth keeping.

---

## 2. Layout

- **Desktop grid**:
  - top bar (34 px) over three columns: left sidebar, main panel, right chat panel.
  - **Sidebar:** FILES tree, then TEXT (the chats, DMs included), VOICE and LIVE. All four
    are always there (2026-10-13; before, VOICE and LIVE came and went with use), so
    nothing below a section moves when a voice chat or a stream starts; an empty VOICE or
    LIVE is its head and its "+". On a hub without voice chats or streams set up, that
    section is left out. The bottom holds only the voice, sharing and watching bars,
    while in use. The Schematic Manager button is in `schematics/`' folder bar, where a
    screenshots folder has its filters. The Manager's board has **← Back to schematics/** first in its bar, back to
    that folder (Esc too), like every folder's Back.
  - **Main panel:** shows one thing at a time: a file, a chat, a folder, the Schematic
    Manager, or a screen being watched.
  - **Right panel:** a second chat with its own picker. It collapses to a thin strip; » flips
    to « in the same spot.
- **Sizes**:
  - **Sidebar:** 260 px by default, at least 160 px.
  - **Chat panel:** 340 px by default, at least 240 px.
  - **Main panel:** keeps at least 320 px.
  - Both side panels resize by dragging their inner edge; a double-click resets them. Widths are
    remembered per browser.
- **Top bar:**
  - **The logo** on the left: the red pixel M from map art MA-001 and the pixel
    MACROTECH lettering in MA-003's broken frame, redrawn as an inline SVG on whole pixels
    (`index.html`). No end ticks on the frame. The bar stays `--top` grey.
  - On the right: search, then your name, which opens the account menu.
  - The tab title and login heading say **MacroTech**.
- **Bars** (the strip at the top of a panel): one height, 41 px (`--bar`), in all three
  columns (the sidebar's FILES head, the main panel's bar whatever it shows, the side chat's),
  so the lines under them meet; and one padding. A bar too narrow for its buttons wraps to a
  second line.
  - **Single-item bar** (one file, picture or post), shared everywhere, in the folder view's
    order: back, name, details; then on the right the text buttons (Save, Edit, History, Open
    folder), the icon buttons, previous/next, and at the far right the **size slot**.
    - **Icon buttons**, the same everywhere: forward, download, open in new tab, **Delete**
      (grey, red only on hover, like the chat toolbar's).
    - **Size slot:** what makes the thing bigger. A text file: the **Size** slider, as in
      the folder view. A picture or post: **full window**, an expand icon (four corners).
    - No **⋯** on a bar: every action is a button on it.
  - **A magnifier means search**, and nothing else: no magnifier for text size, full window
    or zooming a picture (the full-window viewer zooms on a click on the picture: to full
    size, or to twice what was showing when full size would be no bigger; a click again
    zooms back out).
  - **Narrow panels:** the details shorten first, then the buttons drop to their own line.
  - **Folder and board bars** wrap rather than clip.
- **Phones (under 700 px):** chat only, with the chat picker in the panel header.
  - A file link downloads the file or opens the picture in a new tab.
  - Folder views and the Schematic Manager aren't reachable on a phone, **on purpose**. Chat on phones works fine, and there's no mobile development work. New features are desktop-only unless they're chat.

---

## 3. Colour

Dark theme only. Every colour is a token in `:root`; no colours are hard-coded in rules.
The token set below is today's values merged: the many near-same greys collapse into the
nearest token, and the three reds and four blues become one role each.

### 3.1 Tokens

| Token | Value | Use |
|---|---|---|
| `--bg` | #1e1e1e | page, inputs, inset surfaces |
| `--panel` | #252526 | sidebars, bars, dialogs, menus, popups, cards |
| `--panel-2` | #2d2d2d | buttons, chips, code |
| `--top` | #333333 | top bar |
| `--border` | #3c3c3c | every 1 px line, including menus (was #454545) |
| `--hover` | #2a2d2e | row and message hover (VS Code list hover) |
| `--select` | #37373d | the selected row, button hover, highlighted popup row |
| `--active` | #04395e | menu item under the pointer, picked item in a list |
| `--text` | #cccccc | file-side text |
| `--muted` | #8a8a8a | secondary file-side text |
| `--chat-text` | #e0e0e0 | chat and sidebar text (brighter than first tried) |
| `--chat-muted` | #9d9d9d | chat secondary text, sliders |
| `--chat-name` | #ffffff | names, titles |
| `--accent` | #0e639c | primary buttons (see 3.2) |
| `--accent-hi` | #1177bb | primary hover |
| `--focus` | #007fd4 | every focus ring and drop outline (VS Code's focus blue) |
| `--link` | #3794ff | links, link-preview titles |
| `--danger` | #f47067 | error text, the hover on danger icons |
| `--danger-fill` | #a1260d | red buttons (destructive confirm) |
| `--ok` | #73c991 | "online", success marks |
| `--warn` | #5a4a14 | banners, notes to read |
| `--mention` | #5865f2 | @mentions (Discord's blurple) |
| `--flash` | rgba(250,200,60,.25) | a message or block you were sent to, search highlights |
| `--tag-purple` `-gold` `-blue` `-teal` `-green` `-orange` `-red` `-pink` `-grey` | #8a3ffc #9c7a32 #2f6fd0 #1f8a7a #3d8b37 #c0601a #b8323f #c2407f #5f6670 | admin tags (the "op" badge): each admin picks one; purple by default, gold for the owner. `--tag-gold-text` #f2e3bf is gold's text. Were `--admin` and `--owner` |
| `--border-hi` | #585858 | hovered edges, tree guides, reply and forward bars |
| `--danger-fill-hi` | #be2f12 | red button hover |
| `--logo-text` | #c6d2dd | the logo's MACROTECH lettering |
| `--logo-frame` | #929eae | the logo's frame |
| `--logo-red` · `-hi` · `-lo` | #c8161a · #e0393c · #8e0d10 | the logo's red M: middle, top and bottom rows |
| `--mention-tint` | rgba(88,101,242,.25) | mention pill, your reactions |
| `--mention-row` `--mention-row-hi` | rgba(88,101,242,.08) / .13 | the row of a message that mentions you, and on hover |
| `--mention-text` | #c9cdfb | mention pill text |
| `--media-bg` | #000000 | behind videos and pictures |
| `--scrim` / `--scrim-soft` | rgba(0,0,0,.86) / .65 | behind the viewer / behind dialogs |
| `--pill` | rgba(30,31,34,.92) | the viewer's tool pills |

- **Added in the conformance pass:** the rows after the admin tags. The guide's set had no
  token for these roles, so they got one instead of merging into a colour that would change
  the look. `--shadow-near` and `--shadow-float` (5) are in `:root` too.

- **Lighter shades:** white overlays with a set of alphas, for "a shade lighter than what's
  behind it" (Discord's hover style in chat).
  - `--tint-1` .04: hover in chat.
  - `--tint-2` .08: a pressed or open state.
  - `--tint-3` .12: an active chat row.
  - Replaces about 15 one-off alphas.
- **Badge colours stay as they are:** they're identity, not UI.

### 3.2 When something is blue

- **Where it came from:** first "no blue buttons in the main UI", then one blue Edit button
  with Save turning blue when there's something to save. Dialog buttons stayed blue.
- **The rule: blue marks the one thing to do next, and only while there is one.**
  - **A dialog's confirm button** (Log in, Send, Add account, Post): blue.
  - **A bar's single primary action** (Edit, which becomes View, or Cancel once there are unsaved changes): blue. **Save:** blue only
    with unsaved changes.
  - **Everything else is grey,** including New post and Upload: buttons that are always
    there.
  - **Destructive confirms** (Delete, Ban, Discard) are **red** (`--danger-fill`), never blue.
    Today the Delete in "Delete this message?" is blue.
  - **A switch that's on is blue**: that's state, not a call to action, and
    Discord, Windows and Apple all draw it that way.
  - **Settings dialogs that apply at once** have no confirm, so no blue button. Admin's
    one is Add account; Make admin is grey.

### 3.3 Red

Red means "this destroys something" or "this went wrong", and nothing else.
- **Text:** errors under a form, failed toasts.
- **Fills:** destructive confirms, and a destructive menu item while it asks for its second
  click.
- **Text:** destructive menu items (Ban, Delete in Admin's "⋯").
- **Hover:** danger icons (trash).
- **Text:** a voice setting moved off its default in a way that makes you sound worse to
  others (Gain: Manual, a high Microphone gain or Voice activation threshold), with a line
  saying why, as Simple Voice Chat marks the same settings in game (Paul, 2026-10-20). It
  warns that something goes wrong for the people hearing you.
- **The NEW line:** Discord draws it red, but by the rule above that
  would make it read as an error. So it's drawn in `--mention` blurple instead. It's still
  unmistakable, and it keeps red's meaning.

---

## 4. Type

- **Fonts:**
  - **Noto Sans** for everything, and **JetBrains Mono** for code, paths, the editor and code
    blocks. Both are bundled.
  - No `system-ui`, no system fallbacks except for the moment before load.
  - **Emoji** are Twemoji images, never a font.
  - **← → ↑ ↓ ●** are icons (`glyphs()` in `util.ts`), never text: neither bundled font has
    them (Noto Sans' CSS claims ↑ ↓, the file doesn't), and the system font standing in made
    buttons taller with their text lower in Firefox. Any other symbol in the page's own
    text gets checked the same way (a font measurement over every view).
- **Sizes:**
  - **File side:** 13 px (VS Code density).
  - **Chat side:** chat, sidebar and composer at 14 to 15 px (Discord comfort).
  - **Scale:** 11 · 12 · 13 · 14 · 15 · 16 · 22.
  - **Small labels:** section heads and times are 11 to 12 px, section heads in uppercase with
    letter-spacing (FILES, TEXT, MESSAGES · 3).
  - Drops the one-off 12.5 and 13.5 px sizes.
- **Weights:**
  - 400 for text.
  - 600 for section heads, names, bar titles.
  - Bold (700) only in rendered Markdown.
- **Line height:**
  - Text that can be cut short with "…" gets a **whole-pixel line-height**, with negative
    margins if the layout would grow.
  - Reason: Firefox on the GPU path clips such text to its box, and a half-pixel edge drops
    the bottom row of g, p and y.
  - **New code prefers wrapping to cutting text short** (the search dropdown does: the server
    shortens long text instead).
- **Markdown** (files and chat):
  - Single line breaks are kept, as in Discord and GitHub comments.
  - Code is in the mono font on `--panel-2`.

---

## 5. Shape, depth and motion

- **Corner radius, three sizes:**
  - **4 px:** controls (buttons, inputs, chips, small icons).
  - **6 px:** surfaces (cards, menus, dialogs, popups, dropdowns, tiles).
  - **8 px:** the big rounded Discord pieces (composer, viewer tool pills, toast).
  - Today it's 3, 4, 5, 6 and 8 px for the same roles.
  - **Exception:** the tree's inline rename box stays square (VS Code).
- **Shadows, two:**
  - `--shadow-near`: the message hover toolbar.
  - `--shadow-float`: menus, popups, dropdowns, toasts, dialogs.
  - Today there are six.
- **Layers, bottom to top:**
  - panel content;
  - hover toolbars (1);
  - resize handles (2–3);
  - dialogs (10);
  - menus, popups and dropdowns (50);
  - the viewer (100);
  - **toasts (110)**, so a toast shows over the viewer. Today toasts sit at 60, under it.
- **Motion:**
  - **Only to show what changed.** Something moves only to show where a thing came from or
    went while you look: a part of the page opening or closing, a switch flipping. Nothing
    moves for decoration, when a page or view first draws or is redrawn, or on a loop. Content arriving in a list (a
    message, a file, a person joining a voice chat, a stream starting) appears at once, as in
    Discord and VS Code.
  - **One speed, one curve:** `--motion`, 180 ms, `ease-out` (fast first, so it answers at
    once, then settling). The tree's chevron, a switch's knob, the folder search box and
    everything that opens inside a panel use it.
    - **The flash** (a 1.6 s `ease-out` fade of `--flash` on a message, tile or heading you
      were sent to) is the one longer one: it has to be seen after the jump.
  - **Opening and closing inside a panel** (a settings row, a warning line, a bar above the
    message box, the bars at the bottom of the sidebar, the folder view's filters): the panel
    grows or shrinks to make room, and the thing is uncovered from its top edge down (in a
    bar's row, from its left edge), never faded or scaled. What is below it moves with it.
    Built with `reveal()` in `util.ts`.
  - **At once:** things that float over the page (menus, popups, dropdowns, toasts, tooltips,
    dialogs themselves, the viewer) and switching what a panel shows (another file, chat or
    folder). They cover rather than push, and a delay there only slows you down. Anything not
    named in these rules appears at once too.
  - **Changed midway, it turns round from where it is:** nothing jumps to an end first.
  - **It never holds you up:** the page works during a slide. What is closing can't be
    clicked.
  - **Nothing moves under the pointer** (principle 5) still holds, with one exception: a
    centred dialog grows both ways, so its contents move by half the change, the control just
    used included. That is the price of keeping dialogs centred (2026-10-20). The chat keeps its
    place while a bar opens under the messages: at the bottom, it stays at the bottom.
  - **Reduced motion** (`prefers-reduced-motion`) turns every animation off; every change is
    instant and the page works the same.
  - **No animation library and no CSS `@keyframes` for size:** CSS transitions where both
    ends are known sizes (the chevron, the knob, the search box), `reveal()` where one end is
    the thing's own size.

---

## 6. Controls

### 6.1 Buttons

| Kind | Look | Use |
|---|---|---|
| Normal | `--panel-2`, 1 px border, 4 px radius, `3px 10px` | most actions |
| Primary | blue fill (3.2) | the one next step |
| Danger | red fill (3.3) | destructive confirm |
| Icon | bare 16 px stroke icon in a 22 px box; hover lifts the colour | toolbars, sidebar heads, the hover toolbar |
| Viewer pill | icons in a rounded pill (8 px) | single-item bar, full-window viewer |

- **Disabled:** 45% opacity. Never hidden, if it stops something moving (Save in View is
  reserved, not removed).
- **Icons:**
  - One stroke icon set, the SVGs in `chat.ts` `ICON` and the sidebar heads.
  - Material icons only in the file tree and file rows (VS Code).
  - **No text glyphs as icons in new UI** (the schematic form's ◀ ▶ ✕ and the chat panel's
    » « are today's exceptions).
- **Every icon-only button has a tooltip,** and the tooltip names the shortcut if there is one:
  "Save (Ctrl+S)", "Close (Esc)".

### 6.2 Inputs

- **One text input style:**
  - `--bg` fill, 1 px `--border`, 4 px radius, `4px 8px`.
  - **Focus:** 1 px `--focus` outline plus border.
  - All search boxes use it: top bar, folder bar, board (today there are three looks).
- **Exceptions, each from its source app:**
  - **The chat composer** (Discord): roomy, 8 px radius, lighter fill, no focus ring.
  - **The tree's inline rename** (VS Code): square, `--focus` border.
- **Placeholders** end with "…" when they're an invitation to type ("Search…",
  "Message #general" is a label, so no "…").
- **Sliders are grey,** never the browser's blue. In settings a slider has a fixed
  52 px readout beside it ("+0 dB", "70%"), so the value never wraps.
- **Switch or checkbox:** a **switch** (36×20, off grey, on `--accent`) for an on/off
  that applies at once; a **checkbox** only for picking from a list before a confirm button
  (the private chat member picker).

### 6.3 Menus (right-click and ⋯)

- **Look:** `--panel`, `--border`, 6 px radius, float shadow, minimum width 200 px. The item
  under the pointer is `--active` with white text. Shortcuts are shown on the right, muted.
- **Behaviour:**
  - The opener toggles the menu (a second click closes it).
  - It closes on a click elsewhere, a resize, the window losing focus, or Esc. Esc with a menu
    open only closes the menu.
- **Order:** open/act first, then edit (Rename…, Delete), then copy (Copy Path, Copy Link).
  Separators between the groups.
- **Destructive items** are red text after a separator. An item can ask for a second click:
  the first turns it into "Ban? Click again" (red fill) and the menu stays open; a second
  click within 3 s acts (`MenuItem` extras in util.ts).
- **A choice** (the folder view's sort): the item in use has a tick on the right (`checked`).
- **Keyboard:** ↑/↓ move, Enter picks (VS Code and Discord both do this). Today menus
  are mouse only; it's added in the conformance pass.

### 6.4 Popups (pickers, autocomplete, dropdowns)

The search dropdown is the model. The new pieces must follow it: @mention and emoji
autocomplete, the emoji picker, the member picker for private chats and DMs.
- **Placement:** anchored to what opened it; it stays on screen, flipping above or growing
  leftwards as needed.
- **Look:** a surface (`--panel`, `--border`, 6 px, float shadow). Section heads are 11 px
  uppercase muted ("MESSAGES · 3").
  - **Rows:** `6px 12px`; the highlighted row is `--select`.
  - **Search words:** highlighted with `--flash`.
- **Keys:**
  - **↑/↓** move (wrapping); **Enter** picks (also **Tab** in autocomplete, as Discord);
    **Esc** closes and leaves the text as typed.
  - Moving the mouse over a row highlights it; a click picks.
  - A click outside closes it.
  - The text box keeps focus throughout (rows don't take focus).
- **Empty:** one muted line saying so ("Nothing found.").

### 6.5 Dialogs

- **Look and structure:** centred, 380 px (wide ones 720 px; **settings dialogs 520 px**,
  6.8), `--panel`, 6 px radius, float shadow, over a dark overlay.
  - A title (16 px, a question or a name), a body, an inline red error line, then the buttons
    at the bottom right: **Cancel on the left, confirm on the right**.
- **Opening:** focus goes to the first input, or to the confirm button when there's nothing to
  type.
- **Closing:** **Esc closes every dialog except login.** A click on the overlay does
  nothing, so typed input isn't lost by a stray click. Today dialogs ignore Esc.
- **No browser dialogs:** no `confirm()`, `alert()` or `prompt()`. They don't follow the theme
  or these rules (nine `confirm()` calls are left today).

### 6.6 Confirming and destroying

Today there are five ways: browser `confirm()`, a dialog with a checkbox, a custom "ask"
dialog, click-twice in Admin, and Shift+click. The rule:

- **One way:** a themed dialog whose title is the question ("Delete #builds?"), with a body
  saying what's lost and what stays, and a red confirm button named for the action ("Delete",
  not "OK").
- **"Delete this message?" shows the message** (Discord): drawn as the chat draws it (name,
  time, text, its pictures and file cards) in a bordered box on `--bg` under the title, with
  nothing in it to click. Taller than 200 px, the box scrolls.
- **A folder goes only when someone moves it to Trash.** When the last file in a folder
  goes, one at a time or several at once, the folder stays there, empty.
- **Files are never deleted from Files: they are moved to Trash**, and the page says so
  everywhere ("Move to Trash", "Moved 5 items to Trash"). It asks nothing: they can be
  brought back for 30 days. "Delete" is for what has no Trash: messages, chats, accounts.
  **Delete Forever** and **Empty Trash**, in the Trash, are admins' and do ask, in red.
- **Two allowed shortcuts:**
  - **Shift+click** on a message's trash icon skips the question (Discord).
  - **Admin row actions** (Reset Password, Ban, Delete) keep click-twice-within-3-s, now
    inside each person's "⋯" menu. Admin is used by admins only, and the second click
    is the confirmation.
- **Ask only when something is really lost:**
  - Overwriting something versioned in git is recoverable; say so instead of asking. ("The old
    version stays in its history.") Uploading over a versioned file now just replaces it and
    says so in the toast.
  - Moving a file or folder to Trash doesn't ask (above).
  - Uploading over a file in `large/`, `screenshots/` or `map art/` asks "Replace x?": they
    have no history. The old copy goes to Trash for 30 days, and the question says so.
  - Deleting a message that is the last link to files posted in chat offers to move them to
    Trash too (ticked). From a private chat or a DM it adds that they are kept 30 days and
    only an admin can get them back, since the Trash never shows those.
- **Undo** is on two toasts: "Moved … to Trash" puts back what that move took, and "Moved … to
  <folder>/" (any move in Files: a drag, the folder view, cut and paste) puts each thing back
  in the folder it came from. A rename is not a move and has none; nor has an Undo.

### 6.7 Toasts and banners

- **Toast:**
  - One at a time, top centre, 8 px radius, dismissed by time; a new one replaces it.
  - **Two kinds:** **info** (2.5 s) and **error** (6 s, red edge).
  - **Two have a button:** "Moved … to Trash" and "Moved … to <folder>/" stay 6 s and have
    **Undo** (a blue button after the words, the primary button's look).
  - Progress (uploads) stays until done.
  - Toasts never ask anything; a question is a dialog.
- **Banner:** a `--warn` strip under a file's bar, for "this file changed under you". It stays
  while it's true.

### 6.8 Settings dialogs

From the research in `docs/hub-dialog-conventions.md` (Discord, VS Code, GNOME,
Apple, Fluent all agree), approved by the maintainers. Admin, Voice settings and Sound settings use it,
built from `settingsDialog`, `group`, `row`, `toggle` and `readout` in util.ts. They stay
separate dialogs.
- **Frame:** 520 px, 24 px padding, spacing 4 / 8 / 12 / 16 / 24. A header: the title on the
  left, a close X on the right ("Close (Esc)"). Taller than the window, it scrolls.
- **They apply at once:** no Done or Save, so no blue button. The X and Esc close them.
- **Groups:** an 11 px uppercase muted heading (like popups' section heads), then rows; 24 px
  between groups.
- **Rows:** the title (13 px `--text`) with a muted line under it saying what it does (12 px;
  help goes here, never in a loose paragraph) on the left; the control on the right; at least
  48 px tall with 12 px padding; a hairline (`--border`) above each. Something the full width
  (Voice's level meter) sits under its row.
- **Controls:** selects 220 px wide and 28 px high; sliders 160 px with a readout; switches
  (6.2); buttons grey, never wrapping.
- **A row that doesn't apply** (a sound that's off) is shown at 45% but stays visible.
- **Narrow (under 560 px):** a row stacks, the control under its text.
- **Admin:** Add account at the top (name field, Minecraft name field, blue button); then
  each person as a row: name and badges; under it their Minecraft name ("Minecraft: Name", or
  "No Minecraft name"), then "● online" or "Last seen …"; and "⋯" with what you may do to
  them. Your own row's "⋯" has only Minecraft Name… (no "You" label). Recent activity below.
  - **Minecraft names are an admin's to give** (members forget, and screenshots and game chat
    are credited by it): Minecraft Name… puts a box in the person's row, where the line under
    the name was, with Save beside it. Enter saves, an empty box takes the name away, Esc
    puts the box away and leaves Admin open. The account menu has no such item.
  - **One list for everyone:** no separate owner section. The owner's menus add
    Make Admin on a member, and Reset Password and Remove Admin on an admin (an admin is
    banned or deleted only after Remove Admin).
  - **Badges** are the same as in chat: an admin's tag reads "op" in their tag colour,
    for the owner too; "banned" in red.
  - **Tag colour:** a small swatch (a colour well) on your own row if you're an admin, and on
    every admin's row for the owner, before the "⋯" (whose space is kept, so wells line up). It opens a menu of the nine `--tag-*`
    colours, the current one ringed; a click saves it and every open chat redraws.

---

## 7. Lists, rows and cards

- **Tree rows (VS Code):**
  - **Size:** 24 px, 8 px indent with guides on hover, Material icons.
  - **Selection:** selected rows are grey (`--select`): one after a click or an arrow key,
    several with Ctrl+click (in or out), Shift+click and Shift+↑/↓ (a range from the row last
    clicked), Ctrl+A (every row on screen). Esc goes back to one. The row the keys are on has
    a `--focus` outline while the tree has focus. Neither Ctrl+click nor Shift+click opens
    anything.
  - **Several selected:** the right-click menu on one of them is for all of them (Download
    as Zip, Delete, Copy Paths), and on any other row it selects just that one. Delete asks
    once. Dragging one of them takes the rest along: onto a folder they all move or none
    does (a name taken there stops it and the message names it), into a chat each gets a
    card. Several drag as a small "3 items" label. A folder selected with its own files
    counts once; the fixed top-level folders stay, and the message says so.
  - **Trash** is the tree's last row, a little apart, with a trash icon in grey. It isn't a
    folder: a click opens the Trash, and nothing is renamed, made or uploaded in it. Rows and
    tiles dropped on it are moved to Trash (outlined dashed while they would be). While it is
    open it is the one grey row.
  - **Cut, copy, paste, duplicate** (a file explorer's): Ctrl+X, Ctrl+C and Ctrl+V in the
    tree and the folder view, and Cut, Copy, Paste and Duplicate in the right-click menus
    (Paste greyed while there is nothing to paste; the empty space has it too). The clipboard
    is the hub's own, in this tab: it is not the computer's, so selected text still copies as
    text and a picture on the computer's clipboard still uploads on Ctrl+V. Paste lands in
    the folder of the row the keys are on, or the folder the folder view shows. A cut is
    drawn dimmed until pasted (a move, once) or cancelled with Esc; a copy can be pasted
    again. Where a copy's name is taken it becomes `name copy.md`, then `name copy 2.md`;
    Duplicate is a copy beside the original. A copy of more than 100 MB asks first with the
    size. The copies end up selected. The fixed top-level folders can't be cut or duplicated.
  - **Clicks:** a click opens; only the chevron expands. Plain alphabetical, nothing
    pinned.
- **Chat rows (Discord):**
  - **Size:** 34 px, 6 px radius, a big grey `#`.
  - **Unread:** bold, with a white dot.
  - **Active:** `--tint-3`.
  - **Private chats** show a lock; DMs are listed by their people (see 14).
  - **`#text-link`** has a link icon where the `#` is, in the list and in its title, as
    voice-link has in VOICE.
- **Sidebar sections:** an uppercase 12 px head (FILES, TEXT, VOICE, LIVE), with its
  "+"-style icon buttons on the right.
- **People in VOICE** are drawn in light blurple (`--mention-text`; green while talking), so
  a person never reads as a voice chat's name.
- **#voice-link** (VOICE's first row, where set up): a link icon and its name; under it,
  a step further in, everyone in it, a player in game with their server's tag as in `#text-link`; a
  muted 12 px line "Not connected to the game servers" under the name while that is so.
- **The voice bar's first line** is green "Voice connected". In Chromium, a page with no click
  since it loaded (a take-over of #voice-link after a reload) can't play or send sound: the line
  is then a light blurple (`--mention-text`) "Click to turn on sound and your mic", until one
  click anywhere on the page. Not a toast (one can be missed while you're in game) and not red
  (nothing failed). A take-over that couldn't run shows the bar alone with a red line
  ("Couldn't rejoin voice-link: microphone unavailable"); a click on it clears it.
- **LIVE:** one row per person sharing, a screen icon and their name (a satellite dish for
  a stream sent with OBS), styled like the voice chat rows; your own reads brighter.
  **A tag** is a short line (40 characters) saying what the stream is, set by its person from
  their row's menu (Add Tag…, then Edit Tag… and Remove Tag; an admin's menu has Remove Tag
  on anyone's): a small chip (`--mention-tint`, `--mention-text`) on its own line under the
  name, and after the name in the stream's bar. It goes when the stream ends. The
  picture fills the main panel, letterboxed in black, under the single-item bar (2): whose
  it is and how many are watching, then Stop watching, the sound (a stream's; a shared
  screen has none) and, in the size slot, full screen. Full screen
  has the sound and Exit full screen over the bottom of the picture, each on its own dark
  patch (no bar across), gone after three still seconds. A stream or screen keeps playing
  when you open something else, until Stop watching. While you watch, a bar like the sharing
  one says "Watching" and whose, with mute and Stop, and its words lead back; the row is
  grey while its panel is open and only outlined while something else is. Sharing shows a
  bar above the voice bar ("Sharing your screen", who's watching, Stop). On phones a strip at
  the top of the chat ("… is sharing their screen · Watch") opens it full screen.
- **Messages (Discord):**
  - **Layout:** a time gutter on the left; the name, then the text on the next line, never on
    the name's line; grouped messages show their time on hover.
  - **Phones:** no time gutter. The time follows the name, a grouped message's time isn't
    shown, and the text starts near the left edge.
  - **Hover toolbar:** top right.
  - **(edited):** with the time on hover.
  - **Replies:** the quote above the message; a click jumps to it.
  - **A message meant for you** (it has `@you`, `@everyone` or `@here`, or it answers one of
    yours) has its whole row tinted, `--mention-row` with a 2 px `--mention` line down the
    left. Discord's is gold; the hub keeps gold for its own meanings, as with the NEW line.
    Your own messages are never tinted.
  - **Markdown tables**: GitHub's look: hairline cells, a shaded header row, left
    aligned, every column but the last on one line, wide ones scroll sideways.
  - **Day divider**: a hairline across the feed with the day (Today, Yesterday,
    or the date) centred on it, as in Discord.
  - **Every row has an author.** A row with no name looks like a bug. What the hub or a game
    server posts by itself, with no person behind it, is a message from **MacroTech**, the
    name release cards are posted under, and is drawn like any other message.
- **Cards and tiles:**
  - **Folder tiles:** 16:9 thumbnails.
  - **Picked tiles:** the folder view has its own selection, apart from the tree's, gone
    when another folder opens. Ctrl+click, Shift+click, Ctrl+A and Esc as in the tree (Esc
    with nothing picked goes up a folder), and a box dragged from empty space picks the
    tiles it touches (with Ctrl, adds them; near an edge the folder scrolls). A picked tile
    has `--select` behind it and a `--focus` outline; the box is a translucent `--focus`
    fill with a `--focus` edge. A search or a filter lets go of what it hides. The menu,
    Delete and dragging work as for rows; tiles drop on a folder's tile or on Back to move
    there (outlined dashed while they would).
  - **The Trash** (main panel): a bar with its name and count (admins: Empty Trash on the
    right), then a list, newest first, 900 px at most. A row is the item's icon, its name
    (14 px; a "replaced" chip for the old copy from a replace) over one muted 12 px line
    ("from docs/ · who · when · size · 29 days left"; a chat file reads "from #general"), then
    plain buttons: **Restore**, and for admins **Delete Forever**. Restore puts it back where
    it was (a taken name comes back as `name (restored).md`); a file posted in a chat asks for
    a folder with the Save to Files picker. A row dragged onto a folder in the tree is
    restored there. Files from private chats and DMs never show. Empty: "Trash is empty.
    What you move here stays 30 days."
  - **Schematic cards:** text left, render right, on grey.
  - **Link previews:** a coloured left edge.
  - **Mod release cards**: the link-preview look with
    `--accent` down the left edge; a small uppercase MOD RELEASE label, the mod name (16 px,
    600) with its version in mono beside it, tag chips (Client / Server, Required in `--warn`,
    Optional plain), the changes, and a footer with a Note (only for a special step) and the
    jar's name · size with grey **Readme** (the mod's page in `mods/mod info/`, found by its name;
    "Readme" is the word used everywhere) and **Download** buttons. A jar that left Files
    shows a muted line; a server-only card has only Readme.
  - **Server status card** (`/serverstatus`, see 8): the
    link-preview look with a `--border-hi` edge and a small uppercase SERVER STATUS label.
    Per server: a dot (`--ok`, or a hollow grey ring when offline), its name (15 px, 600),
    "3 online" on the right, the names under it; then mspt as a graph of the last ten minutes
    (a dashed line at 50, where the server falls behind) with the last minute's average and
    the peak (the longest single tick in those ten minutes, so a spike registers), and memory as a bar with used / max. The mspt number is red only at 50 or more.
    An offline server is one line: "Offline · last seen 12 min ago". Numbers are in mono.
  - **Behaviour:** anything that's a file can be dragged into chat, where it is a card.
- **Empty states:** one muted line, in sentence case with a full stop, saying what to do next
  where there is something ("Empty folder. Drop files here to upload them."). One style:
  `.muted.pad`. The file view's centred `.empty` is the exception, for a blank main panel.

---

## 8. Chat specifics

- **Composer** (Discord):
  - **Enter** sends; **Shift+Enter** is a new line; **↑** in an empty box edits your last
    message; **Esc** cancels a reply.
  - **Files** (Discord): a pasted, dropped or picked file (any kind) waits in a tray that is the
    top of the box, as a card: its picture, or its icon, then its name and size, and an x in
    the corner. No link text goes in the box. Up to 10 files a message.
    - **Wherever it comes from, the same card**: the same screenshot dropped from the
      computer and from Files must not give two results. A file or
      folder from Files, a schematic card, a picture or file out of a message: a card,
      linked where it is (a private chat's or DM's file dropped elsewhere: a copy). Only
      text is text.
    - A drop on a message being edited goes into its cards; a drop on a chat's row goes to
      that chat, which opens; a drop anywhere else on the page goes to the chat that is
      showing; the page never opens a dropped file.
    - What is dragged is small, so it hides little of the target: a picture at most 160 px
      wide; a card, tile or several things a label (the "3 items" one).
    - Under a message every linked file, folder or schematic post is a card. Its link text
      shows only inside a sentence (or a quote, list or heading line); alone, it's hidden,
      and no empty line is left.
    - Nothing reaches the hub until Enter. Then the box locks, each card shows its own
      progress along its bottom edge, and the message is posted with its files. A message
      can be files only.
    - A file that fails turns its card's edge and line `--danger`, with Try again beside the
      x. Nothing is posted, and the text stays, until every file is up or removed.
    - The tray stays with its chat like a draft, but only while the page is open: a reload
      forgets it (the browser can't keep hold of a file).
  - Drafts are kept per chat.
  - **A sent message shows at once** (Discord): in the feed, last, with its text and previews
    at half strength and no toolbar, until the hub has it; then it is the real message.
    One the hub refuses or can't be reached for stays, its text in `--danger`, with a line
    under it: "Couldn’t send it: <why>. **Retry** · **Delete**" (the two in `--link`). The
    box is empty either way. These live in the page only: a reload forgets them.
  - **Ctrl+B, Ctrl+I, Ctrl+U** (Discord) put `**`, `*` or `__` around the selected text, or
    take them off if they're there; with nothing selected, an empty pair with the cursor
    inside. Ctrl+Z undoes it. They work in a message being edited too.
  - **The box grows with its text** up to half the chat's height, then scrolls inside
    (Discord). The same for a message being edited in place: the feed keeps its place while
    you type, and the whole edit box with the line under it stays in view.
- **Commands** (`commands.ts`): a message that is only `/name` of a command isn't
  posted; it runs. Typing `/` at the start of the message box lists them in the autocomplete
  popup (6.4; the name in mono, what it does muted). Anything else starting with `/` is an
  ordinary message.
  - **Private replies:** a command's answer is drawn in the chat for you alone, under the
    newest message, with no name or time, and a line under it: an eye, "Only you can see
    this · **Dismiss**" (Dismiss in `--link`), as Discord does. It's never stored: Dismiss,
    leaving the chat or reloading removes it. In the side chat it starts at the left edge.
- **The server link** (`internal/server/link.go`): the chat `#text-link` (`#server-link`
  until 2026-10-13; old links follow) is always there on a hub with a game server: no Rename
  or Delete in its menu, and the hub refuses both. It is
  shared with game chat on our servers. A line a player starts with `$ ` in game shows here,
  and everything said here shows in game, in aqua, as `[SMP] name: text` (`[CMP]`, `[HUB]`).
  Nothing else crosses. Names: hub names here (a linked Minecraft name posts as its hub
  account), Minecraft names in game, also for what's typed here.
  - A message said in game has a small quiet tag after the name, **SMP** or **CMP**
    (`.tag.via`: `--panel-2`, muted text, a hairline), with "Said in game on Survival" on
    hover. The same name from another place starts a new header.
  - The chat has a muted line at the top, like a private chat's, with a link icon: what it's
    linked to and how to send from the game.
  - What a server reports by itself (a bot's death) is a message from **MacroTech** with that
    server's tag: `MacroTech SMP`, then the game's own line, "squidbot was slain by Drowned".
    In game it is `[SMP] squidbot was slain by Drowned`, with no name.
- **Editing a message**:
  - The box holds the words only. The message's files are cards under it (the tray's cards),
    each with an x; Save takes the removed ones out of the message, and the hub trashes
    those nothing else links. Files can't be added. Saving with no words and no files left
    asks "Delete this message?" instead (Discord).
  - Desktop has no buttons, only the hint "Enter to save · Esc to cancel", with **Enter** and
    **Esc** in `--mention` blurple. Both are clickable (like Discord's): Enter saves, Esc
    cancels.
  - Phones (under 700 px) show **Save** and **Cancel**, and no hint.
- **Message sound**: three soft glass notes (C#6 A5 E6), the hub's sound. It's
  made by `web/src/sounds/make-message.py`: change it there, never by hand. Every
  detail was tuned by ear: the pitch, the rhythm, the soft strike, the quick fade after 150 ms (so it
  doesn't hang like a clock chime), and the level: 70% in paplay, which is cubic (0.34).
  The file is at full strength; Sound Settings' default of 70% gives the chosen level, with room
  above. When it plays: `ding.ts`.
- **Sound Settings** (the menu on your name): one section per sound, each with a
  switch, a Volume slider (cubic like the system's; letting go plays it; **70% by default**,
  each sound's chosen level, so people can turn it up; a small tick above the slider marks
  it) and **Test**.
  Today: Message sound and Voice chat sounds. New sounds get a section here. Voice Settings
  keeps the microphone and the output (Speaker, Output volume 0–200% squared, a tick at 100%).
- **Right-clicking someone in a voice chat** (Discord's conventions): Join or
  Leave (and Invite People… for a private one's starter), then **Message**; in your own
  voice chat **User Volume** (a slider in the menu, 0–200%, a tick at 100%, squared, saved
  per person per browser) and **Mute** (for you only); for an admin on someone below them,
  **Mute for Everyone** (until they unmute; they're told) and **Disconnect** (red, asks for a
  second click; they can rejoin). Both are in Admin's recent activity.
- **Hover-only buttons on phones** (the message toolbar, + reaction): a tap on a message
  only shows them. The same tap never presses one that appeared under the finger. They act
  only for a press that began on them (`pressedOn` in `chat.ts`; the `phone-taps` suite).
- **Files posted in chat**:
  - Any file up to 50 MB is kept with the chat; the stored message holds a link
    (`#media/<chat>/<file>`) that people never see or type (not in the box, not while
    editing, not in Copy Text), shown under it: pictures, video and sound as previews, anything
    else as a file card (icon, name in `--link`, size, a Download icon button).
  - A preview is never wider than the message column: on a phone it shrinks to fit, keeping
    its shape, and the feed never scrolls sideways.
  - Bigger files: "Add <name> to Files?" offers `large/` (Cancel, **Add and link** blue).
  - **Save to Files…** (toolbar icon, ⋯ and right-click, the viewer, the chat's file list)
    copies files into a folder picked as below.
  - **Files in this chat:** the paperclip next to the 📌 in a chat's header, a popover like
    pins: thumbnail or icon, name, who · when · size; a row jumps to its message, and on hover
    shows Download and Save to Files….
- **Text**: Discord's Markdown subset (see Formatting in 14).
  - **Where formatting shows:**
    - **Full** where whole messages show: the message, pins, the forward preview.
    - **Stripped to plain text** in one-line snippets: reply quotes, search results.
    - That's what Discord does.
- **Mentions:** `@name`, `@everyone` and `@here` are highlighted in `--mention`. No
  notifications.
- **Read markers:** unread dots, Mark as read, the count in the tab title. The NEW
  line and Jump to present (see 14).
- **Times:**
  - **Message:** time of day; the full date and time on hover.
  - **Day dividers:** Today, Yesterday, or the date.
  - **One date format everywhere else** (lists, search, viewer): "Oct 2" this year,
    "Oct 2, 2025" before. Relative times ("3 min ago") only for "last seen" and history.

---

## 9. Files specifics

- **Editor**:
  - Text opens in **View** (read-only): Markdown rendered, other text in a plain read-only
    editor.
  - **One blue Edit** turns into **Cancel**; a **grey Save** to its left turns blue with
    unsaved changes.
  - **Your place** in the file is kept across View, Edit and History. Text size (the bar's Size
    slider, Ctrl+wheel; the percentage is in the slider's tooltip, a double-click is 100%) is remembered.
  - **The editor is plain:** no suggestions, hovers, squiggles or auto-brackets; long lines
    wrap.
- **Unsaved changes:**
  - One sentence everywhere: "You have unsaved changes to X. Discard them?".
  - Asked on Cancel, Back, Esc, opening another file, and the browser's Back.
- **Saving is safe:**
  - A stale save is refused and both versions are shown side by side.
  - Moves are followed by links and open tabs.
- **Sound files** (mp3, ogg, wav, m4a, flac) are media like pictures and videos: a folder
  tile with a play mark, and a player under the single-item bar, with ←/→ to the next file.
  No full window: there is nothing to show.
- **Areas without history:** `large/`, `screenshots/`, `map art/` (and files posted in chat).
  - Uploading to them, or deleting from them, says that nothing can be brought back.
  - They can't be renamed or deleted themselves.
- **Schematic posts are edited in place**: Edit keeps the post's page and layout.
  The title, credit and description become boxes whose text sits where the text was; each
  picture gets Move up, Move down and Remove, and a dashed Add pictures tile follows them.
  The bar shows grey Save (blue once something changed) and Cancel, as for a text file.
  Cancel, Back, Esc or another post with unsaved changes asks "Discard your changes to …?".
  The description is edited as plain text. A new post is the same page, empty. There is no
  separate form.
- **Folder view**:
  - One for every folder: back, title, count, Upload, the search glass, search, sort, Size.
  - **Search:** hidden until the glass at the right end of the icon buttons is clicked.
    The glass turns light blue (`--link`: it's on, like a switch) and the buttons slide left
    as the box comes in (0.2 s). A second click, or Esc in the box, slides it out and clears it.
  - **Filters:** a folder of stamped names (screenshots) shows one **Filters**
    button. A click brings who / From / To / Clear out to its left; a second click puts them
    away. While a filter is set they stay out and **Clear is blue** (the way back, 3.2).
  - **The Schematic Manager's New post** sits on the right, by its search box.
  - **Sort:** a text button that reads the sort in use, "sort:name" or "sort:date"; a click opens a
    menu with Name and Date modified, the one in use ticked. Date is newest first, folders
    too (a folder's date is its newest file's, shown on its tile while sorted by date). One
    choice for every folder, kept per browser; ←/→ in the single view follow it.
  - Ctrl+V pastes pictures (named `<date> <time> <poster>`).
  - A click on a tile opens its single view; full window is one more click.

---

## 10. Keyboard

| Where | Keys |
|---|---|
| Anywhere | `/` or Ctrl+K: search. Esc: close the menu, popup or dialog on top (one layer per press). Alt+←/→: back and forward |
| Tree | ↑/↓, Home/End, →/← expand or collapse (then into or out of a folder), Enter, F2 rename, Delete moves to Trash. Ctrl+click, Shift+click and Shift+↑/↓ select several, Ctrl+A all. Ctrl+X, Ctrl+C, Ctrl+V cut, copy, paste. Esc cancels a cut, or goes back to one row |
| Single item | ←/→ previous or next picture or post, Esc back to its folder or the board |
| Folder view | Ctrl+click, Shift+click or a box dragged from empty space pick several, Ctrl+A all, Delete moves to Trash. Ctrl+X, Ctrl+C, Ctrl+V cut, copy, paste (Ctrl+V also pastes pictures). Esc cancels a cut, lets go of the picked, then goes up one folder |
| Text file | Ctrl+S save, Ctrl+wheel zoom |
| Composer | Enter, Shift+Enter, ↑ edit last, Esc cancel reply, Ctrl+B / Ctrl+I / Ctrl+U bold, italic, underline (also while editing a message) |
| Popups | ↑/↓, Enter/Tab, Esc |
| Viewer | ←/→, Esc |

- **Rules:**
  - A shortcut never fires while you're typing in a box (one shared check: `typing(e)` in
    util).
  - Shortcuts appear in tooltips and on menu items, not in labels.
- **Keyboard shortcuts list:** a "Keyboard shortcuts" item in the account menu, showing this table
  (Discord has Ctrl+/). It's cheap, and it helps the non-technical players most.

---

## 11. Words

- **Names:** on the hub, hub names; in the game, game names. Wherever the hub shows a person
  it shows their hub account name: a player in game whose Minecraft name is linked to an
  account (an admin sets it) appears under that account's name (in #voice-link's list with
  their server's tag, in #text-link, in the status card, on screenshots); a player linked to
  no account has only their Minecraft name, so that is shown. The game shows game names: a
  hub member with a linked name appears in game as that player.
- **Voice:**
  - Plain, short and friendly. Second person for you ("your changes"); a name, or "Someone",
    for others.
  - Warnings say what happens, then what remains: "Delete #builds? Its messages are kept on
    the server."
  - No "Warning:", no exclamation marks, no jargon (no "commit", "repo", "directory").
- **Words we use:**

  | Use | Not |
  |---|---|
  | chat | channel |
  | folder | directory |
  | panel | pane |
  | file | document |
  | post (a schematic post) | entry |
  | admin | moderator |
  | Files (the section) | |
  | Schematic Manager | |
  | Delete (destroys) | |
  | Remove (takes out of a list, nothing destroyed: Remove admin, removing a picture from a post being edited) | |
  | Forward (the dialog's button too) | Send |

  "op" is only the badge text.
- **Case:**
  - **Title Case** for menu items only ("Copy Link", "Open in Side Panel"), which is what
    both apps do.
  - **Sentence case** everywhere else: buttons, tooltips, dialog titles, headings.
  - So the chat hover tooltips become "Add reaction" and "Copy text". Today they copy the menu
    items' Title Case.
- **"…" (one character, U+2026):**
  - Ends a menu item or button that needs more from you before it acts: a name box, a picker,
    a form (New File…, Rename…, Upload…, Forward…, Add Reaction…).
  - **Not** on items that only ask "are you sure": Delete has none (today the chat menu's
    Delete… does).
- **Punctuation:**
  - Typographic apostrophes (’) and quotes (“ ”).
  - Full stops on sentences, not on labels or one-word toasts ("Saved", "Copied").
- **Errors:** "Couldn’t <do it>." plus the reason if known: "Couldn’t send it: the chat was
  deleted." Never just "Failed", never a raw server string in lower case.
- **Irreversible:** one phrase: "This can’t be undone." Today there are four ("has no history",
  "can’t be brought back", "gone for good", "can’t be undone").

---

## 12. Accessibility baseline

The minimum, because the audience includes people who aren't
at home in apps like this:
- **Focus:** everything clickable can be reached and used by keyboard; focus is always visible
  (`--focus`).
- **Contrast:** text at least 4.5:1 against its background (the muted greys pass on the panels;
  check new ones).
- **Targets:** at least 22 px for icon buttons (they are today); 32 px on phones.
- **Motion:** `prefers-reduced-motion` turns every animation off (5, Motion).
- **Tooltips:** every icon button has one; images have `alt` (emoji keep the character).

---

## 13. Browsers and verification

- **Supported browsers:** Firefox (the maintainer's: forced WebRender, NVIDIA) and Chromium-based
  browsers, desktop; phones for chat. Nothing older than a year.
- **Every change gets a test that fails on the old code** (`make browser-test`, Chromium).
- **Styling changes also run `make firefox-check`:**
  - It compares the real screen with Firefox's own capture, view by view.
  - It opens a window for about a minute, so **ask the maintainer first**, and an agent never runs it: it says in the pull request that
    the change needs it.
  - New views (popups, dialogs) are added to it.
- **The maintainer looks only at the live hub;** a local hub started for a test is a throwaway
  tool, not something to show.

---

## 14. Patterns for pieces built on the basics

- **@mention and `:emoji:` autocomplete:** a popup (6.4) above the caret. Rows are
  avatar-less: a name, or an emoji with its `:name:`. Tab or Enter inserts.
- **Emoji picker:** a popup with search at the top (focused), a row of category icons,
  Recently used first, then a grid.
- **NEW line:** a 1 px `--mention` line across the list with a small "NEW" tag on the
  right (3.3).
- **Jump to present:** a pill at the bottom centre of the message list, `--panel-2` with a
  shadow, "Jump to present ↓"; it shows only when you're well up the history.
- **Formatting:**
  - **Code blocks:** `--bg`, 4 px, mono, a copy icon on hover (top right).
  - **Quotes:** a 4 px `--border` bar on the left.
  - **Spoilers:** a solid `--panel-2` block until clicked.
- **Folder picker (Save to Files…):** a dialog, "Save <name> to Files?". The body is
  a folder box and list (the tree's selected folder by default; typing narrows it or names a
  new folder). The buttons are Cancel and **Save** (blue).
- **Private chats and DMs:**
  - **Lock:** a lock stroke icon after the `#` of private chats (and after a private voice
    chat's first row). The same icon has a second meaning in one place: **the lock in
    #voice-link**, at the right end of your own row only (docs/voice/svc/lock-spec.md): open
    and dim (`--muted`, 55%) when off, closed in light blurple (`--mention-text`) on a
    `--mention-tint` chip when on, red (`--danger`) when the page has lost your microphone. Its hints: "Stay in voice-link when you leave the game",
    "Staying in voice-link when you leave the game. Click to stop", "Click here to stay in
    voice-link when you leave the game".
  - **DMs sit in TEXT** (no separate DIRECT MESSAGES section), after the chats,
    shown as "@" and the people. Each section's "+" does its own job: TEXT's is a menu (New
    Chat, New Private Chat… (admins), New Direct Message…), VOICE's is a menu (New Voice
    Chat, New Private Voice Chat…), LIVE's shares your screen.
  - **Starting one:** New Direct Message… or New Private Chat… opens a **member picker** dialog: search, a checkbox list of
    accounts, then the confirm button "Message" (DM) or "Create" (private chat, admins).
  - **The privacy caveat:** a muted line in the DM and private-chat headers.
- **Back and Forward:** no UI of its own. Browser Back, the mouse's back button and
  Alt+←/→ move between places, and unsaved edits still ask (9).

---

## 15. Where the code breaks the guide

Nothing is known to break it. New gaps go here as they are found, and are fixed.
