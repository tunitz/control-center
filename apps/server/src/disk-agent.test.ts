import { test as baseTest, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const test = (name: string, fn: () => Promise<void> | void) => baseTest(name, fn, 30_000);

// ccagent.sh disk metrics: runs the real sampler against fake /proc/diskstats, hwmon, and df.
const AGENT = join(import.meta.dir, "../../../agent/ccagent.sh");
const TMP = process.env.TMPDIR ?? tmpdir();

type Fx = { dir: string; diskstats: string; hwmon: string; df: string };

const DF_P = `Filesystem     1024-blocks      Used Available Capacity Mounted on
/dev/nvme0n1p2   236000000  50000000 180000000      22% /
`;
const DF_PT = `Filesystem     Type     1M-blocks   Used Available Capacity Mounted on
udev           devtmpfs     7783M     0M     7783M       0% /dev
tmpfs          tmpfs        1575M     2M     1574M       1% /run
/dev/nvme0n1p2 ext4       225922M 45873M   168502M      22% /
tmpfs          tmpfs        7873M     0M     7873M       0% /dev/shm
efivarfs       efivarfs        1M     1M        1M      57% /sys/firmware/efi/efivars
/dev/sdb1      ext4       931500M 500000M   383000M      57% /mnt/my disk
/dev/sdc1      xfs       3700000M 1200000M 2500000M      33% /srv/nas
overlay        overlay    100000M  20000M    80000M      20% /var/lib/docker/overlay2/x/merged
squashfs       squashfs      100M    100M        0M     100% /snap/core/1
tmpfs          tmpfs        800M      0M      800M       0% /run/user/1000
cgroup2        cgroup2        0M      0M        0M       0% /sys/fs/cgroup
`;

const stat = (maj: number, min: number, name: string, rd: number, wr: number) =>
  `${maj} ${min} ${name} 1 0 ${rd} 0 1 0 ${wr} 0 0 0 0 0 0 0 0`;
const diskstatsText = (whole: number, part: number) => [
  stat(8, 0, "sda", whole, whole), stat(8, 1, "sda1", part, part),
  stat(259, 0, "nvme0n1", whole, whole), stat(259, 1, "nvme0n1p1", part, part),
  stat(7, 0, "loop0", part, part), stat(1, 0, "ram0", part, part), stat(252, 0, "dm-0", part, part),
].join("\n") + "\n";

function fixture(opts: { hwmon?: { dir: string; name: string; temp?: number }[]; df?: boolean; diskstats?: string } = {}): Fx {
  const dir = mkdtempSync(join(TMP, "ccdisk-"));
  const diskstats = join(dir, "diskstats");
  writeFileSync(diskstats, opts.diskstats ?? diskstatsText(1000, 5));
  const hwmon = join(dir, "hwmon");
  mkdirSync(hwmon);
  for (const h of opts.hwmon ?? []) {
    mkdirSync(join(hwmon, h.dir), { recursive: true });
    writeFileSync(join(hwmon, h.dir, "name"), h.name + "\n");
    if (h.temp !== undefined) writeFileSync(join(hwmon, h.dir, "temp1_input"), h.temp + "\n");
  }
  writeFileSync(join(dir, "df-p"), DF_P);
  writeFileSync(join(dir, "df-pt"), DF_PT);
  const df = join(dir, "df");
  writeFileSync(df, `#!/bin/bash\ncase "$*" in *-PT*) cat '${dir}/df-pt' ;; *) cat '${dir}/df-p' ;; esac\n`);
  Bun.spawnSync(["chmod", "+x", df]);
  if (opts.df === false) return { dir, diskstats, hwmon, df: "/nonexistent/df" };
  return { dir, diskstats, hwmon, df };
}

/** Runs the real ccagent.sh for `samples` loops (INTERVAL=0 so it runs fast) and returns parsed metrics.jsonl lines. */
async function runAgent(fx: Fx, samples: number, env: Record<string, string> = {}, during?: () => void): Promise<any[]> {
  const out = join(fx.dir, "out");
  writeFileSync(join(fx.dir, "conf"), `DIR=${out}\nINTERVAL=0\n`);
  const timer = during ? setInterval(during, 1) : null;
  const p = Bun.spawn(["bash", AGENT], {
    env: {
      PATH: process.env.PATH!, CCAGENT_CONF: join(fx.dir, "conf"), CCAGENT_MAX_SAMPLES: String(samples),
      CCAGENT_DISKSTATS: fx.diskstats, CCAGENT_HWMON: fx.hwmon, CCAGENT_DF: fx.df, ...env,
    },
    stdout: "ignore", stderr: "pipe",
  });
  const kill = setTimeout(() => p.kill(), 60_000);
  const code = await p.exited;
  clearTimeout(kill);
  if (timer) clearInterval(timer);
  expect(code).toBe(0);
  return readFileSync(join(out, "metrics.jsonl"), "utf8").trim().split("\n").map(l => JSON.parse(l));
}

test("first sample has null disk rates; used% comes from df on /; every line is valid JSON", async () => {
  const lines = await runAgent(fixture(), 3);
  expect(lines.length).toBe(3);
  expect(lines[0].disk_read_kbs).toBeNull();
  expect(lines[0].disk_write_kbs).toBeNull();
  expect(lines[0].disk_used_pct).toBe(22);
  expect(lines[1].disk_read_kbs).toBe(0); // static counters: no delta
  for (const l of lines) expect(typeof l.disk_used_pct).toBe("number");
});

test("rates count whole devices only: partitions, loop, ram, dm- growth is ignored", async () => {
  const fx = fixture();
  let i = 0;
  const lines = await runAgent(fx, 60, {}, () => {
    i++;
    const tmp = fx.diskstats + ".tmp";
    writeFileSync(tmp, diskstatsText(1000, i * 100000));
    renameSync(tmp, fx.diskstats);
  });
  expect(lines.slice(1).every(l => l.disk_read_kbs === 0 && l.disk_write_kbs === 0)).toBe(true);
});

test("rates are KB/s from whole-device sector deltas (growth on whole devices is visible)", async () => {
  const fx = fixture();
  let i = 0;
  const lines = await runAgent(fx, 60, {}, () => {
    i++;
    const tmp = fx.diskstats + ".tmp";
    writeFileSync(tmp, diskstatsText(i * 100000, 5));
    renameSync(tmp, fx.diskstats);
  });
  const nums = lines.slice(1).map(l => l.disk_read_kbs);
  expect(nums.every(v => typeof v === "number" && v >= 0 && Number.isInteger(v))).toBe(true);
  expect(Math.max(...nums)).toBeGreaterThan(0);
});

test("disk_temp_c is the max of nvme/drivetemp hwmon temp1_input in whole degrees; other sensors ignored", async () => {
  const lines = await runAgent(fixture({ hwmon: [
    { dir: "hwmon0", name: "nvme", temp: 42850 },
    { dir: "hwmon1", name: "drivetemp", temp: 55500 },
    { dir: "hwmon2", name: "acpitemp", temp: 90000 },
    { dir: "hwmon3", name: "drivetemp", temp: 31000 },
  ] }), 1);
  expect(lines[0].disk_temp_c).toBe(55);
});

test("disk_temp_c is null when no nvme/drivetemp sensor exists or hwmon is missing", async () => {
  expect((await runAgent(fixture({ hwmon: [{ dir: "hwmon0", name: "acpitemp", temp: 40000 }] }), 1))[0].disk_temp_c).toBeNull();
  const fx = fixture();
  expect((await runAgent({ ...fx, hwmon: "/nonexistent/hwmon" }, 1))[0].disk_temp_c).toBeNull();
});

test("disks array on the first sample and every 12th; tmpfs/devtmpfs/overlay/squashfs/efivarfs and /run,/sys,/dev,/var/lib/docker,/snap excluded", async () => {
  const lines = await runAgent(fixture(), 13);
  const withDisks = lines.map((l, i) => (l.disks !== undefined ? i : -1)).filter(i => i >= 0);
  expect(withDisks).toEqual([0, 12]);
  expect(lines[0].disks).toEqual([
    { m: "/", fs: "ext4", total_mb: 225922, used_mb: 45873, avail_mb: 168502 },
    { m: "/mnt/my disk", fs: "ext4", total_mb: 931500, used_mb: 500000, avail_mb: 383000 },
    { m: "/srv/nas", fs: "xfs", total_mb: 3700000, used_mb: 1200000, avail_mb: 2500000 },
  ]);
  expect(lines[12].disks).toEqual(lines[0].disks);
});

test("missing sources never break the loop: no df, no diskstats, no hwmon -> nulls, no disks key, valid JSON", async () => {
  const fx = fixture({ df: false });
  const lines = await runAgent({ ...fx, diskstats: "/nonexistent/diskstats", hwmon: "/nonexistent/hwmon" }, 14);
  expect(lines.length).toBe(14);
  for (const l of lines) {
    expect(l.disk_read_kbs).toBeNull();
    expect(l.disk_write_kbs).toBeNull();
    expect(l.disk_temp_c).toBeNull();
    expect(l.disk_used_pct).toBeNull();
    expect("disks" in l).toBe(false);
    expect(typeof l.cpu_pct === "number" || l.cpu_pct === null).toBe(true);
  }
});
