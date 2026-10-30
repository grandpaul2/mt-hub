# LATER: ideas and work held for later

Not built, and not being worked on now. [`OPEN.md`](OPEN.md) is the work for now; an item moves
there when someone takes it up. Any of these is fair game, and so is something not listed.
Like `OPEN.md`, this is state: an item that is built or dropped leaves, and a decision is kept
where it belongs (the style guide for how the hub looks and behaves).

## From the stocktake

The numbers are from the stocktake ([`docs/stocktake.md`](docs/stocktake.md)), so an idea keeps
its number when others are done.

- **7 Chat groups and topics.** Group chats under collapsible categories, and a one-line topic
  in each header. (The order of the chat list is already set by admins.)
- **8 Chat shortcuts.** Alt+↑/↓ previous or next chat, Alt+Shift+↑/↓ next unread chat, Esc marks
  the chat read and scrolls down, Ctrl+K jumps to a chat by name (the search box could take
  `#gen` then Enter).
- **9 Big emoji.** A message that is only emoji shows them large.
- **11 Mark unread from here.** Alt+click a message, to come back to it later.
- **14 Threads.** Discord has them; the hub has replies. Probably never.
- **17 Several files open, or recent files.** One file at a time today. Tabs are a code
  editor's thing; a "Recent" list may suit non-technical people better.
- **20 Clickable path (breadcrumbs)** in the file bar.
- **21 Recent changes.** One list of what changed lately across all files (who, what, when):
  "what did people do while I was away".
- **22 Markdown side by side.** Edit on the left, rendered on the right.
- **23 Ctrl+P: open a file by name.** The search box does this; the shortcut is a habit.

Tried and dropped: **6 avatars and a name card.** Built and tried live (the linked Minecraft
face or a coloured initial on messages, pins, voice rows and the account button); too busy in
chat and voice. The style guide records the decision.

## Other ideas

- **Regroup the style guide:** section 7 holds chat messages, voice and LIVE, Trash,
  selection and cut/paste; move them into Chat, Files and a new Voice and Live section, and
  fold section 14 into the others. About 100–150 lines shorter with no rule lost, but every
  section number after 7 changes, and the code's comments cite them ("style guide 6.8"), so
  those are updated with it. A whole-guide review lists what goes where.
- **Notifications, presence, status:** unread pings, online dots, typing. Maybe never. A
  new-message sound exists (a new message from someone else, unless a focused tab shows that
  chat; at most once in 3 s across tabs; Sound Settings in the name menu). A browser plays
  sound only after a click or key press in the page, so a tab opened and never touched stays
  silent, and phones pause background tabs. Real push notifications would be a separate,
  bigger job.
- **Emoji skin tones and custom emoji.**
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
- **Top-bar wiring (paused):** PCB traces as a subtle texture behind the logo. The mockup with
  the router is `topbar/wiring-mockup.html` (open it in Firefox; Shuffle re-rolls). Where it
  got to:
  - **Colour:** one grey (#2a2b2d) with a lighter rim (#404143), plus at most one red wire.
    No black or dark grey; the bar stays `--top` grey.
  - **Wires:** 6 px with rounded corners, 13 px apart, 45° turns, never crossing.
  - **Layout:** a crop of a bigger board. Wires drop in from above or below, turn, run along
    and leave, so you rarely see a whole wire. At most 2 to 3 vias visible.
  - **Rejected on the way:** thin edge dashes, a darker bar, radiating from the logo.

## Voice

- A TURN relay on 443 for players on networks that block UDP and port 7881. It clashes with
  a reverse proxy on the same port, so it is left out until someone cannot connect.
- A wireless headset that garbles the first sound after a silence while it wakes up. A quiet
  lead-in and a constant hum did not fix it reliably. It is the headset, not the hub; only
  worth chasing if others hear it too.

### Voice Link hardening

Found by code reviews of the voice-link work and judged too unlikely to be worth it for now.

- **The bridge (`internal/voicebridge`):** cap a game server's roster, and accept a player's
  audio only from that player's server; back off when LiveKit drops a player right after
  joining; avoid a flap for two players with one name; hold roster changes during a LiveKit
  reconnect; repair participants' `mc` attribute in the 20 s check.
- **The hub's voice lock and voice list (`internal/server/voice*.go`):** the sweep re-checks
  before it unlocks; saves sync the file and report write errors; the voice list is written
  after the voice lock is released; the 20 s check does not drop someone who joined while it
  ran. A late `participant_left` of a replaced `link:` participant can drop a live row until
  the 20 s resync (that branch has no session check, unlike ordinary accounts'); a stale one
  from another server's `link:` participant can delete a fresh cut mark; a fresh mark left
  behind by a join by hand that was left within a second refuses that player's Join for up to
  10 s; the 20 s resync can apply a snapshot taken just before a cut or a join.
- **The relay (`internal/voicelink`):** refuse a server name with ":"; resend the game
  servers' rosters every 30 s.
- **The hand-over (#55, #56):** a few frames of hub voice in flight reach the game just after a
  put; an answer to a question asked before a Simple Voice Chat reconnect is still used once; a
  late cut on a refused join by hand leaves a hand-over mark; a join of voice-link while already
  in it cuts the hub side anyway. No test yet for a batch of cuts or a cut past the 2 s
  deadline.
- **The page:** re-check the player is still gone before a take-over; a failed Voice Settings
  rebuild leaves its half-built chain running; a muted joiner's microphone is live for the
  moment between publishing and muting.
