import { test, expect, beforeEach } from "bun:test";
import { openDb } from "./db";
import { setCurrentRate } from "./cost";
import { parseDay, parseRange, dayStart, dailyEnergy, csvEscape, energyCsv } from "./energy";

let db: ReturnType<typeof openDb>;
beforeEach(() => {
  db = openDb(":memory:");
  for (const id of [1, 2]) db.query("INSERT INTO units(id,name,host,pubkey,privkey_enc,created_at) VALUES(?,?,?,?,?,0)").run(id, "u" + id, "h", "pk", "sk");
});

const NOW = Date.UTC(2026, 10, 15) / 1000; // within 2026-11
const insert = (unitId: number, endTs: number, wh: number) =>
  db.query("INSERT OR REPLACE INTO energy_intervals(unit_id,end_ts,wh) VALUES(?,?,?)").run(unitId, endTs, wh);

test("day boundaries respect configured timezone (UTC default and Asia/Manila)", () => {
  expect(dayStart("2026-10-01")).toBe(Date.UTC(2026, 9, 1, 0, 0, 0) / 1000);
  // 2026-10-01 00:00 Manila == 2026-09-30T16:00:00Z; next day starts 24h later.
  expect(dayStart("2026-10-01", "Asia/Manila")).toBe(Date.UTC(2026, 8, 30, 16, 0, 0) / 1000);
  const lastSecond = Date.UTC(2026, 9, 1, 15, 59, 59) / 1000; // 23:59:59 Manila Oct 1
  const midnight = Date.UTC(2026, 9, 1, 16, 0, 0) / 1000;     // 00:00:00 Manila Oct 2
  insert(1, lastSecond, 1000);
  insert(1, midnight, 2000);
  const rows = dailyEnergy(db, "2026-10-01", "2026-10-02", 1, NOW, "Asia/Manila");
  expect(rows.map(r => r.day)).toEqual(["2026-10-01", "2026-10-02"]);
  expect(rows[0].kwh).toBeCloseTo(1, 9);
  expect(rows[1].kwh).toBeCloseTo(2, 9);
});

test("aggregates all units per day and restricts to a single unit", () => {
  const ts = Date.UTC(2026, 9, 5, 12, 0) / 1000;
  insert(1, ts, 1500);
  insert(2, ts, 500);
  expect(dailyEnergy(db, "2026-10-05", "2026-10-05", null, NOW)[0].kwh).toBeCloseTo(2, 9);
  expect(dailyEnergy(db, "2026-10-05", "2026-10-05", 2, NOW)[0].kwh).toBeCloseTo(0.5, 9);
});

test("cost uses each day's month rate from getRate", () => {
  setCurrentRate(db, 8, Date.UTC(2026, 8, 15) / 1000);  // September = 8
  setCurrentRate(db, 12, Date.UTC(2026, 9, 15) / 1000); // October = 12
  insert(1, Date.UTC(2026, 8, 10, 12, 0) / 1000, 1000);
  insert(1, Date.UTC(2026, 9, 10, 12, 0) / 1000, 1000);
  insert(1, Date.UTC(2026, 10, 10, 12, 0) / 1000, 1000);
  const byDay = new Map(dailyEnergy(db, "2026-09-10", "2026-11-10", 1, NOW).map(r => [r.day, r]));
  expect(byDay.get("2026-09-10")!.cost).toBeCloseTo(8, 9);  // September rate
  expect(byDay.get("2026-10-10")!.cost).toBeCloseTo(12, 9); // October rate
  expect(byDay.get("2026-11-10")!.cost).toBeCloseTo(12, 9); // November rolls over October's rate
  expect(byDay.get("2026-11-10")!.php).toBeCloseTo(12, 9);
});

test("CSV has headers and quotes values containing commas, quotes and newlines", () => {
  expect(csvEscape("plain")).toBe("plain");
  expect(csvEscape("a,b")).toBe('"a,b"');
  expect(csvEscape('say "hi"')).toBe('"say ""hi"""');
  expect(csvEscape("line1\nline2")).toBe('"line1\nline2"');
  const csv = energyCsv([{ day: "2026-10-01", kwh: 1, cost: 12 }]);
  expect(csv.split("\r\n")[0]).toBe("day,kwh,cost");
  expect(csv).toContain("2026-10-01,1,12");
});

test("date parameters are validated strictly", () => {
  for (const bad of [null, "", "2026-2-3", "2026-02-30", "2026-13-01", "2026-00-10", "2026-01-00", "not-a-date", "2026-01-01T00:00:00Z", "26-01-01", "2026/01/01"])
    expect(parseDay(bad)).toBeNull();
  expect(parseDay("2026-02-28")).toBe("2026-02-28");
  expect(parseDay("2028-02-29")).toBe("2028-02-29");
  expect(parseRange("2026-10-02", "2026-10-01")).toBeNull();
  expect(parseRange("2026-10-01", "2026-10-02")).toEqual({ from: "2026-10-01", to: "2026-10-02" });
});
