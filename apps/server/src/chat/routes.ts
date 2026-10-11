/**
 * /api/chat router. Auth is applied by the caller (index.ts) before this runs.
 * Runs (send, events, stop, steer) are owned by RunManager (runs.ts).
 */
import { rmSync } from "node:fs";
import { resolve, sep } from "node:path";
import type { Database } from "bun:sqlite";
import { ChatError, json, readJson } from "./http";
import { FakeHermes } from "./fake-hermes";
import { HttpHermes, UnconfiguredHermes, type HermesClient } from "./hermes";
import { getConfig, getModelDef, getModels, isEffort } from "./models";
import * as S from "./store";
import type { Effort } from "./store";
import { toMarkdown, exportFilename } from "./export";
import { buildSessionDir, fileHeaders, inspectFile, MAX_FILES, MAX_BODY_BYTES, sanitizeAsciiFilename, saveUpload, uploadLimits, uploadRoot, type SavedUpload } from "./uploads";
import { assertImageSize, buildPrompt, type PromptAttachment } from "./prompt";
import { RunManager, recoverRuns } from "./runs";
import { DelegationWatcher } from "./watcher";

export type ChatContext = {
  db: Database;
  hermes: HermesClient;
  uploadRoot: string;
  now: () => number;
  /** Reports finished background subagents. Started by index.ts. */
  watcher?: DelegationWatcher;
  /** Host-side read-only credits endpoint (credits-http.service). */
  creditsUrl?: string;
};

const managers = new WeakMap<ChatContext, RunManager>();

/** The run manager for a context. Created on first use when the context was built by hand (tests). */
export function runsOf(ctx: ChatContext): RunManager {
  let m = managers.get(ctx);
  if (!m) {
    m = new RunManager({ db: ctx.db, hermes: ctx.hermes, now: () => ctx.now() });
    managers.set(ctx, m);
  }
  return m;
}

export function createChatContext(
  db: Database,
  opts: { env?: Record<string, string | undefined>; emit?: (event: string, data: unknown) => void } = {},
): ChatContext {
  const env = opts.env ?? process.env;
  let hermes: HermesClient;
  if (env.CHAT_FAKE_HERMES === "1") hermes = new FakeHermes();
  else if (env.HERMES_API_KEY) {
    hermes = new HttpHermes({ baseUrl: env.HERMES_URL || "http://127.0.0.1:8642", apiKey: env.HERMES_API_KEY });
  } else hermes = new UnconfiguredHermes();
  const ctx: ChatContext = { db, hermes, uploadRoot: uploadRoot(env), now: () => Date.now(), creditsUrl: env.CREDITS_URL || "http://127.0.0.1:9103/credits" };
  recoverRuns(db, ctx.now());
  const runs = new RunManager({ db, hermes, now: () => ctx.now(), emit: opts.emit });
  managers.set(ctx, runs);
  ctx.watcher = new DelegationWatcher({ db, hermes, runs, now: () => ctx.now() });
  return ctx;
}

const ID_RE = /^[A-Za-z0-9_-]{1,100}$/;

export async function handleChat(req: Request, url: URL, ctx: ChatContext): Promise<Response> {
  try {
    return await route(req, url, ctx);
  } catch (e) {
    if (e instanceof ChatError) return json({ error: e.message }, e.status);
    console.error("chat route failed:", (e as Error)?.name ?? "error");
    return json({ error: "internal error" }, 500);
  }
}

async function route(req: Request, url: URL, ctx: ChatContext): Promise<Response> {
  const method = req.method;
  if (method !== "GET" && req.headers.get("x-cc") !== "1") {
    return json({ error: "x-cc header required" }, 403);
  }
  const p = url.pathname.replace(/^\/api\/chat/, "");

  if (p === "/models" && method === "GET") return json(await getModels(ctx.db, ctx.hermes));
  if (p === "/config" && method === "GET") return json(getConfig(ctx.db));
  if (p === "/credits" && method === "GET") return creditsRoute(ctx);

  if (p === "/sessions" && method === "GET") return listSessionsRoute(url, ctx);
  if (p === "/sessions" && method === "POST") return createSessionRoute(req, ctx);

  let m = /^\/sessions\/([^/]+)(\/[a-z]+)?$/.exec(p);
  if (m && !m[2] && (method === "PATCH" || method === "DELETE")) {
    const id = safeId(m[1]);
    return method === "PATCH" ? patchSessionRoute(req, id, ctx) : deleteSessionRoute(id, ctx);
  }

  m = /^\/sessions\/([^/]+)\/(messages|send|export)$/.exec(p);
  if (m) {
    const id = safeId(m[1]);
    const action = m[2];
    if (action === "messages" && method === "GET") return messagesRoute(url, id, ctx);
    if (action === "send" && method === "POST") return sendRoute(req, id, ctx);
    if (action === "export" && method === "GET") return exportRoute(id, ctx);
  }

  m = /^\/files\/([^/]+)$/.exec(p);
  if (m && method === "GET") return fileRoute(safeId(m[1]), ctx);

  m = /^\/runs\/([^/]+)\/(events|stop|steer)$/.exec(p);
  if (m) {
    const runId = safeId(m[1]);
    const runs = runsOf(ctx);
    if (m[2] === "events" && method === "GET") {
      return runs.eventsResponse(runId, req.headers.get("last-event-id") ?? url.searchParams.get("last"));
    }
    if (m[2] === "stop" && method === "POST") {
      await runs.stop(runId);
      return json({ ok: true });
    }
    if (m[2] === "steer" && method === "POST") {
      const body = await readJson(req);
      if (typeof body.message !== "string" || body.message.trim() === "") throw new ChatError(400, "message must be a non-empty string");
      await runs.steer(runId, body.message.trim());
      return json({ ok: true });
    }
  }

  return json({ error: "not found" }, 404);
}

function safeId(raw: string): string {
  const id = decodeURIComponent(raw);
  if (!ID_RE.test(id)) throw new ChatError(404, "not found");
  return id;
}

function requireSession(ctx: ChatContext, id: string): S.ChatSession {
  const s = S.getSession(ctx.db, id);
  if (!s) throw new ChatError(404, "session not found");
  return s;
}

function listSessionsRoute(url: URL, ctx: ChatContext): Response {
  const archived = url.searchParams.get("archived") === "1";
  const q = url.searchParams.get("q") ?? "";
  if (q.trim() !== "") return json(S.searchSessions(ctx.db, { q, archived }));
  return json(S.listSessions(ctx.db, { archived }));
}

function resolveModel(ctx: ChatContext, model: unknown): { model: string; provider: string } {
  if (typeof model !== "string") throw new ChatError(400, "model must be a string");
  const def = getModelDef(ctx.db, model);
  if (!def) throw new ChatError(400, "unknown model");
  return { model: def.id, provider: def.provider };
}

function parseEffort(v: unknown): Effort | null {
  if (v === null || v === undefined) return null;
  if (!isEffort(v)) throw new ChatError(400, "invalid effort");
  return v;
}

async function createSessionRoute(req: Request, ctx: ChatContext): Promise<Response> {
  const body = await readJson(req);
  const cfg = getConfig(ctx.db);
  const picked = body.model === undefined ? { model: cfg.defaultModel, provider: getModelDef(ctx.db, cfg.defaultModel)!.provider } : resolveModel(ctx, body.model);
  const effort: Effort | null = body.effort === undefined ? cfg.defaultEffort : parseEffort(body.effort);

  const id = await ctx.hermes.createSession();
  try {
    await ctx.hermes.lockModel(id, picked.model, picked.provider);
  } catch {
    await ctx.hermes.deleteSession(id).catch(() => {});
    throw new ChatError(502, "could not set the model in hermes");
  }
  const session = S.createSession(ctx.db, {
    id, model: picked.model, provider: picked.provider, effort, now: ctx.now(), lockedModel: picked.model,
  });
  return json(session, 201);
}

async function patchSessionRoute(req: Request, id: string, ctx: ChatContext): Promise<Response> {
  requireSession(ctx, id);
  const body = await readJson(req);
  const patch: Parameters<typeof S.updateSession>[2] = {};
  if (body.title !== undefined) {
    if (typeof body.title !== "string" || body.title.trim() === "") throw new ChatError(400, "title must be a non-empty string");
    patch.title = body.title.trim().slice(0, 200);
  }
  if (body.pinned !== undefined) {
    if (typeof body.pinned !== "boolean") throw new ChatError(400, "pinned must be a boolean");
    patch.pinned = body.pinned;
  }
  if (body.archived !== undefined) {
    if (typeof body.archived !== "boolean") throw new ChatError(400, "archived must be a boolean");
    patch.archived = body.archived;
  }
  if (body.model !== undefined) {
    const r = resolveModel(ctx, body.model);
    patch.model = r.model;
    patch.provider = r.provider;
  }
  if (body.effort !== undefined) patch.effort = parseEffort(body.effort);
  const updated = S.updateSession(ctx.db, id, patch, ctx.now());
  return json(updated);
}

async function deleteSessionRoute(id: string, ctx: ChatContext): Promise<Response> {
  const s = requireSession(ctx, id);
  if (s.runState !== "idle") throw new ChatError(409, "run active");
  await ctx.hermes.deleteSession(id);
  S.deleteSession(ctx.db, id);
  rmSync(buildSessionDir(ctx.uploadRoot, id), { recursive: true, force: true });
  return json({ ok: true });
}

function messagesRoute(url: URL, id: string, ctx: ChatContext): Response {
  requireSession(ctx, id);
  const beforeRaw = url.searchParams.get("before");
  const limitRaw = url.searchParams.get("limit");
  if (beforeRaw !== null && !/^\d+$/.test(beforeRaw)) throw new ChatError(400, "before must be a seq number");
  if (limitRaw !== null && !/^\d+$/.test(limitRaw)) throw new ChatError(400, "limit must be a number");
  const page = S.listMessages(ctx.db, id, {
    before: beforeRaw === null ? undefined : Number(beforeRaw),
    limit: limitRaw === null ? 40 : Number(limitRaw),
  });
  return json(page);
}

function exportRoute(id: string, ctx: ChatContext): Response {
  const s = requireSession(ctx, id);
  const md = toMarkdown({
    title: s.title, model: s.model, createdAt: s.createdAt,
    messages: S.listAllMessages(ctx.db, id).map(m => ({
      role: m.role, text: m.text, status: m.status, reasoning: m.reasoning, attachments: m.attachments,
    })),
  });
  const fname = exportFilename(s.title);
  const enc = encodeURIComponent(fname).replace(/['()*]/g, c => "%" + c.charCodeAt(0).toString(16).toUpperCase());
  return new Response(md, {
    headers: {
      "content-type": "text/markdown; charset=utf-8",
      "content-disposition": `attachment; filename="${sanitizeAsciiFilename(fname)}"; filename*=UTF-8''${enc}`,
      "x-content-type-options": "nosniff",
      "cache-control": "no-store",
    },
  });
}

function fileRoute(id: string, ctx: ChatContext): Response {
  const row = ctx.db.query(
    "SELECT path, kind, name, mime FROM chat_attachments WHERE id = ?",
  ).get(id) as { path: string; kind: "image" | "file"; name: string; mime: string } | null;
  if (!row) throw new ChatError(404, "not found");
  const root = resolve(ctx.uploadRoot);
  const path = resolve(row.path);
  if (!path.startsWith(root + sep)) throw new ChatError(404, "not found");
  const file = Bun.file(path);
  return new Response(file, { headers: fileHeaders({ kind: row.kind, mime: row.mime, name: row.name }) });
}

async function sendRoute(req: Request, id: string, ctx: ChatContext): Promise<Response> {
  const s = requireSession(ctx, id);
  if (s.runState !== "idle") throw new ChatError(409, "run active");
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > MAX_BODY_BYTES) throw new ChatError(413, "request too large");

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    throw new ChatError(400, "multipart form required");
  }

  const text = form.get("text");
  if (text !== null && typeof text !== "string") throw new ChatError(400, "text must be a string");
  const files = form.getAll("files").filter((v): v is File => typeof v !== "string");
  if (form.getAll("files").length > MAX_FILES) throw new ChatError(400, "too many files");
  const trimmed = (text ?? "").trim();
  if (trimmed === "" && files.length === 0) throw new ChatError(400, "empty message");

  const modelField = form.get("model");
  const effortField = form.get("effort");
  const picked = typeof modelField === "string" && modelField !== ""
    ? resolveModel(ctx, modelField) : { model: s.model, provider: s.provider };
  const effort = typeof effortField === "string" && effortField !== "" ? parseEffort(effortField) : s.effort;
  // Effort is a hint, sent only to models that report reasoning.
  const sentEffort = getModelDef(ctx.db, picked.model)?.reasoning ? effort : null;

  const { maxBytes } = uploadLimits(ctx.db);
  const blobs: { name: string; bytes: Uint8Array }[] = [];
  for (const f of files) {
    const bytes = new Uint8Array(await f.arrayBuffer());
    if (bytes.length === 0) throw new ChatError(400, "empty file");
    if (bytes.length > maxBytes) throw new ChatError(413, "file too large");
    const info = inspectFile(f.name || "file", bytes);
    if (info.kind === "image") {
      if (info.w === null || info.h === null) throw new ChatError(400, "image unreadable");
      assertImageSize(info.w, info.h);
    }
    blobs.push({ name: f.name || "file", bytes });
  }

  const runs = runsOf(ctx);
  runs.reserve(id);
  const saved: SavedUpload[] = [];
  let started = false;
  try {
    await runs.ensureModel(id, picked.model, picked.provider);
    if (typeof modelField === "string" && modelField !== "" || typeof effortField === "string" && effortField !== "") {
      S.updateSession(ctx.db, id, {
        ...(typeof modelField === "string" && modelField !== "" ? { model: picked.model, provider: picked.provider } : {}),
        ...(typeof effortField === "string" && effortField !== "" ? { effort } : {}),
      }, ctx.now());
    }
    for (const b of blobs) saved.push(await saveUpload(ctx.uploadRoot, id, b.name, b.bytes, maxBytes));

    const promptAtts: PromptAttachment[] = saved.map((a, i) => ({
      kind: a.kind, name: a.name, mime: a.mime, size: a.size, path: a.path, w: a.w, h: a.h,
      bytes: a.kind === "image" ? blobs[i].bytes : undefined,
    }));
    const prompt = buildPrompt({ text: trimmed, attachments: promptAtts });
    const r = runs.begin(id, {
      text: trimmed, message: prompt.message, attachments: saved, model: picked.model, effort: sentEffort,
    });
    started = true;
    return json({ runId: r.runId, userMessage: r.userMessage, assistantMessage: r.assistantMessage }, 201);
  } finally {
    if (!started) {
      runs.release(id);
      for (const a of saved) rmSync(a.path, { force: true });
    }
  }
}

/** /credits: balance text from the host script, via a tiny read-only endpoint. No model call, no tokens. */
async function creditsRoute(ctx: ChatContext): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(ctx.creditsUrl ?? "http://127.0.0.1:9103/credits", { signal: AbortSignal.timeout(45_000) });
  } catch {
    throw new ChatError(502, "credits service is not reachable");
  }
  const text = (await res.text()).trim();
  if (!res.ok) throw new ChatError(502, text || `credits failed (${res.status})`);
  return json({ text });
}
