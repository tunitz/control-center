import { useState } from "react";
import { Icon } from "./Icon";
import { approvalSummary } from "../../chat/approval";
import type { Approval } from "../../chat/types";

/**
 * A Pi approval. While it waits it is a full card with Approve and Deny. Once answered (or ended) it folds into one
 * row like a tool call; tap it to review the full command. Hermes approvals have no id and stay a read-only
 * notice (see Message.tsx).
 */
export function ApprovalCard({ a, onAnswer }: { a: Approval; onAnswer: (choice: "approve" | "deny") => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [open, setOpen] = useState(false);
  const pending = a.status === "pending";
  const answer = async (choice: "approve" | "deny") => {
    setBusy(true); setErr("");
    try { await onAnswer(choice); }
    catch (e) { setErr((e as { status?: number; message?: string }).status === 409 ? "This request is no longer waiting." : (e as Error).message); setBusy(false); }
  };

  if (!pending) {
    const sum = approvalSummary(a);
    const id = `appr-${a.id ?? "x"}`;
    return (
      <div className="fgroup">
        <div className="fold-wrap">
          <button type="button" className="fold appr-fold" aria-expanded={open} aria-controls={id} onClick={() => setOpen(o => !o)}>
            <Icon name="chevr" className="chev" />
            <Icon name="alert" className="i sm" />
            <span className="appr-title">{a.note}</span>
            {sum.preview && <span className="targ">{sum.preview}</span>}
            <span className={sum.cls}>{sum.label}</span>
          </button>
          {open && <pre className="out" id={id} style={{ whiteSpace: "pre-wrap" }}>{a.command ?? a.note}</pre>}
        </div>
      </div>
    );
  }

  return (
    <div className="appr" role="group" aria-label="Approval request">
      <div className="appr-h"><Icon name="alert" /><h3>{a.note}</h3></div>
      {a.command && <pre className="cmdblk">{a.command}</pre>}
      <div className="appr-actions">
        <button className="btn primary" type="button" disabled={busy} onClick={() => void answer("approve")}>Approve</button>
        <button className="btn danger-o" type="button" disabled={busy} onClick={() => void answer("deny")}>Deny</button>
      </div>
      <p className="meta">Pi waits for your answer and denies after 5 minutes.</p>
      {err && <p className="err-row" role="alert">{err}</p>}
    </div>
  );
}
