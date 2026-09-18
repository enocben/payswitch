// §18 core — idempotency: same key+same hash → 200 existing,
// same key+different hash → 409; deterministic provider keys; no double debit.
import { describe, expect, test } from "bun:test";
import {
  assertIdempotency,
  buildProviderIdempotencyKey,
  computeRequestHash,
  resolveIdempotency,
} from "../src/engine/idempotency.js";
import { IdempotencyKeyReusedError } from "../src/errors.js";
import { MockProvider } from "../src/providers/mock.js";
import type { ProviderCapabilities } from "../src/types.js";

const caps: ProviderCapabilities = {
  supported_countries: ["CD"],
  supported_networks: { CD: ["AIRTEL"] },
  supported_currencies: ["CDF"],
  min_amount_minor: 100n,
  max_amount_minor: 100000000n,
  operations: ["collect"],
  supports_idempotency: true,
};

describe("request_hash", () => {
  test("same payload → same hash (200 existing)", () => {
    const payload = {
      amount_minor: 500000n,
      currency: "CDF",
      phone: "+243810000001",
      country: "CD",
      network: "AIRTEL",
    };
    const h1 = computeRequestHash(payload);
    const h2 = computeRequestHash({ ...payload });
    expect(h1).toBe(h2);
    expect(resolveIdempotency(h1, h2)).toEqual({ result: "ok_existing", httpStatus: 200 });
  });

  test("same key + different payload → 409 IDEMPOTENCY_KEY_REUSED", () => {
    const h1 = computeRequestHash({ amount_minor: 500000n });
    const h2 = computeRequestHash({ amount_minor: 600000n });
    expect(h1).not.toBe(h2);
    expect(resolveIdempotency(h1, h2)).toEqual({ result: "conflict", httpStatus: 409 });
    expect(() => assertIdempotency(h1, h2)).toThrow(IdempotencyKeyReusedError);
    expect(() => assertIdempotency(h1, h1)).not.toThrow();
  });

  test("key order does not change the hash", () => {
    const a = computeRequestHash({ x: 1, y: 2 });
    const b = computeRequestHash({ y: 2, x: 1 });
    expect(a).toBe(b);
  });
});

describe("providerIdempotencyKey", () => {
  test("deterministic SHA256 hex, 64 chars", () => {
    const k1 = buildProviderIdempotencyKey("pay_1", 1);
    const k2 = buildProviderIdempotencyKey("pay_1", 1);
    expect(k1).toBe(k2);
    expect(k1).toMatch(/^[0-9a-f]{64}$/);
  });

  test("attempt number changes the key; payment id changes the key", () => {
    const a = buildProviderIdempotencyKey("pay_1", 1);
    expect(buildProviderIdempotencyKey("pay_1", 2)).not.toBe(a);
    expect(buildProviderIdempotencyKey("pay_2", 1)).not.toBe(a);
  });
});

describe("retry same key → no double debit (mock)", () => {
  test("two initiates with the same key hit the same provider key", async () => {
    const mock = new MockProvider({ capabilities: caps, scenario: "success" });
    const key = buildProviderIdempotencyKey("pay_retry", 1);
    const base = {
      amountMinor: 500000n,
      currency: "CDF",
      phone: "+243810000001",
      country: "CD",
      network: "AIRTEL",
      paymentId: "pay_retry",
      idempotencyKey: "merchant-key",
      providerIdempotencyKey: key,
      correlationId: "corr",
    };
    const r1 = await mock.initiate(base);
    const r2 = await mock.initiate(base);
    expect(r1.providerReference).toBe(r2.providerReference);
    expect(mock.seenKeyCount(key)).toBe(2);
  });
});
