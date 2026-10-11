# Accounts, tokens and private chats

How the hub's people and game servers log in, and who may do what. Data directory paths are
relative to `<data>`, the directory given to `mthub -data`.

**Everything is behind a login.** There is no sign-up: accounts are made by an admin on the
Admin page, or with `mthub passwd` on the hub's machine (below). They live in
`<data>/users.json` (name, `owner`, `admin`, `banned`, bcrypt hash); the hub rereads it when it
changes, so no restart is needed. The owner is not a fixed name: it is the account with the
`owner` flag, which only `mthub user -owner=true <name>` can set.

**The Admin page** (menu on your name, admins only) lists every account with when it last had
the hub open, with Ban/Unban, Reset password (a temporary one, shown once) and Delete on each
member, and Add account (also a temporary password). Ban, Reset and Delete need a second click.
Every admin sees the same page, one list; each person's ⋯ menu holds what you may do to them.
The owner's menus also have Make Admin on a member, and Reset password and Remove admin on an
admin. Recent actions are listed under it (`<data>/admin-log.jsonl`); last-seen times are in
`<data>/seen.json`.

- **Who may do what:** admins act on regular members. Only the owner (the account flagged
  `owner`) can make or
  remove admins or reset one's password, and nobody can act on the owner. To ban or delete an
  admin, remove admin first.
- **A ban is immediate:** the banned person's requests are refused, and their open pages drop
  to the login form, which says the account is banned. Unbanning restores their old logins.
- **Deleting** an account keeps their messages and files under their name.

On the hub's machine (the only way to set the owner, and a ban that works without the page):

    mthub passwd -data <data> [-admin=true] <name>     # set a password (makes the account if new)
    mthub user -data <data> -banned=true <name>        # or -admin=true, -owner=true

The flags go before the name. `passwd` asks for the password twice on a terminal, or reads one
line from standard input (8 characters at least). To start a new hub, make the first account
and make it the owner:

    mthub passwd -data <data> -admin=true alice
    mthub user -data <data> -owner=true alice

A login is a signed cookie that lasts 60 days from when the hub was last used (renewed at most
daily; the key is `<data>/secret`, and replacing it logs everyone out). Changing your password,
or **Log Out Everywhere** (both in the menu on your name), logs out your other sessions.
Password guesses are limited per address (5 in 15 minutes) and per account (10 an hour), at
login and in Change Password; a right password clears both. A new account's or reset
password is temporary: until its owner picks their own, every call but `/api/me`,
`/api/password` and `/api/logout` answers 403, and the page asks for a new one.

Admins can also rename and delete chats, pin, and delete or edit anyone's messages.

**Server tokens: how game servers log in** (`internal/auth/tokens.go`, `<data>/tokens.json`).
The MT Hub Server mod ([`mthub-mod`](https://github.com/grandpaul2/mthub-mod)) on a game
server does the hub's work for that server's players: `/b`'s shortcuts, the schematics list
and files, and posting screenshots. Players never log in from the game.
- **Format:** sent as `Authorization: Bearer mt_<id>_<secret>`. Tokens never expire, and are
  revoked by hand: make a new one (and revoke the old) when someone loses access to that
  server's panel.
- **Storage:** only a hash is stored. A token is shown once, when it's made (below).
- **A token reaches only its routes** (`tokenAllow` in `internal/server/tokens.go`):
  `/api/me`, reading `commands/`, `/api/schematics`, `GET /api/file/schematics/…`,
  `POST /api/screenshots`, `POST /api/server-status` and `/api/server-link` (reading and
  posting). Everything else is 403. A token sitting in a config file on a rented server can't
  read chats, edit files or touch accounts.
- **Screenshots:** a server names the player with `?poster=<Minecraft name>` (letters, digits,
  `_`, 1–16 characters). If someone linked that Minecraft name to their account (menu on your
  name → Minecraft Name; one account per name, any case), the screenshot goes under their hub
  name. Otherwise it goes under the Minecraft name.

        mthub token -data <data> add -server survival   # prints the token once
        mthub token -data <data> list
        mthub token -data <data> revoke <id>

**The release token:** mod release cards are posted to #mod-discussion with it, as
**MacroTech**. It isn't an account (no login, and no account may be named MacroTech) and reaches
only
`GET /api/me` and posting, editing or deleting its own messages in #mod-discussion. Made with
`mthub token … add -release`.

**Release cards:** a message shaped like this is drawn as a card (`parseRelease` in
`web/src/chat.ts`); anything else stays ordinary text:

    ## <mod> <version>
    -# Client · Required             (Client, Server or Client + Server; Required or Optional)
    #[mods/client/<file>.jar]        (optional: the jar to download; keep the brackets)
    - what changed …
    **Note:** …                      (optional: a special step or need-to-know)

A bare `#path` matches only letters, digits, `.`, `_`, `/` and `-`, so a file name with a space
or a `+` needs the brackets, or the line is not read as the jar link. The card's **Readme**
button opens `mods/mod info/<mod>.md` when that page exists.

**The chat list's order** is everyone's, set by admins: drag a chat, or right-click → Move
Up / Move Down (`<data>/chat/order.json`). DMs come last, the most recent message first.

**Private chats and direct messages.**
- **Kinds:** a chat is public, private or a DM. It's set in `<data>/chat/<chat>/meta.json`;
  a chat without one is public.
- **Private chats** are for their members and every admin. Admins make them ("+" next to
  CHATS) and change their members (right-click: Members…, Make Private…, Make Public).
- **DMs** are for their 2 to 10 people only, admins included. Anyone starts one from the "+"
  next to CHATS (New Direct Message…); they're listed under the chats. Their folders are named
  `dm-<random>`. A DM can't be renamed or deleted, only hidden, and it comes back on its next
  message.
- **The server checks every chat request** (`inChat` in `internal/server/private.go`):
  a chat you can't see answers "not found". Live events, search and the renames list only
  carry what you can see.
- **Files posted** in a chat are kept with it (`<data>/chat/<chat>/media/`), outside Files,
  and served only to its people (see "Files posted in chat" in
  [`chat-and-files.md`](chat-and-files.md)). One that no message links goes to the trash
  after a day: the hub checks a few minutes after it starts and then daily, and logs what
  it moved.
- **Private means private from other players:** the hub stores everything as plain files,
  so whoever runs it can read them all.
