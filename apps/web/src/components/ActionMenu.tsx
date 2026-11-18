import { useEffect, useRef, useState } from "react";

export type MenuAction = { label: string; onSelect: () => void; danger?: boolean };

/**
 * Popup action menu. Uses the native popover API and focusgroup where available,
 * with progressive fallbacks for Safari/Firefox: light dismiss, roles, and arrow keys.
 */
export default function ActionMenu({ label, actions }: { label: string; actions: MenuAction[] }) {
  const [open, setOpen] = useState(false);
  const pop = useRef<HTMLDivElement>(null);
  const nativePopover = typeof HTMLElement !== "undefined" && "popover" in HTMLElement.prototype;
  const nativeFocusGroup = typeof HTMLElement !== "undefined" && "focusGroup" in HTMLElement.prototype;

  useEffect(() => {
    const el = pop.current;
    if (!el) return;
    if (open) {
      if (nativePopover && !el.matches(":popover-open")) el.showPopover();
    } else if (nativePopover && el.matches(":popover-open")) {
      el.hidePopover();
    }
  }, [open, nativePopover]);

  // Native light dismiss and Escape close the popover without touching React state.
  // Keep aria-expanded and our render state in sync with the element.
  useEffect(() => {
    const el = pop.current;
    if (!el || !nativePopover) return;
    const onToggle = () => setOpen(el.matches(":popover-open"));
    el.addEventListener("toggle", onToggle);
    return () => el.removeEventListener("toggle", onToggle);
  }, [nativePopover]);

  // Fallback outside-press and Escape handling when popover light-dismiss is unavailable.
  useEffect(() => {
    if (!open || nativePopover) return;
    const outside = (e: PointerEvent) => { if (pop.current && !pop.current.contains(e.target as Node)) setOpen(false); };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", key);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", key); };
  }, [open, nativePopover]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (nativeFocusGroup) return; // browser handles roving focus
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
    const items = [...e.currentTarget.querySelectorAll<HTMLButtonElement>("button:not([disabled])")];
    if (!items.length) return;
    const i = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = e.key === "Home" ? 0 : e.key === "End" ? items.length - 1
      : (i + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
    e.preventDefault();
    items[next].focus();
  };

  return (
    <div className="menu">
      <button type="button" className="btn pri" aria-haspopup="menu" aria-expanded={open}
        onClick={() => setOpen(o => !o)}
        onKeyDown={e => {
          if (e.key !== "ArrowDown") return;
          e.preventDefault();
          setOpen(true);
          requestAnimationFrame(() => pop.current?.querySelector<HTMLButtonElement>("button")?.focus());
        }}>{label} ▾</button>
      <div ref={pop} className={"card pop" + (open ? " pop-open" : "")}
        {...(nativePopover ? ({ popover: "auto" } as any) : {})}>
        <div {...({ focusgroup: "menu nomemory" } as any)} role={nativeFocusGroup ? undefined : "menu"} aria-label={label} onKeyDown={onKeyDown}>
          {actions.map(a => (
            <button key={a.label} type="button" role={nativeFocusGroup ? undefined : "menuitem"}
              className={a.danger ? "dng" : ""}
              onClick={() => { a.onSelect(); setOpen(false); }}>{a.label}</button>
          ))}
        </div>
      </div>
    </div>
  );
}
