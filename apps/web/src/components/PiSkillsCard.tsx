import { useEffect, useState } from "react";
import { chat, ChatError } from "../chat/api";
import type { PiSkill } from "../chat/types";

/** Last two path segments, so a project folder fits on one line. */
const shortPath = (p: string): string => p.split("/").filter(Boolean).slice(-2).join("/");

/** Pi skills (global + project) with a per-skill enable/disable toggle. Lives in Settings. */
export default function PiSkillsCard({ onMsg }: { onMsg: (m: string) => void }) {
  const [skills, setSkills] = useState<PiSkill[]>([]);
  const [state, setState] = useState<"loading" | "ready" | "off" | "down">("loading");
  const [saving, setSaving] = useState("");
  const [err, setErr] = useState("");

  useEffect(() => {
    chat.piSkills().then(r => { setSkills(r.skills); setState("ready"); })
      .catch(e => setState((e as ChatError).status === 503 && /not configured/i.test((e as Error).message) ? "off" : "down"));
  }, []);

  const toggle = async (s: PiSkill) => {
    setErr("");
    setSaving(s.path);
    const disabled = new Set(skills.filter(x => !x.enabled).map(x => x.path));
    if (s.enabled) disabled.add(s.path); else disabled.delete(s.path);
    try {
      const r = await chat.putPiSkills([...disabled]);
      setSkills(r.skills);
      onMsg(s.enabled ? `${s.name} disabled.` : `${s.name} enabled.`);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSaving("");
    }
  };

  const group = (scope: PiSkill["scope"]) => skills.filter(s => s.scope === scope);
  const row = (s: PiSkill) => (
    <label className="pi-skill" key={s.path}>
      <input type="checkbox" checked={s.enabled} disabled={saving === s.path} onChange={() => void toggle(s)} />
      <span className="pi-skill-main">
        <span className="pi-skill-head">
          <span className="pi-skill-name">{s.name}</span>
          <span className={`pi-skill-tag${s.enabled ? "" : " off"}`}>{s.enabled ? "On" : "Off"}</span>
        </span>
        <span className="pi-skill-desc">{s.description}</span>
        {s.scope === "project" && s.cwd && <span className="pi-skill-where">Project · {shortPath(s.cwd)}</span>}
      </span>
    </label>
  );

  const globals = group("global");
  const projects = group("project");

  return (
    <div className="acc-sub" id="pi-skills"><h3 className="acc-subtitle">Skills</h3>
      {state === "loading" && <p className="muted" role="status">Loading</p>}
      {state === "off" && <p className="muted">Pi is not set up on this server.</p>}
      {state === "down" && <p className="muted" role="alert">Pi is not reachable. Start the pi-bridge service, then reload this page.</p>}
      {state === "ready" && (
        <>
          <p className="muted">Skills Pi can use. A toggle applies to every Pi chat on its next message.</p>
          {skills.length === 0 && <p className="muted">No skills found. Add a folder with a <code>SKILL.md</code> under <code>~/.agents/skills</code> or a project's <code>.pi/skills</code>.</p>}
          {globals.length > 0 && (
            <>
              <h4 className="pi-skill-group">Global</h4>
              <div className="pi-skill-list">{globals.map(row)}</div>
            </>
          )}
          {projects.length > 0 && (
            <>
              <h4 className="pi-skill-group">Project</h4>
              <div className="pi-skill-list">{projects.map(row)}</div>
            </>
          )}
          {err && <p role="alert" className="muted" style={{ color: "var(--err)" }}>{err}</p>}
          <p className="muted">A skill with a description is loaded by Pi; disabling one restarts idle chats and takes effect on a busy chat's next message.</p>
        </>
      )}
    </div>
  );
}
