# Change the page

Use this for anything a member sees or clicks: a new button, a different layout, a new
dialog. The page is plain TypeScript in `web/src/`, bundled by `build.mjs`. There is no
framework.

## Steps

1. **Read the rule first.** `docs/style-guide.md` says how everything looks and behaves, and it
   wins over the code. Find the section for what you change (colours 3, controls 6, chat 8,
   files 9, words 11) so the change fits in. If it does something different on purpose, say so
   in the pull request.
2. **Find where it lives.**

   | Area | File |
   |------|------|
   | Files tree, editor, tabs, history, startup, `openHash` | `main.ts` |
   | Chats, messages, composer, reactions, release cards | `chat.ts` |
   | Folder view (grid, filters, sort) | `folder.ts` |
   | One picture, video or post on its own, the full-window viewer | `viewer.ts` |
   | Schematic Manager and posts | `schems.ts` |
   | `/` commands | `commands.ts` (see `docs/agents/add-a-chat-command.md`) |
   | `@` and `:emoji:` popups | `autocomplete.ts`, `emoji.ts` |
   | Voice chats and sounds | `voice.ts`, `sounds.ts`, `ding.ts` |
   | Screen sharing | `stream.ts` |
   | Admin page | `admin.ts` |
   | Search | `search.ts` |
   | Shared helpers (`h`, `req`, `toast`, `ask`, `openDialog`, menus) | `util.ts` |
   | All CSS | `style.css` |

3. **Build elements with `h()`** from `util.ts`: `h('button', { class: 'x', title: 'Save' },
   'Save')`. Props are assigned to the element; children are nodes or strings.
4. **Use the tokens.** `style.css` starts with the colour, size, radius and shadow tokens
   (`--panel`, `--accent`, `--danger`, ...) that style guide section 3 defines. Use a token
   instead of a new hex colour, and one of the guide's sizes instead of a new one.
5. **Talk to the server with `fetch`:** `req(method, url, body)` and `json<T>(response)` in
   `util.ts`. Every change to data is a `fetch` from script; never a form.
6. **Use the shared pieces** rather than new ones: `toast` / `toastError`, `ask({...})` for a
   confirmation, `openDialog`, the menu helpers, `go(hash)` to navigate.
7. **Use the words the guide uses** (section 11): "chat", "folder", "panel"; Title Case for menu
   items only and sentence case everywhere else; plain sentences in toasts, no jargon.
8. **Write the browser test** (`docs/agents/write-a-browser-test.md`).
9. **Dependencies:** the page loads nothing from other sites, so anything new must bundle into
   it; mention it in the pull request.

## Build and look

    make                       # the page is bundled into bin/mthub
    npm run watch              # rebuild web/dist on every save
    ./bin/mthub -dev -addr 127.0.0.1:8601 -data /tmp/mthub-scratch     # a throwaway hub for looking

With `-dev` the hub serves `web/dist` from disk, so refresh the page after a change. Use your
own data directory and port: it is a scratch hub, not something to leave running.

## Check it

    npx tsc                        # type check
    make check
    node test/browser/run.mjs <the suite for your area>

A styling change also needs `make firefox-check`, which checks a real Firefox's screen on the
maintainer's machines. Do not run it; say in the pull request that the change needs it.

## What people get wrong

- `innerHTML` with anything but a constant. Text a member wrote is never parsed as HTML. The
  two places that show rendered Markdown go through `cleanHTML` (`util.ts`).
- A hard-coded colour or font size, or a symbol character where the guide wants a stroke icon.
- Loading anything from another site: the Content Security Policy (`internal/server/headers.go`)
  blocks it and the browser tests fail on it. The page ships its own fonts and emoji.
- Controls that move when something appears (the guide's principle 5): reserve the space.
- Changing a shape the server sends (see `docs/agents/add-a-route.md`, step 7).
