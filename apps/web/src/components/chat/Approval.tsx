import { useState } from "react";
import { Icon } from "./Icon";
import type { Approval } from "../../chat/types";

const RESULT: Record<string, string> = { approved: "Approved", denied: "Denied", ended: "Not answered" };

/** A Pi approval you can answer. Hermes approvals have no id and stay a read-only notice (see Message.tsx). */
export function ApprovalCard({ a, onAnswer }: { a: Approval; onAnswer: (choice: "approve" | "deny") => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const pending = a.status === "pending";
  const answer = async (choice: "approve" | "deny") => {
    setBusy(true); setErr("");
    try { await onAnswer(choice); }
    catch (e) { setErr((e as { status?: number; message?: string }).status === 409 ? "This request is no longer waiting." : (e as Error).message); setBusy(false); }
  };
  return (
    <div className={`appr${pending ? "" : " done"}`} role="group" aria-label="Approval request">
      <div className="appr-h"><Icon name="alert" /><h3>{a.note}</h3></div>
      {a.command && <pre className="cmdblk">{a.command}</pre>}
      {pending ? (
        <div className="appr-actions">
          <button className="btn primary" type="button" disabled={busy} onClick={() => void answer("approve")}>Approve</button>
          <button className="btn danger-o" type="button" disabled={busy} onClick={() => void answer("deny")}>Deny</button>
        </div>
      ) : (
        <p className="meta appr-result" role="status">{RESULT[a.status ?? "ended"]}</p>
      )}
      {pending && <p className="meta">Pi waits for your answer and denies after 2 minutes.</p>}
      {err && <p className="err-row" role="alert">{err}</p>}
    </div>
  );
}
