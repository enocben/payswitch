// @payswitch/api tests — moteur + Mock (sans DB, spec §18).
// Cycle create→initiate→verify, retry même clé, unknown→verify sans
// fallback, 409 idempotence, expiration, concurrence webhook+polling.

import { describe, expect, test } from "bun:test";
import {
  MockProvider,
  type PaymentProvider,
  type ProviderCapabilities,
} from "@payswitch/core";
import { PaymentEngine, type CreatePaymentInput } from "../src/engine/payment-engine.js";
import { POLL_BACKOFF_MS, computeNextPollAt, expirationHours } from "../src/engine/polling.js";
import { hashPhone, last4, maskPhone } from "../src/engine/phone.js";
import { MemoryStore, seedMemory } from "./memory-store.js";

const CAPS: ProviderCapabilities = {
  supported_countries: ["CD"],
  supported_networks: { CD: ["AIRTEL"] },
  supported_currencies: ["CDF"],
  min_amount_minor: 100n,
  max_amount_minor: 100_000_000n,
  operations: ["collect"],
  supports_idempotency: true,
};

function mocks(primary: "success" | "temporary_failure" | "timeout_unknown" | "confirmed_failed" | "pending" = "success", secondary: typeof primary = "success") {
  const providers = new Map<string, PaymentProvider>();
  providers.set("mockprimary", new MockProvider({ code: "mockprimary", capabilities: CAPS, scenario: primary }));
  providers.set("mocksecondary", new MockProvider({ code: "mocksecondary", capabilities: CAPS, scenario: secondary }));
  return providers;
}

let n = 0;
function engineWith(store: MemoryStore, providers: Map<string, PaymentProvider>, expirationHoursRaw = "24") {
  const engine = new PaymentEngine({ store, providers, expirationHoursRaw });
  return engine;
}

function input(over: Partial<CreatePaymentInput> = {}): CreatePaymentInput {
  n++;
  return {
    amount_minor: 1000n,
    currency: "CDF",
    phone: "+243810000001",
    country: "CD",
    network: "AIRTEL",
    idempotency_key: `idem-${Date.now()}-${n}`,
    correlation_id: `corr-${n}`,
    request_id: `req-${n}`,
    ...over,
  };
}

async function createTracked(engine: PaymentEngine, store: MemoryStore, over: Partial<CreatePaymentInput> = {}) {
  const res = await engine.create(input(over));
  store.geo.set(res.payment.id, { country: "CD", network: "AIRTEL" });
  return res;
}

describe("payment-engine (Mock, mémoire)", () => {
  test("cycle create→initiate→verify → succeeded", async () => {
    const store = new MemoryStore();
    seedMemory(store);
    const providers = mocks("success", "success");
    const engine = engineWith(store, providers);
    const { payment, created, httpStatus } = await createTracked(engine, store);
    expect(created).toBe(true);
    expect(httpStatus).toBe(201);
    expect(payment.status).toBe("created");
    expect(payment.phone_hash).toBe(hashPhone("+243810000001"));
    expect(payment.phone_last4).toBe("0001");

    const initiated = await engine.initiate(payment.id);
    expect(initiated.status).toBe("pending");
    expect(initiated.next_poll_at).not.toBeNull();

    const attempts = await store.listAttempts(payment.id);
    expect(attempts).toHaveLength(1);
    expect(attempts[0].provider_reference).toMatch(/^mock_/);
    expect(attempts[0].provider_idempotency_key).toHaveLength(64);

    const verified = await engine.verify(payment.id);
    expect(verified.status).toBe("succeeded");
  });

  test("retry même providerIdempotencyKey puis fallback provider-safe (§9.2)", async () => {
    const store = new MemoryStore();
    seedMemory(store);
    const providers = mocks("temporary_failure", "success");
    const engine = engineWith(store, providers);
    const { payment } = await createTracked(engine, store);

    const initiated = await engine.initiate(payment.id);
    const primary = providers.get("mockprimary") as MockProvider;
    const attempts = await store.listAttempts(payment.id);
    // Retry : même clé vue 2 fois chez mockprimary, puis fallback mocksecondary.
    expect(attempts).toHaveLength(2);
    const firstKey = attempts[0].provider_idempotency_key;
    expect(primary.seenKeyCount(firstKey)).toBe(2);
    expect(initiated.status).toBe("pending");
  });

  test("unknown/timeout → verify obligatoire, aucun fallback si verify unknown/pending", async () => {
    const store = new MemoryStore();
    seedMemory(store);
    // Les deux providers restent ambigus : aucun fallback, reste pending + backoff.
    const providers = mocks("timeout_unknown", "pending");
    const engine = engineWith(store, providers);
    const { payment } = await createTracked(engine, store);

    const initiated = await engine.initiate(payment.id);
    expect(initiated.status).toBe("pending");
    expect(initiated.next_poll_at).not.toBeNull();
    const attempts = await store.listAttempts(payment.id);
    // primary unknown → verify unknown (stay_pending) → PAS de fallback
    // (spec §9.2) : 1 seule tentative, jamais failed, polling replanifié.
    expect(attempts).toHaveLength(1);
    expect(attempts[0].status).toBe("pending");
  });

  test("idempotence : même clé+même hash → 200 existant, hash différent → 409", async () => {
    const store = new MemoryStore();
    seedMemory(store);
    const engine = engineWith(store, mocks());
    const key = `idem-conflict-${Date.now()}`;
    const first = await createTracked(engine, store, { idempotency_key: key });
    expect(first.httpStatus).toBe(201);

    const same = await engine.create(input({ idempotency_key: key }));
    expect(same.httpStatus).toBe(200);
    expect(same.created).toBe(false);
    expect(same.payment.id).toBe(first.payment.id);

    let code = "";
    try {
      await engine.create(input({ idempotency_key: key, amount_minor: 9999n }));
    } catch (err) {
      code = (err as { code?: string }).code ?? "";
    }
    expect(code).toBe("IDEMPOTENCY_KEY_REUSED");
  });

  test("expiration : pending→expired, incertain→unknown, jamais failed", async () => {
    const store = new MemoryStore();
    seedMemory(store);
    const engine = engineWith(store, mocks("success", "success"), "24");

    // Cas certain (initiate success → pending franc) → expired.
    const certain = await createTracked(engine, store);
    await engine.initiate(certain.payment.id);
    const farFuture = new Date(Date.now() + 25 * 3_600_000);
    const r1 = await engine.expireDue(farFuture);
    expect(r1.expired).toBe(1);
    const p1 = await store.findPaymentById(certain.payment.id);
    expect(p1?.status).toBe("expired");

    // Cas incertain (timeout, verify unknown) → unknown.
    const store2 = new MemoryStore();
    seedMemory(store2);
    const engine2 = engineWith(store2, mocks("timeout_unknown", "timeout_unknown"), "24");
    const uncertain = await createTracked(engine2, store2);
    await engine2.initiate(uncertain.payment.id);
    const r2 = await engine2.expireDue(new Date(Date.now() + 25 * 3_600_000));
    expect(r2.unknown).toBe(1);
    const p2 = await store2.findPaymentById(uncertain.payment.id);
    expect(p2?.status).toBe("unknown");
    expect(p2?.status).not.toBe("failed");
  });

  test("concurrence webhook+polling : un seul changement d'état", async () => {
    const store = new MemoryStore();
    seedMemory(store);
    const providers = mocks("pending", "pending");
    const engine = engineWith(store, providers);
    const { payment } = await createTracked(engine, store);
    await engine.initiate(payment.id);
    const attempts = await store.listAttempts(payment.id);
    const ref = attempts[0].provider_reference!;
    const primary = providers.get("mockprimary") as MockProvider;

    const body = JSON.stringify({ provider_reference: ref, status: "succeeded", event_id: "evt-1" });
    const headers = { "x-webhook-signature": primary.signWebhook(body) };

    // Webhook + polling (verify) concurrents : verify est pending (pas de
    // référence gagnante), le webhook succeeded doit gagner exactement une fois.
    const [w1, w2] = await Promise.all([
      engine.applyInboundWebhook("mockprimary", body, headers),
      engine.applyInboundWebhook("mockprimary", body, headers),
    ]);
    const results = [w1.result, w2.result].sort();
    expect(results).toEqual(["applied", "duplicate"]);
    const fresh = await store.findPaymentById(payment.id);
    expect(fresh?.status).toBe("succeeded");
  });

  test("webhook tardif après expired → late, sans mutation", async () => {
    const store = new MemoryStore();
    seedMemory(store);
    const providers = mocks("pending", "pending");
    const engine = engineWith(store, providers, "24");
    const { payment } = await createTracked(engine, store);
    await engine.initiate(payment.id);
    await engine.expireDue(new Date(Date.now() + 25 * 3_600_000));
    const expired = await store.findPaymentById(payment.id);
    expect(expired?.status).toBe("unknown"); // incertain (pending mock) → unknown

    const attempts = await store.listAttempts(payment.id);
    const ref = attempts[0].provider_reference!;
    const primary = providers.get("mockprimary") as MockProvider;
    const body = JSON.stringify({ provider_reference: ref, status: "succeeded", event_id: "evt-late" });
    const out = await engine.applyInboundWebhook("mockprimary", body, {
      "x-webhook-signature": primary.signWebhook(body),
    });
    expect(out.result).toBe("late");
    const fresh = await store.findPaymentById(payment.id);
    expect(fresh?.status).toBe("unknown"); // pas de mutation aveugle
  });

  test("webhook signature invalide → 403, sans effet", async () => {
    const store = new MemoryStore();
    seedMemory(store);
    const engine = engineWith(store, mocks());
    const { payment } = await createTracked(engine, store);
    const out = await engine.applyInboundWebhook("mockprimary", "{}", {});
    expect(out.result).toBe("invalid_signature");
    expect(out.httpStatus).toBe(403);
    expect((await store.findPaymentById(payment.id))?.status).toBe("created");
  });
});

describe("polling / expiration helpers", () => {
  test("backoff spec 30s,2m,5m,10m,30m,1h,2h", () => {
    expect([...POLL_BACKOFF_MS]).toEqual([30_000, 120_000, 300_000, 600_000, 1_800_000, 3_600_000, 7_200_000]);
    const t0 = Date.now();
    expect(computeNextPollAt(t0, 0)).toBe(new Date(t0 + 30_000).toISOString());
    expect(computeNextPollAt(t0, 99)).toBe(new Date(t0 + 7_200_000).toISOString());
  });

  test("expiration défaut 24h (PAYMENT_EXPIRATION_HOURS vide)", () => {
    expect(expirationHours(undefined)).toBe(24);
    expect(expirationHours("")).toBe(24);
    expect(expirationHours("48")).toBe(48);
  });
});

describe("PII téléphone", () => {
  test("hash déterministe, last4, masquage logs", () => {
    expect(hashPhone("+243810000001")).toHaveLength(64);
    expect(last4("+243810000001")).toBe("0001");
    expect(maskPhone("+243810000001")).toBe("+243****0001");
    expect(maskPhone("+243810000001")).not.toContain("8100");
  });
});
