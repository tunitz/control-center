import { createHash, timingSafeEqual } from "node:crypto";

// Hash both sides first so the compare is fixed-length and the length of the
// expected token does not leak through timing.
export function tokenMatches(provided: string, expected: string): boolean {
  if (!expected) return false;
  const a = createHash("sha256").update(provided, "utf8").digest();
  const b = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(a, b) && provided.length === expected.length;
}

export function bearerFrom(req: Request): string | null {
  const header = req.headers.get("authorization") ?? "";
  const m = /^Bearer (.+)$/.exec(header);
  return m ? m[1] : null;
}
