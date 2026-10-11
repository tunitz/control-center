import { useState } from "react";
import { Icon } from "./Icon";
import { chat } from "../../chat/api";
import { groupSessions } from "../../chat/sessions";
import type { ChatSession, SessionHit } from "../../chat/types";

type Row = ChatSession | SessionHit;

export type SessionsProps = {
  list: Row[];
  activeId: string | null;
  query: string;
  archived: boolean;
  onQuery: (q: string) => void;
  onToggleArchived: () => void;
  onOpen: (id: string) => void;
  onNew: () => void;
  onChanged: () => void;
  onPatch: (id: string, p: Partial<ChatSession>) => void;
  onDeleted: (id: string) => void;
  onError: (msg: string) => void;
  /** Phone drawer only: shows the "Chats" title row with a close button. */
  onClose?: () => void;
};

export function Sessions(p: SessionsProps) {
  const groups = groupSessions(p.list, Date.now());
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [menu, setMenu] = useState<string | null>(null);
  const [confirmDel, setConfirmDel] = useState<string | null>(null);

  const act = async (fn: () => Promise<unknown>) => {
    setMenu(null);
    try { await fn(); p.onChanged(); } catch (e) { p.onError((e as Error).message); }
  };

  return (
    <>
      {p.onClose && (
        <div className="side-head">
          <h2>Chats</h2>
          <button className="ib" type="button" aria-label="Close chats" onClick={p.onClose}>
            <Icon name="x" />
          </button>
        </div>
      )}
      <div className="side-top">
        <button className="btn primary" type="button" onClick={p.onNew}>
          <Icon name="plus" className="i sm" />New chat
        </button>
        <label className="search">
          <Icon name="search" className="i sm" />
          <input type="search" placeholder="Search all chats" aria-label="Search all chats" value={p.query} onChange={e => p.onQuery(e.target.value)} />
        </label>
      </div>

      <div className="side-list">
        <div className="side-scroll">
          {groups.length === 0 && <p className="meta side-empty">{p.archived ? "No archived chats." : p.query ? "No chats match." : "No chats yet."}</p>}
          {groups.map(g => (
            <div key={g.label}>
              <div className="sec">{g.label}</div>
              {g.items.map(s => {
                const isActive = s.id === p.activeId;
                if (renaming === s.id) {
                  return (
                    <div className="rename" key={s.id}>
                      <input type="text" value={draft} aria-label="Rename chat" autoFocus onChange={e => setDraft(e.target.value)}
                        onKeyDown={e => { if (e.key === "Enter") void act(() => chat.patchSession(s.id, { title: draft.trim() || s.title }).then(r => p.onPatch(s.id, r))).then(() => setRenaming(null)); if (e.key === "Escape") setRenaming(null); }} />
                      <div className="acts">
                        <button className="btn ghost" type="button" onClick={() => setRenaming(null)}>Cancel</button>
                        <button className="btn" type="button" onClick={() => void act(() => chat.patchSession(s.id, { title: draft.trim() || s.title }).then(r => p.onPatch(s.id, r))).then(() => setRenaming(null))}>Save</button>
                      </div>
                    </div>
                  );
                }
                return (
                  <div className="row-wrap" key={s.id}>
                    <a className="row" href={`#/chat/${encodeURIComponent(s.id)}`} aria-current={isActive ? "true" : undefined} title={s.title}
                      onClick={e => { e.preventDefault(); p.onOpen(s.id); }}>
                      <span className="pulse-wrap">
                        {s.runState !== "idle" && <span className="pulse" aria-label="Running" />}
                        {s.runState === "idle" && s.unread && <span className="pulse" style={{ opacity: 0.5 }} aria-label="Unread" />}
                      </span>
                      <span className="row-txt">
                        <span className="row-title">{s.title}</span>
                        <span className="row-meta">{(s as SessionHit).snippet || `${s.provider} · ${s.model}`}</span>
                      </span>
                    </a>
                    <button className="more" type="button" aria-haspopup="menu" aria-expanded={menu === s.id} aria-label={`Chat actions for ${s.title}`} onClick={() => setMenu(menu === s.id ? null : s.id)}>
                      <Icon name="dots" className="i sm" />
                    </button>
                    {menu === s.id && (
                      <div className="pop menu" role="menu">
                        <button className="menu-item" role="menuitem" type="button" onClick={() => { setMenu(null); setDraft(s.title); setRenaming(s.id); }}><Icon name="edit" className="i sm" />Rename</button>
                        <button className="menu-item" role="menuitem" type="button" onClick={() => void act(() => chat.patchSession(s.id, { pinned: !s.pinned }).then(r => p.onPatch(s.id, r)))}><Icon name="pin" className="i sm" />{s.pinned ? "Unpin" : "Pin"}</button>
                        <button className="menu-item" role="menuitem" type="button" onClick={() => void act(() => chat.patchSession(s.id, { archived: !s.archived }))}><Icon name="archive" className="i sm" />{s.archived ? "Unarchive" : "Archive"}</button>
                        <a className="menu-item" role="menuitem" href={chat.exportUrl(s.id)}><Icon name="export" className="i sm" />Export (Markdown)</a>
                        <div className="menu-sep" />
                        <button className="menu-item danger" role="menuitem" type="button" onClick={() => { setMenu(null); setConfirmDel(s.id); }}><Icon name="trash" className="i sm" />Delete</button>
                      </div>
                    )}
                    {confirmDel === s.id && (
                      <div className="rename" role="alertdialog" aria-label="Delete chat">
                        <p className="meta">Delete “{s.title}”? This cannot be undone.</p>
                        <div className="acts">
                          <button className="btn ghost" type="button" onClick={() => setConfirmDel(null)}>Cancel</button>
                          <button className="btn danger-o" type="button" onClick={() => void act(async () => { await chat.deleteSession(s.id); p.onDeleted(s.id); setConfirmDel(null); })}>Delete chat</button>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </div>

      <div className="side-foot">
        <button className="link-btn" type="button" onClick={p.onToggleArchived}>
          <Icon name="archive" className="i sm" />{p.archived ? "Back to chats" : "Archived"}
        </button>
      </div>
    </>
  );
}
