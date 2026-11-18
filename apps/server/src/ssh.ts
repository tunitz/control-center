import { Client } from "ssh2";

export type Target = { host: string; port: number; username: string; privateKey: string; hostVerifier?: (key: Buffer) => boolean };

/** One persistent connection per unit; each command runs on its own exec channel. */
export class SshPool {
  private conns = new Map<number, { c: Client; ready: Promise<void>; dead: boolean }>();
  private hostKeys = new Map<number, string>();
  constructor(private readyTimeoutMs = 8000) {}
  hostKey(id: number): string | undefined { return this.hostKeys.get(id); }

  private connect(id: number, t: Target) {
    const c = new Client();
    const entry = { c, dead: false, ready: undefined as unknown as Promise<void> };
    entry.ready = new Promise<void>((res, rej) => {
      c.once("ready", () => {
        const key = (c as any).getHostKey?.() as Buffer | undefined;
        if (key) this.hostKeys.set(id, key.toString("base64"));
        res();
      });
      c.once("error", e => { entry.dead = true; rej(e); });
      c.connect({
        host: t.host, port: t.port, username: t.username, privateKey: t.privateKey,
        hostVerifier: t.hostVerifier ?? (() => true),
        readyTimeout: this.readyTimeoutMs, keepaliveInterval: 15000, keepaliveCountMax: 3,
      });
    });
    entry.ready.catch(() => {});
    c.on("close", () => { entry.dead = true; if (this.conns.get(id) === entry) this.conns.delete(id); });
    c.on("error", () => { entry.dead = true; });
    this.conns.set(id, entry);
    return entry;
  }
  async exec(id: number, t: Target, cmd: string, timeoutMs = 15000, stdin?: string): Promise<string> {
    let e = this.conns.get(id);
    if (!e || e.dead) e = this.connect(id, t);
    // Hard deadline on the handshake too: a peer that accepts TCP but never finishes SSH must not
    // leave the caller awaiting forever (that wedged a unit's poll loop for hours after a reboot).
    await this.within(e.ready, this.readyTimeoutMs + 2000, `ssh connect to ${t.host}:${t.port} stalled`);
    return new Promise<string>((res, rej) => {
      const timer = setTimeout(() => rej(new Error("exec timeout")), timeoutMs);
      e!.c.exec(cmd, (err, stream) => {
        if (err) { clearTimeout(timer); return rej(err); }
        let out = "", errOut = "";
        stream.on("data", (d: Buffer) => (out += d.toString()));
        stream.stderr.on("data", (d: Buffer) => (errOut += d.toString()));
        if (stdin !== undefined) { stream.end(stdin); }
        stream.on("close", (code: number) => { clearTimeout(timer); code === 0 || code == null ? res(out) : rej(new Error(`exit ${code}: ${errOut.trim() || out.trim()}`)); });
      });
    });
  }
  private within<T>(p: Promise<T>, ms: number, msg: string): Promise<T> {
    return new Promise<T>((res, rej) => {
      const timer = setTimeout(() => rej(new Error(msg)), ms);
      p.then(v => { clearTimeout(timer); res(v); }, err => { clearTimeout(timer); rej(err); });
    });
  }
  drop(id: number) {
    const e = this.conns.get(id);
    if (!e) return;
    this.conns.delete(id);
    this.hostKeys.delete(id);
    e.dead = true;
    try { e.c.end(); } catch { /* already gone */ }
    try { (e.c as any).destroy?.(); } catch { /* already gone */ }
  }
  closeAll() { for (const [id] of this.conns) this.drop(id); }
}
