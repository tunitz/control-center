import { test, expect } from "bun:test";
import { fitSize, tooSmall, outputMime, ACCEPTED_TYPES, MAX_BYTES, QUALITY_LADDER } from "./imaging";

test("longest side is capped at 2048 and aspect kept", () => {
  expect(fitSize(4000, 2000)).toEqual({ w: 2048, h: 1024, scaled: true });
  expect(fitSize(1000, 3000)).toEqual({ w: 683, h: 2048, scaled: true });
});

test("images already within 2048 are not upscaled", () => {
  expect(fitSize(800, 600)).toEqual({ w: 800, h: 600, scaled: false });
});

test("minimum side 64px is enforced", () => {
  expect(tooSmall(63, 900)).toBe(true);
  expect(tooSmall(900, 64)).toBe(false);
  expect(tooSmall(64, 64)).toBe(false);
});

test("alpha PNG stays PNG, everything else becomes JPEG", () => {
  expect(outputMime("image/png", true)).toBe("image/png");
  expect(outputMime("image/png", false)).toBe("image/jpeg");
  expect(outputMime("image/webp", true)).toBe("image/jpeg");
});

test("budget and ladder constants", () => {
  expect(MAX_BYTES).toBe(6 * 1024 * 1024);
  expect(QUALITY_LADDER[0]).toBeGreaterThan(QUALITY_LADDER[QUALITY_LADDER.length - 1]);
  expect(ACCEPTED_TYPES).toContain("image/jpeg");
  expect(ACCEPTED_TYPES).not.toContain("image/svg+xml");
});
