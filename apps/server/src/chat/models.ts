/** Curated model allowlist, capability flags, availability and chat config. */
import type { Database } from "bun:sqlite";
import type { HermesClient, ModelOptions } from "./hermes";
import { uploadLimits } from "./uploads";
import { EFFORTS, type Effort } from "./store";

export type ChatModelDef = {
  id: string;
  provider: string;
  label: string;
  reasoning: boolean;
  canDisableReasoning: boolean;
  vision: boolean;
  local: boolean;
};

export type ChatModel = ChatModelDef & { online: boolean };

export const DEFAULT_MODELS: ChatModelDef[] = [
  { id: "claude-sonnet-5-5", provider: "anthropic", label: "Claude Sonnet 5.5", reasoning: true, canDisableReasoning: true, vision: true, local: false },
  { id: "claude-haiku-5-5", provider: "anthropic", label: "Claude Haiku 5.5", reasoning: false, canDisableReasoning: false, vision: true, local: false },
  { id: "deepseek-flash", provider: "deepseek", label: "DeepSeek Flash", reasoning: true, canDisableReasoning: true, vision: false, local: false },
];

export const CONTEXT_WINDOW: Record<string, number> = {
  "claude-sonnet-5-5": 200000,
  "claude-haiku-5-5": 200000,
  "deepseek-flash": 1000000,
};

const DEFAULT_MODEL = "claude-sonnet-5-5";

function getSettingRaw(db: Database, key: string): string | null {
  const row = db.query("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | null;
  return row ? row.value : null;
}

/** Effective list: settings `chat.models` (JSON array) if it has at least one valid entry, else the default. */
export function modelList(db: Database): ChatModelDef[] {
  const raw = getSettingRaw(db, "chat.models");
  if (!raw) return DEFAULT_MODELS;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return DEFAULT_MODELS; }
  if (!Array.isArray(parsed)) return DEFAULT_MODELS;
  const valid: ChatModelDef[] = [];
  for (const e of parsed) {
    if (typeof e !== "object" || e === null) continue;
    const m = e as Record<string, unknown>;
    if (typeof m.id !== "string" || typeof m.provider !== "string") continue;
    valid.push({
      id: m.id,
      provider: m.provider,
      label: typeof m.label === "string" ? m.label : m.id,
      reasoning: m.reasoning === true,
      canDisableReasoning: m.canDisableReasoning === true,
      vision: m.vision === true,
      local: m.local === true,
    });
  }
  return valid.length ? valid : DEFAULT_MODELS;
}

export function getModelDef(db: Database, id: string): ChatModelDef | null {
  return modelList(db).find(m => m.id === id) ?? null;
}

/** Availability from Hermes: excluded models and providers that are not authenticated are offline. */
function onlineFrom(m: ChatModelDef, opts: ModelOptions): boolean {
  if (opts.unavailable_models.includes(m.id)) return false;
  const p = opts.providers.find(x => x.id === m.provider);
  if (p && !p.authenticated) return false;
  return true;
}

/**
 * Models with Hermes availability. `localProbe` (optional) gates local models on a short
 * reachability check; it is never awaited for more than its own timeout and never blocks
 * the Hermes call. Without a probe, local models follow Hermes availability alone.
 */
export async function getModels(
  db: Database, hermes: HermesClient, opts: { localProbe?: () => Promise<boolean> } = {},
): Promise<ChatModel[]> {
  const list = modelList(db);
  let mo: ModelOptions | null = null;
  try {
    mo = await hermes.modelOptions();
  } catch {
    mo = null;
  }
  const localUp = opts.localProbe && list.some(m => m.local) ? await opts.localProbe().catch(() => false) : true;
  return list.map(m => ({ ...m, online: mo ? onlineFrom(m, mo) && (!m.local || localUp) : false }));
}

export function isEffort(v: unknown): v is Effort {
  return typeof v === "string" && (EFFORTS as readonly string[]).includes(v);
}

export function getConfig(db: Database): {
  defaultModel: string;
  defaultEffort: Effort | null;
  maxUploadMb: number;
  contextWindow: Record<string, number>;
} {
  const dm = getSettingRaw(db, "chat.defaultModel");
  const de = getSettingRaw(db, "chat.defaultEffort");
  return {
    defaultModel: dm && getModelDef(db, dm) ? dm : DEFAULT_MODEL,
    defaultEffort: isEffort(de) ? de : null,
    maxUploadMb: uploadLimits(db).maxMb,
    contextWindow: CONTEXT_WINDOW,
  };
}
