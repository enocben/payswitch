// §18 core — state machines: transitions, finals never downgraded,
// expired/unknown never mapped to failed, late-webhook policy.
import { describe, expect, test } from "bun:test";
import {
  canTransitionAttempt,
  canTransitionPayment,
  isLateWebhook,
  mayApplyWebhook,
  resolveExpiration,
  transitionAttempt,
  transitionPayment,
} from "../src/domain/state-machine.js";
import { createAttempt } from "../src/domain/attempt.js";
import { createPayment } from "../src/domain/payment.js";
import { CoreError } from "../src/errors.js";

function payment() {
  return createPayment({
    id: "pay_1",
    idempotency_key: "key-1",
    request_hash: "hash",
    amount_minor: 500000n,
    currency: "CDF",
    phone: "+243810000001",
    country_id: "CD",
    network_id: "CD-AIRTEL",
    correlation_id: "corr-1",
    request_id: "req-1",
    expires_at: new Date(Date.now() + 86400000).toISOString(),
  });
}

function attempt() {
  return createAttempt({
    id: "att_1",
    payment_id: "pay_1",
    provider_id: "pawapay",
    attempt_number: 1,
    provider_idempotency_key: "idem-1",
  });
}

describe("payment state machine", () => {
  test("created → processing → pending → succeeded", () => {
    let p = payment();
    p = transitionPayment(p, "processing");
    p = transitionPayment(p, "pending");
    p = transitionPayment(p, "succeeded");
    expect(p.status).toBe("succeeded");
  });

  test("pending → failed | unknown | expired are all reachable", () => {
    for (const to of ["failed", "unknown", "expired"] as const) {
      let p = transitionPayment(transitionPayment(payment(), "processing"), "pending");
      p = transitionPayment(p, to);
      expect(p.status).toBe(to);
    }
  });

  test("illegal jump created → succeeded is rejected", () => {
    expect(() => transitionPayment(payment(), "succeeded")).toThrow(CoreError);
    expect(canTransitionPayment("created", "succeeded")).toBe(false);
  });

  test("final states are never downgraded", () => {
    for (const final of ["succeeded", "failed", "unknown", "expired"] as const) {
      let p = transitionPayment(transitionPayment(payment(), "processing"), "pending");
      p = transitionPayment(p, final);
      for (const to of ["processing", "pending", "succeeded", "failed"] as const) {
        if (to === final) continue;
        expect(() => transitionPayment(p, to)).toThrow(CoreError);
      }
    }
  });

  test("succeeded never goes back to failed; expired never to succeeded", () => {
    let p = transitionPayment(transitionPayment(payment(), "processing"), "pending");
    p = transitionPayment(p, "succeeded");
    expect(() => transitionPayment(p, "failed")).toThrow(CoreError);
    let q = transitionPayment(transitionPayment(payment(), "processing"), "pending");
    q = transitionPayment(q, "expired");
    expect(() => transitionPayment(q, "succeeded")).toThrow(CoreError);
  });
});

describe("attempt state machine", () => {
  test("created → sending → accepted → pending → succeeded", () => {
    let a = attempt();
    a = transitionAttempt(a, "sending");
    a = transitionAttempt(a, "accepted");
    a = transitionAttempt(a, "pending");
    a = transitionAttempt(a, "succeeded");
    expect(a.status).toBe("succeeded");
  });

  test("pending → failed | timeout | unknown | cancelled", () => {
    for (const to of ["failed", "timeout", "unknown", "cancelled"] as const) {
      let a = transitionAttempt(transitionAttempt(attempt(), "sending"), "accepted");
      a = transitionAttempt(a, "pending");
      expect(transitionAttempt(a, to).status).toBe(to);
    }
  });

  test("created → succeeded is rejected", () => {
    expect(canTransitionAttempt("created", "succeeded")).toBe(false);
    expect(() => transitionAttempt(attempt(), "succeeded")).toThrow(CoreError);
  });
});

describe("expired vs unknown (never failed)", () => {
  test("resolveExpiration never yields failed", () => {
    expect(resolveExpiration(false)).toBe("expired");
    expect(resolveExpiration(true)).toBe("unknown");
    expect(resolveExpiration(false)).not.toBe("failed");
    expect(resolveExpiration(true)).not.toBe("failed");
  });
});

describe("late webhook policy (§5.4)", () => {
  test("webhook after expired/unknown is late and must not mutate", () => {
    expect(isLateWebhook("expired")).toBe(true);
    expect(isLateWebhook("unknown")).toBe(true);
    expect(isLateWebhook("pending")).toBe(false);
    expect(isLateWebhook("succeeded")).toBe(false);
    expect(mayApplyWebhook("expired", "succeeded")).toBe(false);
    expect(mayApplyWebhook("unknown", "succeeded")).toBe(false);
    expect(mayApplyWebhook("pending", "succeeded")).toBe(true);
  });
});
