import { test, expect } from "bun:test";
import { relativeTime, stateTone, canStart, canStop, groupByKind, filterItems, hintFor, isAgentMissing, AGENT_HINT, displayName, KIND_ORDER, KIND_LABEL } from "./services";

const AGENT_MISSING = "agent not reachable";

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

test("groupByKind: fixed order systemd, user, docker, lxc; empty kinds dropped; names sorted", () => {
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

test("KIND_ORDER is systemd, user, docker, lxc and every kind has a label", () => {
  expect(KIND_ORDER).toEqual(["systemd", "user", "docker", "lxc"]);
  expect(KIND_LABEL.user).toBe("User services");
});

test("groupByKind: user items form one group per username, sorted by username, labelled", () => {
  const items = [
    { kind: "user" as const, name: "carol:syncthing.service", state: "active" },
    { kind: "user" as const, name: "bob:redis.service", state: "active" },
    { kind: "user" as const, name: "carol:backup.timer", state: "active" },
    { kind: "systemd" as const, name: "sshd.service", state: "active" },
  ];
  const g = groupByKind(items);
  expect(g.map(x => x.kind)).toEqual(["systemd", "user", "user"]);
  expect(g[1]).toMatchObject({ kind: "user", label: "User services (bob)" });
  expect(g[1].items.map(i => i.name)).toEqual(["bob:redis.service"]);
  expect(g[2]).toMatchObject({ kind: "user", label: "User services (carol)" });
  expect(g[2].items.map(i => i.name)).toEqual(["carol:backup.timer", "carol:syncthing.service"]);
});

test("groupByKind: non-user groups carry the KIND_LABEL label", () => {
  const g = groupByKind([{ kind: "docker" as const, name: "web", state: "running" }]);
  expect(g[0]).toMatchObject({ kind: "docker", label: "Docker" });
});

test("displayName: unit part for user items, plain name otherwise", () => {
  expect(displayName({ kind: "user", name: "carol:syncthing.service" })).toBe("syncthing.service");
  expect(displayName({ kind: "user", name: "a:b:c" })).toBe("b:c");
  expect(displayName({ kind: "systemd", name: "nginx.service" })).toBe("nginx.service");
  expect(displayName({ kind: "docker", name: "web" })).toBe("web");
});

test("filterItems: matches the displayName of user items, and the full name too", () => {
  const items = [
    { kind: "user" as const, name: "carol:syncthing.service", state: "active" },
    { kind: "systemd" as const, name: "nginx.service", state: "active" },
  ];
  expect(filterItems(items, "SYNC").map(i => i.name)).toEqual(["carol:syncthing.service"]);
  expect(filterItems(items, "carol:sync").map(i => i.name)).toEqual(["carol:syncthing.service"]);
  expect(filterItems(items, "carol").map(i => i.name)).toEqual(["carol:syncthing.service"]);
  expect(filterItems(items, "nginx").map(i => i.name)).toEqual(["nginx.service"]);
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

test("hintFor: list-level agent hint shows only when the picker is closed", () => {
  expect(hintFor({ listErr: AGENT_MISSING, pickerOpen: false, discoverCount: 0, pickerErr: "" })).toBe("list");
  expect(hintFor({ listErr: AGENT_MISSING, pickerOpen: true, discoverCount: 0, pickerErr: "" })).toBe("picker");
});

test("hintFor: picker shows the hint once for empty discover or agent-missing error, never both", () => {
  expect(hintFor({ listErr: "", pickerOpen: true, discoverCount: 0, pickerErr: "" })).toBe("picker");
  expect(hintFor({ listErr: "", pickerOpen: true, discoverCount: 3, pickerErr: AGENT_MISSING })).toBe("picker");
  expect(hintFor({ listErr: "", pickerOpen: true, discoverCount: 0, pickerErr: AGENT_MISSING })).toBe("picker");
  expect(hintFor({ listErr: "", pickerOpen: true, discoverCount: 3, pickerErr: "" })).toBeNull();
});

test("hintFor: non-agent errors never produce the hint", () => {
  expect(hintFor({ listErr: "timeout", pickerOpen: false, discoverCount: 0, pickerErr: "" })).toBeNull();
  expect(hintFor({ listErr: "", pickerOpen: true, discoverCount: 3, pickerErr: "timeout" })).toBeNull();
  expect(hintFor({ listErr: "", pickerOpen: false, discoverCount: 0, pickerErr: "" })).toBeNull();
});

test("isAgentMissing matches agent-related error text", () => {
  expect(isAgentMissing("agent not installed")).toBe(true);
  expect(isAgentMissing("Agent offline")).toBe(true);
  expect(isAgentMissing("timeout")).toBe(false);
});
