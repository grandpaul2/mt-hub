# Add a `/` chat command

Use this to add a command such as `/serverstatus`: a message that is only `/name` is not
posted. It runs, and its answer is drawn in the chat for the person alone, with a Dismiss
line, until they dismiss it, leave the chat or reload. Anything else starting with `/` is an
ordinary message.

## Steps

1. **Add the data route first, if the command needs server data** (`docs/agents/add-a-route.md`).
   A command with no server data needs none.
2. **Write the command** in `web/src/commands.ts`: an `async function name(): Promise<HTMLElement>`
   that fetches with `req` / `json` and returns the card built with `h()`. Throw an `Error`
   with a plain message when it fails; the chat shows "Couldn’t run /name: ..." as an error toast
   (`run` in `chat.ts`).
3. **Register it** in the `COMMANDS` array at the top of the same file:
   `{ name: 'name', about: 'What it does', run: name }`. The name is lowercase letters only
   (`commandIn` matches `^/([a-z]+)$`). That one line also makes it appear in the
   autocomplete popup when someone types `/` at the start of the message box
   (`autocomplete.ts`), with `about` as its description.
4. **Style the card** in `style.css`, with the tokens (`docs/agents/change-the-page.md`). The
   look of cards and private replies is in `docs/style-guide.md` section 8 (Commands).
5. **Write the browser test** for it (`docs/agents/write-a-browser-test.md`).
6. **Add the command to the docs:** a line in `docs/style-guide.md` section 8 if it adds a
   pattern, and `docs/api.md` for any new route.

## Example

`/serverstatus`: the entry in `COMMANDS`, `serverStatus()` and `serverBlock()` in
`web/src/commands.ts`, the route `GET /api/server-status` in `internal/server/status.go`, and
the suite `test/browser/serverstatus.mjs` (popup, Tab completion, "not offered mid-message",
the card, Dismiss).

## Check it

    node test/browser/run.mjs serverstatus     # an existing command suite, as a model
    node test/browser/run.mjs <your suite>
    make check

## What people get wrong

- Registering a name with a capital letter, a digit or a dash: it never matches.
- Building the card with `innerHTML` and server text. Use `h()`; only constants and numbers you
  format yourself may go in `innerHTML` (as the sparkline in `commands.ts` does).
- Making the command post or store something. A command's answer is never stored.
