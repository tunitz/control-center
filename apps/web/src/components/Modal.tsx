import { useEffect, useRef, type ReactNode } from "react";

/**
 * Blocking confirmation/form dialog backed by the native <dialog> element.
 * The browser supplies focus containment, inert background, top layer, Escape and
 * focus return. `closedby="any"` adds light dismiss where supported; older browsers
 * (including Safari) get a press-outside fallback below.
 */
export default function Modal({ label, onClose, children }: { label: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.showModal();
    // Native showModal focuses the first control. Destructive confirms mark the safe
    // action with data-safe so the browser puts focus there instead.
    (el.querySelector<HTMLElement>("[data-safe]") ?? el.querySelector<HTMLElement>("[autofocus]"))?.focus();
    const cancel = (e: Event) => { e.preventDefault(); onClose(); };
    const closed = () => onClose();
    el.addEventListener("cancel", cancel);
    el.addEventListener("close", closed);
    const supportsClosedBy = "closedBy" in HTMLDialogElement.prototype;
    const outside = (e: PointerEvent) => {
      const r = el.getBoundingClientRect();
      return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
    };
    let pressedOutside = false;
    const down = (e: PointerEvent) => { pressedOutside = outside(e); };
    const up = (e: PointerEvent) => { if (pressedOutside && outside(e)) onClose(); pressedOutside = false; };
    if (!supportsClosedBy) {
      el.addEventListener("pointerdown", down);
      el.addEventListener("pointerup", up);
    }
    return () => {
      el.removeEventListener("cancel", cancel);
      el.removeEventListener("close", closed);
      el.removeEventListener("pointerdown", down);
      el.removeEventListener("pointerup", up);
      if (el.open) el.close();
    };
  }, [onClose]);
  return (
    <dialog ref={ref} className="modal" aria-label={label} {...({ closedby: "any" } as any)}>
      <div className="card">{children}</div>
    </dialog>
  );
}
