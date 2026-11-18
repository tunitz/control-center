import { test, expect } from "bun:test";
import { unitView } from "./unitview";

const NOW = 1_000_000;
const base = { id: 1, name: "u", host: "h", ssh_port: 62478, mac: null, broadcast: null, enabled: 1, last_seen: NOW - 5, last_error: null, fingerprint: null, sample_interval_s: 5 };
const view = (u: any, latest: Record<string, number | null> | null, pollInterval = 5) =>
  unitView(u, { now: NOW, pollInterval, latest: () => latest, staticJson: () => null });

test("online+enabled unit: live_w = cpu_w + gpu_w", () => {
  const v = view(base, { cpu_w: 40, gpu_w: 60 });
  expect(v.online).toBe(true);
  expect(v.live_w).toBe(100);
});

test("online+enabled unit: null watts treated as 0", () => {
  expect(view(base, { cpu_w: 40, gpu_w: null }).live_w).toBe(40);
  expect(view(base, { cpu_w: null, gpu_w: 25 }).live_w).toBe(25);
});

test("online+enabled unit: live_w null when both watts are null or no sample", () => {
  expect(view(base, { cpu_w: null, gpu_w: null }).live_w).toBeNull();
  expect(view(base, null).live_w).toBeNull();
});

test("offline unit (stale last_seen): live_w null, online false", () => {
  const stale = { ...base, last_seen: NOW - 1000 };
  const v = view(stale, { cpu_w: 40, gpu_w: 60 });
  expect(v.online).toBe(false);
  expect(v.live_w).toBeNull();
});

test("offline unit (last_seen null): live_w null", () => {
  const v = view({ ...base, last_seen: null }, { cpu_w: 40, gpu_w: 60 });
  expect(v.online).toBe(false);
  expect(v.live_w).toBeNull();
});

test("offline threshold uses max(30, pollInterval*4)", () => {
  // pollInterval 20 -> threshold 80s; last_seen 60s ago is still online
  expect(view({ ...base, last_seen: NOW - 60 }, { cpu_w: 1, gpu_w: 1 }, 20).live_w).toBe(2);
  expect(view({ ...base, last_seen: NOW - 90 }, { cpu_w: 1, gpu_w: 1 }, 20).live_w).toBeNull();
});

test("disabled unit: live_w null even when online", () => {
  const v = view({ ...base, enabled: 0 }, { cpu_w: 40, gpu_w: 60 });
  expect(v.online).toBe(true);
  expect(v.enabled).toBe(false);
  expect(v.live_w).toBeNull();
});

test("online flag unchanged and latest passed through", () => {
  const latest = { cpu_w: 40, gpu_w: 60, cpu_pct: 12 };
  const v = view(base, latest);
  expect(v.online).toBe(true);
  expect(v.latest).toEqual(latest);
});
