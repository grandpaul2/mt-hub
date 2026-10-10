# Add or change an API route

Use this when the job needs the server to do something new: a new `/api/...` call, a new
field in an answer, a new permission check. The routes live in `internal/server/`.

## Steps

1. **Decide who may call it.** Every `/api/` call needs a login already (`ServeHTTP` in
   `server.go` answers 401 otherwise), so a plain route is open to any member. Then pick:
   - **Admins only:** start the handler with `if !s.admin(w, r) { return }` (`admin.go`), or
     `s.isAdmin(r)` when you want your own error text (see `setOrder` in `chat.go`).
   - **Inside one chat** (`/api/channels/{name}/...`): add the route to the map of chat routes
     in `New` (`server.go`), so it goes through `inChat` (`private.go`). A chat the caller
     cannot see answers "not found". Register chat routes only in that map, so private chats stay private.
   - **For a game server:** a server token reaches only the routes in `serverAllow`
     (`tokens.go`). A new route is closed to tokens until you add `"METHOD /path"` there on
     purpose. A trailing `/` means "anything under it". Most routes should stay closed.
2. **Write the handler** in the file for its area (`chat.go`, `status.go`, `voice.go`, ...) as
   `func (s *Server) name(w http.ResponseWriter, r *http.Request)`. Helpers: `who(r)` is the
   caller (`Name`, `Admin`, `Owner`, `Token`), `readJSON(w, r, &req)` reads the body and
   answers 400 itself, `writeJSON(w, status, v)` answers, `fail(w, err)` maps a workspace or
   store error to a status.
3. **Register it** with `s.mux.HandleFunc("METHOD /api/path/{param}", s.name)`. A new area gets
   its own `func (s *Server) fooRoutes()` in its file and one call to it in `New`
   (`server.go`), like `statusRoutes` in `status.go`.
4. **If it takes a file path,** pass it through `workspace.Clean` before using it
   (`internal/workspace`), as `putFile` and `move` do. `Clean` refuses `.git` parts and
   control characters.
5. **If it stores bytes,** call `s.roomFor(w, size)` first (`limits.go`) and give it a size
   limit; wrap a streamed upload in `s.floored(r.Body)`.
6. **If other pages must see the change,** call `s.bus.publish("event", payload)` (or
   `s.publishChat` for a chat, which only reaches people who can see it). The page listens in
   `main.ts`/`chat.ts`; see `docs/agents/change-the-page.md`.
7. **Only add to an answer.** A browser may hold a page older than the server. Add fields rather than renaming
   or removing one the page reads, so an older page keeps working.
8. **Write the Go test** in `internal/server/` (below), and add a row to `docs/api.md`.

## Example: `PUT /api/channel-order`

Read `setOrder` in `internal/server/chat.go` (admin check, `readJSON`, a store call,
`s.bus.publish("channel", ...)`), its registration in `New`, and its test in
`internal/server/order_test.go`. `status.go` and `status_test.go` show a route that tokens may
use, and the test checks who may do what (a person, each kind of token).

A test builds the server with `New(us, ws, cs, ls, thumbs, fstest.MapFS{}, nil)` over a
`t.TempDir()`, makes a user with `us.SetPassword`, logs in with `us.Login` and sends the
cookie as `sessionCookie`; a token comes from `us.NewToken("survival", "")` and goes in an
`Authorization: Bearer` header. Copy the setup from `status_test.go`.

## Check it

    go test ./internal/server -run TestYourTest      # fast, one test
    make check                                       # type check, go vet, all Go tests

A new route needs a test that fails without it, covering who is refused (not logged in is
handled for you; test a member where admins only, and a token where closed to tokens).

## What people get wrong

- Adding a chat route straight to the mux: private chats and DMs then leak. Use the `inChat` map.
- Forgetting `tokenAllow`'s other side: a route that must work for a game server answers 403
  until it is listed in `serverAllow`.
- Using a path from the request without `workspace.Clean`.
- Reading a whole upload into memory, or accepting one without `roomFor`.
- Changing the shape of an existing answer.
