import type { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import { getSetting, setSetting } from "./db";

export async function ensureAdmin(db: Database, envPassword?: string): Promise<string | null> {
  if (getSetting(db, "admin_hash", "")) return null;
  const pw = envPassword || randomBytes(9).toString("base64url");
  setSetting(db, "admin_hash", await Bun.password.hash(pw, { algorithm: "argon2id" }));
  return envPassword ? null : pw;
}
export async function checkPassword(db: Database, pw: string): Promise<boolean> {
  const h = getSetting(db, "admin_hash", "");
  return !!h && Bun.password.verify(pw, h);
}
export async function changePassword(db: Database, pw: string) {
  if (pw.length < 8) throw new Error("password too short (min 8)");
  setSetting(db, "admin_hash", await Bun.password.hash(pw, { algorithm: "argon2id" }));
}
export function createSession(db: Database, now: number): string {
  const id = randomBytes(24).toString("base64url");
  db.query("INSERT INTO sessions(id,expires_at) VALUES(?,?)").run(id, now + 7 * 86400);
  return id;
}
export function validSession(db: Database, id: string | undefined, now: number): boolean {
  if (!id) return false;
  return !!db.query("SELECT 1 FROM sessions WHERE id=? AND expires_at>?").get(id, now);
}
export function destroySession(db: Database, id: string) { db.query("DELETE FROM sessions WHERE id=?").run(id); }

/** Fixed-window limiter: max n per window per key. */
export function makeLimiter(max: number, windowS: number) {
  const hits = new Map<string, { c: number; reset: number }>();
  return (k: string, now: number) => {
    const h = hits.get(k);
    if (!h || h.reset <= now) { hits.set(k, { c: 1, reset: now + windowS }); return true; }
    return ++h.c <= max;
  };
}
