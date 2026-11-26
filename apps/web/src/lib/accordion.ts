/** Which accordion section was open last. "" means every section is closed. */
type Store = Pick<Storage, "getItem" | "setItem">;

/** The stored section if it still exists (or "" for all closed); otherwise `fallback`. Never throws. */
export function readOpenSection(storage: Store | null, key: string, ids: readonly string[], fallback: string): string {
  try {
    const v = storage?.getItem(key);
    if (v === "" || (typeof v === "string" && ids.includes(v))) return v;
  } catch { /* storage blocked */ }
  return fallback;
}

export function writeOpenSection(storage: Store | null, key: string, id: string): void {
  try { storage?.setItem(key, id); } catch { /* storage blocked */ }
}
