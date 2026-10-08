const EVENTS = ["hashchange", "popstate", "pageshow"];

/** Reports the current hash on subscribe and on every navigation event.
 *  iOS Home Screen swipe-back can restore the page without firing hashchange,
 *  so popstate and pageshow are watched too. Returns an unsubscribe. */
export function subscribeHash(onChange: (hash: string) => void): () => void {
  const report = () => onChange(location.hash || "#/");
  const f = () => report();
  for (const ev of EVENTS) addEventListener(ev, f);
  report();
  return () => {
    for (const ev of EVENTS) removeEventListener(ev, f);
  };
}
