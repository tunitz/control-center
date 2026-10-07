// Seeds a DEMO database with synthetic units and history (for screenshots / scale test). Not used in production.
import { openDb } from "../apps/server/src/db";
import { ingestLines } from "../apps/server/src/ingest";
import { rollup } from "../apps/server/src/rollup";
import { encrypt, generateUnitKey } from "../apps/server/src/crypto";
import { setCurrentRate } from "../apps/server/src/cost";
import { ensureAdmin } from "../apps/server/src/auth";

const [path = "demo.db", nUnits = "3", hours = "72", step = "5"] = process.argv.slice(2);
const db = openDb(path);
await ensureAdmin(db, "demo-pass-123");
const now = Math.floor(Date.now() / 1000), n = Number(nUnits), H = Number(hours), STEP = Number(step);
const profiles = [
  { name: "tun-sfx", host: "192.168.31.15", mac: "d8:43:ae:2c:0c:ed", cpu: "AMD Ryzen 7 5800X3D 8-Core Processor", cores: 8, threads: 16, base: 3400, boost: 4500, gpu: "AMD Radeon RX 7800 XT", vram: 16384, ram: 32768, cw: 90, gw: 250, gpu_on: true },
  { name: "tun-minipc", host: "192.168.31.206", mac: "aa:bb:cc:00:11:22", cpu: "Intel(R) N100", cores: 4, threads: 4, base: 800, boost: 3400, gpu: null, vram: null, ram: 15744, cw: 12, gw: 0, gpu_on: false },
  { name: "proxmox-pve", host: "192.168.1.200", mac: "aa:bb:cc:00:11:33", cpu: "Intel(R) Core(TM) i5-8500", cores: 6, threads: 6, base: 3000, boost: 4100, gpu: null, vram: null, ram: 32768, cw: 38, gw: 0, gpu_on: false },
];
const t0 = Date.now();
let rows = 0;
for (let i = 0; i < n; i++) {
  const p = profiles[i % profiles.length], name = n > 3 ? `${p.name}-${i}` : p.name;
  const k = generateUnitKey("demo");
  db.query("INSERT INTO units(id,name,host,pubkey,privkey_enc,fingerprint,mac,last_seen,created_at) VALUES(?,?,?,?,?,?,?,?,?)").run(i + 1, name, p.host, k.publicKey, encrypt("x", k.privateKey), k.fingerprint, p.mac, now, now - H * 3600);
  db.query("INSERT INTO unit_static(unit_id,json,updated_at) VALUES(?,?,?)").run(i + 1, JSON.stringify({ cpu_model: p.cpu, cores: p.cores, threads: p.threads, base_mhz: p.base, boost_mhz: p.boost, gpu_model: p.gpu, vram_total_mb: p.vram, ram_total_mb: p.ram, swap_total_mb: 8192, interval: STEP }), now);
  let uj = 0, seed = i * 7919;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let chunk = 0; chunk < H * 3600; chunk += 3600) {
    const lines: string[] = [];
    for (let t = chunk; t < chunk + 3600; t += STEP) {
      const ts = now - H * 3600 + t, day = Math.sin((ts / 3600 % 24 - 8) / 24 * 2 * Math.PI) * 0.5 + 0.5;
      const burst = rnd() < 0.04 ? 0.5 : 0;
      const cpu = Math.min(99, 4 + day * 28 + burst * 60 * rnd() + rnd() * 6);
      const gpuBusy = p.gpu_on ? Math.min(99, (day > 0.6 ? 40 * rnd() + 35 * burst * 2 : 2 + rnd() * 5)) : null;
      const cw = p.cw * (0.18 + cpu / 100 * 0.9), gw = p.gpu_on ? 22 + (gpuBusy! / 100) * (p.gw - 22) : null;
      uj += Math.round(cw * STEP * 1e6);
      lines.push(JSON.stringify({ v: 1, ts, cpu_pct: +cpu.toFixed(1), cpu_mhz: Math.round(p.base + (p.boost - p.base) * cpu / 100), cpu_w: +cw.toFixed(1), cpu_uj: uj,
        gpu_pct: gpuBusy == null ? null : Math.round(gpuBusy), gpu_mhz: p.gpu_on ? Math.round(300 + gpuBusy! * 22) : null, vram_used_mb: p.gpu_on ? Math.round(900 + gpuBusy! * 120) : null, gpu_w: gw == null ? null : +gw.toFixed(1), gpu_uj: null,
        ram_used_mb: Math.round(p.ram * (0.22 + day * 0.18 + rnd() * 0.02)), ram_free_mb: 4000, ram_cached_mb: Math.round(p.ram * 0.25), swap_used_mb: Math.round(rnd() * 40) }));
    }
    rows += ingestLines(db, i + 1, lines, STEP);
  }
}
setCurrentRate(db, 11.5, now);
rollup(db, now);
console.log(JSON.stringify({ units: n, hours: H, step: STEP, rows, seconds: (Date.now() - t0) / 1000 }));
