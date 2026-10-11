import { navigate } from "./route";

/** Route one level up, or null at the top. */
export function parentHash(hash: string): string | null {
  if (/^#\/chat\/./.test(hash)) return "#/chat";
  if (hash === "#/chat") return "#/";
  return /^#\/(unit\/|settings)/.test(hash) ? "#/" : null;
}

export interface Drag { x0: number; y0: number; x1: number; y1: number; ms: number }
const EDGE = 40, MIN_DX = 70, MAX_DY = 70, MAX_MS = 900;

/** A left-edge drag to the right, mostly horizontal and quick. */
export function isBackSwipe(d: Drag): boolean {
  const dx = d.x1 - d.x0, dy = Math.abs(d.y1 - d.y0);
  return d.x0 <= EDGE && dx >= MIN_DX && dy <= MAX_DY && dy < dx && d.ms <= MAX_MS;
}

export const isStandalone = (): boolean =>
  (navigator as any).standalone === true || matchMedia("(display-mode: standalone)").matches;

/** Home Screen app only: the OS edge swipe reloads the page on a hash route,
 *  so keep history at one entry (links replace instead of push) and handle the
 *  edge swipe here. In a Safari tab the browser keeps its own back gesture. */
export function initSwipeBack(): void {
  if (!isStandalone()) return;
  document.addEventListener("click", e => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey) return;
    const a = (e.target as Element).closest?.("a[href^='#/']") as HTMLAnchorElement | null;
    if (!a) return;
    e.preventDefault();
    navigate(a.getAttribute("href")!);
  });
  let start: { x: number; y: number; t: number } | null = null;
  document.addEventListener("touchstart", e => {
    const t = e.touches[0];
    start = e.touches.length === 1 && t.clientX <= EDGE ? { x: t.clientX, y: t.clientY, t: Date.now() } : null;
  }, { passive: true });
  document.addEventListener("touchend", e => {
    const s = start; start = null;
    if (!s) return;
    const t = e.changedTouches[0];
    if (!isBackSwipe({ x0: s.x, y0: s.y, x1: t.clientX, y1: t.clientY, ms: Date.now() - s.t })) return;
    const up = parentHash(location.hash);
    if (up) navigate(up);
  }, { passive: true });
}
