import { Client } from "ssh2";

export type Target = { host: string; port: number; username: string; privateKey: string };

/** One persistent connection per unit; each command runs on its own exec channel. */
export class SshPool {
  private conns = new Map<number, { c: Client; ready: Promise<void>; dead: boolean }>();
  constructor(private readyTimeoutMs = 8000) {}

  private connect(id: number, t: Target) {
    const c = new Client();
    const entry = { c, dead: false, ready: undefined as unknown as Promise<void> };
    entry.ready = new Promise<void>((res, rej) => {
      c.once("ready", () => res());
      c.once("error", e => { entry.dead = true; rej(e); });
      c.connect({ host: t.host, port: t.port, username: t.username, privateKey: t.privateKey, readyTimeout: this.readyTimeoutMs, keepaliveInterval: 15000, keepaliveCountMax: 3 });
    });
    entry.ready.catch(() => {});
    c.on("close", () => { entry.dead = true; if (this.conns.get(id) === entry) this.conns.delete(id); });
    c.on("error", () => { entry.dead = true; });
    this.conns.set(id, entry);
    return entry;
  }
  async exec(id: number, t: Target, cmd: string, timeoutMs = 15000): Promise<string> {
    let e = this.conns.get(id);
    if (!e || e.dead) e = this.connect(id, t);
    await e.ready;
    return new Promise<string>((res, rej) => {
      const timer = setTimeout(() => rej(new Error("exec timeout")), timeoutMs);
      e!.c.exec(cmd, (err, stream) => {
        if (err) { clearTimeout(timer); return rej(err); }
        let out = "", errOut = "";
        stream.on("data", (d: Buffer) => (out += d.toString()));
        stream.stderr.on("data", (d: Buffer) => (errOut += d.toString()));
        stream.on("close", (code: number) => { clearTimeout(timer); code === 0 || code == null ? res(out) : rej(new Error(`exit ${code}: ${errOut.trim() || out.trim()}`)); });
      });
    });
  }
  drop(id: number) { const e = this.conns.get(id); if (e) { e.c.end(); this.conns.delete(id); } }
  closeAll() { for (const [id] of this.conns) this.drop(id); }
}
