// LF-only JSONL framing. Pi's docs require splitting on LF only: readline also splits on
// U+2028/U+2029, which are legal raw inside JSON strings. Splitting on the byte 0x0A is safe
// for UTF-8 because 0x0A never occurs inside a multi-byte sequence.

export function encodeLine(value: unknown): string {
  return JSON.stringify(value) + "\n";
}

function stripCr(line: Buffer): Buffer {
  return line.length > 0 && line[line.length - 1] === 0x0d ? line.subarray(0, -1) : line;
}

export class LfSplitter {
  private buf: Buffer = Buffer.alloc(0);

  push(chunk: Buffer | Uint8Array | string): string[] {
    const bytes = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : Buffer.from(chunk);
    this.buf = this.buf.length === 0 ? bytes : Buffer.concat([this.buf, bytes]);
    const out: string[] = [];
    let idx: number;
    while ((idx = this.buf.indexOf(0x0a)) !== -1) {
      const line = stripCr(this.buf.subarray(0, idx));
      this.buf = this.buf.subarray(idx + 1);
      if (line.length > 0) out.push(line.toString("utf8"));
    }
    return out;
  }

  // Returns an unterminated tail (if any) at end of stream and clears it.
  end(): string[] {
    const rest = stripCr(this.buf);
    this.buf = Buffer.alloc(0);
    return rest.length > 0 ? [rest.toString("utf8")] : [];
  }
}
