import { test, expect } from "bun:test";
import { usagePct, usageTone, toneColor, freeMb, freeLine, rateUnit, hasSeries } from "./disks";

const m = (total_mb: number, used_mb: number) => ({ mount: "/", fs: "ext4", total_mb, used_mb });

test("usagePct: share of total, clamped, zero-size reads as 0", () => {
  expect(usagePct(m(1000, 250))).toBe(25);
  expect(usagePct(m(1000, 1200))).toBe(100);
  expect(usagePct(m(1000, -5))).toBe(0);
  expect(usagePct(m(0, 0))).toBe(0);
  expect(usagePct(m(0, 10))).toBe(0);
});

test("usageTone: <80 ok, 80-90 warn, >90 err", () => {
  expect(usageTone(0)).toBe("ok");
  expect(usageTone(79.9)).toBe("ok");
  expect(usageTone(80)).toBe("warn");
  expect(usageTone(90)).toBe("warn");
  expect(usageTone(90.1)).toBe("err");
  expect(usageTone(100)).toBe("err");
});

test("toneColor uses theme CSS vars only", () => {
  expect(toneColor("ok")).toBe("var(--ok)");
  expect(toneColor("warn")).toBe("var(--warn)");
  expect(toneColor("err")).toBe("var(--err)");
});

test("freeMb and freeLine: available space in binary units", () => {
  expect(freeMb(m(512000, 128000))).toBe(384000);
  expect(freeMb(m(1000, 2000))).toBe(0);
  // df 'avail' excludes reserved blocks; prefer it over total-used when reported.
  expect(freeMb({ ...m(512000, 128000), available_mb: 300000 })).toBe(300000);
  expect(freeLine(m(512000, 128000))).toBe("375.0 GiB available of 500.0 GiB");
  expect(freeLine(m(0, 0))).toBe("0.0 GiB available of 0.0 GiB");
});

test("rateUnit: KiB/s below 1024, MiB/s at or above", () => {
  expect(rateUnit(null)).toEqual({ scale: 1, unit: " KiB/s" });
  expect(rateUnit(undefined)).toEqual({ scale: 1, unit: " KiB/s" });
  expect(rateUnit(1023)).toEqual({ scale: 1, unit: " KiB/s" });
  expect(rateUnit(1024)).toEqual({ scale: 1 / 1024, unit: " MiB/s" });
});

test("hasSeries: true only when some sample is non-null", () => {
  expect(hasSeries([{ disk_temp_c: null }, { disk_temp_c: null }], "disk_temp_c")).toBe(false);
  expect(hasSeries([{ disk_temp_c: null }, { disk_temp_c: 41 }], "disk_temp_c")).toBe(true);
  expect(hasSeries([], "disk_temp_c")).toBe(false);
  expect(hasSeries([{ cpu_pct: 3 }], "disk_temp_c")).toBe(false);
});
