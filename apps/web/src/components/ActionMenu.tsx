import { useEffect, useRef, useState } from "react";

export type MenuAction = { label: string; onSelect: () => void; danger?: boolean };

/**
 * Action menu anchored to its trigger. A plain positioned element is used instead of
 * the native popover: popovers enter the top layer, where UA centering overrides the
 * anchor and light-dismiss races with React state (the menu drifted and closed at random).
 */
export default function ActionMenu({ label, actions }: { label: string; actions: MenuAction[] }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const nativeFocusGroup = typeof HTMLElement !== "undefined" && "focusGroup" in HTMLElement.prototype;

  useEffect(() => {
    if (!open) return;
    const outside = (e: PointerEvent) => { if (root.current && !root.current.contains(e.target as Node)) setOpen(false); };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") { setOpen(false); (root.current?.querySelector("button") as HTMLButtonElement | null)?.focus(); } };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", key);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", key); };
  }, [open]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (nativeFocusGroup) return;
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
    <div className="menu" ref={root}>
      <button type="button" className="btn pri" aria-haspopup="menu" aria-expanded={open}
        onClick={() => setOpen(o => !o)}
        onKeyDown={e => {
          if (e.key !== "ArrowDown") return;
          e.preventDefault();
          setOpen(true);
          requestAnimationFrame(() => pop.current?.querySelector<HTMLButtonElement>("button")?.focus());
        }}>{label} ▾</button>
      {open && <div ref={pop} className="card pop">
        <div {...({ focusgroup: "menu nomemory" } as any)} role={nativeFocusGroup ? undefined : "menu"} aria-label={label} onKeyDown={onKeyDown}>
          {actions.map(a => (
            <button key={a.label} type="button" role={nativeFocusGroup ? undefined : "menuitem"}
              className={a.danger ? "dng" : ""}
              onClick={() => { setOpen(false); a.onSelect(); }}>{a.label}</button>
          ))}
        </div>
      </div>}
    </div>
  );
}
