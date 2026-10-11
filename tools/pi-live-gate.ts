// Live gate for Pi chats (docs/pi-plan.md T8). Runs the real path: HTTP API of a Control Center
// instance -> PiClient -> pi-bridge (systemd) -> real Pi -> DeepSeek flash. Costs a few cents.
//
//   CC_URL=http://127.0.0.1:3031 CC_PASSWORD=... bun run tools/pi-live-gate.ts [--skip-timeout]
//
// Needs the bridge's env file for the bridge restart scenario (systemctl --user restart pi-bridge).
// Prints PASS/FAIL per scenario and exits 1 on any FAIL. Never prints the token or the key.
import { existsSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const BASE = process.env.CC_URL ?? "http://127.0.0.1:3031";
const PASSWORD = process.env.CC_PASSWORD ?? "";
const SKIP_TIMEOUT = process.argv.includes("--skip-timeout");
const WS = join(homedir(), ".local/share/cc-pi/workspace");
const MODEL = "deepseek-flash";

let cookie = "";
const results: { name: string; ok: boolean; note: string }[] = [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function api(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const headers: Record<string, string> = { cookie, "x-cc": "1" };
  let payload: BodyInit | undefined;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) { headers["content-type"] = "application/json"; payload = JSON.stringify(body); }
  const res = await fetch(BASE + "/api/chat" + path, { method, headers, body: payload });
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text.slice(0, 200) }; }
  return { status: res.status, json };
}

async function login() {
  const res = await fetch(BASE + "/api/auth/login", { method: "POST", headers: { "content-type": "application/json", "x-cc": "1" }, body: JSON.stringify({ password: PASSWORD }) });
  if (!res.ok) throw new Error(`login failed (${res.status})`);
  cookie = (res.headers.get("set-cookie") ?? "").split(";")[0];
}

const fd = (text: string, model = MODEL) => { const f = new FormData(); f.set("text", text); f.set("model", model); return f; };
const newPiChat = async () => (await api("POST", "/sessions", { backend: "pi", model: MODEL })).json;
const state = async (id: string) => (await api("GET", "/sessions")).json.find((s: any) => s.id === id)?.runState as string | undefined;
const messages = async (id: string) => (await api("GET", `/sessions/${id}/messages`)).json.messages as any[];

async function waitFor(what: string, fn: () => Promise<boolean>, ms = 60_000, every = 400): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await fn()) return; await sleep(every); }
  throw new Error(`timed out waiting for ${what}`);
}
const waitIdle = (id: string, ms = 90_000) => waitFor("idle", async () => (await state(id)) === "idle", ms);
const waitApproval = (id: string) => waitFor("needs_approval", async () => (await state(id)) === "needs_approval", 60_000);

/** Reads a run's SSE once from `last` (Last-Event-ID) until done or the stream closes. */
async function readEvents(runId: string, last = 0, stopAfterMs = 60_000): Promise<{ id: number; type: string; data: any }[]> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), stopAfterMs);
  const out: { id: number; type: string; data: any }[] = [];
  try {
    const res = await fetch(`${BASE}/api/chat/runs/${runId}/events`, { headers: { cookie, "last-event-id": String(last) }, signal: ctl.signal });
    const rd = res.body!.getReader(); const dec = new TextDecoder(); let buf = "";
    for (;;) {
      const { value, done } = await rd.read(); if (done) break;
      buf += dec.decode(value, { stream: true });
      let i: number;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const blk = buf.slice(0, i); buf = buf.slice(i + 2);
        const id = Number(/^id: (\d+)/m.exec(blk)?.[1] ?? 0);
        const type = /^event: (.*)$/m.exec(blk)?.[1] ?? "";
        const data = blk.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5)).join("");
        if (!type) continue;
        out.push({ id, type, data: data ? JSON.parse(data) : null });
        if (type === "done") return out;
      }
    }
  } catch { /* aborted or closed */ } finally { clearTimeout(timer); }
  return out;
}

async function scenario(name: string, fn: () => Promise<string>) {
  const t0 = Date.now();
  try { const note = await fn(); results.push({ name, ok: true, note }); console.log(`PASS  ${name} (${((Date.now() - t0) / 1000).toFixed(1)}s) ${note}`); }
  catch (e) { results.push({ name, ok: false, note: (e as Error).message }); console.log(`FAIL  ${name}: ${(e as Error).message}`); }
}
const must = (c: unknown, msg: string) => { if (!c) throw new Error(msg); };

async function main() {
  await login();
  const models = (await api("GET", "/models")).json as any[];
  must(models.some((m) => m.backend === "pi" && m.id === MODEL), "Pi model missing from /models (bridge down or token unset on this instance)");
  const created: string[] = [];
  const mk = async () => { const s = await newPiChat(); created.push(s.id); return s; };

  await scenario("1 stream: plain answer completes with usage and no approval", async () => {
    const s = await mk();
    const sent = (await api("POST", `/sessions/${s.id}/send`, fd("Reply with exactly the word PONG."))).json;
    await waitIdle(s.id);
    const m = (await messages(s.id)).find((x) => x.id === sent.assistantMessage.id);
    must(m.status === "complete", `status ${m.status}`);
    must(/PONG/i.test(m.text), `text: ${m.text.slice(0, 60)}`);
    must(m.usage && m.usage.input > 0, "no usage");
    return `"${m.text.trim().slice(0, 20)}" ${m.usage.input} in/${m.usage.output} out`;
  });

  await scenario("2 approve: risky command asks, Approve runs it, file exists", async () => {
    const s = await mk(); const f = join(WS, "gate-approve.txt"); rmSync(f, { force: true });
    const sent = (await api("POST", `/sessions/${s.id}/send`, fd(`Use the bash tool to run exactly: echo approved > ${f}  Then reply done.`))).json;
    await waitApproval(s.id);
    const evs = await readEvents(sent.runId, 0, 3000);
    const ap = evs.find((e) => e.type === "approval"); must(ap?.data?.id, "approval event has no id");
    must((await api("POST", `/runs/${sent.runId}/approval`, { id: ap!.data.id, choice: "approve" })).status === 200, "approve refused");
    await waitIdle(s.id);
    must(existsSync(f) && readFileSync(f, "utf8").trim() === "approved", "file not written");
    rmSync(f, { force: true });
    return "file written after Approve";
  });

  await scenario("3 deny: Deny blocks the command, file absent, run still completes", async () => {
    const s = await mk(); const f = join(WS, "gate-deny.txt"); rmSync(f, { force: true });
    const sent = (await api("POST", `/sessions/${s.id}/send`, fd(`Use the bash tool to run exactly: echo denied > ${f}  Then reply done.`))).json;
    await waitApproval(s.id);
    const ap = (await readEvents(sent.runId, 0, 3000)).find((e) => e.type === "approval");
    await api("POST", `/runs/${sent.runId}/approval`, { id: ap!.data.id, choice: "deny" });
    await waitIdle(s.id);
    must(!existsSync(f), "file exists after Deny");
    const m = (await messages(s.id)).find((x) => x.id === sent.assistantMessage.id);
    must(m.status === "complete", `status ${m.status}`);
    must(m.tools.some((t: any) => t.name === "bash" && t.status === "failed"), "bash not recorded as failed");
    return "blocked";
  });

  await scenario("4 protected path: reading ~/.ssh asks even though it is only a read", async () => {
    const s = await mk();
    const sent = (await api("POST", `/sessions/${s.id}/send`, fd("Use the read tool on ~/.ssh/config and tell me the first line."))).json;
    await waitApproval(s.id);
    const ap = (await readEvents(sent.runId, 0, 3000)).find((e) => e.type === "approval");
    must(/Protected path/.test(ap!.data.note), `note: ${ap!.data.note}`);
    await api("POST", `/runs/${sent.runId}/approval`, { id: ap!.data.id, choice: "deny" });
    await waitIdle(s.id);
    return "asked, denied";
  });

  await scenario("5 todo list: todo_write is stored on the message and returned after reload", async () => {
    const s = await mk();
    const sent = (await api("POST", `/sessions/${s.id}/send`, fd("Call todo_write once with 2 todos: id 1 content read status completed, id 2 content write status in_progress. Then reply done."))).json;
    await waitIdle(s.id);
    const m = (await messages(s.id)).find((x) => x.id === sent.assistantMessage.id);
    must(Array.isArray(m.todos) && m.todos.length === 2, `todos: ${JSON.stringify(m.todos)}`);
    return `${m.todos.length} items`;
  });

  await scenario("6 reload mid-run: reattach with Last-Event-ID replays, no duplicates, run completes", async () => {
    const s = await mk();
    const sent = (await api("POST", `/sessions/${s.id}/send`, fd("Count from 1 to 600, one number per line, nothing else."))).json;
    await sleep(700);
    const first = await readEvents(sent.runId, 0, 600);
    const lastSeen = first.at(-1)?.id ?? 0; must(lastSeen > 0, "no events before the reload");
    const second = await readEvents(sent.runId, lastSeen, 60_000);
    must(second.at(-1)?.type === "done", "reattached stream did not reach done");
    must(second.every((e) => e.id > lastSeen), "replay repeated events");
    const m = (await messages(s.id)).find((x) => x.id === sent.assistantMessage.id);
    must(m.status === "complete" && /600/.test(m.text), `final text: ${m.text.slice(-30)}`);
    return `reattached after event ${lastSeen}`;
  });

  await scenario("7 two chats at once: both finish, each with its own answer", async () => {
    const a = await mk(), b = await mk();
    const [sa, sb] = await Promise.all([
      api("POST", `/sessions/${a.id}/send`, fd("Reply with exactly the word ALPHA.")),
      api("POST", `/sessions/${b.id}/send`, fd("Reply with exactly the word BRAVO.")),
    ]);
    await Promise.all([waitIdle(a.id), waitIdle(b.id)]);
    const ma = (await messages(a.id)).find((x) => x.id === sa.json.assistantMessage.id);
    const mb = (await messages(b.id)).find((x) => x.id === sb.json.assistantMessage.id);
    must(/ALPHA/i.test(ma.text) && !/BRAVO/i.test(ma.text), `A: ${ma.text.slice(0, 30)}`);
    must(/BRAVO/i.test(mb.text) && !/ALPHA/i.test(mb.text), `B: ${mb.text.slice(0, 30)}`);
    return "separate answers";
  });

  await scenario("8 stop: stopping a long run ends it interrupted, not failed", async () => {
    const s = await mk();
    const sent = (await api("POST", `/sessions/${s.id}/send`, fd("Write a very long story about a dragon, at least 1500 words. Do not use any tools."))).json;
    await sleep(1200);
    must((await state(s.id)) === "running", "run already finished before the stop; the scenario needs a longer prompt");
    await api("POST", `/runs/${sent.runId}/stop`);
    await waitIdle(s.id, 30_000);
    const m = (await messages(s.id)).find((x) => x.id === sent.assistantMessage.id);
    must(m.status === "interrupted", `status ${m.status}`);
    return "interrupted";
  });

  await scenario("8b stop while an approval is waiting: Stop works, the command never runs, the chat is usable", async () => {
    const s = await mk(); const f = join(WS, "gate-stop-ask.txt"); rmSync(f, { force: true });
    const sent = (await api("POST", `/sessions/${s.id}/send`, fd(`Use the bash tool to run exactly: echo x > ${f}  Then reply done.`))).json;
    await waitApproval(s.id);
    const t0 = Date.now();
    must((await api("POST", `/runs/${sent.runId}/stop`)).status === 200, "stop refused");
    await waitIdle(s.id, 30_000);
    must(Date.now() - t0 < 20_000, `stop took ${Date.now() - t0} ms`);
    must(!existsSync(f), "the command ran although it was never approved");
    const again = (await api("POST", `/sessions/${s.id}/send`, fd("Reply with exactly the word BACK."))).json;
    await waitIdle(s.id);
    const m = (await messages(s.id)).find((x) => x.id === again.assistantMessage.id);
    must(m.status === "complete", `after stop: ${m.status}`);
    return `stopped in ${((Date.now() - t0) / 1000).toFixed(1)}s`;
  });

  await scenario("9 settings then next message: per-chat tools and steering apply after a restart, history kept", async () => {
    const s = await mk();
    await api("POST", `/sessions/${s.id}/send`, fd("Remember the code word KIWI-7. Reply OK."));
    await waitIdle(s.id);
    must((await api("PATCH", `/sessions/${s.id}/pi-settings`, { tools: ["read", "ls"], steeringMode: "all" })).status === 200, "patch refused");
    const sent = (await api("POST", `/sessions/${s.id}/send`, fd("What was the code word? Then list your tool names, comma separated."))).json;
    await waitIdle(s.id);
    const m = (await messages(s.id)).find((x) => x.id === sent.assistantMessage.id);
    must(/KIWI-7/i.test(m.text), `history lost: ${m.text.slice(0, 60)}`);
    must(!/\bbash\b/.test(m.text) && /\bread\b/.test(m.text), `tools not reduced: ${m.text.slice(0, 80)}`);
    return "history kept, tools reduced";
  });

  await scenario("10 settings are refused during a run (409) and change nothing", async () => {
    const s = await mk();
    const sent = (await api("POST", `/sessions/${s.id}/send`, fd("Write a very long story about a dragon, at least 1500 words. Do not use any tools."))).json;
    await sleep(1000);
    must((await state(s.id)) === "running", "run already finished");
    const r = await api("PATCH", `/sessions/${s.id}/pi-settings`, { autoRetry: false });
    must(r.status === 409, `status ${r.status}`);
    await api("POST", `/runs/${sent.runId}/stop`); await waitIdle(s.id);
    return "409 run active";
  });

  await scenario("11 bridge restart while idle: the next message resumes the same conversation", async () => {
    const s = await mk();
    await api("POST", `/sessions/${s.id}/send`, fd("Remember the code word MANGO-3. Reply OK."));
    await waitIdle(s.id);
    const p = Bun.spawnSync(["systemctl", "--user", "restart", "pi-bridge"]); must(p.exitCode === 0, "could not restart pi-bridge");
    await sleep(3000);
    const sent = (await api("POST", `/sessions/${s.id}/send`, fd("What was the code word?"))).json;
    await waitIdle(s.id);
    const m = (await messages(s.id)).find((x) => x.id === sent.assistantMessage.id);
    must(m.status === "complete" && /MANGO-3/i.test(m.text), `${m.status}: ${m.text.slice(0, 60)}`);
    return "resumed from the session file";
  });

  await scenario("12 bridge restart mid-run: the run ends interrupted or failed (never stuck), the chat works again", async () => {
    const s = await mk();
    const sent = (await api("POST", `/sessions/${s.id}/send`, fd("Write a very long story about a dragon, at least 1500 words. Do not use any tools."))).json;
    await sleep(1200);
    must((await state(s.id)) === "running", "run already finished");
    Bun.spawnSync(["systemctl", "--user", "restart", "pi-bridge"]);
    await waitIdle(s.id, 60_000);
    const m = (await messages(s.id)).find((x) => x.id === sent.assistantMessage.id);
    must(m.status === "interrupted" || m.status === "failed", `status ${m.status}`);
    await sleep(2500);
    const again = (await api("POST", `/sessions/${s.id}/send`, fd("Reply with exactly the word BACK."))).json;
    await waitIdle(s.id);
    const m2 = (await messages(s.id)).find((x) => x.id === again.assistantMessage.id);
    must(m2.status === "complete" && /BACK/i.test(m2.text), `after: ${m2.status} ${m2.text.slice(0, 40)}`);
    return `run ${m.status}, chat recovered`;
  });

  await scenario("13 backend isolation: a Hermes chat is untouched (backend hermes, no Pi fields)", async () => {
    const s = (await api("POST", "/sessions", {})).json; created.push(s.id);
    must(s.backend === "hermes", `backend ${s.backend}`);
    must((await api("GET", `/sessions/${s.id}/pi-settings`)).status === 400, "pi-settings should be 400 on Hermes");
    return "hermes chat unaffected";
  });

  if (!SKIP_TIMEOUT) {
    await scenario("14 no answer for 5 minutes: the command is denied, the file is absent", async () => {
      const s = await mk(); const f = join(WS, "gate-timeout.txt"); rmSync(f, { force: true });
      await api("POST", `/sessions/${s.id}/send`, fd(`Use the bash tool to run exactly: echo late > ${f}  Then reply done.`));
      await waitApproval(s.id);
      await waitIdle(s.id, 360_000);
      must(!existsSync(f), "file exists although nobody approved");
      return "denied by timeout";
    });
  }

  for (const id of created) await api("DELETE", `/sessions/${id}`);
  const bad = results.filter((r) => !r.ok);
  console.log(`\n${results.length - bad.length}/${results.length} scenarios passed`);
  process.exit(bad.length ? 1 : 0);
}

main().catch((e) => { console.log(`FAIL  gate crashed: ${(e as Error).message}`); process.exit(1); });
