// @payswitch/api — uuid7 local (RFC 9562, spec §5.1 : IDs uuid7 partout).
// Node 22 : crypto.randomBytes, aucun dépendance. Même format que le
// moteur (engine/payment-engine.ts) pour request_id / correlation_id.

import { randomBytes } from "node:crypto";

/** uuid7 (48 bits temps ms + 74 bits aléatoires + version/variant). */
export function uuidv7(nowMs = Date.now()): string {
  const b = randomBytes(16);
  const t = Math.floor(nowMs);
  b[0] = (t / 2 ** 40) & 0xff;
  b[1] = (t / 2 ** 32) & 0xff;
  b[2] = (t / 2 ** 24) & 0xff;
  b[3] = (t / 2 ** 16) & 0xff;
  b[4] = (t / 2 ** 8) & 0xff;
  b[5] = t & 0xff;
  b[6] = 0x70 | (b[6] & 0x0f);
  b[8] = 0x80 | (b[8] & 0x3f);
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
