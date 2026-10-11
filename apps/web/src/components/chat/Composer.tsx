import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent } from "react";
import { Icon } from "./Icon";
import { ACCEPTED_TYPES, MAX_BYTES, prepareImage } from "../../chat/imaging";
import { PAGE_COMMANDS, helpText, parseEffort, parseSlash, suggestions, unknownText, type Parsed } from "../../chat/slash";
import { contextMeter } from "../../chat/context";
import { shortModelLabel } from "./label";
import { TextMenu } from "./TextMenu";
import { effortLabel } from "../../chat/menu";
import { effortChoices, modelUsable } from "../../chat/pi";
import type { Backend, ChatModel, Effort } from "../../chat/types";

export type Pending = { key: string; file: File; name: string; kind: "image" | "file"; status: "preparing" | "ready" | "error"; error: string; note: string };

const MAX_FILES = 6;
const isPdf = (f: File) => f.type === "application/pdf" || /\.pdf$/i.test(f.name);

export type ComposerProps = {
  phone: boolean;
  running: boolean;
  runId: string | null;
  models: ChatModel[];
  /** Backend of the open chat; null before a chat exists. A chat keeps its backend, so other models are disabled. */
  chatBackend: Backend | null;
  /** Thinking levels Pi reports for the current model (Pi chats only). */
  piLevels: string[] | null;
  model: string;
  effort: Effort | null;
  ctxInput: number | null;
  ctxWindow: number | undefined;
  maxUploadMb: number;
  onSend: (text: string, files: File[]) => Promise<void>;
  onSteer: (text: string) => Promise<"ok" | "finished">;
  /** Page-level slash commands (retry, title, export, pin, archive, delete). Returns a short notice. */
  onAction: (name: string, arg: string) => Promise<string>;
  /** Long command output goes into the thread as a collapsible row, not under the composer. */
  onNote: (title: string, body: string) => void;
  onStop: () => void;
  onNew: () => void;
  onModel: (id: string) => void;
  onEffort: (e: Effort) => void;
  /** Floating "jump to latest" button above the composer, shown while the thread is scrolled up. */
  jump: { show: boolean; unseen: boolean; onJump: () => void };
};

export function Composer(p: ComposerProps) {
  const [text, setText] = useState("");
  const [files, setFiles] = useState<Pending[]>([]);
  const [err, setErr] = useState("");
  const [notice, setNotice] = useState("");
  const [drag, setDrag] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
  const [effortOpen, setEffortOpen] = useState(false);
  const ta = useRef<HTMLTextAreaElement>(null);
  const fileIn = useRef<HTMLInputElement>(null);
  const camIn = useRef<HTMLInputElement>(null);
  const model = p.models.find(m => m.id === p.model);
  const backend: Backend = p.chatBackend ?? model?.backend ?? "hermes";
  const efforts = effortChoices(model, p.piLevels);
  const meter = contextMeter(p.ctxInput, p.ctxWindow);
  const slash = suggestions(text, backend);
  // Short notices clear themselves; they used to stay under the composer until the next send.
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(""), 5000);
    return () => clearTimeout(t);
  }, [notice]);
  const busy = p.running;

  // Autogrow up to ~8 lines.
  useEffect(() => {
    const el = ta.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [text]);

  const addFiles = async (list: FileList | File[]) => {
    const incoming = Array.from(list);
    const room = MAX_FILES - files.length;
    if (incoming.length > room) setErr(`Up to ${MAX_FILES} files per message.`);
    for (const f of incoming.slice(0, Math.max(0, room))) {
      const key = `${f.name}-${f.size}-${Math.random().toString(36).slice(2, 7)}`;
      const isImg = f.type.startsWith("image/");
      if (!isImg && !isPdf(f) && !/^text\/|json|yaml|xml|markdown/.test(f.type) && !/\.(txt|md|log|csv|json|ya?ml|sh|py|ts|js|sql|xml|html|css|docx)$/i.test(f.name)) {
        setErr(`${f.name}: this file type is not supported.`);
        continue;
      }
      if (f.size > p.maxUploadMb * 1024 * 1024) { setErr(`${f.name}: over ${p.maxUploadMb} MB.`); continue; }
      const base: Pending = { key, file: f, name: f.name, kind: isImg ? "image" : "file", status: "preparing", error: "", note: isPdf(f) ? "Text PDFs only" : "" };
      setFiles(prev => [...prev, base]);
      if (isImg) {
        try {
          const r = await prepareImage(f);
          setFiles(prev => prev.map(x => (x.key === key ? { ...x, file: r.file, status: "ready", note: r.scaled ? `resized to ${r.w}×${r.h}` : `${r.w}×${r.h}` } : x)));
        } catch (e) {
          setFiles(prev => prev.map(x => (x.key === key ? { ...x, status: "error", error: (e as Error).message } : x)));
        }
      } else {
        setFiles(prev => prev.map(x => (x.key === key ? { ...x, status: "ready" } : x)));
      }
    }
  };

  const runCommand = (cmd: Exclude<Parsed, null>) => {
    if (cmd.kind === "unknown") { setNotice(unknownText(cmd.name)); return true; }
    if (cmd.name === "help") { p.onNote("/help", helpText(backend)); setText(""); return true; }
    if ((PAGE_COMMANDS as readonly string[]).includes(cmd.name)) {
      const keep = text;
      setText("");
      // `onAction` records the command row itself; here we only restore the text if it throws.
      p.onAction(cmd.name, cmd.arg).catch(e => { setText(keep); setErr((e as Error).message); });
      return true;
    }
    if (cmd.name === "new") { p.onNew(); setText(""); return true; }
    if (cmd.name === "stop") {
      if (p.running) p.onNote("/stop", "Stopped the running task.");
      else p.onNote("/stop", "Nothing is running.");
      if (p.running) p.onStop();
      setText("");
      return true;
    }
    if (cmd.name === "model") {
      const hit = p.models.find(m => modelUsable(m, p.chatBackend) && (m.id.toLowerCase() === cmd.arg.toLowerCase() || m.label.toLowerCase() === cmd.arg.toLowerCase()));
      if (hit) { p.onModel(hit.id); setText(""); p.onNote("/model", `Model set to ${hit.label}.`); }
      else if (!cmd.arg) { setModelOpen(true); p.onNote("/model", "Choose a model in the picker."); }
      else p.onNote("/model", `No model called "${cmd.arg}".`);
      return true;
    }
    if (cmd.name === "reasoning") {
      const e = parseEffort(cmd.arg);
      if (!e || !efforts.includes(e)) { p.onNote("/reasoning", efforts.length ? `Use one of: ${efforts.join(", ")}.` : "This model has no thinking control."); return true; }
      p.onEffort(e); setText(""); p.onNote("/reasoning", `Thinking set to ${e}.`);
      return true;
    }
    return false;
  };

  const submit = async () => {
    const cmd = parseSlash(text, backend);
    setErr(""); setNotice("");
    if (cmd && runCommand(cmd)) return;
    if (busy) return;
    const ready = files.filter(f => f.status === "ready");
    if (files.some(f => f.status === "preparing")) { setErr("Wait for the attachments to finish."); return; }
    if (!text.trim() && ready.length === 0) return;
    const value = text;
    setText("");
    setFiles([]);
    try {
      await p.onSend(value, ready.map(f => f.file));
    } catch (e) {
      setText(value);
      setFiles(ready);
      setErr((e as Error).message);
    }
  };

  const steer = async () => {
    if (!text.trim()) return;
    const value = text;
    try {
      const res = await p.onSteer(value);
      if (res === "finished") { setErr("Run already finished"); return; } // keep the text
      setText("");
      setNotice("Steer sent to the running task.");
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Escape") { setModelOpen(false); setEffortOpen(false); return; }
    if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
    // Phone: Enter is a newline. Desktop: Enter sends, Shift+Enter is a newline.
    if (p.phone || e.shiftKey) return;
    e.preventDefault();
    if (busy) return;
    void submit();
  };

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const imgs = Array.from(e.clipboardData.files);
    if (imgs.length) { e.preventDefault(); void addFiles(imgs); }
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault(); setDrag(false);
    if (e.dataTransfer.files.length) void addFiles(e.dataTransfer.files);
  };

  const removeFile = (key: string) => setFiles(prev => prev.filter(f => f.key !== key));
  const canSend = !busy && !files.some(f => f.status === "preparing") && (text.trim() !== "" || files.some(f => f.status === "ready"));
  const canSteer = busy && text.trim() !== "";

  return (
    <div className="composer-wrap" onDragOver={e => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)} onDrop={onDrop}>
      <div className="comp-inner">
        {p.jump.show && (
          <button className={`ib jump-btn${p.jump.unseen ? " has-new" : ""}`} type="button"
            aria-label={p.jump.unseen ? "New messages, scroll to latest" : "Scroll to latest"}
            title={p.jump.unseen ? "New messages — jump to latest" : "Jump to latest"} onClick={p.jump.onJump}>
            <Icon name="down" />
          </button>
        )}
        {slash.length > 0 && (
          <div className="pop" id="cmd" role="listbox" aria-label="Commands" style={{ position: "absolute", bottom: "calc(100% + 8px)", left: 0, right: 0 }}>
            {slash.map(c => (
              <button key={c.name} type="button" role="option" className="cmd-item" aria-selected={false} onClick={() => { setText(`/${c.name} `); ta.current?.focus(); }}>
                <code>/{c.name}</code>
                <span className="d">{c.desc}</span>
              </button>
            ))}
          </div>
        )}
        {drag && <div className="dropzone"><div className="dz-in">Drop files to attach</div></div>}
        <div className={`composer${drag ? " drag" : ""}`}>
          {files.length > 0 && (
            <div className="attach-row">
              {files.map(f => (
                <span key={f.key} className={`achip${f.kind === "image" ? " img" : ""}`}>
                  <Icon name={f.kind === "image" ? "image" : "file"} className="i sm" />
                  <span className="ameta">
                    <span className="aname">{f.name}</span>
                    <span className="asub">
                      {f.status === "preparing" ? "preparing…" : f.status === "error" ? f.error : [f.note, f.status === "ready" ? "ready" : ""].filter(Boolean).join(" · ")}
                    </span>
                  </span>
                  <button className="x" type="button" aria-label={`Remove ${f.name}`} onClick={() => removeFile(f.key)}>
                    <Icon name="x" className="i sm" />
                  </button>
                </span>
              ))}
            </div>
          )}
          <textarea
            ref={ta}
            rows={1}
            value={text}
            placeholder={`Message ${backend === "pi" ? "Pi" : "Hermes"}…`}
            aria-label={`Message ${backend === "pi" ? "Pi" : "Hermes"}`}
            onChange={e => setText(e.target.value)}
            onKeyDown={onKey}
            onPaste={onPaste}
          />
          <div className="comp-bottom">
            <div className="comp-left">
              <button className="ib" type="button" aria-label="Attach file" title="Attach" onClick={() => fileIn.current?.click()}>
                <Icon name="clip" />
              </button>
              {p.phone && (
                <button className="ib" type="button" aria-label="Take photo" title="Camera" onClick={() => camIn.current?.click()}>
                  <Icon name="camera" />
                </button>
              )}
              {meter && (
                <span className="meter" title={`Context ~${meter.label}`} aria-label={`Context about ${meter.label}`}>
                  <span className="bar" style={{ width: `${meter.pct}%` }} />
                </span>
              )}
            </div>
            <input ref={fileIn} type="file" hidden multiple accept={[...ACCEPTED_TYPES, "application/pdf", ".txt,.md,.log,.csv,.json,.yaml,.yml,.sh,.py,.ts,.js,.sql,.xml,.html,.css,.docx"].join(",")} onChange={e => { if (e.target.files) void addFiles(e.target.files); e.target.value = ""; }} />
            <input ref={camIn} type="file" hidden accept="image/*" capture="environment" onChange={e => { if (e.target.files) void addFiles(e.target.files); e.target.value = ""; }} />

            <div className={`comp-right${busy ? " busy" : ""}`}>
            {p.phone && efforts.length > 0 && (
              <TextMenu
                ariaLabel="Thinking level"
                trigger={`Think: ${p.effort ? effortLabel(p.effort) : "Default"}`}
                items={efforts.map(v => ({ value: v, label: effortLabel(v) }))}
                value={p.effort ?? ""}
                open={effortOpen}
                onOpenChange={setEffortOpen}
                onSelect={v => p.onEffort(v as Effort)}
              />
            )}
            {p.phone && (
              <TextMenu
                ariaLabel="Model"
                trigger={shortModelLabel(model?.label ?? p.model)}
                items={p.models.map(m => {
                  const usable = modelUsable(m, p.chatBackend);
                  const note = !m.online ? "offline" : !usable ? (m.backend === "pi" ? "Pi chats only" : "Hermes chats only") : m.backend === "pi" ? "Pi" : undefined;
                  return { value: m.id, label: shortModelLabel(m.label), sub: m.provider, note, disabled: !m.online || !usable };
                })}
                value={p.model}
                open={modelOpen}
                onOpenChange={setModelOpen}
                onSelect={id => p.onModel(id)}
              />
            )}

            {efforts.length > 0 && (
              <div className="effort" role="group" aria-label="Reasoning effort">
                <span className="effort-lbl">Thinking</span>
                <div className="seg">
                  {efforts.map(e => (
                    <button key={e} type="button" aria-pressed={p.effort === e} onClick={() => p.onEffort(e)}>{e === "off" ? "Off" : e === "low" ? "Low" : e === "medium" ? "Med" : "High"}</button>
                  ))}
                </div>
              </div>
            )}

            {busy && p.runId && (
              <button className="btn stop icon-send" type="button" aria-label="Stop" onClick={p.onStop}>
                <Icon name="stop" className="i sm" /><span className="send-lbl">Stop</span>
              </button>
            )}
            {busy ? (
              <button className="btn primary icon-send" type="button" aria-label="Steer" disabled={!canSteer} onClick={() => void steer()}><Icon name="up" className="i sm" /><span className="send-lbl">Steer</span></button>
            ) : (
              <button className="btn primary icon-send" type="button" aria-label="Send" disabled={!canSend} onClick={() => void submit()}>
                <Icon name="up" className="i sm" /><span className="send-lbl">Send</span>
              </button>
            )}
            </div>
          </div>
        </div>
        <div className="comp-foot">
          <span className={`hint${notice && !err ? " note" : ""}`} role={notice || err ? "status" : undefined}>{err || notice || (files.some(f => f.note === "Text PDFs only") ? "Text PDFs only" : p.phone ? (meter && meter.pct >= 70 ? `Context ~${Math.round(meter.pct)}% full` : "") : "Enter to send · Shift+Enter for a new line")}</span>
        </div>
      </div>
    </div>
  );
}
