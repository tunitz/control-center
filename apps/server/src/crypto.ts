import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { utils } from "ssh2";

const key = (master: string) => createHash("sha256").update(master).digest();
export function encrypt(master: string, plain: string): string {
  const iv = randomBytes(12), c = createCipheriv("aes-256-gcm", key(master), iv);
  const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString("base64");
}
export function decrypt(master: string, blob: string): string {
  const b = Buffer.from(blob, "base64");
  const d = createDecipheriv("aes-256-gcm", key(master), b.subarray(0, 12));
  d.setAuthTag(b.subarray(12, 28));
  return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString("utf8");
}
/** ssh2's ed25519 generator emits a key its own parser rejects roughly 1 time in 250, so retry until it loads. */
export function generateUnitKey(comment: string) {
  for (let attempt = 0; attempt < 20; attempt++) {
    const kp = utils.generateKeyPairSync("ed25519", { comment });
    if (utils.parseKey(kp.private) instanceof Error) continue;
    const fp = createHash("sha256").update(Buffer.from(kp.public.split(" ")[1], "base64")).digest("base64").replace(/=+$/, "");
    return { publicKey: kp.public.trim(), privateKey: kp.private, fingerprint: "SHA256:" + fp };
  }
  throw new Error("could not generate a loadable SSH key");
}
