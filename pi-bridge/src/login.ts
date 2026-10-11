/**
 * Provider sign-in ("/login" in the chat) driven from the bridge.
 *
 * The bridge owns one Pi `ModelRuntime` pointed at the agent dir's auth.json, the same file the
 * spawned `pi --mode rpc` processes read. A login is an async flow that asks the user questions
 * (API key, an authorization code) through `prompt()` and announces links/device codes through
 * `notify()`; both are forwarded to the browser over SSE and answered through HTTP. `auth.json`
 * holds API keys and OAuth tokens, so it is never returned by any route here.
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { HttpError, type Frame } from "./chat";
import type { BridgeConfig } from "./config";

export type AuthType = "oauth" | "api_key";

export interface AuthProviderInfo {
  id: string;
  name: string;
  authTypes: AuthType[];
  oauthLabel?: string;
  subscription: boolean;
  configured: boolean;
  source?: string;
}

export interface LoginPromptOption {
  id: string;
  label: string;
  description?: string;
}

export interface LoginPrompt {
  id: string;
  type: "text" | "secret" | "select" | "manual_code";
  message: string;
  placeholder?: string;
  options?: LoginPromptOption[];
}

/** The subset of Pi's `ModelRuntime` the login manager uses. Injectable so tests need no SDK. */
export interface AuthRuntimeProvider {
  id: string;
  name: string;
  auth: { oauth?: { isSubscription?: boolean; loginLabel?: string }; apiKey?: { login?: unknown } };
}

export interface AuthRuntime {
  getProviders(): AuthRuntimeProvider[];
  getProviderAuthStatus(id: string): { configured: boolean; label?: string; source?: string };
  login(
    providerId: string,
    type: AuthType,
    interaction: { signal: AbortSignal; prompt(prompt: any): Promise<string>; notify(event: any): void },
    options?: { getDeviceId?: () => string },
  ): Promise<unknown>;
}

export type LoadRuntime = () => Promise<AuthRuntime>;

/** One in-flight (or just-finished) sign-in. Questions and notices are replayed from `ring` on reconnect. */
export class AuthSession {
  readonly ring: Frame[] = [];
  readonly subs = new Set<(f: Frame) => void>();
  seq = 0;
  done = false;
  result: { ok: boolean; error: string | null } | null = null;
  startedAt = Date.now();
  finishedAt: number | null = null;
  private pending: (LoginPrompt & { resolve(value: string): void; reject(err: Error): void }) | null = null;
  private readonly abort = new AbortController();

  constructor(
    readonly id: string,
    readonly provider: string,
    readonly providerName: string,
    readonly authType: AuthType,
  ) {}

  get signal(): AbortSignal {
    return this.abort.signal;
  }

  emit(event: string, data: any): void {
    const f: Frame = { id: ++this.seq, event, data };
    this.ring.push(f);
    if (this.ring.length > 200) this.ring.splice(0, this.ring.length - 200);
    for (const s of this.subs) s(f);
  }

  /** Pi asks the user something. Only one question is open at a time; the flow awaits the answer. */
  ask(raw: any): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const id = randomUUID();
      const prompt: LoginPrompt & { resolve(value: string): void; reject(err: Error): void } = {
        id,
        type: raw?.type === "secret" || raw?.type === "select" || raw?.type === "manual_code" ? raw.type : "text",
        message: typeof raw?.message === "string" ? raw.message : "Enter a value",
        ...(typeof raw?.placeholder === "string" ? { placeholder: raw.placeholder } : {}),
        ...(Array.isArray(raw?.options)
          ? {
              options: raw.options
                .filter((o: any) => o && typeof o.id === "string" && typeof o.label === "string")
                .map((o: any) => ({ id: o.id, label: o.label, ...(typeof o.description === "string" ? { description: o.description } : {}) })),
            }
          : {}),
        resolve,
        reject,
      };
      this.pending = prompt;
      this.emit("prompt", { id, type: prompt.type, message: prompt.message, placeholder: prompt.placeholder, options: prompt.options });
      // Some flows race a manual prompt against a callback; the loser is aborted and must reject.
      if (raw?.signal) {
        const signal: AbortSignal = raw.signal;
        const onAbort = () => {
          if (this.pending?.id === id) {
            this.pending = null;
            this.emit("prompt_end", { id, cancelled: true });
            reject(new Error("Login cancelled"));
          }
        };
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      }
    });
  }

  respond(value: string, promptId?: string): void {
    const p = this.pending;
    if (!p || (promptId !== undefined && promptId !== p.id)) throw new HttpError(409, "this question is no longer waiting");
    this.pending = null;
    this.emit("prompt_end", { id: p.id });
    p.resolve(value);
  }

  finish(ok: boolean, error: string | null): void {
    if (this.done) return;
    this.done = true;
    this.finishedAt = Date.now();
    this.result = { ok, error };
    this.emit("done", { ok, error, provider: this.provider, authType: this.authType });
  }

  cancel(): void {
    if (this.done) return;
    this.abort.abort(new Error("Login cancelled"));
    const p = this.pending;
    this.pending = null;
    if (p) {
      this.emit("prompt_end", { id: p.id, cancelled: true });
      p.reject(new Error("Login cancelled"));
    }
    this.finish(false, "cancelled");
  }
}

export interface AuthManagerOptions {
  loadRuntime: LoadRuntime;
  /** A stable per-installation id (some providers send it). Cached once read. */
  getDeviceId: () => string;
  now?: () => number;
  /** How long a finished sign-in stays readable for a late client. */
  keepMs?: number;
  /** Called after a credential is stored: live Pi processes must be recycled to see it. */
  onLogin?: () => void;
}

export class AuthManager {
  private runtime: Promise<AuthRuntime> | null = null;
  private starting = false;
  private readonly sessions = new Map<string, AuthSession>();
  private readonly loadRuntime: LoadRuntime;
  private readonly loadDeviceId: () => string;
  private readonly now: () => number;
  private readonly keepMs: number;
  private readonly onLogin: (() => void) | undefined;

  constructor(opts: AuthManagerOptions) {
    this.loadRuntime = opts.loadRuntime;
    this.loadDeviceId = opts.getDeviceId;
    this.now = opts.now ?? (() => Date.now());
    this.keepMs = opts.keepMs ?? 5 * 60_000;
    this.onLogin = opts.onLogin;
  }

  private rt(): Promise<AuthRuntime> {
    this.runtime ??= this.loadRuntime();
    return this.runtime;
  }

  /** Every provider Pi can sign in to (OAuth and/or an interactive API key). */
  async providers(): Promise<AuthProviderInfo[]> {
    const rt = await this.rt();
    const out: AuthProviderInfo[] = [];
    for (const p of rt.getProviders()) {
      const authTypes: AuthType[] = [];
      if (p.auth.oauth) authTypes.push("oauth");
      if (p.auth.apiKey?.login) authTypes.push("api_key");
      if (authTypes.length === 0) continue;
      let status: { configured: boolean; label?: string; source?: string } = { configured: false };
      try {
        status = rt.getProviderAuthStatus(p.id) ?? status;
      } catch {
        // a status check must never take down the list
      }
      out.push({
        id: p.id,
        name: p.name,
        authTypes,
        ...(p.auth.oauth?.loginLabel ? { oauthLabel: p.auth.oauth.loginLabel } : {}),
        subscription: p.auth.oauth?.isSubscription === true,
        configured: status.configured === true,
        ...(status.label || status.source ? { source: status.label ?? status.source } : {}),
      });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  /** The sign-in currently in flight, if any. Only one runs at a time so auth.json writes cannot interleave. */
  active(): AuthSession | null {
    for (const s of this.sessions.values()) if (!s.done) return s;
    return null;
  }

  async start(providerId: string, authType: AuthType): Promise<AuthSession> {
    // A second sign-in supersedes the first. A stale flow (the sheet was reloaded, or an earlier
    // attempt was abandoned) must never wedge the feature; cancel it and start fresh.
    this.active()?.cancel();
    if (this.starting) throw new HttpError(409, "a sign-in is already starting");
    this.starting = true;
    try {
      const rt = await this.rt();
      const provider = rt.getProviders().find((p) => p.id === providerId);
      if (!provider) throw new HttpError(400, `unknown provider: ${providerId}`);
      if (authType === "oauth" ? !provider.auth.oauth : !provider.auth.apiKey?.login) {
        throw new HttpError(400, `${provider.name} does not support ${authType === "oauth" ? "a sign-in" : "an API key"}`);
      }
      const session = new AuthSession(randomUUID(), provider.id, provider.name, authType);
      this.sessions.set(session.id, session);
      void this.run(rt, session).catch(() => {});
      return session;
    } finally {
      this.starting = false;
    }
  }

  private async run(rt: AuthRuntime, session: AuthSession): Promise<void> {
    try {
      await rt.login(
        session.provider,
        session.authType,
        {
          signal: session.signal,
          prompt: (p) => session.ask(p),
          notify: (e) => session.emit("auth", e),
        },
        { getDeviceId: () => this.loadDeviceId() },
      );
      // A stored credential only reaches a live Pi process when that process is recycled.
      try { this.onLogin?.(); } catch { /* a recycle failure must not fail the sign-in */ }
      session.finish(true, null);
    } catch (e) {
      session.finish(false, session.signal.aborted ? "cancelled" : (e as Error)?.message || "sign-in failed");
    }
  }

  get(id: string): AuthSession {
    const s = this.sessions.get(id);
    if (!s) throw new HttpError(404, "no sign-in with that id");
    return s;
  }

  respond(id: string, value: string, promptId?: string): void {
    this.get(id).respond(value, promptId);
  }

  cancel(id: string): void {
    this.get(id).cancel();
  }

  /** Drops finished sign-ins after a while so a late client can still read the outcome. */
  prune(): void {
    const cutoff = this.now() - this.keepMs;
    for (const [id, s] of this.sessions) {
      if (s.done && s.finishedAt !== null && s.finishedAt < cutoff) this.sessions.delete(id);
    }
  }

  events(id: string, after: number): Response {
    const session = this.get(id);
    const enc = new TextEncoder();
    let closed = false;
    let sub: ((f: Frame) => void) | undefined;
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        // Flush the headers at once; otherwise a client waiting on the stream stalls until the first event.
        controller.enqueue(enc.encode(": open\n\n"));
        const send = (f: Frame) => {
          if (closed) return;
          controller.enqueue(enc.encode(`id: ${f.id}\nevent: ${f.event}\ndata: ${JSON.stringify(f.data)}\n\n`));
        };
        for (const f of session.ring) if ((f.id ?? 0) > after) send(f);
        if (session.done) {
          closed = true;
          controller.close();
          return;
        }
        sub = (f) => {
          send(f);
          if (f.event === "done") {
            closed = true;
            session.subs.delete(sub!);
            try {
              controller.close();
            } catch {}
          }
        };
        session.subs.add(sub);
      },
      cancel: () => {
        closed = true;
        if (sub) session.subs.delete(sub);
      },
    });
    return new Response(stream, {
      headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" },
    });
  }
}

/** Reads (or creates) the stable device id next to auth.json. */
export function makeDeviceIdLoader(agentDir: string): () => string {
  const path = join(agentDir, "device-id");
  let cached: string | null = null;
  return () => {
    if (cached) return cached;
    try {
      if (existsSync(path)) {
        const v = readFileSync(path, "utf8").trim();
        if (v) {
          cached = v;
          return v;
        }
      }
    } catch {
      // fall through and regenerate
    }
    cached = randomUUID();
    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, cached + "\n", { mode: 0o600 });
    } catch {
      // an unwritable agent dir only costs a fresh id per process
    }
    return cached;
  };
}

/** Loads Pi's own ModelRuntime against the bridge's agent dir (the same files the spawned Pi reads). */
export function makeRuntimeLoader(cfg: BridgeConfig): LoadRuntime {
  let cached: Promise<AuthRuntime> | null = null;
  return () => {
    cached ??= (async () => {
      const entry = join(cfg.piPackageDir, "dist/index.js");
      if (!existsSync(entry)) throw new HttpError(503, "Pi package is not installed");
      const sdk: any = await import(entry);
      const runtime = await sdk.ModelRuntime.create({
        authPath: join(cfg.agentDir, "auth.json"),
        modelsPath: join(cfg.agentDir, "models.json"),
        modelsStorePath: join(cfg.agentDir, "models-store.json"),
      });
      return runtime as AuthRuntime;
    })();
    return cached;
  };
}
