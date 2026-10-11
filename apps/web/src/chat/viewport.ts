import { useEffect, type RefObject } from "react";

/** iOS keyboard: keep the chat root inside the visual viewport. Sets --vvh (px) on the root, read by chat.css.
 *  The root's height is the visual viewport height minus the app header; the fixed tabbar overlays the bottom
 *  padding that the app shell already reserves (see styles.css .app padding-bottom). */
export function useVisualViewportHeight(ref: RefObject<HTMLElement>, enabled: boolean): void {
  useEffect(() => {
    const el = ref.current;
    if (!el || !enabled) return;
    const vv = window.visualViewport;
    const phoneQuery = window.matchMedia("(max-width: 760px)");
    const set = () => {
      const header = document.querySelector("header.top") as HTMLElement | null;
      const top = header ? header.getBoundingClientRect().bottom : 0;
      const vvh = vv ? vv.height : window.innerHeight;
      // .app keeps 96px bottom padding (for the phone tabbar) on every width; subtract it so the page does not scroll.
      const pad = 96;
      el.style.setProperty("--vvh", `${Math.max(320, Math.round(vvh - top - pad))}px`);
    };
    set();
    vv?.addEventListener("resize", set);
    window.addEventListener("resize", set);
    phoneQuery.addEventListener("change", set);
    return () => {
      phoneQuery.removeEventListener("change", set);
      vv?.removeEventListener("resize", set);
      window.removeEventListener("resize", set);
    };
  }, [ref, enabled]);
}
