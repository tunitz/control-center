import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { tokenMatches } from "../src/auth";
import { api, harness, type Harness, TOKEN } from "./helpers";

let h: Harness;
beforeAll(async () => {
  h = await harness();
});
afterAll(async () => {
  await h.close();
});

describe("bearer auth", () => {
  test("every route answers 401 without a token", async () => {
    const routes: [string, string][] = [
      ["GET", "/sessions"],
      ["GET", "/models"],
      ["GET", "/chats/abc/events"],
      ["POST", "/chats/abc/start"],
      ["POST", "/chats/abc/prompt"],
      ["DELETE", "/chats/abc"],
      ["GET", "/nope"],
    ];
    for (const [m, p] of routes) {
      const r = await api(h, m, p, m === "POST" ? {} : undefined, null);
      expect([m, p, r.status]).toEqual([m, p, 401]);
    }
  });

  test("wrong token and wrong-length token are rejected", async () => {
    expect((await api(h, "GET", "/sessions", undefined, "nope")).status).toBe(401);
    expect((await api(h, "GET", "/sessions", undefined, TOKEN + "x")).status).toBe(401);
    expect((await api(h, "GET", "/sessions", undefined, "")).status).toBe(401);
  });

  test("correct token is accepted", async () => {
    const r = await api(h, "GET", "/sessions");
    expect(r.status).toBe(200);
  });

  test("tokenMatches is an exact, constant-time-style compare", () => {
    expect(tokenMatches("abc", "abc")).toBe(true);
    expect(tokenMatches("abc", "abd")).toBe(false);
    expect(tokenMatches("abc", "ab")).toBe(false);
    expect(tokenMatches("abc", "")).toBe(false);
  });
});
