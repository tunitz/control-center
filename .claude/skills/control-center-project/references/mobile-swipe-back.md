# Control Center: iOS Home Screen swipe-back

## Symptom
In the iOS Home Screen (standalone) app, the left-edge swipe reloads the page or behaves like a broken back instead of returning to the dashboard.

## Cause
Every hash-route link pushed a history entry. iOS's edge swipe then navigated back through the hash history, which reloads the page in standalone mode.

## Rule
In standalone mode (`navigator.standalone` or `matchMedia('(display-mode: standalone)')`), route links must replace the current history entry instead of pushing one. The app handles the left-edge swipe itself: from a unit page or Settings it goes to the dashboard, and on the dashboard it does nothing.

Safari tabs are unchanged, because the browser owns that gesture there.

## Testing without a phone
- Headless Chromium: `Page.addScriptToEvaluateOnNewDocument` with `Object.defineProperty(navigator,'standalone',{get:()=>true})`, then reload.
- Emulate touch with `Input.dispatchTouchEvent`. A swipe starting at x<=20 counts as an edge swipe; a swipe from the middle must not navigate.
- Check `history.length` stays flat and a `window.__m` marker survives (no reload).
- Verify on a real iPhone before calling it fixed. Headless can't prove the iOS gesture.

## Pitfalls
- `pkill -f 'apps/server/src/inde[x].ts'`-style patterns can match the shell running them. Kill by PID from `pgrep` and check `/proc/<pid>/environ` for `PORT=`.
- Re-add the Home Screen icon after an icon change. iOS reads it only at add time.
