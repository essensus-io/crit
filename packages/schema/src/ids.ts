import { randomBytes } from "node:crypto";

let lastMs = 0;
let seq = 0;

/**
 * UUIDv7 (RFC 9562): 48-bit ms timestamp, then random bits. Sortable by time,
 * made in code so local rows never clash with rows from another store.
 * Monotonic within a process: ids made in the same ms still sort in creation order.
 */
export function newId(now: number = Date.now()): string {
  if (now <= lastMs) {
    seq++;
    now = lastMs;
  } else {
    lastMs = now;
    seq = 0;
  }
  const bytes = randomBytes(16);
  bytes[0] = Math.floor(now / 2 ** 40) & 0xff;
  bytes[1] = Math.floor(now / 2 ** 32) & 0xff;
  bytes[2] = (now >>> 24) & 0xff;
  bytes[3] = (now >>> 16) & 0xff;
  bytes[4] = (now >>> 8) & 0xff;
  bytes[5] = now & 0xff;
  // 12-bit rand_a carries the in-ms sequence for monotonic ordering.
  bytes[6] = 0x70 | ((seq >>> 8) & 0x0f);
  bytes[7] = seq & 0xff;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Short display id: first 4 hex chars of the random tail (e.g. "a41f"). */
export function shortId(id: string): string {
  return id.replaceAll("-", "").slice(-4);
}

export const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
