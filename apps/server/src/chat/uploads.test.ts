import { test, expect } from "bun:test";
import { mkdtempSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { openDb } from "../db";
import {
  uploadRoot, sniffType, safeExt, pickExt, buildUploadPath, buildSessionDir, sanitizeDisplayName,
  imageSize, saveUpload, uploadLimits, MAX_FILES, sha256Hex, fileHeaders, sanitizeAsciiFilename,
} from "./uploads";

const b = (...n: number[]) => new Uint8Array(n);
const ascii = (s: string) => new TextEncoder().encode(s);
const PNG = b(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 128, 0, 0, 0, 64, 8, 6, 0, 0, 0);
const JPEG = b(0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x40, 0x00, 0x80, 0x01, 0x01, 0x11, 0x00);
const GIF = new Uint8Array([...ascii("GIF89a"), 0x80, 0x00, 0x40, 0x00, 0, 0, 0]);
const RIFF = (tag: string, body: number[]) => new Uint8Array([...ascii("RIFF"), 0, 0, 0, 0, ...ascii("WEBP"), ...ascii(tag), 0, 0, 0, 0, ...body]);
// body starts at byte 20: VP8X flags(20..23) w-1(24..26) h-1(27..29)
const WEBP_VP8X = RIFF("VP8X", [0, 0, 0, 0, 127, 0, 0, 63, 0, 0]);
// VP8 frame tag(20..22) start code(23..25) width(26..27) height(28..29)
const WEBP_VP8 = RIFF("VP8 ", [0, 0, 0, 0x9d, 0x01, 0x2a, 0x80, 0x00, 0x40, 0x00]);
// VP8L signature 0x2f(20) then packed w-1/h-1 bits(21..24)
const VP8L_BODY = [0x2f, 0x7f, 0xc0, 0x0f, 0x00, 0, 0, 0, 0, 0];
const WEBP_VP8L = RIFF("VP8L", VP8L_BODY);
const PDF = ascii("%PDF-1.4\n%....");

const tmp = () => mkdtempSync(join(tmpdir(), "chat-up-"));

test("sniffType recognises png, jpeg, gif, webp, pdf by magic bytes", () => {
  expect(sniffType(PNG)).toEqual({ ext: "png", mime: "image/png", kind: "image" });
  expect(sniffType(JPEG)).toEqual({ ext: "jpg", mime: "image/jpeg", kind: "image" });
  expect(sniffType(GIF)).toEqual({ ext: "gif", mime: "image/gif", kind: "image" });
  expect(sniffType(WEBP_VP8)).toEqual({ ext: "webp", mime: "image/webp", kind: "image" });
  expect(sniffType(PDF)).toEqual({ ext: "pdf", mime: "application/pdf", kind: "file" });
  expect(sniffType(ascii("plain text"))).toBeNull();
});

test("pickExt: sniffed type wins over a misleading name; safe name ext next; else bin", () => {
  expect(pickExt(PNG, "photo.jpg")).toBe("png");
  expect(pickExt(ascii("hello"), "notes.TXT")).toBe("txt");
  expect(pickExt(ascii("hello"), "archive.tar.gz")).toBe("gz");
  expect(pickExt(ascii("hello"), "abcde.abcde")).toBe("abcde");
  expect(pickExt(ascii("hello"), "x.toolong")).toBe("bin");
  expect(pickExt(ascii("hello"), "x.e x")).toBe("bin");
  expect(pickExt(ascii("hello"), "x.exe\u0000.sh")).toBe("sh");
  expect(pickExt(ascii("hello"), "资料.中文")).toBe("bin");
  expect(pickExt(ascii("hello"), "noext")).toBe("bin");
  expect(pickExt(ascii("hello"), "../../etc/passwd")).toBe("bin");
  expect(safeExt("a.B-c")).toBeNull();
});

test("buildUploadPath only accepts generated names under root/<session>", () => {
  const root = resolve(tmp());
  const ok = buildUploadPath(root, "sess-1", "0123456789abcdef0123456789abcdef.png");
  expect(dirname(ok)).toBe(join(root, "sess-1"));
  expect(ok.startsWith(root + "/")).toBe(true);
  const badFiles = ["../../x", "../x.png", "/etc/passwd", "/abs.png", "a\u0000b.png", "x".repeat(300) + ".png",
    "资料 笔记.pdf", "my file.txt", "", ".", "..", "a/b.png", "a\\b.png"];
  for (const f of badFiles) expect(() => buildUploadPath(root, "sess-1", f)).toThrow();
  for (const s of ["../../x", "..", ".", "a/b", "a\u0000b", "", "x".repeat(101), "资料"]) {
    expect(() => buildUploadPath(root, s, "0123456789abcdef0123456789abcdef.png")).toThrow();
  }
  expect(buildSessionDir(root, "sess-1")).toBe(join(root, "sess-1"));
  expect(() => buildSessionDir(root, "../up")).toThrow();
});

test("sanitizeDisplayName strips paths, control chars and newlines; keeps unicode", () => {
  expect(sanitizeDisplayName("../../x")).toBe("x");
  expect(sanitizeDisplayName("C:\\evil\\a.txt")).toBe("a.txt");
  expect(sanitizeDisplayName("a\u0000b\nc\r\u2028d.txt")).toBe("abcd.txt");
  expect(sanitizeDisplayName("资料 笔记.pdf")).toBe("资料 笔记.pdf");
  expect(sanitizeDisplayName("my file (1).txt")).toBe("my file (1).txt");
  expect(sanitizeDisplayName("/")).toBe("file");
  expect(sanitizeDisplayName("")).toBe("file");
  expect(sanitizeDisplayName("x".repeat(300)).length).toBeLessThanOrEqual(200);
});

test("imageSize parses png, jpeg, gif and all three webp variants, and never throws on junk", () => {
  expect(imageSize(PNG)).toEqual({ w: 128, h: 64 });
  expect(imageSize(JPEG)).toEqual({ w: 128, h: 64 });
  expect(imageSize(GIF)).toEqual({ w: 128, h: 64 });
  expect(imageSize(WEBP_VP8X)).toEqual({ w: 128, h: 64 });
  expect(imageSize(WEBP_VP8)).toEqual({ w: 128, h: 64 });
  expect(imageSize(WEBP_VP8L)).toEqual({ w: 128, h: 64 });
  expect(imageSize(PNG.slice(0, 10))).toBeNull();
  expect(imageSize(JPEG.slice(0, 12))).toBeNull();
  expect(imageSize(ascii("hello world"))).toBeNull();
  expect(imageSize(PDF)).toBeNull();
});

test("sha256Hex matches the known vector", () => {
  expect(sha256Hex(ascii("abc"))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});

test("uploadRoot: default relative to cwd, env override, always absolute", () => {
  const prev = process.env.CHAT_UPLOAD_DIR;
  delete process.env.CHAT_UPLOAD_DIR;
  expect(uploadRoot()).toBe(resolve("./data/chat-uploads"));
  process.env.CHAT_UPLOAD_DIR = "/home/tunitz/.hermes/cache/chat-uploads";
  expect(uploadRoot()).toBe("/home/tunitz/.hermes/cache/chat-uploads");
  process.env.CHAT_UPLOAD_DIR = "rel/dir";
  expect(uploadRoot()).toBe(resolve("rel/dir"));
  if (prev === undefined) delete process.env.CHAT_UPLOAD_DIR; else process.env.CHAT_UPLOAD_DIR = prev;
});

test("uploadLimits reads chat.maxUploadMb with default 20 and sane bounds", () => {
  const db = openDb(":memory:");
  expect(uploadLimits(db).maxBytes).toBe(20 * 1024 * 1024);
  expect(MAX_FILES).toBe(6);
  db.query("INSERT INTO settings(key,value) VALUES('chat.maxUploadMb','2')").run();
  expect(uploadLimits(db).maxBytes).toBe(2 * 1024 * 1024);
  db.query("UPDATE settings SET value='abc' WHERE key='chat.maxUploadMb'").run();
  expect(uploadLimits(db).maxBytes).toBe(20 * 1024 * 1024);
  db.query("UPDATE settings SET value='0' WHERE key='chat.maxUploadMb'").run();
  expect(uploadLimits(db).maxBytes).toBe(20 * 1024 * 1024);
  db.query("UPDATE settings SET value='100000' WHERE key='chat.maxUploadMb'").run();
  expect(uploadLimits(db).maxBytes).toBe(100 * 1024 * 1024); // clamped to 100
});

test("saveUpload writes under root/<session>, disk name from sniffed type, returns metadata", async () => {
  const root = resolve(tmp());
  const r = await saveUpload(root, "sess-1", "photo.jpg", PNG, 1024 * 1024);
  expect(r.kind).toBe("image");
  expect(r.mime).toBe("image/png");
  expect(r.size).toBe(PNG.length);
  expect(r.w).toBe(128);
  expect(r.h).toBe(64);
  expect(r.sha256).toBe(sha256Hex(PNG));
  expect(r.name).toBe("photo.jpg");
  expect(r.path.startsWith(join(root, "sess-1") + "/")).toBe(true);
  expect(r.path.endsWith(".png")).toBe(true);
  expect(r.path.split("/").pop()!.startsWith(r.id)).toBe(true);
  expect(readFileSync(r.path).equals(Buffer.from(PNG))).toBe(true);
});

test("saveUpload: hostile names never leave the session dir and never reach the disk name", async () => {
  const root = resolve(tmp());
  const names = ["../../x", "/etc/passwd", "a\u0000b.txt", "x".repeat(300), "资料 笔记 (1).md", "my file.txt", "..\\..\\win.txt"];
  for (const n of names) {
    const r = await saveUpload(root, "sess-h", n, ascii("hi there"), 1024);
    expect(r.path.startsWith(join(root, "sess-h") + "/")).toBe(true);
    expect(r.path).not.toContain(n);
    expect(r.kind).toBe("file");
    expect(r.name).not.toContain("\u0000");
    expect(r.name).not.toContain("/");
    expect(r.name.length).toBeLessThanOrEqual(200);
  }
  expect(existsSync(join(root, "..", "x"))).toBe(false);
  expect(existsSync("/etc/passwd.bak")).toBe(false);
  expect(readdirSync(join(root, "sess-h")).length).toBe(names.length);
});

test("saveUpload rejects zero-byte (400) and oversize (413) files", async () => {
  const root = resolve(tmp());
  await expect(saveUpload(root, "s", "e.txt", new Uint8Array(0), 100)).rejects.toMatchObject({ status: 400 });
  await expect(saveUpload(root, "s", "big.txt", ascii("x".repeat(101)), 100)).rejects.toMatchObject({ status: 413 });
  await saveUpload(root, "s", "ok.txt", ascii("x".repeat(100)), 100); // exactly at the cap is fine
});

test("fileHeaders: image inline with its type, others octet-stream attachment, always nosniff", () => {
  const img = fileHeaders({ kind: "image", mime: "image/png", name: "a.png" });
  expect(img.get("content-type")).toBe("image/png");
  expect(img.get("content-disposition")).toBeNull();
  expect(img.get("x-content-type-options")).toBe("nosniff");
  expect(img.get("cache-control")).toBe("private, max-age=3600");

  const f = fileHeaders({ kind: "file", mime: "application/pdf", name: "资料 \"x\".pdf\r\nSet-Cookie: a=b" });
  expect(f.get("content-type")).toBe("application/octet-stream");
  const cd = f.get("content-disposition") ?? "";
  expect(cd.startsWith("attachment")).toBe(true);
  expect(cd).not.toMatch(/[\r\n]/);
  expect(cd).toContain("filename*=UTF-8''");
  expect(f.get("x-content-type-options")).toBe("nosniff");
  expect(f.get("cache-control")).toBe("private, max-age=3600");
  expect(sanitizeAsciiFilename("资料 \"x\".pdf")).toMatch(/^[\x20-\x7e]+$/);
});
