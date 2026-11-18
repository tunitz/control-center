import type { DiskSnapshot } from "./lib/disks";
export type { DiskSnapshot } from "./lib/disks";
export class ApiError extends Error { constructor(public status: number, msg: string) { super(msg); } }
export async function api<T = any>(path: string, opts: { method?: string; body?: unknown; priority?: "low" | "high" | "auto" } = {}): Promise<T> {
  const r = await fetch("/api" + path, {
    method: opts.method ?? "GET", credentials: "same-origin",
    headers: { "content-type": "application/json", ...(opts.method && opts.method !== "GET" ? { "x-cc": "1" } : {}) },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    // Progressive enhancement: unsupported browsers ignore this key.
    ...(opts.priority ? ({ priority: opts.priority } as any) : {}),
  });
  const j = await r.json().catch(() => ({}));
  if (r.status === 401 && typeof window !== "undefined") {
    try { localStorage.removeItem("cc:authed"); } catch { /* ignore */ }
  }
  if (!r.ok) { const e = new ApiError(r.status, j.error ?? r.statusText); Object.assign(e, j); throw e; }
  return j as T;
}
export type ServiceKind = "systemd" | "user" | "docker" | "lxc";
export type ServiceItem = { kind: ServiceKind; name: string; state: string; detail?: string };
export type ServiceRef = { kind: ServiceKind; name: string };
export type ServiceLogLine = { ts: number; level: "error" | "warn" | "info" | "debug"; msg: string };
export type Sample = Record<string, number | null>;
export type Unit = {
  id: number; name: string; host: string; ssh_port?: number; mac: string | null; broadcast: string | null; enabled: boolean; online: boolean; sample_fresh?: boolean; last_sample_ts?: number | null; last_seen: number | null; last_error: string | null;
  fingerprint: string | null; public_key?: string | null; host_fingerprint?: string | null; migration_pending_port?: number | null; sample_interval_s: number; latest: Sample | null; live_w: number | null; wall_w?: number | null; wall_ts?: number | null; ram_pct: number | null; vram_pct: number | null;
  static: null | { cpu_model: string; cores: number; threads: number; base_mhz: number | null; boost_mhz: number | null; gpu_model: string | null; vram_total_mb: number | null; ram_total_mb: number; swap_total_mb: number };
  month?: { kwh: number; php: number };
  disks?: DiskSnapshot;
};
export type Metrics = { range: string; tier: string; points: Sample[]; energy_wh: number; summary: Record<string, { min: number | null; avg: number | null; max: number | null }> };
export const RANGES = ["1h", "6h", "12h", "24h", "7d", "30d"] as const;
export const fmt = (v: number | null | undefined, d = 0, unit = "") => (v == null || !isFinite(v) ? "—" : v.toFixed(d) + unit);
export const gb = (mb: number | null | undefined) => (mb == null ? "—" : (mb / 1024).toFixed(1) + " GB");
