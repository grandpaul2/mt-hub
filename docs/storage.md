# How data is stored

## Editing files directly

    cd <data>/workspace          # use any editor, cp, rsync, git, ...

The Files tree is an ordinary folder, so it can be changed directly on the hub's machine by
whoever owns the files. Before listing or changing anything, the server commits whatever
changed on disk ("Edit on the box: ..."), credited to the files' owner. So direct edits get
history within a few seconds, and a page save can't silently overwrite them.

Uploads stop when the disk is down to 20 GB free (`-min-free`, in GB). The page and its
workers carry a Content Security Policy (`internal/server/headers.go`): nothing loads from or
connects to anywhere but the hub, its voice server and YouTube embeds. The browser tests fail
on anything it blocks.

## Large files and other no-history areas

Anything under `large/` (worlds, client packs) is stored as plain files, outside git. Those
files have no history, because git handles multi-GB files badly. Everywhere else, files are
capped at 50 MB; the page offers to put a bigger upload in `large/` instead. Uploads and
downloads stream, so memory stays flat even for multi-GB files, and downloads can resume.
On the hub's machine, just `rsync` into `<data>/workspace/large/`. `screenshots/` and
`map art/` are kept the same way (pictures don't change, and git handles piles of them
badly).

## How files are stored

`<data>/workspace` is an ordinary git repo. Every save, upload or delete
is a commit under the person's name. A save carries the revision the editor started from. If
the file has changed since then, the server refuses the save (HTTP 409) and the page shows
both versions side by side.

## Chat

Channels are folders in `<data>/chat/`, holding one file per month:
`<data>/chat/<channel>/<YYYY-MM>.jsonl`. Each message, edit or delete is one JSON line,
appended. So on the hub's machine you can watch and search the chat:

    tail -f <data>/chat/general/2026-10.jsonl
    grep -h farm <data>/chat/*/*.jsonl

Read them freely, but don't edit them while the server runs; it keeps chat in memory and
rebuilds it from these files at startup.
