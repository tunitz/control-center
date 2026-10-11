/**
 * Per-chat Pi settings that Pi applies live over RPC (docs/pi-plan.md T6, first slice).
 * Only the keys a person changed are stored; reads merge them over Pi's own defaults.
 * Anything not in this schema is rejected, never ignored.
 */
import { ChatError } from "./http";

export type QueueMode = "all" | "one-at-a-time";
export type PiSettings = {
  steeringMode: QueueMode;
  followUpMode: QueueMode;
  autoCompaction: boolean;
  autoRetry: boolean;
};

export const PI_SETTING_DEFAULTS: PiSettings = {
  steeringMode: "one-at-a-time",
  followUpMode: "one-at-a-time",
  autoCompaction: true,
  autoRetry: true,
};

const MODES: readonly string[] = ["all", "one-at-a-time"];

/** Validates a PATCH body. Throws ChatError 400 on an unknown key, a wrong type, or an empty object. */
export function parsePiSettingsPatch(body: unknown): Partial<PiSettings> {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new ChatError(400, "settings must be an object");
  const out: Partial<PiSettings> = {};
  for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
    if (k === "steeringMode" || k === "followUpMode") {
      if (typeof v !== "string" || !MODES.includes(v)) throw new ChatError(400, `${k} must be all or one-at-a-time`);
      out[k] = v as QueueMode;
    } else if (k === "autoCompaction" || k === "autoRetry") {
      if (typeof v !== "boolean") throw new ChatError(400, `${k} must be a boolean`);
      out[k] = v;
    } else {
      throw new ChatError(400, `unknown setting: ${k}`);
    }
  }
  if (Object.keys(out).length === 0) throw new ChatError(400, "no settings given");
  return out;
}

/** Reads the stored JSON defensively: a corrupt or foreign value is dropped key by key. */
export function readStoredSettings(json: string | null): Partial<PiSettings> {
  if (!json) return {};
  try {
    return parsePiSettingsPatch(JSON.parse(json));
  } catch {
    return {};
  }
}

export const withDefaults = (stored: Partial<PiSettings>): PiSettings => ({ ...PI_SETTING_DEFAULTS, ...stored });
