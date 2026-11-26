import { useState, type ReactNode } from "react";
import { readOpenSection, writeOpenSection } from "../lib/accordion";

export type AccordionItem = { id: string; title: string; /** One muted line under the title: what is inside. */ hint?: string; body: ReactNode };

const store = (): Storage | null => { try { return localStorage; } catch { return null; } };

/**
 * One section open at a time; tap the open one to close it. The last open section is remembered. Closed bodies stay
 * mounted but hidden, so a half-edited form keeps its text when you look at another section.
 */
export default function Accordion({ items, storageKey, defaultOpen }: { items: AccordionItem[]; storageKey: string; defaultOpen: string }) {
  const [open, setOpen] = useState(() => readOpenSection(store(), storageKey, items.map(i => i.id), defaultOpen));
  const toggle = (id: string) => {
    const next = open === id ? "" : id;
    setOpen(next);
    writeOpenSection(store(), storageKey, next);
  };
  return (
    <div className="acc">
      {items.map(i => {
        const isOpen = open === i.id;
        return (
          <section className="acc-item" key={i.id}>
            <h2 className="acc-h">
              <button type="button" className="acc-head" id={`acc-${i.id}-head`} aria-expanded={isOpen} aria-controls={`acc-${i.id}-body`} onClick={() => toggle(i.id)}>
                <span className="acc-title">
                  <span className="acc-name">{i.title}</span>
                  {i.hint && <span className="acc-hint">{i.hint}</span>}
                </span>
                <span className="acc-chev" aria-hidden="true" />
              </button>
            </h2>
            <div className="acc-body" id={`acc-${i.id}-body`} role="region" aria-labelledby={`acc-${i.id}-head`} hidden={!isOpen}>{i.body}</div>
          </section>
        );
      })}
    </div>
  );
}
