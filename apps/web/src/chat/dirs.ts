// Pure helpers for the Pi working-folder picker (no React, unit-tested).
import type { Backend, Effort } from "./types";

/** Thrown when the user closes the folder step without creating the chat. Callers stay quiet on it. */
export class PickCancelled extends Error {
  constructor() { super(""); this.name = "PickCancelled"; }
}

/** Shows a path relative to the user's home: "~" for home, "~/a/b" below it, absolute otherwise. */
export function homeRelative(path: string, home: string): string {
  const h = home.replace(/\/+$/, "");
  if (path === h) return "~";
  if (h && path.startsWith(h + "/")) return "~" + path.slice(h.length);
  return path;
}

/** Body for POST /api/chat/sessions. `cwd` is only sent for Pi chats with a chosen folder. */
export function sessionCreatePayload(o: { model?: string; effort?: Effort | null; backend?: Backend; cwd?: string | null }): {
  model?: string; effort?: Effort | null; backend?: Backend; cwd?: string;
} {
  const out: { model?: string; effort?: Effort | null; backend?: Backend; cwd?: string } = {};
  if (o.model !== undefined) out.model = o.model;
  if (o.effort !== undefined) out.effort = o.effort;
  if (o.backend === "pi") {
    out.backend = "pi";
    if (o.cwd) out.cwd = o.cwd;
  }
  return out;
}

/** The message to show inline for a failed folder call. Server text wins when it is present. */
export function mapDirError(status: number, message: string): string {
  const text = message.trim();
  if (status === 400) return text || "That folder cannot be used.";
  if (status === 409) return text || "A folder with that name already exists.";
  return text || "Something went wrong.";
}

/** Small tag for a chat's folder: the last two path segments, with the full path as tooltip. Null means no tag. */
export function folderTag(cwd: string | null): { label: string; title: string } | null {
  if (!cwd) return null;
  const parts = cwd.split("/").filter(Boolean);
  if (parts.length === 0) return null;
  return { label: parts.slice(-2).join("/"), title: cwd };
}

/** A new folder name: non-empty after trimming, not "." or "..", and no path separators. */
export function validFolderName(name: string): boolean {
  const n = name.trim();
  if (n === "" || n === "." || n === "..") return false;
  return !/[\\/]/.test(n);
}
