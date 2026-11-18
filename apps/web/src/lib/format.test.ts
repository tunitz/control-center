import { test, expect } from "bun:test";
import { relativeTime, sampleLabel, localTime } from "./format";

const NOW = 1_800_000_000_000;

test("relativeTime covers seconds, minutes, hours, days and clock skew", () => {
  expect(relativeTime(NOW, NOW)).toBe("0s ago");
  expect(relativeTime(NOW - 12_000, NOW)).toBe("12s ago");
  expect(relativeTime(NOW - 3 * 60_000 - 5_000, NOW)).toBe("3m ago");
  expect(relativeTime(NOW - 2 * 3_600_000, NOW)).toBe("2h ago");
  expect(relativeTime(NOW - 3 * 86_400_000, NOW)).toBe("3d ago");
  expect(relativeTime(NOW + 5000, NOW)).toBe("0s ago");
});

test("sampleLabel is prominent and marks stale samples", () => {
  expect(sampleLabel(NOW / 1000 - 12, undefined, NOW)).toBe("Sample 12s ago");
  expect(sampleLabel(NOW / 1000 - 3600, false, NOW)).toBe("Stale sample · 1h ago");
  expect(sampleLabel(null, false, NOW)).toBe("No sample yet");
});

test("localTime renders a readable timestamp", () => {
  expect(localTime(0)).toMatch(/\d/);
});
