import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Icon } from "./Icon";
import { menuLeft } from "../../chat/menu";

export type TextMenuItem = { value: string; label: string; sub?: string; note?: string; disabled?: boolean };

export type TextMenuProps = {
  /** Visible trigger text, e.g. "Think: Off" or "Sonnet 5.5". */
  trigger: ReactNode;
  /** Accessible name for the trigger and the menu. */
  ariaLabel: string;
  items: TextMenuItem[];
  value: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (value: string) => void;
};

const GUTTER = 16;

/**
 * Text-only dropdown trigger with a popup menu opened above it (the composer sits at the bottom of the screen).
 * Closes on outside press, Escape and selection. Controlled by `open` so the composer can open it from a command.
 */
export function TextMenu(p: TextMenuProps) {
  const wrap = useRef<HTMLSpanElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; bottom: number } | null>(null);

  // Place the popup in viewport coordinates, clamped to the 16px gutters. Runs before paint.
  useLayoutEffect(() => {
    if (!p.open) { setPos(null); return; }
    const t = btn.current?.getBoundingClientRect();
    const w = pop.current?.offsetWidth ?? 200;
    if (!t) return;
    setPos({ left: menuLeft(t.left, t.width, w, window.innerWidth, GUTTER), bottom: window.innerHeight - t.top + 8 });
  }, [p.open, p.items.length]);

  // Outside press and Escape close the menu; focus returns to the trigger on Escape.
  useEffect(() => {
    if (!p.open) return;
    const onDown = (e: PointerEvent) => { if (!wrap.current?.contains(e.target as Node)) p.onOpenChange(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { p.onOpenChange(false); btn.current?.focus(); } };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("pointerdown", onDown); document.removeEventListener("keydown", onKey); };
  }, [p.open]); // eslint-disable-line react-hooks/exhaustive-deps

  // Focus the current option when the menu opens.
  useEffect(() => {
    if (!p.open) return;
    const cur = pop.current?.querySelector<HTMLButtonElement>("[aria-checked=true]:not(:disabled)");
    cur?.focus();
  }, [p.open]);

  const choose = (v: string) => {
    p.onSelect(v);
    p.onOpenChange(false);
    btn.current?.focus();
  };

  return (
    <span className="tmenu-wrap" ref={wrap}>
      <button ref={btn} className="ptrig" type="button" aria-haspopup="menu" aria-expanded={p.open} aria-label={p.ariaLabel}
        onClick={() => p.onOpenChange(!p.open)}>
        <span className="ptrig-txt">{p.trigger}</span>
        <Icon name="chev" className="i chev" />
      </button>
      {p.open && (
        <div ref={pop} className="pop tmenu" role="menu" aria-label={p.ariaLabel}
          style={pos ? { left: pos.left, bottom: pos.bottom } : { left: 0, bottom: 0, visibility: "hidden" }}>
          {p.items.map(it => (
            <button key={it.value} type="button" role="menuitemradio" aria-checked={it.value === p.value} disabled={it.disabled}
              className="titem" onClick={() => choose(it.value)}>
              <span className="titem-main">
                <span className="titem-name">{it.label}</span>
                {it.sub && <span className="titem-sub">{it.sub}</span>}
              </span>
              {it.note && <span className="titem-note">{it.note}</span>}
              <Icon name="check" className="i chk" />
            </button>
          ))}
        </div>
      )}
    </span>
  );
}
