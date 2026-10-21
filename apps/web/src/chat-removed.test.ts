import { test, expect } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const SRC = import.meta.dir;

/** Every source file under a directory, skipping tests (they name the paths they ban). */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap(f => {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) return sourceFiles(p);
    return /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f) ? [p] : [];
  });
}

test("the chat and Pi modules are gone from the web app", () => {
  const gone = [
    "chat", "chat.css", "components/chat", "pages/Chat.tsx",
    "components/PiConfigCard.tsx", "components/PiSkillsCard.tsx",
    "components/PiToolList.tsx", "components/SubagentsCard.tsx",
  ];
  const still = gone.filter(p => existsSync(join(SRC, p)));
  expect(still).toEqual([]);
});

test("no web source routes to the chat", () => {
  const offenders = sourceFiles(SRC)
    .map(f => [relative(SRC, f), readFileSync(f, "utf8")] as const)
    .filter(([, text]) => text.includes("#/chat") || text.includes("/api/chat"))
    .map(([file]) => file);
  expect(offenders).toEqual([]);
});

test("the app shell has no chat tab", () => {
  const main = readFileSync(join(SRC, "main.tsx"), "utf8");
  expect(main).not.toContain('href="#/chat"');
  expect(main).not.toContain("pages/Chat");
  // Header tabs and the bottom tab bar link to the dashboard and settings only.
  expect(main.match(/href="#\/[^"]*"/g)?.sort()).toEqual([
    'href="#/"', 'href="#/"', 'href="#/settings"', 'href="#/settings"',
  ]);
});

test("Settings has no Pi agent or Subagents group", () => {
  const settings = readFileSync(join(SRC, "pages/Settings.tsx"), "utf8");
  expect(settings).not.toContain("PiConfigCard");
  expect(settings).not.toContain("PiSkillsCard");
  expect(settings).not.toContain("SubagentsCard");
  expect(settings).not.toContain("Pi agent");
  expect(settings.match(/id: "[a-z-]+"/g)?.sort()).toEqual([
    'id: "appearance"', 'id: "monitoring"', 'id: "security"',
  ]);
});
