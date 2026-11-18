# Throwaway Control Center instance

Use this to check a UI or API change without touching a live instance or a real unit. Nothing here uses live credentials or live data.

## Steps

1. Build the web bundle: `bun run build:web`. The server serves `apps/web/dist`, so rebuild after every web change.
2. Create a disposable data directory: `D=<scratch-dir>/cctest && mkdir -p "$D"`. Keep it outside the app's normal data directory.
3. Start the server on a spare port with polling disabled:

   ```bash
   CC_DATA="$D" CC_NO_POLL=1 \
     CC_ADMIN_PASSWORD=<throwaway> CC_MASTER_KEY=<throwaway> \
     PORT=<spare-port> HOST=127.0.0.1 \
     bun run apps/server/src/index.ts
   ```

   Use throwaway values for the admin password and master key; never values from `.env`. `CC_NO_POLL=1` keeps the SSH poller away from real units. Use `HOST=0.0.0.0` instead of `127.0.0.1` only when a device on the LAN must reach the instance.
4. Confirm readiness before testing: `curl -fsS -o /dev/null -w '%{http_code}' http://127.0.0.1:<spare-port>/` must return `200`. Do not rely on sleep-based waits; they race server startup.
5. If the UI needs a unit, seed a demo row in `$D/cc.db` and label it as demo in the report. Never point the instance at real unit data.
6. Use playwright-cli or an equivalent browser. Check both a narrow viewport (390px) and desktop width. Navigate by hash (`#/`, `#/unit/<id>`, `#/settings`) and reload after changing the hash so the page refetches.
7. Mock only the API routes that the backend cannot produce for this test, inject the mock before the first navigation, and label every screenshot taken with a mock as mocked. A mock proves the UI renders a state; it says nothing about the server.
8. Check the real endpoint as well as the rendered UI: run `fetch('/api/...').then(r => r.json())` in the page and assert the field is present and non-null. A unit test can pass while the handler never forwards the value, leaving the endpoint null.
9. Scroll the feature into view before a screenshot. Viewport screenshots cut off below-fold content.

## Web-only static preview (optional)

For layout or client logic only, no server is needed. Serve `apps/web/dist` from a short Bun script that answers `/api/auth/status` with `{"setupNeeded":false,"needsBootstrapToken":false,"localSetup":false,"authed":true}`, returns a JSON 404 for other `/api/*` paths, and falls back to `index.html`. Other pages need their own small stubs. Start it detached and stop it by its PID from `ss -ltnp`. Label every shot as a static preview; it proves no server behaviour.

When reading computed styles inside a narrow iframe, use `iframe.contentDocument`. To type into a React controlled input, call the native value setter from the element's prototype, dispatch an `input` event from the frame's own window, and allow a short render delay. After a web rebuild, reload the page or you are testing the old bundle.

## Teardown (required before reporting done)

Stop the server by the PID recorded when it was launched. Never use `pkill -f` patterns: the pattern matches the shell that runs the command, so it kills itself. If you did not record the PID, locate it from the listener (`ss -ltnp`) and verify it belongs to this throwaway instance before killing it. Then confirm the listener is gone:

```bash
ss -ltn | grep -c ':<spare-port> '   # expect 0
rm -rf "$D"
```
