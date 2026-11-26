# iOS Home Screen routing and swipe-back

Applies to the standalone Home Screen web app, not to Safari tabs (the browser owns the back gesture there). Browser-width checks do not reproduce this behaviour; verify on a real device before calling a fix done.

## Behaviour

In standalone mode (`navigator.standalone` or `(display-mode: standalone)`), link clicks replace the current history entry rather than pushing new ones. The app handles a left-edge swipe itself: from a unit page or Settings it returns to the dashboard; on the dashboard it does nothing. Safari tabs are unchanged.

The implementation lives in `apps/web/src/swipe.ts` (`initSwipeBack`, `parentHash`, `isBackSwipe`) and `apps/web/src/route.ts`, which listens for `hashchange`, `popstate`, `pageshow` and the app's `cc-nav` event. iOS can restore the page on an edge swipe without firing `hashchange`, so `pageshow` is required. Use `navigate()` rather than assigning `location.hash` in app code so history stays flat.

## Verification without a device

- In headless Chromium, force `navigator.standalone` with `Page.addScriptToEvaluateOnNewDocument` (emulated display-mode media does not stick), then reload.
- Emulate the gesture with `Input.dispatchTouchEvent`. A drag starting at the left edge and travelling right counts as back; a drag from the middle or a short/vertical/slow drag must not navigate.
- Assert `history.length` stays flat and a `window` marker set before the swipe survives (no reload). Assert on visible page content, not a class shared with dashboard cards.
- Keep the routing and swipe unit tests green (`apps/web/src/route.test.ts`, `apps/web/src/swipe.test.ts`).

## Pitfalls

- Never use `pkill -f` patterns to stop a test server: the pattern matches the shell running it. Record the PID at launch, kill that PID, and confirm the listener is gone with `ss -ltn`.
- Re-add the Home Screen icon after an icon change; the OS reads it only when the icon is added.
- See `docs/development.md` for the general browser and mobile-width verification checklist.
