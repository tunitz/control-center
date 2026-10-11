import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { api, harness, parseFrame, type Frame, type Harness } from "./helpers";
import type { AuthRuntime, AuthType } from "../src/login";

/** A scripted stand-in for Pi's ModelRuntime. The login flow notifies, asks for a code, then completes. */
class FakeRuntime implements AuthRuntime {
  lastValue: string | undefined;
  selected: string | undefined;
  selectFirst = false;
  failNext = false;
  readonly statuses = new Map<string, { configured: boolean; label?: string; source?: string }>();
  readonly providers = [
    { id: "anthropic", name: "Anthropic", auth: { oauth: { isSubscription: true, loginLabel: "Sign in with Claude" }, apiKey: { login: {} } } },
    { id: "deepseek", name: "DeepSeek", auth: { apiKey: { login: {} } } },
    { id: "ambient", name: "Ambient Cloud", auth: { apiKey: {} } },
  ];
  getProviders() {
    return this.providers;
  }
  getProviderAuthStatus(id: string) {
    return this.statuses.get(id) ?? { configured: false };
  }
  async login(providerId: string, _type: AuthType, interaction: any) {
    this.statuses.set(providerId, { configured: true, label: "OAuth" });
    interaction.notify({ type: "auth_url", url: "https://example.com/sign-in", instructions: "Open the page" });
    if (this.selectFirst) {
      this.selected = await interaction.prompt({
        type: "select",
        message: "Select Anthropic login method:",
        options: [
          { id: "browser", label: "Browser login (default)" },
          { id: "headless", label: "Copy code login (headless)" },
        ],
      });
    }
    const value = await interaction.prompt({ type: "manual_code", message: "Paste the code", placeholder: "code" });
    this.lastValue = value;
    if (value === "bad") throw new Error("wrong code");
    if (this.failNext) throw new Error("provider exploded");
    interaction.notify({ type: "progress", message: "Saved" });
  }
}

let rt: FakeRuntime;
let h: Harness;

beforeAll(async () => {
  rt = new FakeRuntime();
  h = await harness({}, { loadAuthRuntime: async () => rt });
});
afterAll(async () => {
  await h.close();
});

/** Reads an auth SSE stream until `until` matches. */
async function readAuth(hh: Harness, id: string, until: (f: Frame) => boolean, after = 0, timeoutMs = 3000): Promise<Frame[]> {
  const ac = new AbortController();
  const frames: Frame[] = [];
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(`${hh.base}/auth/login/${id}/events?after=${after}`, { headers: { authorization: `Bearer ${hh.token}` }, signal: ac.signal });
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf("\n\n")) !== -1) {
        const raw = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const f = parseFrame(raw);
        if (!f) continue;
        frames.push(f);
        if (until(f)) {
          ac.abort();
          return frames;
        }
      }
    }
  } catch {
    // aborted or stream ended
  } finally {
    clearTimeout(timer);
    ac.abort();
  }
  return frames;
}

const started = (f: Frame) => f.event === "prompt";
const done = (f: Frame) => f.event === "done";

describe("auth providers", () => {
  test("lists only providers with a usable method, with auth types and status", async () => {
    const r = await api(h, "GET", "/auth/providers");
    expect(r.status).toBe(200);
    const ids = r.json.providers.map((p: any) => p.id);
    expect(ids).toEqual(["anthropic", "deepseek"]); // ambient (no login) is omitted, sorted by name
    const anthropic = r.json.providers.find((p: any) => p.id === "anthropic");
    expect(anthropic.authTypes).toEqual(["oauth", "api_key"]);
    expect(anthropic.oauthLabel).toBe("Sign in with Claude");
    expect(anthropic.subscription).toBe(true);
    expect(anthropic.configured).toBe(false);
  });

  test("requires the bearer token", async () => {
    const r = await api(h, "GET", "/auth/providers", undefined, null);
    expect(r.status).toBe(401);
  });
});

describe("auth login", () => {
  test("rejects an unknown provider and an unsupported method", async () => {
    expect((await api(h, "POST", "/auth/login", { provider: "nope", authType: "oauth" })).status).toBe(400);
    expect((await api(h, "POST", "/auth/login", { provider: "deepseek", authType: "oauth" })).status).toBe(400);
    expect((await api(h, "POST", "/auth/login", { provider: "anthropic", authType: "nonsense" })).status).toBe(400);
  });

  test("runs the flow: notify, prompt, answer, done", async () => {
    const start = await api(h, "POST", "/auth/login", { provider: "anthropic", authType: "oauth" });
    expect(start.status).toBe(201);
    const id = start.json.id as string;

    const seen = await readAuth(h, id, started);
    const auth = seen.find((f) => f.event === "auth")!;
    expect(auth.data).toMatchObject({ type: "auth_url", url: "https://example.com/sign-in" });
    const prompt = seen.find((f) => f.event === "prompt")!;
    expect(prompt.data.type).toBe("manual_code");
    expect(prompt.data.message).toBe("Paste the code");

    const answer = await api(h, "POST", `/auth/login/${id}/response`, { value: "abc-123", promptId: prompt.data.id });
    expect(answer.status).toBe(200);
    expect(rt.lastValue).toBe("abc-123");

    const finished = await readAuth(h, id, done, prompt.id ?? 0);
    expect(finished.find((f) => f.event === "done")!.data).toMatchObject({ ok: true, error: null });

    // The provider is now configured, and the list reflects it.
    const list = await api(h, "GET", "/auth/providers");
    expect(list.json.providers.find((p: any) => p.id === "anthropic").configured).toBe(true);
  });

  test("a completed sign-in recycles idle chats so they pick up the credential", async () => {
    expect((await api(h, "POST", "/chats/recycle-1/start", {})).status).toBe(200);
    expect(h.bridge.chats.size()).toBe(1);
    const start = await api(h, "POST", "/auth/login", { provider: "anthropic", authType: "oauth" });
    const id = start.json.id as string;
    const seen = await readAuth(h, id, started);
    const prompt = seen.find((f) => f.event === "prompt")!;
    await api(h, "POST", `/auth/login/${id}/response`, { value: "code", promptId: prompt.data.id });
    await readAuth(h, id, done, prompt.id ?? 0);
    await new Promise((r) => setTimeout(r, 30));
    expect(h.bridge.chats.size()).toBe(0);
  });

  test("a stale prompt answer is refused", async () => {
    const start = await api(h, "POST", "/auth/login", { provider: "anthropic", authType: "oauth" });
    const id = start.json.id as string;
    const seen = await readAuth(h, id, started);
    const prompt = seen.find((f) => f.event === "prompt")!;
    const bad = await api(h, "POST", `/auth/login/${id}/response`, { value: "x", promptId: "wrong" });
    expect(bad.status).toBe(409);
    await api(h, "POST", `/auth/login/${id}/cancel`, {});
  });

  test("a new sign-in supersedes the previous one instead of wedging", async () => {
    const a = await api(h, "POST", "/auth/login", { provider: "anthropic", authType: "oauth" });
    expect(a.status).toBe(201);
    await readAuth(h, a.json.id, started);
    const b = await api(h, "POST", "/auth/login", { provider: "deepseek", authType: "api_key" });
    expect(b.status).toBe(201);
    const frames = await readAuth(h, a.json.id, done, 0);
    expect(frames.find((f) => f.event === "done")!.data).toMatchObject({ ok: false, error: "cancelled" });
    await api(h, "POST", `/auth/login/${b.json.id}/cancel`, {});
  });

  test("a select question forwards its options and answers by option id", async () => {
    const sel = new FakeRuntime();
    sel.selectFirst = true;
    const hh = await harness({}, { loadAuthRuntime: async () => sel });
    try {
      const start = await api(hh, "POST", "/auth/login", { provider: "anthropic", authType: "oauth" });
      const id = start.json.id as string;
      const seen = await readAuth(hh, id, (f) => f.event === "prompt" && f.data.type === "select");
      const prompt = seen.find((f) => f.event === "prompt")!;
      expect(prompt.data.options).toEqual([
        { id: "browser", label: "Browser login (default)" },
        { id: "headless", label: "Copy code login (headless)" },
      ]);
      await api(hh, "POST", `/auth/login/${id}/response`, { value: "browser", promptId: prompt.data.id });
      expect(sel.selected).toBe("browser");
      await api(hh, "POST", `/auth/login/${id}/cancel`, {});
    } finally {
      await hh.close();
    }
  });

  test("cancel ends the flow", async () => {
    const start = await api(h, "POST", "/auth/login", { provider: "anthropic", authType: "oauth" });
    const id = start.json.id as string;
    await readAuth(h, id, started);
    await api(h, "POST", `/auth/login/${id}/cancel`, {});
    const frames = await readAuth(h, id, done, 0);
    const d = frames.find((f) => f.event === "done")!;
    expect(d.data.ok).toBe(false);
    expect(d.data.error).toBe("cancelled");
  });

  test("a failed flow reports the message", async () => {
    const start = await api(h, "POST", "/auth/login", { provider: "anthropic", authType: "oauth" });
    const id = start.json.id as string;
    const seen = await readAuth(h, id, started);
    const prompt = seen.find((f) => f.event === "prompt")!;
    await api(h, "POST", `/auth/login/${id}/response`, { value: "bad", promptId: prompt.data.id });
    const frames = await readAuth(h, id, done, prompt.id ?? 0);
    expect(frames.find((f) => f.event === "done")!.data).toMatchObject({ ok: false, error: "wrong code" });
  });

  test("unknown login id is 404", async () => {
    expect((await api(h, "POST", "/auth/login/00000000-0000-0000-0000-000000000000/cancel", {})).status).toBe(404);
    expect((await api(h, "GET", "/auth/login/00000000-0000-0000-0000-000000000000/events")).status).toBe(404);
  });
});
