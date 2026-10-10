# Docs

Every document in this folder, with what kind it is:

- **current spec**: describes what is built, or the agreed rules; keep it true.
- **reference**: how a part behaves; keep it true.
- **research record**: how a choice was made; not edited when the code moves on.
- **mockup**: a design sketch; open the HTML in a browser.

Contributors and their agents start with [`../AGENTS.md`](../AGENTS.md).

## Reference and specs

| Doc | Kind | What it is |
|-----|------|------------|
| [`architecture.md`](architecture.md) | reference | One screen: the binary, the data directory, the page, live updates, LiveKit, tokens. |
| [`admin.md`](admin.md) | reference | Accounts, the Admin page, game-server tokens, release cards, private chats and DMs. |
| [`chat-and-files.md`](chat-and-files.md) | reference | How chat, pictures, the folder view and the Schematic Manager behave. |
| [`storage.md`](storage.md) | reference | How files and chats are stored on disk, and the limits. |
| [`voice-and-streams.md`](voice-and-streams.md) | reference | How voice chats and screen sharing run, and the voice lab. |
| [`api.md`](api.md) | reference | The HTTP API. |
| [`testing.md`](testing.md) | reference | Go tests, browser tests, the Firefox check. |
| [`style-guide.md`](style-guide.md) | current spec | How the hub looks and behaves. Agreed by the maintainers; it wins over the code. |
| [`hub-backlog.md`](hub-backlog.md) | current spec | Ideas not built yet (the **Later** list) and the stocktake they came from. |
| [`voice/rooms-design.md`](voice/rooms-design.md) | current spec | Voice chats as built. |
| [`stream/screen-share-spec.md`](stream/screen-share-spec.md) | current spec | Screen sharing as built. |
| [`voice/svc/link-spec.md`](voice/svc/link-spec.md) | current spec | Voice Link: a Simple Voice Chat room shared between game servers. |

## Research records

| Doc | What it is |
|-----|------------|
| [`voice/README.md`](voice/README.md) | The voice design as built, the voice lab's results, and the superseded first proposal. |
| [`voice/noise-suppression.md`](voice/noise-suppression.md) | Noise models that run in the browser. |
| [`voice/audio-chain.md`](voice/audio-chain.md) | Voice detection, echo cancellation, gain and Opus settings. |
| [`voice/transport.md`](voice/transport.md) | The media server, TURN and where media runs. |
| [`voice/prior-art.md`](voice/prior-art.md) | What other open-source products ship, and what users complain about. |
| [`voice/svc/plugins-and-bridge.md`](voice/svc/plugins-and-bridge.md) | Simple Voice Chat plugins, Discord bridges and a cross-server link. |
| [`hub-dialog-conventions.md`](hub-dialog-conventions.md) | The research behind the dialog and menu rules in the style guide. |

## Mockups

| Folder | What it is |
|--------|------------|
| `topbar/` | The top bar's logo and wiring texture. The logo is MacroTech's own artwork, by the maintainer. |
| `commands/` | The `/serverstatus` card. |

## Agent guides

One guide per job, linked from the task table in [`../AGENTS.md`](../AGENTS.md):

- [`agents/add-a-route.md`](agents/add-a-route.md): an API route or permission.
- [`agents/change-the-page.md`](agents/change-the-page.md): the page, its styles and its words.
- [`agents/add-a-chat-command.md`](agents/add-a-chat-command.md): a `/` command.
- [`agents/write-a-browser-test.md`](agents/write-a-browser-test.md): a browser suite.

Paths like `server/chat.go` in the docs are short for `internal/server/chat.go`.
