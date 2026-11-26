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
/** Setup is authorized by a configured bootstrap token. Loopback is accepted only in local development. */
export async function authorizedSetup(db: Database, token: string, loopback: boolean, devMode = false): Promise<boolean> {
  return (devMode && loopback) || await checkBootstrap(db, token);
}

export async function setupAdmin(db: Database, pw: string): Promise<void> {
  assertPassword(pw);
  const hash = await Bun.password.hash(pw, { algorithm: "argon2id" });
  // The single statement is the lock: once the hash exists, setup is no longer needed.
  const r = db.query("UPDATE settings SET value=? WHERE key='admin_hash' AND value=''").run(hash);
  if (r.changes === 0) throw new Error("password already set");
}

export async function checkPassword(db: Database, pw: string): Promise<boolean> {
  const h = getSetting(db, "admin_hash", "");
  return !!h && Bun.password.verify(pw, h);
}
export async function changePassword(db: Database, pw: string) {
  assertPassword(pw);
  const hash = await Bun.password.hash(pw, { algorithm: "argon2id" });
  db.transaction(() => {
    setSetting(db, "admin_hash", hash);
    destroyAllSessions(db);
  })();
}
const currentAuthVersion = (db: Database) => Number(getSetting(db, "auth_version", "0"));
export const bootstrapRequired = (db: Database) => !getSetting(db, "bootstrap_hash", "");
export function createSession(db: Database, now: number): string {
  const id = randomBytes(24).toString("base64url");
  db.query("INSERT INTO sessions(id,expires_at,auth_version) VALUES(?,?,?)").run(id, now + 7 * 86400, currentAuthVersion(db));
  return id;
}
export function validSession(db: Database, id: string | undefined, now: number): boolean {
  if (!id) return false;
  return !!db.query("SELECT 1 FROM sessions WHERE id=? AND expires_at>? AND auth_version=?").get(id, now, currentAuthVersion(db));
}
export function destroySession(db: Database, id: string) { db.query("DELETE FROM sessions WHERE id=?").run(id); }
/** Invalidate every browser session after a credential or bootstrap-secret change. */
export function destroyAllSessions(db: Database) {
  const next = currentAuthVersion(db) + 1;
  setSetting(db, "auth_version", String(next));
  const stale = db.query("SELECT id FROM sessions WHERE auth_version<>?").all(next) as { id: string }[];
  const del = db.query("DELETE FROM sessions WHERE id=?");
  db.transaction(() => { for (const row of stale) del.run(row.id); })();
}
/** One-time onboarding secret. It is a password, not an API key: hash it before storage. */
export async function setBootstrapHash(db: Database, secret: string): Promise<void> {
  if (secret.length < MIN_PASSWORD_LENGTH) throw new Error(`bootstrap secret too short (min ${MIN_PASSWORD_LENGTH})`);
  setSetting(db, "bootstrap_hash", await Bun.password.hash(secret, { algorithm: "argon2id" }));
}
export async function checkBootstrap(db: Database, secret: string): Promise<boolean> {
  const h = getSetting(db, "bootstrap_hash", "");
  return !!h && await Bun.password.verify(secret, h);
}
export function clearBootstrap(db: Database) { setSetting(db, "bootstrap_hash", ""); }

/** One place for the session cookie flags, shared by login, setup and logout. */
export const sessionCookie = (id: string, secure = false) => `cc_session=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${7 * 86400}${secure ? "; Secure" : ""}`;
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
