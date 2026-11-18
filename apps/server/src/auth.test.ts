import { test, expect } from "bun:test";
import { openDb, getSetting } from "./db";
import { ensureAdmin, setupNeeded, setupAdmin, checkPassword, changePassword, createSession, validSession, sessionCookie, clearSessionCookie } from "./auth";

test("fresh database needs setup and invents no password", async () => {
  const db = openDb(":memory:");
  expect(await ensureAdmin(db)).toBeUndefined();
  expect(setupNeeded(db)).toBe(true);
  expect(getSetting(db, "admin_hash", "")).toBe("");
  expect(await checkPassword(db, "anything")).toBe(false);
});

test("env password seeds the hash and skips setup", async () => {
  const db = openDb(":memory:");
  await ensureAdmin(db, "envpassword");
  expect(setupNeeded(db)).toBe(false);
  expect(await checkPassword(db, "envpassword")).toBe(true);
  expect(await checkPassword(db, "wrong")).toBe(false);
});

test("setup sets the hash and cannot be repeated", async () => {
  const db = openDb(":memory:");
  await ensureAdmin(db);
  await setupAdmin(db, "strongpassword");
  expect(setupNeeded(db)).toBe(false);
  expect(await checkPassword(db, "strongpassword")).toBe(true);
  await expect(setupAdmin(db, "anotherpassword")).rejects.toThrow("password already set");
  expect(await checkPassword(db, "anotherpassword")).toBe(false);
});

test("setup and reset enforce the minimum length", async () => {
  const db = openDb(":memory:");
  await ensureAdmin(db);
  await expect(setupAdmin(db, "short")).rejects.toThrow("min 8");
  await setupAdmin(db, "longenough");
  await expect(changePassword(db, "short")).rejects.toThrow("min 8");
  await changePassword(db, "newlongenough");
  expect(await checkPassword(db, "newlongenough")).toBe(true);
});

test("sessions expire and cookie flags are centralised", () => {
  const db = openDb(":memory:");
  const id = createSession(db, 100);
  expect(validSession(db, id, 200)).toBe(true);
  expect(validSession(db, id, 100 + 7 * 86400 + 1)).toBe(false);
  expect(validSession(db, undefined, 200)).toBe(false);
  expect(sessionCookie(id)).toContain("HttpOnly");
  expect(sessionCookie(id)).toContain("SameSite=Strict");
  expect(sessionCookie(id)).toContain(`cc_session=${id}`);
  expect(clearSessionCookie()).toContain("Max-Age=0");
});
