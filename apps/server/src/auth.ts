import type { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import { getSetting, setSetting } from "./db";

const MIN_PASSWORD_LENGTH = 8;
const assertPassword = (pw: string) => {
  if (pw.length < MIN_PASSWORD_LENGTH) throw new Error(`password too short (min ${MIN_PASSWORD_LENGTH})`);
};

/** Seeds the hash only when an env password is supplied. With no env password the DB stays in
 *  setup-needed state and the browser prompts for one on first run (no random secret is invented). */
export async function ensureAdmin(db: Database, envPassword?: string): Promise<void> {
  if (getSetting(db, "admin_hash", "") || !envPassword) return;
  setSetting(db, "admin_hash", await Bun.password.hash(envPassword, { algorithm: "argon2id" }));
}

export function setupNeeded(db: Database): boolean {
  return !getSetting(db, "admin_hash", "");
}

export async function setupAdmin(db: Database, pw: string): Promise<void> {
  if (!setupNeeded(db)) throw new Error("password already set");
  assertPassword(pw);
  setSetting(db, "admin_hash", await Bun.password.hash(pw, { algorithm: "argon2id" }));
}

export async function checkPassword(db: Database, pw: string): Promise<boolean> {
  const h = getSetting(db, "admin_hash", "");
  return !!h && Bun.password.verify(pw, h);
}
export async function changePassword(db: Database, pw: string) {
  assertPassword(pw);
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

/** One place for the session cookie flags, shared by login, setup and logout. */
export const sessionCookie = (id: string) => `cc_session=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${7 * 86400}`;
export const clearSessionCookie = () => "cc_session=; Path=/; Max-Age=0";

/** Fixed-window limiter: max n per window per key. */
export function makeLimiter(max: number, windowS: number) {
  const hits = new Map<string, { c: number; reset: number }>();
  return (k: string, now: number) => {
    const h = hits.get(k);
    if (!h || h.reset <= now) { hits.set(k, { c: 1, reset: now + windowS }); return true; }
    return ++h.c <= max;
  };
}
