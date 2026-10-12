import { useEffect, useMemo, useState } from "react";
import { chat, ChatError } from "../chat/api";
import type { PiAgent, PiSkill } from "../chat/types";
import { agentFromDraft, blankAgent, filterSkills, modelOptions, THINKING_OPTIONS, thinkingValue, validAgentName, type AgentDraft } from "../chat/subagents";
import { toolRows } from "../chat/tools";
import { PiToolList, usePiTools } from "./PiToolList";

type Editing = { isNew: boolean; name: string; draft: AgentDraft };

/** Subagents the main Pi agent can hand work to. Each has its own model, thinking, instructions, notes, tools and skills. */
export default function SubagentsCard({ onMsg }: { onMsg: (m: string) => void }) {
  const [agents, setAgents] = useState<PiAgent[]>([]);
  const [state, setState] = useState<"loading" | "ready" | "off" | "down">("loading");
  const [editing, setEditing] = useState<Editing | null>(null);
  const [skills, setSkills] = useState<PiSkill[]>([]);
  const [skillQuery, setSkillQuery] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const tools = usePiTools();

  const load = () => chat.piAgents().then(r => { setAgents(r.agents); setState("ready"); })
    .catch(e => setState((e as ChatError).status === 503 && /not configured/i.test((e as Error).message) ? "off" : "down"));

  useEffect(() => {
    void load();
    chat.piSkills().then(r => setSkills(r.skills)).catch(() => setSkills([]));
  }, []);

  const dedupedSkills = useMemo(() => {
    const seen = new Set<string>();
    return skills.filter(s => (seen.has(s.name) ? false : (seen.add(s.name), true)));
  }, [skills]);
  const shownSkills = filterSkills(dedupedSkills, skillQuery);
  const models = modelOptions(agents);

  const open = (a: PiAgent) => {
    setErr(""); setSkillQuery("");
    setEditing({ isNew: false, name: a.name, draft: { description: a.description, model: a.model, thinking: a.thinking, instructions: a.instructions, notes: a.notes, tools: a.tools, skills: a.skills } });
  };
  const startNew = () => { setErr(""); setSkillQuery(""); setEditing({ isNew: true, name: "", draft: blankAgent() }); };
  const close = () => { setEditing(null); setErr(""); };
  const patch = (p: Partial<AgentDraft>) => setEditing(e => (e ? { ...e, draft: { ...e.draft, ...p } } : e));

  const toggleIn = (list: string[], v: string) => (list.includes(v) ? list.filter(x => x !== v) : [...list, v]);

  const save = async () => {
    if (!editing) return;
    setErr("");
    const name = editing.name.trim();
    if (!validAgentName(name)) { setErr("Name: use lowercase letters, digits and dashes, starting with a letter, up to 40 characters."); return; }
    if (editing.isNew && agents.some(a => a.name === name)) { setErr("A subagent with that name already exists."); return; }
    setBusy(true);
    try {
      const saved = await chat.putPiAgent(agentFromDraft(name, editing.draft));
      setAgents(list => [...list.filter(a => a.name !== saved.name), saved].sort((x, y) => x.name.localeCompare(y.name)));
      setEditing(null);
      onMsg(`${saved.name} saved.`);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!editing || editing.isNew) return;
    if (!confirm(`Delete the subagent ${editing.name}?`)) return;
    setErr(""); setBusy(true);
    try {
      await chat.deletePiAgent(editing.name);
      setAgents(list => list.filter(a => a.name !== editing.name));
      setEditing(null);
      onMsg(`${editing.name} deleted.`);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const d = editing?.draft;
  const toolList = d ? toolRows(tools ?? [], d.tools) : [];

  return (
    <div className="acc-sub" id="subagents"><h3 className="acc-subtitle">Subagents</h3>
      {state === "loading" && <p className="muted" role="status">Loading</p>}
      {state === "off" && <p className="muted">Pi is not set up on this server.</p>}
      {state === "down" && <p className="muted" role="alert">Pi is not reachable. Start the pi-bridge service, then reload this page.</p>}
      {state === "ready" && !editing && (
        <>
          <p className="muted">Subagents are helpers the main Pi agent can hand work to. Each one has its own tools and skills.</p>
          {agents.length === 0 && <p className="muted">No subagents yet.</p>}
          {agents.length > 0 && (
            <ul className="pi-rules">
              {agents.map(a => (
                <li key={a.name}>
                  <span style={{ minWidth: 0 }}><code>{a.name}</code>{a.description && <span className="muted"> {a.description}</span>}</span>
                  <button className="btn" type="button" aria-label={`Edit ${a.name}`} onClick={() => open(a)}>Edit</button>
                </li>
              ))}
            </ul>
          )}
          <div style={{ marginTop: 12 }}><button className="btn pri" type="button" onClick={startNew}>New subagent</button></div>
        </>
      )}
      {state === "ready" && editing && d && (
        <form onSubmit={e => { e.preventDefault(); void save(); }} style={{ display: "grid", gap: 12, minWidth: 0 }}>
          <div>
            <label htmlFor="sub-name">Name</label>
            <input id="sub-name" value={editing.name} readOnly={!editing.isNew} onChange={e => setEditing({ ...editing, name: e.target.value })} placeholder="code-review" autoComplete="off" />
            {editing.isNew && <p className="muted">Lowercase letters, digits and dashes. Can't be changed later.</p>}
          </div>
          <div>
            <label htmlFor="sub-desc">Description</label>
            <input id="sub-desc" value={d.description} maxLength={500} onChange={e => patch({ description: e.target.value })} placeholder="What it is for" />
          </div>
          <div>
            <label htmlFor="sub-model">Model</label>
            <input id="sub-model" list="sub-models" value={d.model} onChange={e => patch({ model: e.target.value })} placeholder="inherit" autoComplete="off" />
            <datalist id="sub-models">{models.map(m => <option key={m} value={m} />)}</datalist>
            <p className="muted">"inherit" uses the chat's model.</p>
          </div>
          <div>
            <label htmlFor="sub-thinking">Thinking</label>
            <select id="sub-thinking" value={thinkingValue(d.thinking)} onChange={e => patch({ thinking: e.target.value })}>
              {THINKING_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </div>
          <div>
            <label htmlFor="sub-instructions">Extra instructions</label>
            <textarea id="sub-instructions" rows={4} value={d.instructions} maxLength={20000} onChange={e => patch({ instructions: e.target.value })} style={{ width: "100%" }} />
          </div>
          <div>
            <label htmlFor="sub-notes">Notes</label>
            <textarea id="sub-notes" rows={3} value={d.notes} maxLength={20000} onChange={e => patch({ notes: e.target.value })} style={{ width: "100%" }} />
          </div>
          <fieldset style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
            <legend style={{ fontWeight: 600 }}>Tools</legend>
            <p className="muted">Only these tools, for this subagent. Nothing is selected by default.</p>
            {tools === null && <p className="muted" role="status">Loading tools</p>}
            <PiToolList
              label="Subagent tools"
              rows={toolList}
              disabled={false}
              isLocked={() => false}
              onToggle={name => patch({ tools: toggleIn(d.tools, name) })}
            />
          </fieldset>
          <fieldset style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
            <legend style={{ fontWeight: 600 }}>Skills</legend>
            <label htmlFor="sub-skill-q" className="muted">Search skills</label>
            <input id="sub-skill-q" type="search" value={skillQuery} onChange={e => setSkillQuery(e.target.value)} placeholder="Search by name or description" autoComplete="off" />
            <div className="pi-tool-list" role="group" aria-label="Skills" style={{ marginTop: 8 }}>
              {shownSkills.map(s => (
                <label className="pi-tool" key={s.name}>
                  <input type="checkbox" checked={d.skills.includes(s.name)} onChange={() => patch({ skills: toggleIn(d.skills, s.name) })} />
                  <span className="pi-tool-main"><code>{s.name}</code>{s.description && <span className="muted">{s.description}</span>}</span>
                </label>
              ))}
              {shownSkills.length === 0 && <p className="muted">No skills match.</p>}
            </div>
          </fieldset>
          {err && <p role="alert" className="muted" style={{ color: "var(--err)", margin: 0, overflowWrap: "anywhere" }}>{err}</p>}
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            <button className="btn pri" type="submit" disabled={busy}>Save</button>
            <button className="btn" type="button" onClick={close} disabled={busy}>Cancel</button>
            {!editing.isNew && <button className="btn dng" type="button" onClick={() => void remove()} disabled={busy}>Delete</button>}
          </div>
        </form>
      )}
    </div>
  );
}
