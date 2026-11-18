import { test, expect } from "bun:test";
import { createSocket } from "node:dgram";
import { magicPacket, wolPorts, sendWol } from "./commands";

const MAC = "00:e0:4c:5f:c0:8d";

test("magic packet is 6xFF followed by the MAC repeated 16 times", () => {
  const p = magicPacket(MAC);
  expect(p.length).toBe(102);
  expect(p.subarray(0, 6).toString("hex")).toBe("ffffffffffff");
  expect(p.subarray(6, 12).toString("hex")).toBe("00e04c5fc08d");
  expect(p.subarray(96, 102).toString("hex")).toBe("00e04c5fc08d");
});

test("invalid MAC is rejected", () => {
  expect(() => magicPacket("not-a-mac")).toThrow("invalid MAC");
});

test("default WoL sends to UDP 9 and 7; a custom port sends once", () => {
  expect(wolPorts()).toEqual([9, 7]);
  expect(wolPorts(9)).toEqual([9, 7]);
  expect(wolPorts(7)).toEqual([7]);
  expect(wolPorts(39010)).toEqual([39010]);
});

test("sendWol delivers a real UDP packet to a listener", async () => {
  const port = 39111;
  const listener = createSocket("udp4");
  const received: Buffer[] = [];
  listener.on("message", d => { received.push(d); });
  await new Promise<void>(res => listener.bind(port, "0.0.0.0", res));
  try {
    await sendWol(MAC, "255.255.255.255", port);
    await new Promise(r => setTimeout(r, 300));
    expect(received.length).toBeGreaterThan(0);
    expect(received[0].length).toBe(102);
    expect(received[0].subarray(0, 6).toString("hex")).toBe("ffffffffffff");
  } finally { listener.close(); }
});
