/**
 * Upload store. Disk names are generated (`<random hex>.<ext>`); user file names
 * never reach the filesystem. The only path builder is buildUploadPath().
 */
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import type { Database } from "bun:sqlite";
import { ChatError } from "./http";

export const MAX_FILES = 6;
export const MAX_BODY_BYTES = 25 * 1024 * 1024;
const DEFAULT_MAX_MB = 20;
const MAX_ALLOWED_MB = 100;

const SESSION_RE = /^[A-Za-z0-9_-]{1,100}$/;
const DISK_RE = /^[0-9a-f]{32}\.[a-z0-9]{1,5}$/;
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;

export function uploadRoot(env: Record<string, string | undefined> = process.env): string {
  return resolve(env.CHAT_UPLOAD_DIR || "./data/chat-uploads");
}

export type SniffedType = { ext: string; mime: string; kind: "image" | "file" };

/** Recognises png/jpg/gif/webp/pdf by magic bytes. Returns null for anything else. */
export function sniffType(b: Uint8Array): SniffedType | null {
  const starts = (sig: number[], at = 0) => sig.every((v, i) => b[at + i] === v);
  const ascii = (s: string, at = 0) => [...s].every((c, i) => b[at + i] === c.charCodeAt(0));
  if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { ext: "png", mime: "image/png", kind: "image" };
  if (starts([0xff, 0xd8, 0xff])) return { ext: "jpg", mime: "image/jpeg", kind: "image" };
  if (ascii("GIF87a") || ascii("GIF89a")) return { ext: "gif", mime: "image/gif", kind: "image" };
  if (ascii("RIFF") && ascii("WEBP", 8)) return { ext: "webp", mime: "image/webp", kind: "image" };
  if (ascii("%PDF-")) return { ext: "pdf", mime: "application/pdf", kind: "file" };
  return null;
}

/** Lowercase [a-z0-9]{1,5} extension of a name, or null. */
export function safeExt(name: string): string | null {
  const dot = name.lastIndexOf(".");
  if (dot < 0) return null;
  const ext = name.slice(dot + 1).toLowerCase();
  return /^[a-z0-9]{1,5}$/.test(ext) ? ext : null;
}

/** Disk extension: sniffed type first, then the safe name extension, else "bin". */
export function pickExt(bytes: Uint8Array, name: string): string {
  const sniffed = sniffType(bytes);
  if (sniffed) return sniffed.ext;
  return safeExt(name.replace(CONTROL_RE, "")) ?? "bin";
}

const TEXT_MIME: Record<string, string> = {
  txt: "text/plain", md: "text/markdown", csv: "text/csv", json: "application/json", log: "text/plain",
};

/** Name shown in the UI and prompt: basename only, no control characters, max 200 code points. */
export function sanitizeDisplayName(name: string): string {
  const stripped = name.replace(CONTROL_RE, "");
  const base = (stripped.split(/[\\/]/).pop() ?? "").trim();
  if (base === "" || base === "." || base === "..") return "file";
  return Array.from(base).slice(0, 200).join("");
}

export function buildSessionDir(root: string, sessionId: string): string {
  if (!SESSION_RE.test(sessionId)) throw new Error("invalid session id for upload dir");
  return join(resolve(root), sessionId);
}

/** The single path builder. Only generated disk names are accepted; the result is always inside root/<session>. */
export function buildUploadPath(root: string, sessionId: string, diskName: string): string {
  if (!DISK_RE.test(diskName)) throw new Error("invalid upload disk name");
  const dir = buildSessionDir(root, sessionId);
  const p = join(dir, diskName);
  if (dirname(p) !== dir || !p.startsWith(dir + sep)) throw new Error("upload path escaped its directory");
  return p;
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

const u16be = (b: Uint8Array, i: number) => (b[i] << 8) | b[i + 1];
const u16le = (b: Uint8Array, i: number) => b[i] | (b[i + 1] << 8);
const u24le = (b: Uint8Array, i: number) => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16);
const u32le = (b: Uint8Array, i: number) => (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0;

/** Image dimensions from png/jpeg/gif/webp headers. Null when unreadable. Never throws. */
export function imageSize(b: Uint8Array): { w: number; h: number } | null {
  try {
    if (b.length >= 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
      return { w: (b[16] << 24 | b[17] << 16 | b[18] << 8 | b[19]) >>> 0, h: (b[20] << 24 | b[21] << 16 | b[22] << 8 | b[23]) >>> 0 };
    }
    if (b.length >= 10 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) {
      return { w: u16le(b, 6), h: u16le(b, 8) };
    }
    if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
      let i = 2;
      while (i + 9 < b.length) {
        if (b[i] !== 0xff) return null;
        const m = b[i + 1];
        if (m === 0xff) { i += 1; continue; }
        if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
          return { w: u16be(b, i + 7), h: u16be(b, i + 5) };
        }
        if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; }
        const len = u16be(b, i + 2);
        if (len < 2) return null;
        i += 2 + len;
      }
      return null;
    }
    if (b.length >= 30 && b[0] === 0x52 && b[8] === 0x57) {
      const tag = String.fromCharCode(b[12], b[13], b[14], b[15]);
      if (tag === "VP8X") return { w: 1 + u24le(b, 24), h: 1 + u24le(b, 27) };
      if (tag === "VP8 ") return { w: u16le(b, 26) & 0x3fff, h: u16le(b, 28) & 0x3fff };
      if (tag === "VP8L" && b[20] === 0x2f) {
        const bits = u32le(b, 21);
        return { w: (bits & 0x3fff) + 1, h: ((bits >>> 14) & 0x3fff) + 1 };
      }
    }
    return null;
  } catch {
    return null;
  }
}

export type Inspected = {
  kind: "image" | "file";
  mime: string;
  ext: string;
  w: number | null;
  h: number | null;
  sha256: string;
};

/** Sniffs and measures a file without touching disk. Used by send validation and saveUpload. */
export function inspectFile(name: string, bytes: Uint8Array): Inspected {
  const sniffed = sniffType(bytes);
  const dims = sniffed?.kind === "image" ? imageSize(bytes) : null;
  const ext = pickExt(bytes, name);
  const fromName = safeExt(name.replace(CONTROL_RE, ""));
  const mime = sniffed?.mime ?? (fromName && TEXT_MIME[fromName]) ?? "application/octet-stream";
  return { kind: sniffed?.kind ?? "file", mime, ext, w: dims?.w ?? null, h: dims?.h ?? null, sha256: sha256Hex(bytes) };
}

export function uploadLimits(db: Database): { maxMb: number; maxBytes: number } {
  const row = db.query("SELECT value FROM settings WHERE key = 'chat.maxUploadMb'").get() as { value: string } | null;
  const n = row ? Number(row.value) : NaN;
  let mb = Number.isInteger(n) && n >= 1 ? n : DEFAULT_MAX_MB;
  mb = Math.min(mb, MAX_ALLOWED_MB);
  return { maxMb: mb, maxBytes: mb * 1024 * 1024 };
}

export type SavedUpload = {
  id: string;
  kind: "image" | "file";
  name: string;
  mime: string;
  size: number;
  sha256: string;
  path: string;
  w: number | null;
  h: number | null;
};

/** Validates size, writes to root/<session>/<id>.<ext>, returns metadata. Throws ChatError 400/413. */
export async function saveUpload(
  root: string, sessionId: string, name: string, bytes: Uint8Array, maxBytes: number,
): Promise<SavedUpload> {
  if (bytes.length === 0) throw new ChatError(400, "empty file");
  if (bytes.length > maxBytes) throw new ChatError(413, "file too large");
  const info = inspectFile(name, bytes);
  if (info.kind === "image" && info.w === null) throw new ChatError(400, "image unreadable");
  const id = randomBytes(16).toString("hex");
  const path = buildUploadPath(root, sessionId, `${id}.${info.ext}`);
  mkdirSync(dirname(path), { recursive: true, mode: 0o775 });
  await Bun.write(path, bytes);
  return {
    id, kind: info.kind, name: sanitizeDisplayName(name), mime: info.mime, size: bytes.length,
    sha256: info.sha256, path, w: info.w, h: info.h,
  };
}

/** Content-Disposition/Content-Type headers for GET /files/:id. */
export function fileHeaders(f: { kind: "image" | "file"; mime: string; name: string }): Headers {
  const h = new Headers();
  h.set("x-content-type-options", "nosniff");
  h.set("cache-control", "private, max-age=3600");
  if (f.kind === "image") {
    h.set("content-type", f.mime);
  } else {
    h.set("content-type", "application/octet-stream");
    const name = sanitizeDisplayName(f.name);
    h.set("content-disposition", `attachment; filename="${sanitizeAsciiFilename(name)}"; filename*=UTF-8''${encodeRfc5987(name)}`);
  }
  return h;
}

/** ASCII-only fallback filename with quotes and backslashes removed. */
export function sanitizeAsciiFilename(name: string): string {
  const out = Array.from(name).map(c => (/[\x20-\x7e]/.test(c) && c !== '"' && c !== "\\" ? c : "_")).join("");
  return out.trim() === "" ? "file" : out;
}

function encodeRfc5987(s: string): string {
  return encodeURIComponent(s).replace(/['()*]/g, c => "%" + c.charCodeAt(0).toString(16).toUpperCase());
}
