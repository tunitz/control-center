import { useState } from "react";
import { Icon } from "./Icon";
import { Markdown } from "./Markdown";
import { ApprovalCard } from "./Approval";
import { Todos } from "./Todos";
import { copyText } from "../../clipboard";
import { fmtTokens } from "../../chat/context";
import { isAbnormal, showReasoning } from "../../chat/reduce";
import { toolDetail, toolStatus, toolTarget } from "../../chat/tool";
import type { Approval, Attachment, ChatMessage, ToolRow } from "../../chat/types";

const fmtSize = (n: number) => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1048576).toFixed(1)} MB`);
const fmtTime = (t: number) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const fmtDur = (ms: number | null) => (ms == null ? "" : ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`);

export function Attachments({ items, onOpen }: { items: Attachment[]; onOpen: (a: Attachment) => void }) {
  if (!items.length) return null;
  return (
    <div className="atts">
      {items.map(a =>
        a.kind === "image" ? (
          <button key={a.id} type="button" className="thumb-sm" aria-label={`Open image ${a.name}`} onClick={() => onOpen(a)}>
            <img src={a.url} alt={a.name} width={72} height={72} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
          </button>
        ) : (
          <span key={a.id} className="file-chip">
            <Icon name="file" className="i sm" />
            <span className="fn">{a.name}</span>
            <span className="fs">{fmtSize(a.size)}</span>
          </span>
        ),
      )}
    </div>
  );
}

function ToolRows({ tools }: { tools: ToolRow[] }) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <>
      {tools.map(t => {
        const isOpen = open === t.id;
        const target = toolTarget(t.args);
        const st = toolStatus(t);
        const icon = t.name.includes("file") ? "file" : t.name.includes("search") ? "search" : "term";
        return (
          <div className="fold-wrap" key={t.id}>
            <button type="button" className="fold" aria-expanded={isOpen} aria-controls={`tool-${t.id}`} onClick={() => setOpen(isOpen ? null : t.id)}>
              <Icon name="chevr" className="chev" />
              <Icon name={icon} className="i sm" />
              <span className="tname">{t.name}</span>
              {target && <span className="targ">{target}</span>}
              {t.durationMs != null && <span className="tdur">{fmtDur(t.durationMs)}</span>}
              <span className={st.cls}>{st.label}</span>
            </button>
            {isOpen && (
              <pre className="out" id={`tool-${t.id}`}>
                {[toolDetail(t.args), t.preview && t.preview !== toolDetail(t.args) ? `— preview —\n${t.preview}` : ""].filter(Boolean).join("\n\n") || "No details."}
              </pre>
            )}
          </div>
        );
      })}
    </>
  );
}

export function UserMessage({ m, onOpenImage }: { m: ChatMessage; onOpenImage: (a: Attachment) => void }) {
  return (
    <div className="msg user">
      <div className="bubble">
        <Attachments items={m.attachments} onOpen={onOpenImage} />
        {m.text && <p style={{ whiteSpace: "pre-wrap" }}>{m.text}</p>}
      </div>
      <div className="msg-actions">
        <button className="ib" type="button" aria-label="Copy message" title="Copy" onClick={() => void copyText(m.text)}>
          <Icon name="copy" className="i sm" />
        </button>
      </div>
    </div>
  );
}

export function AssistantMessage({ m, pending, agent = "Hermes", onApprove }: {
  m: ChatMessage; pending: Approval[]; agent?: string;
  /** Answers a Pi approval for this message's run. */
  onApprove?: (runId: string, approvalId: string, choice: "approve" | "deny") => Promise<void>;
}) {
  const [thoughtOpen, setThoughtOpen] = useState(false);
  const running = m.status === "running";
  const abnormal = isAbnormal(m);
  return (
    <div className="asst">
      <div className="ahead">
        <span className="who">{agent}</span>
        {m.model && (<><span>·</span><span>{m.model}</span></>)}
        <span>·</span>
        <time>{fmtTime(m.createdAt)}</time>
      </div>

      {(showReasoning(m) || m.tools.length > 0 || (m.todos?.length ?? 0) > 0) && (
        <div className="fgroup">
          {showReasoning(m) && (
            <div className="fold-wrap">
              <button type="button" className="fold" aria-expanded={thoughtOpen} aria-controls={`thought-${m.id}`} onClick={() => setThoughtOpen(o => !o)}>
                <Icon name="chevr" className="chev" />
                <Icon name="bulb" className="i sm" />
                <span className="lbl">Thought</span>
              </button>
              {thoughtOpen && <div className="thought" id={`thought-${m.id}`}>{m.reasoning}</div>}
            </div>
          )}
          <ToolRows tools={m.tools} />
          <Todos id={m.id} todos={m.todos} />
        </div>
      )}

      {running && !m.text && m.tools.length === 0 && (
        <div className="fold static" role="status" aria-live="polite"><span className="spin" aria-hidden="true" /><span className="lbl">Working</span></div>
      )}

      {pending.map((a, i) => a.id && onApprove && m.runId ? (
        <ApprovalCard key={a.id} a={a} onAnswer={c => onApprove(m.runId!, a.id!, c)} />
      ) : (
        <div className="appr" key={i} role="note">
          <div className="appr-h"><Icon name="alert" /><h3>Needs approval in Hermes</h3></div>
          {a.command && <pre className="cmdblk">{a.command}</pre>}
          <p className="meta">Approve this in Hermes. Control Center cannot approve it.</p>
        </div>
      ))}

      {abnormal && (
        <div className="err-row" role="alert">
          <Icon name="alert" className="i sm" />
          <span>{m.status === "failed" ? "Failed" : "Interrupted"}{m.error ? `: ${m.error}` : ""}</span>
        </div>
      )}

      {m.text && <Markdown text={m.text} />}
      {running && <span className="caret" aria-hidden="true" />}

      {!running && m.text && (
        <div className="msg-actions">
          <button className="ib" type="button" aria-label="Copy response" title="Copy" onClick={() => void copyText(m.text)}>
            <Icon name="copy" className="i sm" />
          </button>
        </div>
      )}
      {m.usage && (
        <div className="usage">
          <span>{fmtTokens(m.usage.input)} in</span>
          <span>{fmtTokens(m.usage.output)} out</span>
        </div>
      )}
    </div>
  );
}
