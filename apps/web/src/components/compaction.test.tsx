import { test, expect } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { CompactionSection } from "./PiConfigCard";
import { compactionPatch, compactionError, COMPACTION_LIMITS } from "./piCompaction";
import type { PiCompaction } from "../chat/types";

const saved: PiCompaction = { enabled: true, compactAtTokens: 200000, keepRecentTokens: 20000 };

test("compactionPatch: only the changed fields go to the bridge", () => {
  expect(compactionPatch(saved, { ...saved, compactAtTokens: 300000 })).toEqual({ compactAtTokens: 300000 });
  expect(compactionPatch(saved, { ...saved, enabled: false, keepRecentTokens: 30000 })).toEqual({ enabled: false, keepRecentTokens: 30000 });
});

test("compactionPatch: no change is undefined, so the card sends nothing for it", () => {
  expect(compactionPatch(saved, { ...saved })).toBeUndefined();
});

test("compactionError: integers within the bridge's ranges pass; anything else says what is wrong", () => {
  expect(compactionError({ ...saved, compactAtTokens: COMPACTION_LIMITS.compactAtTokens.min })).toBeNull();
  expect(compactionError({ ...saved, compactAtTokens: COMPACTION_LIMITS.compactAtTokens.max })).toBeNull();
  expect(compactionError({ ...saved, compactAtTokens: 49999 })).toContain("50000");
  expect(compactionError({ ...saved, compactAtTokens: 900001 })).toContain("900000");
  expect(compactionError({ ...saved, compactAtTokens: 1.5 })).toContain("whole number");
  expect(compactionError({ ...saved, keepRecentTokens: 4999 })).toContain("5000");
  expect(compactionError({ ...saved, keepRecentTokens: 100001 })).toContain("100000");
  expect(compactionError({ ...saved, keepRecentTokens: Number.NaN })).toContain("whole number");
});

test("CompactionSection renders the toggle, both number inputs with aria-labels, and the help line", () => {
  const html = renderToStaticMarkup(<CompactionSection value={saved} onChange={() => {}} />);
  expect(html).toContain('aria-label="Compact automatically"');
  expect(html).toContain('type="checkbox"');
  expect(html).toContain("Compact automatically");
  expect(html).toContain("Compact when context passes (tokens)");
  expect(html).toContain("Keep recent (tokens)");
  expect(html).toContain('aria-label="Compact when context passes (tokens)"');
  expect(html).toContain('aria-label="Keep recent (tokens)"');
  expect(html).toContain('type="number"');
  expect(html).toContain('value="200000"');
  expect(html).toContain('value="20000"');
  expect(html).toContain('min="50000"');
  expect(html).toContain('max="900000"');
  expect(html).toContain('min="5000"');
  expect(html).toContain('max="100000"');
  expect(html).toMatch(/lower[^<]*save tokens/i);
});

test("CompactionSection: tap targets are 44px and no hardcoded colors are used", () => {
  const html = renderToStaticMarkup(<CompactionSection value={saved} onChange={() => {}} />);
  expect(html).not.toMatch(/#[0-9a-f]{3,6}\b|rgb\(|hsl\(/i);
  expect(html).toContain("pi-chk");
  expect(html).toContain("pi-num");
});

test("CompactionSection: a disabled toggle still shows the thresholds, and the help line", () => {
  const html = renderToStaticMarkup(<CompactionSection value={{ ...saved, enabled: false }} onChange={() => {}} />);
  expect(html).toContain('value="200000"');
  expect(html).not.toMatch(/checked=""/);
});
