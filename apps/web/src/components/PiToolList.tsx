import { useEffect, useState } from "react";
import { chat } from "../chat/api";
import type { PiTool } from "../chat/types";
import type { ToolRow } from "../chat/tools";

/**
 * The tools Pi offers, from the bridge. Null while loading or when the bridge is unreachable;
 * callers fall back to the names in the config so the list still shows.
 */
export function usePiTools(): PiTool[] | null {
  const [tools, setTools] = useState<PiTool[] | null>(null);
  useEffect(() => {
    let live = true;
    chat.piTools().then(r => { if (live) setTools(r.tools); }).catch(() => { if (live) setTools(null); });
    return () => { live = false; };
  }, []);
  return tools;
}

/** Checkbox list of tools, one per row with its description. Scrolls when long. */
export function PiToolList({ label, rows, disabled, isLocked, onToggle }: {
  label: string;
  rows: ToolRow[];
  disabled: boolean;
  isLocked: (name: string) => boolean;
  onToggle: (name: string) => void;
}) {
  return (
    <div className="pi-tool-list" role="group" aria-label={label}>
      {rows.map(r => (
        <label className="pi-tool" key={r.name}>
          <input type="checkbox" checked={r.checked} disabled={disabled || isLocked(r.name)} onChange={() => onToggle(r.name)} />
          <span className="pi-tool-main">
            <code>{r.name}</code>
            {r.description && <span className="muted">{r.description}</span>}
          </span>
        </label>
      ))}
    </div>
  );
}
