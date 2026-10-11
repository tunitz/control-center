import { Fragment, useState, type ReactNode } from "react";
import { Icon } from "./Icon";
import { Markdown } from "./Markdown";
import { ApprovalCard } from "./Approval";
import { Todos } from "./Todos";
import { copyText } from "../../clipboard";
import { usageRows, usageSummary } from "../../chat/usage";
import { isAbnormal, showReasoning } from "../../chat/reduce";
import { toolDetail, toolStatus, toolTarget } from "../../chat/tool";
import type { Approval, Attachment, ChatMessage, MessageBlock, TokenUsage, ToolRow } from "../../chat/types";

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

function ToolFold({ t }: { t: ToolRow }) {
  const [open, setOpen] = useState(false);
  const target = toolTarget(t.args);
  const st = toolStatus(t);
  const icon = t.name.includes("file") ? "file" : t.name.includes("search") ? "search" : "term";
  return (
    <div className="fold-wrap">
      <button type="button" className="fold" aria-expanded={open} aria-controls={`tool-${t.id}`} onClick={() => setOpen(o => !o)}>
        <Icon name="chevr" className="chev" />
        <Icon name={icon} className="i sm" />
        <span className="tname">{t.name}</span>
        {target && <span className="targ">{target}</span>}
        {t.durationMs != null && <span className="tdur">{fmtDur(t.durationMs)}</span>}
        <span className={st.cls}>{st.label}</span>
      </button>
      {open && (
        <pre className="out" id={`tool-${t.id}`}>
          {[toolDetail(t.args), t.preview && t.preview !== toolDetail(t.args) ? `— preview —\n${t.preview}` : ""].filter(Boolean).join("\n\n") || "No details."}
        </pre>
      )}
    </div>
  );
}

/** A Hermes approval has no id: it can only be answered in Hermes. */
function ApprovalNotice({ a }: { a: Approval }) {
  return (
    <div className="appr" role="note">
      <div className="appr-h"><Icon name="alert" /><h3>Needs approval in Hermes</h3></div>
      {a.command && <pre className="cmdblk">{a.command}</pre>}
      <p className="meta">Approve this in Hermes. Control Center cannot approve it.</p>
    </div>
  );
}

/** Messages written before blocks existed (and the dev mock) render from text + tools. */
function orderedBlocks(m: ChatMessage): MessageBlock[] {
  if (m.blocks?.length) return m.blocks;
  return [
    ...m.tools.map((t): MessageBlock => ({ kind: "tool", id: t.id })),
    ...(m.text ? [{ kind: "text", text: m.text } as MessageBlock] : []),
  ];
}

/** Renders the turn body in stream order: consecutive tool rows share one group, text and approvals sit between them. */
function TurnBody({ m, onApprove }: { m: ChatMessage; onApprove?: (runId: string, approvalId: string, choice: "approve" | "deny") => Promise<void> }) {
  const tools = new Map(m.tools.map(t => [t.id, t]));
  const out: ReactNode[] = [];
  let group: string[] = [];
  const flush = (key: string) => {
    if (!group.length) return;
    out.push(
      <div className="fgroup" key={`g-${key}`}>
        {group.map(id => { const t = tools.get(id); return t ? <ToolFold key={id} t={t} /> : null; })}
      </div>,
    );
    group = [];
  };
  orderedBlocks(m).forEach((b, i) => {
    if (b.kind === "tool") { group.push(b.id); return; }
    flush(String(i));
    if (b.kind === "text") { out.push(<Markdown key={`t-${i}`} text={b.text} />); return; }
    const a = b.approval;
    out.push(a.id && onApprove && m.runId
      ? <ApprovalCard key={`a-${a.id}`} a={a} onAnswer={c => onApprove(m.runId!, a.id!, c)} />
      : <ApprovalNotice key={`a-${i}`} a={a} />);
  });
  flush("end");
  return <>{out}</>;
}

export function UserMessage({ m, onOpenImage, onRetry, onDelete }: {
  m: ChatMessage; onOpenImage: (a: Attachment) => void;
  /** Rebranches from here: the message is re-run and the reply after it is replaced. Absent while a run is active. */
  onRetry?: () => void;
  /** Deletes this message from the chat. Absent while a run is active. */
  onDelete?: () => void;
}) {
  return (
    <div className="msg user">
      <div className="bubble">
        <Attachments items={m.attachments} onOpen={onOpenImage} />
        {m.text && <p style={{ whiteSpace: "pre-wrap" }}>{m.text}</p>}
      </div>
      <div className="msg-actions">
        {onRetry && m.text.trim() && (
          <button className="ib" type="button" aria-label="Retry from here" title="Retry — replaces the reply after this message" onClick={onRetry}>
            <Icon name="refresh" className="i sm" />
          </button>
        )}
        <button className="ib" type="button" aria-label="Copy message" title="Copy" onClick={() => void copyText(m.text)}>
          <Icon name="copy" className="i sm" />
        </button>
        {onDelete && (
          <button className="ib danger" type="button" aria-label="Delete message" title="Delete message" onClick={onDelete}>
            <Icon name="trash" className="i sm" />
          </button>
        )}
      </div>
    </div>
  );
}

/** The token line under a reply. Tap it for the full breakdown: uncached input, cache read/write, output, timing. */
function UsageRow({ id, u }: { id: string; u: TokenUsage }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="usage-wrap">
      <button type="button" className="usage usage-btn" aria-expanded={open} aria-controls={`usage-${id}`} title="Token details" onClick={() => setOpen(o => !o)}>
        {usageSummary(u).map(part => <span key={part}>{part}</span>)}
        <Icon name="chevr" className="chev" />
      </button>
      {open && (
        <dl className="usage-grid" id={`usage-${id}`}>
          {usageRows(u).map(r => <Fragment key={r.label}><dt>{r.label}</dt><dd>{r.value}</dd></Fragment>)}
        </dl>
      )}
    </div>
  );
}

export function AssistantMessage({ m, agent = "Hermes", onApprove }: {
  m: ChatMessage; agent?: string;
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

      {(showReasoning(m) || (m.todos?.length ?? 0) > 0) && (
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
          <Todos id={m.id} todos={m.todos} />
        </div>
      )}

      {running && !m.text && m.tools.length === 0 && (
        <div className="fold static" role="status" aria-live="polite"><span className="spin" aria-hidden="true" /><span className="lbl">Working</span></div>
      )}

      <TurnBody m={m} onApprove={onApprove} />

      {running && <span className="caret" aria-hidden="true" />}

      {abnormal && (
        <div className="err-row" role="alert">
          <Icon name="alert" className="i sm" />
          <span>{m.status === "failed" ? "Failed" : "Interrupted"}{m.error ? `: ${m.error}` : ""}</span>
        </div>
      )}

      {!running && m.text && (
        <div className="msg-actions">
          <button className="ib" type="button" aria-label="Copy response" title="Copy" onClick={() => void copyText(m.text)}>
            <Icon name="copy" className="i sm" />
          </button>
        </div>
      )}
      {m.usage && <UsageRow id={m.id} u={m.usage} />}
    </div>
  );
}
