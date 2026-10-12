# Throwaway Control Center test instance (UI checks)

Use this to check a new UI state without touching the live :3030 instance or any real unit.

## Steps

1. Build the web bundle: `cd ~/projects/control-center && bun run build:web`. The server serves `apps/web/dist`, so rebuild after every web change.
2. Pick a scratch dir: `D=$HOME/.hermes/cache/scratch/cctest && mkdir -p $D` (`/tmp` is wiped; use scratch).
3. Start the server on a spare port with the poller off. Launch it with `terminal(background=true, notify_on_complete=true)`, not a shell `nohup ... &`: the terminal tool rejects shell-level background wrappers and the call fails before anything starts:
   `CC_DATA=$D CC_NO_POLL=1 CC_ADMIN_PASSWORD=<throwaway> PORT=3031 HOST=127.0.0.1 bun run apps/server/src/index.ts > $D/log 2>&1`
   Then confirm readiness with a separate call (`curl` returns 200) before testing.
   - `CC_NO_POLL=1` keeps the SSH poller off, so no real unit is contacted.
   - Use a throwaway admin password, never the one in `.env`.
4. Seed a demo unit with `bun:sqlite` against `$D/cc.db` (the `units` table needs `name, host, pubkey, privkey_enc, created_at`; set `last_seen` to now to show it online). Label it demo in the report.
5. Mock only the API routes the backend cannot serve yet, before the first navigation:
   `cdp('Page.addScriptToEvaluateOnNewDocument', source=<window.fetch wrapper>)`, then `Emulation.setDeviceMetricsOverride` at 390px with `mobile=True`.
   The mock proves the UI renders a state. It does not prove the server. Say "mocked API" next to every shot.
6. Log in only if `input[type=password]` is present. An existing session can skip the form, and `fill_input` raises `element not found` when it is missing. Then navigate by hash (`#/unit/<id>`). Reload after changing the hash so the page refetches.
8. Check the real endpoint, not only the rendered UI. Run `fetch('/api/units/<id>').then(r=>r.json())` in the page and assert the new field is present and non-null. A helper unit test calls the function directly and still passes when the handler never forwards the value, so the endpoint returns null while the tests stay green.
7. Before the screenshot, `scrollIntoView()` the feature. `capture_screenshot()` takes the viewport only, and the vision check on a fold shot will report below-fold features as missing.

## Static preview with the dev mock (fastest layout check, web changes only)

No Control Center server, Docker or login is needed. Run `bun run build:web`, serve `apps/web/dist` with a few lines of Bun that answer `/api/me` with `{"ok":true}`, return 404 JSON for other `/api/*`, and fall back to `index.html`, then open `/?chatmock=1#/chat`. The mock in `chat/mock.ts` serves the chat API (fixtures: running chat `s-disk`, Pi approvals demo `s-appr`). Other pages need their own stubs (Settings: `/api/units`, `/api/rates`, `/api/settings`, `/api/audit`). Put the script in the scratch dir, start it with `setsid`, and stop it by its PID (find it with `ss -ltnp`), not `pkill -f`.

- **Phone width**: a browser window cannot be narrowed here, so serve a second page holding `<iframe src="/?chatmock=1#/chat/s-disk" style="width:390px;height:560px;border:0">` and read computed styles through `iframe.contentDocument`. The `max-width:480px` rules apply inside the frame.
- **Typing into a React textarea**: setting `.value` does nothing. Use the native setter from `HTMLTextAreaElement.prototype`, then dispatch an `input` event (from the frame's own window), then wait about 500 ms.
- **Stale frames**: a screenshot taken right after a state change can show the previous frame. Read the computed style first (it is already the new one), then screenshot again. After a rebuild, reload the page or you are testing the old bundle.
- This proves layout and client logic only. Label every shot "dev mock"; it says nothing about the server, Pi or the iOS Home Screen app.

## Container variant (full build, same image as deploy)

Use this when you need the production bundle and server exactly as deployed, with login. Still a throwaway: separate port and container name.

```bash
cd ~/projects/control-center
docker build -t cc-smoke:ui . > $HOME/.hermes/cache/scratch/ccsmoke-build.log 2>&1
D=$HOME/.hermes/cache/scratch/ccsmoke-up && mkdir -p $D
docker run -d --name cc-smoke --network host \
  -e PORT=3031 -e CC_MASTER_KEY=$(openssl rand -hex 32) \
  -e CC_ADMIN_PASSWORD=<throwaway> -e CHAT_UPLOAD_DIR=$D \
  -v $D:$D cc-smoke:ui
```

- The upload mount path must equal `CHAT_UPLOAD_DIR` on both sides, or the server writes into the container layer and loses files on remove.
- Use a throwaway `CC_ADMIN_PASSWORD`, not the one in `.env`. Pass `HERMES_API_KEY` only if the chat must reach the real Hermes.
- Before the first shot: `curl -s -o /dev/null -w '%{http_code}' localhost:3031/` must return 200. Sleep-based waits can race the server start.
- A localStorage flag such as `cc-chat-mock=1` skips the client auth gate. Shots taken that way are unauthenticated; label them mocked and never present them as a logged-in run.
- Teardown: `docker rm -f cc-smoke`, then `rm -rf $D`.

## Backend-only chat check against real Hermes (no browser)

Use this for a server change in `apps/server/src/chat/` that a unit test cannot prove, such as the transcript watcher. Run it on the throwaway instance above (a scratch `CC_DATA`, a spare port, a throwaway admin password). Load `HERMES_API_KEY` from `.env` into the environment in the shell that starts the server. Never print it.

- Log in with `POST /api/auth/login` and keep the cookie jar. Every mutating request needs the header `x-cc: 1`.
- Create a session with `POST /api/chat/sessions` (`{"model":"claude-haiku-5-5"}`). Haiku is the cheap choice for live runs.
- Send with `POST /api/chat/sessions/<id>/send` as `multipart/form-data` with a text field. A JSON body is refused.
- Poll `GET /api/chat/sessions` every 2 s and record each `(runState, awaiting)` change. Stop when the state is idle and awaiting is 0, or after a hard limit of about 7 min. Then read `GET /api/chat/sessions/<id>/messages`.
- Delete only the session the script created, through `DELETE /api/chat/sessions/<id>`. Keep the id in a file as it is created, as `references/chat-hermes-api.md` requires.
- Teardown: stop the server by its PID from the launch call. Then check `ss -ltn | grep -c ':3031 '` returns 0.

## Teardown (required before reporting done)

```bash
for p in $(pgrep -f 'apps/server/src/inde[x].ts'); do
  tr '\0' '\n' < /proc/$p/environ 2>/dev/null | grep -qx 'PORT=3031' && kill $p
done
ss -ltn | grep -c ':3031 '   # expect 0
rm -rf $D
```

The bracket in the pattern stops `pgrep` matching the shell that runs the loop. Without it the shell kills itself with exit -15.
