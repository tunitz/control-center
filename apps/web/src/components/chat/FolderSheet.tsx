import { useEffect, useRef, useState } from "react";
import { Icon } from "./Icon";
import { ChatError, chat, type PiDirList } from "../../chat/api";
import { homeRelative, mapDirError, validFolderName } from "../../chat/dirs";

type Props = {
  /** Called with the chosen absolute folder, or null for the default per-chat workspace. */
  onPick: (cwd: string | null) => void;
  /** Called when the user closes the sheet without choosing. */
  onCancel: () => void;
};

/** Working-folder step for a new Pi chat. Browses and creates folders only; the caller creates the chat. */
export function FolderSheet({ onPick, onCancel }: Props) {
  const [home, setHome] = useState<string | null>(null);
  const [dir, setDir] = useState<PiDirList | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [creating, setCreating] = useState(false);
  const [newOpen, setNewOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [newErr, setNewErr] = useState("");
  const [busy, setBusy] = useState(false);
  // Only the latest listing request may update the sheet.
  const reqRef = useRef(0);
  const dialogRef = useRef<HTMLDivElement>(null);

  const load = async (path?: string) => {
    const id = ++reqRef.current;
    setLoading(true); setErr("");
    try {
      const d = await chat.piDirs(path);
      if (id !== reqRef.current) return;
      setDir(d);
      if (d.parent === null) setHome(d.path);
    } catch (e) {
      if (id !== reqRef.current) return;
      setErr(e instanceof ChatError ? mapDirError(e.status, e.message) : "Could not load folders.");
    } finally {
      if (id === reqRef.current) setLoading(false);
    }
  };

  useEffect(() => { void load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Mount-only: focus the dialog once and keep the latest onCancel without re-focusing on each parent render.
  const cancelRef = useRef(onCancel);
  cancelRef.current = onCancel;
  useEffect(() => {
    dialogRef.current?.focus();
    const f = (e: KeyboardEvent) => { if (e.key === "Escape") cancelRef.current(); };
    document.addEventListener("keydown", f);
    return () => document.removeEventListener("keydown", f);
  }, []);

  const create = async () => {
    if (!dir || !validFolderName(newName) || busy) return;
    setBusy(true); setNewErr("");
    try {
      const made = await chat.piMkdir(dir.path, newName.trim());
      setNewName(""); setNewOpen(false); setCreating(false);
      await load(made.path);
    } catch (e) {
      setNewErr(e instanceof ChatError ? mapDirError(e.status, e.message) : "Could not create the folder.");
    } finally {
      setBusy(false);
    }
  };

  const shown = dir ? homeRelative(dir.path, home ?? "") : "";

  return (
    <>
      <button className="sheet-scrim" type="button" aria-label="Close working folder" onClick={onCancel} />
      <div className="sheet folder-sheet" role="dialog" aria-modal="true" aria-labelledby="folder-title" tabIndex={-1} ref={dialogRef}>
        <div className="sheet-head">
          <h2 id="folder-title">Working folder</h2>
          <button className="ib tap" type="button" aria-label="Close working folder" onClick={onCancel}><Icon name="x" /></button>
        </div>

        <div className="sheet-body">
          <p className="dir-path" aria-live="polite" title={dir?.path ?? ""}>{loading && !dir ? "Loading…" : shown || "~"}</p>

          {err && <p className="err-row" role="alert">{err}</p>}

          {dir && (
            <>
              <div className="dir-list" role="list" aria-label="Subfolders">
                {dir.parent !== null && (
                  <button className="dir-row" type="button" role="listitem" aria-label="Up to parent folder" disabled={loading}
                    onClick={() => void load(dir.parent!)}>
                    <Icon name="up" className="i sm" /><span className="name">..</span>
                  </button>
                )}
                {dir.entries.map(en => (
                  <button className="dir-row" type="button" role="listitem" key={en.path} disabled={loading}
                    title={en.path} onClick={() => void load(en.path)}>
                    <Icon name="chevr" className="i sm" /><span className="name">{en.name}</span>
                  </button>
                ))}
              </div>
              {!loading && dir.entries.length === 0 && <p className="meta" role="status">No subfolders</p>}
            </>
          )}

          {dir && !creating && (
            <button className="btn ghost" type="button" disabled={loading} onClick={() => setCreating(true)} aria-expanded={creating}>
              <Icon name="plus" className="i sm" />New folder
            </button>
          )}
          {dir && creating && (
            <form className="dir-new" onSubmit={e => { e.preventDefault(); void create(); }}>
              <input type="text" aria-label="New folder name" placeholder="Folder name" value={newName} autoComplete="off"
                onChange={e => { setNewName(e.target.value); setNewErr(""); }} disabled={busy} />
              <button className="btn" type="submit" disabled={busy || !validFolderName(newName)}>Create</button>
            </form>
          )}
          {newErr && <p className="err-row" role="alert">{newErr}</p>}
        </div>

        <div className="sheet-foot">
          <button className="btn primary lg" type="button" disabled={!dir || loading} onClick={() => dir && onPick(dir.path)}>Use this folder</button>
          <button className="btn ghost lg" type="button" onClick={() => onPick(null)}>Default workspace</button>
        </div>
      </div>
    </>
  );
}
