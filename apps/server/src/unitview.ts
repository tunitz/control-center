export type UnitViewDeps = {
  now: number;
  pollInterval: number;
  latest: (unitId: number) => Record<string, number | null> | null;
  staticJson: (unitId: number) => string | null;
};

export const isOnline = (u: { last_seen: number | null }, now: number, pollInterval: number) =>
  !!u.last_seen && now - u.last_seen < Math.max(30, pollInterval * 4);

export function unitView(u: any, deps: UnitViewDeps) {
  const l = deps.latest(u.id);
  const sj = deps.staticJson(u.id);
  const s = sj ? JSON.parse(sj) : null;
  const online = isOnline(u, deps.now, deps.pollInterval);
  const enabled = !!u.enabled;
  // Live power only counts units that are online and enabled; offline/disabled contribute nothing.
  const live_w = !online || !enabled || !l || (l.cpu_w == null && l.gpu_w == null) ? null : (l.cpu_w ?? 0) + (l.gpu_w ?? 0);
  return {
    live_w,
    id: u.id, name: u.name, host: u.host, ssh_port: u.ssh_port, mac: u.mac, broadcast: u.broadcast, enabled: !!u.enabled, online, last_seen: u.last_seen, last_error: u.last_error,
    fingerprint: u.fingerprint, sample_interval_s: u.sample_interval_s, static: s, latest: l,
    ram_pct: l && s && l.ram_used_mb != null ? (l.ram_used_mb / s.ram_total_mb) * 100 : null,
    vram_pct: l && s?.vram_total_mb && l.vram_used_mb != null ? (l.vram_used_mb / s.vram_total_mb) * 100 : null,
  };
}
