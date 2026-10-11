import { describe, expect, test } from "bun:test";
import { encodeLine, LfSplitter } from "../src/jsonl";

describe("LF-only JSONL framing", () => {
  test("U+2028 and U+2029 inside a JSON string are not record separators", () => {
    const rec = { type: "message_update", delta: "a\u2028b\u2029c" };
    const s = new LfSplitter();
    const lines = s.push(Buffer.from(encodeLine(rec), "utf8"));
    expect(lines.length).toBe(1);
    expect(JSON.parse(lines[0])).toEqual(rec);
    expect(s.end()).toEqual([]);
  });

  test("records survive being split at every byte, including inside multibyte UTF-8", () => {
    const recs = [
      { type: "a", text: "héllo \u2028 wörld 🙂" },
      { type: "b", text: "line\u2029two" },
    ];
    const wire = Buffer.from(recs.map(encodeLine).join(""), "utf8");
    for (let cut = 1; cut < wire.length; cut++) {
      const s = new LfSplitter();
      const got = [...s.push(wire.subarray(0, cut)), ...s.push(wire.subarray(cut))];
      expect(got.map((l) => JSON.parse(l))).toEqual(recs);
    }
  });

  test("CRLF is stripped, blank lines are skipped, partial line waits for LF", () => {
    const s = new LfSplitter();
    expect(s.push('{"a":1}\r\n\n{"b"')).toEqual(['{"a":1}']);
    expect(s.push(':2}\n')).toEqual(['{"b":2}']);
  });

  test("end() returns an unterminated tail and clears it", () => {
    const s = new LfSplitter();
    expect(s.push('{"x":1}')).toEqual([]);
    expect(s.end()).toEqual(['{"x":1}']);
    expect(s.end()).toEqual([]);
  });

  test("encodeLine never writes a raw LF inside a record", () => {
    const line = encodeLine({ text: "x\ny\u2028z" });
    expect(line.endsWith("\n")).toBe(true);
    expect(line.slice(0, -1).includes("\n")).toBe(false);
  });
});
