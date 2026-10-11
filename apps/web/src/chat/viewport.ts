import { useEffect, type RefObject } from "react";

/** Height (px) for the chat root so it ends exactly at the tabbar (phone) or 16px above the viewport bottom (desktop).
 *  `top` is the root's page-relative top; `vvh` the visual viewport height; `tabbarTop` the tabbar's viewport top or null when hidden. */
export function chatHeight(a: { top: number; vvh: number; tabbarTop: number | null }): number {
  const limit = a.tabbarTop === null ? a.vvh - 16 : Math.min(a.tabbarTop, a.vvh);
  return Math.max(320, Math.round(limit - a.top));
}

/** Keeps the chat root inside the visual viewport (iOS keyboard) and locks page scroll while mounted:
 *  the thread and composer are fixed, only the message list scrolls. Sets --vvh (px) on the root, read by chat.css. */
export function useVisualViewportHeight(ref: RefObject<HTMLElement>, enabled: boolean): void {
  useEffect(() => {
    const el = ref.current;
    if (!el || !enabled) return;
    const vv = window.visualViewport;
    const phoneQuery = window.matchMedia("(max-width: 760px)");
    const html = document.documentElement;
    const prevOverflow = html.style.overflow;
    html.style.overflow = "hidden";
    const set = () => {
      window.scrollTo(0, 0);
      const tab = document.querySelector(".tabbar") as HTMLElement | null;
      const tabShown = !!tab && getComputedStyle(tab).display !== "none";
      const top = el.getBoundingClientRect().top;
      const vvh = vv ? vv.height : window.innerHeight;
      el.style.setProperty("--vvh", `${chatHeight({ top, vvh, tabbarTop: tabShown ? tab!.getBoundingClientRect().top : null })}px`);
    };
    set();
    vv?.addEventListener("resize", set);
    window.addEventListener("resize", set);
    phoneQuery.addEventListener("change", set);
    return () => {
      html.style.overflow = prevOverflow;
      phoneQuery.removeEventListener("change", set);
      vv?.removeEventListener("resize", set);
      window.removeEventListener("resize", set);
    };
  }, [ref, enabled]);
}
