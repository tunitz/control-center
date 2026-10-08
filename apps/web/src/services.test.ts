import { test, expect } from "bun:test";
import { relativeTime, stateTone, canStart, canStop, groupByKind, filterItems } from "./services";

const NOW = 1_700_000_000_000;

test("relativeTime: seconds, minutes, hours, days", () => {
  expect(relativeTime(NOW - 0, NOW)).toBe("0s ago");
  expect(relativeTime(NOW - 12_000, NOW)).toBe("12s ago");
  expect(relativeTime(NOW - 59_999, NOW)).toBe("59s ago");
  expect(relativeTime(NOW - 60_000, NOW)).toBe("1m ago");
  expect(relativeTime(NOW - 3 * 60_000 - 5_000, NOW)).toBe("3m ago");
  expect(relativeTime(NOW - 2 * 3_600_000, NOW)).toBe("2h ago");
  expect(relativeTime(NOW - 3 * 86_400_000, NOW)).toBe("3d ago");
});

test("relativeTime: future timestamps (clock skew) clamp to 0s ago", () => {
  expect(relativeTime(NOW + 5_000, NOW)).toBe("0s ago");
});

test("stateTone: running/active ok, failed bad, everything else off", () => {
  expect(stateTone("running")).toBe("ok");
  expect(stateTone("active")).toBe("ok");
  expect(stateTone("Active")).toBe("ok");
  expect(stateTone("failed")).toBe("bad");
  expect(stateTone("stopped")).toBe("off");
  expect(stateTone("inactive")).toBe("off");
  expect(stateTone("exited")).toBe("off");
  expect(stateTone("")).toBe("off");
});

test("canStart is disabled only when already running", () => {
  expect(canStart("running")).toBe(false);
  expect(canStart("active")).toBe(false);
  expect(canStart("stopped")).toBe(true);
  expect(canStart("failed")).toBe(true);
});

test("canStop is disabled only when already stopped", () => {
  expect(canStop("running")).toBe(true);
  expect(canStop("failed")).toBe(true);
  expect(canStop("stopped")).toBe(false);
  expect(canStop("inactive")).toBe(false);
});

test("groupByKind: fixed order systemd, docker, lxc; empty kinds dropped; names sorted", () => {
  const items = [
    { kind: "lxc" as const, name: "101", state: "running", detail: "" },
    { kind: "docker" as const, name: "web", state: "running", detail: "" },
    { kind: "systemd" as const, name: "nginx", state: "active", detail: "" },
    { kind: "systemd" as const, name: "cron", state: "active", detail: "" },
  ];
  const g = groupByKind(items);
  expect(g.map(x => x.kind)).toEqual(["systemd", "docker", "lxc"]);
  expect(g[0].items.map(i => i.name)).toEqual(["cron", "nginx"]);
  expect(groupByKind([])).toEqual([]);
  expect(groupByKind(items.filter(i => i.kind !== "docker")).map(x => x.kind)).toEqual(["systemd", "lxc"]);
});

test("filterItems: case-insensitive substring on name, empty query keeps all", () => {
  const items = [
    { kind: "systemd" as const, name: "nginx", state: "active" },
    { kind: "docker" as const, name: "Plex", state: "running" },
  ];
  expect(filterItems(items, "")).toEqual(items);
  expect(filterItems(items, "  ")).toEqual(items);
  expect(filterItems(items, "PLE").map(i => i.name)).toEqual(["Plex"]);
  expect(filterItems(items, "zzz")).toEqual([]);
});
