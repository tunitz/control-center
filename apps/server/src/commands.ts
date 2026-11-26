import { createSocket } from "node:dgram";

export type Command = { verb: string; destructive: boolean; gate?: string };
/** Registry: adding service control later = one gate verb + one entry here. */
export const COMMANDS: Record<string, Command> = {
  shutdown: { verb: "shutdown", destructive: true, gate: "power-off" },
  restart: { verb: "restart", destructive: true, gate: "reboot" },
  wake: { verb: "wake", destructive: false },
};

export function magicPacket(mac: string): Buffer {
  const hex = mac.replace(/[^0-9a-f]/gi, "");
  if (hex.length !== 12) throw new Error("invalid MAC");
  const m = Buffer.from(hex, "hex");
  return Buffer.concat([Buffer.alloc(6, 0xff), ...Array(16).fill(m)]);
}
/** Send to UDP 9 (standard) and 7 (some NIC firmware only listens there). A custom port
 *  is used as-is, so callers that provide their own port get exactly one packet. */
export const wolPorts = (port = 9): number[] => (port === 9 ? [9, 7] : [port]);

const sendPacket = (pkt: Buffer, broadcast: string, port: number): Promise<void> =>
  new Promise((res, rej) => {
    const s = createSocket("udp4");
    s.once("error", e => { s.close(); rej(e); });
    s.bind(() => { s.setBroadcast(true); s.send(pkt, port, broadcast, e => { s.close(); e ? rej(e) : res(); }); });
  });

export async function sendWol(mac: string, broadcast = "255.255.255.255", port = 9): Promise<void> {
  const pkt = magicPacket(mac);
  for (const p of wolPorts(port)) await sendPacket(pkt, broadcast, p);
}
