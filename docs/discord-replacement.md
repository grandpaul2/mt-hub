# Replacing Discord — our own workspace ("the hub")

Started 2026-10-01. Reasons for leaving Discord: ads, privacy, and it's the wrong shape. Most of
what we share is **files** (schematics, screenshots, mods, world downloads), and those get
buried in channels. Discord's 10 MB upload limit is why client packs are split into parts.

Voice moves in-game: Simple Voice Chat or Plasmo Voice. Both need an **extra UDP port** on the
game server, so add it to the host checklist in `hosting-migration.md`.

## Design (2026-10-01, Paul + Claude)

**What it is:** a shared VS Code-style workspace with text channels. You pick a file to
preview, download or edit, or you chat in a channel. We build and own it. It runs on
home-server and is reached through the relay VPS. The relay (`server/relay/`) is the model:
shell access, config files in git, a runbook in the ops repo, no GUI admin, no password prompts.
Working name "the hub"; the real name is TBD.

### Requirements (Paul's answers)
- **≤ 10 users** for now. Small enough that one process and SQLite are plenty.
- **No live co-editing.** Save, and warn on a conflict.
- **Phones get text channels only.** The full workspace is a desktop thing.
- Command line first for admin and daily use. Every feature goes through an HTTP API, and the
  web page is just one client of it.

### Layout
- **Desktop web page:**
  - **Left sidebar:** the file tree, with text channels listed below it.
  - **Main pane:** the open file.
    - Text and config files open in the Monaco editor (VS Code's editor component).
    - Images and markdown get previewed.
    - `.litematic` shows an info card first: size, block counts, author. A 3D preview comes
      later; Schem-at/schematic-renderer (AGPL-3.0, Three.js + WASM) is the best base.
    - Anything else shows metadata and a download button.
    - Every file has a history view (who changed what, plus revert).
  - **Right pane:** the active channel.
- **Phone (same URL, narrow layout):** channel list and chat only. A file link in a message
  downloads the file, or shows it if it's an image. No tree and no editor.
- **File links in chat:** `#path/to/file` becomes a link that opens the file in the main pane.

### Architecture
- **One Go program** (`mthub`, single binary), serving the API, the websocket and the static
  frontend. Go because the binary is easy to deploy, and it cross-compiles the `mt` CLI for
  Windows players too.
- **Workspace = a git repo on disk.** Every save, upload, move or delete is a commit authored
  by the acting user. That gives history, blame and revert for free. The server drives the git
  CLI. Users never see git.
- **Large files** (worlds, client packs) live outside git in a plain `large/` area, listed in
  the same tree with a marker. They get no history, only uploader and time. Threshold: about
  50 MB, tunable.
- **Chat = SQLite**: channels, messages, edits, reactions later. New messages and file changes
  are pushed live to open pages over one websocket. Unread state is tracked per user.
- **Conflict rule:** the client sends the commit it opened the file at. If the file changed
  since then, the save is refused and the user sees a diff, with a choice to overwrite or copy
  their version.
- **Frontend:** plain TypeScript with Monaco, no framework, built into the binary.

### API sketch (all JSON, token auth)
- `GET /api/tree`, `GET /api/file/<path>` (with `?rev=`), `PUT /api/file/<path>` (with
  `base_rev`), `POST /api/upload`, `POST /api/move`, `DELETE /api/file/<path>`,
  `GET /api/history/<path>`
- `GET /api/channels`, `GET /api/channels/<id>/messages?before=`,
  `POST /api/channels/<id>/messages`
- `GET /api/ws` for the live events: new message, file changed, presence

### CLI (`mt`)
`mt ls [path]`, `mt get <path>`, `mt push <local> [path]`, `mt log <path>`, `mt say <channel>
"..."`, `mt tail <channel>`. The token lives in `~/.config/mt/token`.

### Accounts
- One account per person, created with `mthub user add <name>` on the box. That prints an
  invite link, where the user sets a password.
- The web login is a session cookie. The CLI, the game client and bots use long-lived
  per-device tokens, which can be revoked.
- Roles: `admin` (Paul and two others) and `member`. No per-folder permissions until a
  need shows up.

### Integrations
- **BotSpawner** currently reads its macros from a Discord channel over Discord's REST API.
  Change it to read from a hub channel instead. This removes our only code dependency on
  Discord.
- **mt-utils in-game client** (later): list schematics and pull one into Litematica's
  `schematics/`. It might also show chat. It uses the same API and a per-device token.

### Build status
- **2026-10-01:** in `~/mt-hub` (`grandpaul2/mt-hub`, private).
  - Working: files (tree, editor, preview, upload, history, conflict-safe saves), plus
    editing directly over ssh, which is auto-committed.
  - The `mt` CLI was built, then dropped until players without ssh need it (git `aac2023`).
  - One copy runs on home-server over the tailnet; runbook in `server/hub/README.md`.
  - **Accounts were built, then removed at Paul's request while building.** People just
    type a name. Bring accounts back (git `b73ee81`) before going public.
  - Large-files area done: `large/` sits outside git, and uploads elsewhere are capped at
    50 MB. **Milestone 1 complete.**
  - **Milestone 2 (chat) done:**
    - storage is plain JSONL files rather than SQLite (Paul's call; tiny scale)
    - live updates over SSE
    - `#path` file links
    - chat-only phone layout
  - **S36–S37 (2026-10-01):** screenshots, map art and schematics galleries (Discord imports),
    VS Code-style Files tree with moves, link previews, Discord-style chat list.
  - **S38 (2026-10-01/02):**
    - nightly backups to a USB stick (`server/hub/README.md` "Backups")
    - browser test suites in the repo (`make browser-test`, parallel, ~27 s)
    - chat message actions (react, reply, forward, edit, copy, delete; admin-only pins)
    - chat media in `media/<chat>/` (no history; the chat holds only a link plus a preview)
    - folder previews for media folders
    - one full-window picture viewer used everywhere
    - @mention highlights (no notifications, probably ever)
    - #general's last 100 Discord messages imported as **test data** (to be deleted)
  - **S39–S40 (2026-10-02):** everything became files. One folder view for every folder
    (grid, search, Size, back/Esc); screenshots and map art are plain no-history folders
    (names carry poster and date); each schematic post is a folder (file, renders, README.md)
    shown by the **Schematic Manager** (big-card board, button at the bottom of the sidebar).
    The separate gallery/schematics stores are gone. Every folder has a README.
  - **S41 (2026-10-02):** auth and public access. Accounts in `~/hub/users.json` (set with
    `mthub passwd`), signed session cookies, everything behind login; grandpaul and one other
    are admins. Public at `https://macrotechmc.com` (Porkbun domain, Caddy on the relay
    VPS, ssh tunnel from home-server), so a non-technical player only needs the address.
    Failed logins are limited per address. Chat authors `Paul` became `grandpaul`.
    Last 100 messages of #ongoing-project-discussion, #links and #music imported into
    project-updates, links and music (a one-off import script). Branding:
    MACROTECHMC.COM top left; admin badges read "op" (grandpaul gold, others purple).
  - **S42 (2026-10-02):**
    - Admin page: ban/unban (cuts open pages at once), reset password, add, delete,
      last seen, admin log; grandpaul is owner (owner-only section for admins)
    - the hub ships its own fonts (Noto Sans, JetBrains Mono)
    - Discord-style chat layout (time gutter, indented content)
    - chat scroll holds its place on resize
    - text files open in View with one Edit/Cancel button, zoom, place kept
    - `make firefox-check`: a real Firefox window with GPU rendering, screen vs Firefox's
      own capture. It found g/p/y losing their bottom pixel row in file-tree names.
  - Next: more refinement, then milestone 3 (move off Discord).

### Staging (decided 2026-10-01, changed 2026-10-02)
At first: no domain, LAN/tailnet only, testers through a Tailscale share. Changed in S41:
Not every admin is technical, and some need just an address, and players get uneasy at the browser's
"not secure" warning on a plain-http login. So the hub went public behind a login, early,
with HTTPS. The relay VPS is shared with the stream relay (fine at this size; move Caddy and
the tunnel to their own VPS if bandwidth ever competes).

### Deploy (as built: `~/mt-hub/README.md` "Where it runs"; the original plan follows)
- **home-server:**
  - unprivileged `mthub` user, data in `/srv/mthub/` (`workspace/`, `large/`, `hub.db`)
  - systemd service
  - kept separate from `~/backups/minecraft/`
- **Tunnel:** a systemd unit on home-server holds `ssh -N -R 127.0.0.1:<port>:localhost:<port>`
  open to the VPS with a restricted key. No router changes; the Spectrum gateway can't
  port-forward.
- **VPS:** Caddy reverse-proxies the domain to the tunnel port, with automatic HTTPS. This
  needs a domain (about $10/yr).
- **Backups:** nightly copy of `/srv/mthub/` (git repo + `large/` + a SQLite `.backup`) to a
  second location. home-server is currently the only copy of everything.
- **Source:** its own repo `~/mt-hub` with a private GitHub remote. The runbook and config
  templates go here, under `server/hub/`.

### Milestones
1. **Files:** tree, preview, Monaco edit with conflict check, upload/download, history,
   accounts, `mt` CLI, deploy plus tunnel plus Caddy.
2. **Chat:** channels, websocket, unreads, `#file` links, phone layout.
3. **Move off Discord:** BotSpawner migration, copy over the schematics and pinned material
   we want to keep, invite everyone.
4. **Later:** in-game client, `.litematic` 3D preview, threads. (Reactions done S38; push
   notifications not wanted.)

### Open checks before going public
- Home upload speed (`speedtest-cli` on home-server) decides whether big downloads are
  reasonable from home.
- A second copy of the world backups and the hub data must exist before the hub's address is
  shared. **Done S38** (USB stick in home-server). An off-site copy is still missing.
- Pick the domain and the name.

## History: Nextcloud trial, abandoned 2026-10-01
We first tried managed Nextcloud on Hetzner Storage Share (`nx109294`, about €4.29/mo). Paul
stopped within an hour: "our actual solution needs to have a command line".
- There's no shell; admin work happens in web settings pages.
- Every admin API call needs a live password confirmation.

That's where the requirement above comes from. Any replacement is command line first, on
infrastructure we own. Billing is hourly; cancel before the 2026-10-08 invoice.
