// @payswitch/core — idempotency helpers (spec §6.1, §9.2, §18).
// request_hash = SHA256(normalized payload). providerIdempotencyKey =
// SHA256(paymentId:attemptNumber), deterministic + persisted per attempt.
// Pure, zero I/O (sync SHA256 via node:crypto — no network).

import { createHash } from "node:crypto";
import { IdempotencyKeyReusedError } from "../errors.js";

function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/** Normalize a merchant payload for stable hashing (bigint-safe, key-sorted). */
export function normalizePayload(
  payload: Record<string, unknown>,
): string {
  const sorted = Object.keys(payload)
    .sort()
    .map((k) => {
      const v = payload[k];
      const encoded =
        typeof v === "bigint"
          ? `bigint:${v.toString()}`
          : typeof v === "object" && v !== null
            ? JSON.stringify(v)
            : String(v);
      return `${k}=${encoded}`;
    });
  return sorted.join("&");
}

/** Merchant-level request hash: SHA256 of the normalized payload. */
export function computeRequestHash(payload: Record<string, unknown>): string {
  return sha256Hex(normalizePayload(payload));
}

/**
 * Deterministic provider idempotency key for an attempt.
 * Same (paymentId, attemptNumber) → same key, reused identically on retry.
 */
export function buildProviderIdempotencyKey(
  paymentId: string,
  attemptNumber: number,
): string {
  if (!paymentId) throw new Error("paymentId is required");
  if (!Number.isInteger(attemptNumber) || attemptNumber < 1) {
    throw new Error("attemptNumber must be an integer >= 1");
  }
  return sha256Hex(`${paymentId}:${attemptNumber}`);
}

export type IdempotencyDecision =
  | { result: "ok_existing"; httpStatus: 200 }
  | { result: "conflict"; httpStatus: 409 };

/**
 * Idempotency rule (spec §18): same key + same hash → return existing (200);
 * same key + different hash → 409 IDEMPOTENCY_KEY_REUSED.
 */
export function resolveIdempotency(
  storedHash: string,
  incomingHash: string,
): IdempotencyDecision {
  if (storedHash === incomingHash) {
    return { result: "ok_existing", httpStatus: 200 };
  }
  return { result: "conflict", httpStatus: 409 };
}

/** Throwing variant for the API layer. */
export function assertIdempotency(
  storedHash: string,
  incomingHash: string,
): void {
  if (storedHash !== incomingHash) {
    throw new IdempotencyKeyReusedError({ storedHash, incomingHash });
  }
}
