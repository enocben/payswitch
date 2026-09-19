// §18 core — retry/fallback provider-safe decision matrix (spec §9.2).
import { describe, expect, test } from "bun:test";
import {
  decideAfterInitiate,
  decideAfterVerify,
} from "../src/engine/retry-policy.js";

describe("decideAfterInitiate", () => {
  test("success → accept_pending, no fallback", () => {
    expect(
      decideAfterInitiate({
        outcome: "success",
        confirmed: false,
        canRetry: false,
        canFallback: true,
        supportsIdempotency: true,
        retryCount: 0,
      }),
    ).toBe("accept_pending");
  });

  test("definitive confirmed + canFallback → fallback", () => {
    expect(
      decideAfterInitiate({
        outcome: "definitive_failure",
        confirmed: true,
        canRetry: false,
        canFallback: true,
        supportsIdempotency: true,
        retryCount: 0,
      }),
    ).toBe("fallback");
  });

  test("definitive confirmed, no fallback → fail", () => {
    expect(
      decideAfterInitiate({
        outcome: "definitive_failure",
        confirmed: true,
        canRetry: false,
        canFallback: false,
        supportsIdempotency: true,
        retryCount: 0,
      }),
    ).toBe("fail");
  });

  test("definitive !confirmed → verify_required, never fallback", () => {
    expect(
      decideAfterInitiate({
        outcome: "definitive_failure",
        confirmed: false,
        canRetry: false,
        canFallback: true,
        supportsIdempotency: true,
        retryCount: 0,
      }),
    ).toBe("verify_required");
  });

  test("temporary → 1 retry same key, then fallback", () => {
    const base = {
      outcome: "temporary_failure" as const,
      confirmed: false,
      canRetry: true,
      canFallback: true,
      supportsIdempotency: true,
      retryCount: 0,
    };
    expect(decideAfterInitiate(base)).toBe("retry_same_key");
    expect(decideAfterInitiate({ ...base, retryCount: 1 })).toBe("fallback");
  });

  test("temporary, second failure without fallback → verify, not fail", () => {
    expect(
      decideAfterInitiate({
        outcome: "temporary_failure",
        confirmed: false,
        canRetry: true,
        canFallback: false,
        supportsIdempotency: true,
        retryCount: 1,
      }),
    ).toBe("verify_required");
  });

  test("temporary without native idempotency → verify first, no blind retry", () => {
    expect(
      decideAfterInitiate({
        outcome: "temporary_failure",
        confirmed: false,
        canRetry: true,
        canFallback: true,
        supportsIdempotency: false,
        retryCount: 0,
      }),
    ).toBe("verify_required");
  });

  test("unknown/timeout → verify_required always", () => {
    for (const outcome of ["unknown"] as const) {
      expect(
        decideAfterInitiate({
          outcome,
          confirmed: false,
          canRetry: true,
          canFallback: true,
          supportsIdempotency: true,
          retryCount: 0,
        }),
      ).toBe("verify_required");
    }
  });
});

describe("decideAfterVerify", () => {
  test("succeeded → succeed", () => {
    expect(decideAfterVerify("succeeded", true)).toBe("succeed");
  });

  test("confirmed_failed + canFallback → fallback", () => {
    expect(decideAfterVerify("confirmed_failed", true)).toBe("fallback");
  });

  test("confirmed_failed without fallback → fail", () => {
    expect(decideAfterVerify("confirmed_failed", false)).toBe("fail");
  });

  test("unknown/pending → stay_pending, NO fallback", () => {
    expect(decideAfterVerify("unknown", true)).toBe("stay_pending");
    expect(decideAfterVerify("pending", true)).toBe("stay_pending");
    expect(decideAfterVerify("unknown", false)).toBe("stay_pending");
  });

  test("verify unknown/pending never yields fail", () => {
    expect(decideAfterVerify("unknown", false)).not.toBe("fail");
    expect(decideAfterVerify("pending", false)).not.toBe("fail");
  });
});
