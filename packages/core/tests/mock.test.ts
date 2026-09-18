// §18 core — MockProvider: all scenarios + supportsIdempotency +
// mapNetwork + duplicate/delayed webhooks + signatures.
import { describe, expect, test } from "bun:test";
import { MockProvider } from "../src/providers/mock.js";
import type { ProviderCapabilities } from "../src/types.js";

const caps: ProviderCapabilities = {
  supported_countries: ["CD", "CG"],
  supported_networks: { CD: ["AIRTEL", "ORANGE"], CG: ["AIRTEL"] },
  supported_currencies: ["CDF", "XAF"],
  min_amount_minor: 100n,
  max_amount_minor: 100000000n,
  operations: ["collect"],
  supports_idempotency: true,
};

function initiateParams(key: string) {
  return {
    amountMinor: 500000n,
    currency: "CDF",
    phone: "+243810000001",
    country: "CD",
    network: "AIRTEL",
    paymentId: "pay_mock",
    idempotencyKey: "merchant-key",
    providerIdempotencyKey: key,
    correlationId: "corr",
  };
}

describe("MockProvider scenarios", () => {
  test("success → outcome success, verify → succeeded", async () => {
    const mock = new MockProvider({ capabilities: caps, scenario: "success" });
    const res = await mock.initiate(initiateParams("k1"));
    expect(res.outcome).toBe("success");
    expect(res.status).toBe("pending");
    expect(res.providerReference).not.toBe("");
    const v = await mock.verify({ providerReference: res.providerReference, paymentId: "pay_mock" });
    expect(v.status).toBe("succeeded");
  });

  test("confirmed_failed → definitive confirmed, verify → confirmed_failed", async () => {
    const mock = new MockProvider({ capabilities: caps, scenario: "confirmed_failed" });
    const res = await mock.initiate(initiateParams("k2"));
    expect(res.outcome).toBe("definitive_failure");
    expect(res.confirmed).toBe(true);
    expect(res.status).toBe("failed");
    const v = await mock.verify({ providerReference: res.providerReference, paymentId: "pay_mock" });
    expect(v.status).toBe("confirmed_failed");
    const n = mock.normalizeError({ code: "MOCK_CONFIRMED_FAILED" });
    expect(n.canFallback).toBe(true);
    expect(n.requiresVerification).toBe(false);
  });

  test("temporary_failure → temporary, verify → pending (no blind fallback)", async () => {
    const mock = new MockProvider({ capabilities: caps, scenario: "temporary_failure" });
    const res = await mock.initiate(initiateParams("k3"));
    expect(res.outcome).toBe("temporary_failure");
    expect(res.confirmed).toBe(false);
    const v = await mock.verify({ providerReference: "x", paymentId: "pay_mock" });
    expect(v.status).toBe("pending");
    const n = mock.normalizeError({ code: "MOCK_TEMPORARY" });
    expect(n.outcome).toBe("temporary_failure");
    expect(n.canRetry).toBe(true);
  });

  test("timeout/unknown → unknown + requiresVerification", async () => {
    const mock = new MockProvider({ capabilities: caps, scenario: "timeout_unknown" });
    const res = await mock.initiate(initiateParams("k4"));
    expect(res.outcome).toBe("unknown");
    expect(res.confirmed).toBe(false);
    const v = await mock.verify({ providerReference: "x", paymentId: "pay_mock" });
    expect(v.status).toBe("unknown");
    const n = mock.normalizeError({ code: "MOCK_TIMEOUT" });
    expect(n.requiresVerification).toBe(true);
    expect(n.canFallback).toBe(false);
  });

  test("pending → unknown outcome, verify stays pending", async () => {
    const mock = new MockProvider({ capabilities: caps, scenario: "pending" });
    const res = await mock.initiate(initiateParams("k5"));
    expect(res.status).toBe("pending");
    const v = await mock.verify({ providerReference: res.providerReference, paymentId: "pay_mock" });
    expect(v.status).toBe("pending");
  });
});

describe("MockProvider contract surface", () => {
  test("supportsIdempotency reflects capabilities (overridable)", () => {
    expect(new MockProvider({ capabilities: caps }).supportsIdempotency()).toBe(true);
    const noIdem: ProviderCapabilities = { ...caps, supports_idempotency: false };
    expect(new MockProvider({ capabilities: noIdem }).supportsIdempotency()).toBe(false);
    expect(
      new MockProvider({ capabilities: noIdem, supportsIdempotencyOverride: true }).supportsIdempotency(),
    ).toBe(true);
  });

  test("mapNetwork is per-adapter: CD-AIRTEL ≠ CG-AIRTEL", () => {
    const mock = new MockProvider({ capabilities: caps });
    expect(mock.mapNetwork({ country: "CD", network: "AIRTEL" })).toBe("CD-AIRTEL");
    expect(mock.mapNetwork({ country: "CG", network: "AIRTEL" })).toBe("CG-AIRTEL");
    expect(mock.mapNetwork({ country: "CD", network: "AIRTEL" })).not.toBe(
      mock.mapNetwork({ country: "CG", network: "AIRTEL" }),
    );
  });

  test("duplicate webhook → same providerEventId (UNIQUE dedup)", () => {
    const mock = new MockProvider({ capabilities: caps });
    const body = JSON.stringify({ provider_reference: "mock_abc", status: "succeeded" });
    const e1 = mock.parseWebhook(body, {});
    const e2 = mock.parseWebhook(body, {});
    expect(e1.providerEventId).toBe(e2.providerEventId);
    expect(e1.status).toBe("succeeded");
  });

  test("delayed webhook preserves occurred_at for is_late handling", () => {
    const mock = new MockProvider({ capabilities: caps });
    const body = JSON.stringify({
      provider_reference: "mock_abc",
      status: "succeeded",
      occurred_at: "2026-01-01T00:00:00.000Z",
    });
    const e = mock.parseWebhook(body, {});
    expect((e.rawBody as Record<string, unknown>)["occurred_at"]).toBe(
      "2026-01-01T00:00:00.000Z",
    );
  });

  test("valid signature passes, invalid fails", () => {
    const mock = new MockProvider({ capabilities: caps });
    const body = JSON.stringify({ provider_reference: "mock_abc" });
    const sig = mock.signWebhook(body);
    expect(mock.verifyWebhookSignature(body, { "x-webhook-signature": sig })).toBe(true);
    expect(mock.verifyWebhookSignature(body, { "x-webhook-signature": "bad" })).toBe(false);
    expect(mock.verifyWebhookSignature(body, {})).toBe(false);
  });
});
