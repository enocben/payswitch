// @payswitch/api tests — webhooks sortants + routing audité (spec §5.4, §8.2, US-10, US-15).
// Mémoire uniquement : enqueue/sign/retry HMAC, réordonnancement + AuditLog,
// webhook tardif → is_late + AuditLog sans mutation.

import { describe, expect, test } from "bun:test";
import {
  MockProvider,
  type PaymentProvider,
  type ProviderCapabilities,
} from "@payswitch/core";
import { PaymentEngine, type CreatePaymentInput } from "../src/engine/payment-engine.js";
import {
  finalEventType,
  maxRetries,
  parseRetrySchedule,
  signPayload,
} from "../src/engine/webhook-outbound.js";
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

function registry(): Map<string, PaymentProvider> {
  const m = new Map<string, PaymentProvider>();
  m.set("mockprimary", new MockProvider({ code: "mockprimary", capabilities: CAPS, scenario: "success" }));
  m.set("mocksecondary", new MockProvider({ code: "mocksecondary", capabilities: CAPS, scenario: "success" }));
  return m;
}

let n = 0;
function input(over: Partial<CreatePaymentInput> = {}): CreatePaymentInput {
  n++;
  return {
    amount_minor: 1000n,
    currency: "CDF",
    phone: "+243810000001",
    country: "CD",
    network: "AIRTEL",
    idempotency_key: `mw-${Date.now()}-${n}`,
    correlation_id: `corr-${n}`,
    request_id: `req-${n}`,
    ...over,
  };
}

async function succeededPayment(engine: PaymentEngine, store: MemoryStore) {
  const { payment } = await engine.create(input());
  store.geo.set(payment.id, { country: "CD", network: "AIRTEL" });
  await engine.initiate(payment.id);
  await engine.verify(payment.id);
  return (await store.findPaymentById(payment.id))!;
}

describe("webhooks sortants (US-10, §8.2)", () => {
  test("enqueue : event_id + attempt_id + HMAC vérifiable, due immédiate", async () => {
    const store = new MemoryStore();
    seedMemory(store);
    const engine = new PaymentEngine({ store, providers: registry(), expirationHoursRaw: "24" });
    const payment = await succeededPayment(engine, store);
    expect(payment.status).toBe("succeeded");

    const secret = "whsec_test123";
    const delivery = await engine.enqueueMerchantDelivery({
      paymentId: payment.id,
      url: "https://merchant.example/hook",
      secret,
    });
    expect(delivery.event_type).toBe("payment.succeeded");
    expect(delivery.status).toBe("pending");
    expect(delivery.attempt_id).not.toBeNull();
    const payload = delivery.payload as Record<string, unknown>;
    expect(payload.event_id).toBe(delivery.event_id);
    expect(payload.attempt_id).toBe(delivery.attempt_id);
    expect(delivery.signature).toBe(signPayload(secret, delivery.payload));
    expect(delivery.next_retry_at).not.toBeNull();

    const dues = await store.listDueWebhookDeliveries(new Date().toISOString(), 10);
    expect(dues.map((d) => d.id)).toContain(delivery.id);
  });

  test("enqueue refuse un état non final (pas de notification)", async () => {
    const store = new MemoryStore();
    seedMemory(store);
    const engine = new PaymentEngine({ store, providers: registry(), expirationHoursRaw: "24" });
    const { payment } = await engine.create(input());
    store.geo.set(payment.id, { country: "CD", network: "AIRTEL" });
    let code = "";
    try {
      await engine.enqueueMerchantDelivery({ paymentId: payment.id, url: "https://x.example/", secret: "s" });
    } catch (err) {
      code = (err as { code?: string }).code ?? "";
    }
    expect(code).toBe("INVALID_TRANSITION");
  });

  test("process : 2xx → delivered ; 500 → retrying avec backoff ; max → failed", async () => {
    const store = new MemoryStore();
    seedMemory(store);
    const engine = new PaymentEngine({ store, providers: registry(), expirationHoursRaw: "24" });
    const payment = await succeededPayment(engine, store);
    const delivery = await engine.enqueueMerchantDelivery({
      paymentId: payment.id,
      url: "https://merchant.example/hook",
      secret: "whsec_test123",
    });
    const now = new Date();

    // Marchand down → retrying, next_retry_at = +1m (palier 1 du défaut).
    const r1 = await engine.processDueDeliveries(now, async () => ({ statusCode: 500, body: "boom" }));
    expect(r1).toMatchObject({ checked: 1, retrying: 1 });
    const retrying = (await store.listDueWebhookDeliveries(new Date().toISOString(), 10));
    expect(retrying).toHaveLength(0); // pas encore due (backoff 1m)
    const stored = await store.updateWebhookDelivery(delivery.id, {});
    expect(stored.status).toBe("retrying");
    expect(stored.attempts).toBe(1);
    expect(new Date(stored.next_retry_at!).getTime() - now.getTime()).toBe(60_000);

    // Marchand OK après backoff → delivered.
    const later = new Date(now.getTime() + 61_000);
    const r2 = await engine.processDueDeliveries(later, async (url, _body, headers) => {
      expect(url).toBe("https://merchant.example/hook");
      expect(headers["X-Event-Id"]).toBe(delivery.event_id);
      expect(headers["X-Webhook-Signature"]).toBe(delivery.signature);
      return { statusCode: 200 };
    });
    expect(r2).toMatchObject({ checked: 1, delivered: 1 });

    // Échecs répétés → failed après max=2.
    const d2 = await engine.enqueueMerchantDelivery({
      paymentId: payment.id,
      url: "https://down.example/",
      secret: "whsec_test123",
    });
    expect(d2.event_id).not.toBe(delivery.event_id);
    let t = new Date();
    for (let i = 0; i < 2; i++) {
      await engine.processDueDeliveries(t, async () => ({ statusCode: 500 }), { maxRetriesRaw: "2" });
      t = new Date(t.getTime() + 400_000);
    }
    const fin = await store.updateWebhookDelivery(d2.id, {});
    expect(fin.status).toBe("failed");
    expect(fin.next_retry_at).toBeNull();
  });

  test("schedule/parse : défauts spec + entrées invalides", () => {
    expect(parseRetrySchedule(undefined)).toEqual([60_000, 300_000, 900_000, 3_600_000, 21_600_000, 86_400_000]);
    expect(parseRetrySchedule("nope")).toEqual(parseRetrySchedule(undefined));
    expect(parseRetrySchedule("30s,2m")).toEqual([30_000, 120_000]);
    expect(maxRetries(undefined)).toBe(6);
    expect(maxRetries("0")).toBe(6);
    expect(maxRetries("3")).toBe(3);
  });

  test("finalEventType : expired/unknown → payment.unknown, non-final → null", () => {
    expect(finalEventType("succeeded")).toBe("payment.succeeded");
    expect(finalEventType("failed")).toBe("payment.failed");
    expect(finalEventType("unknown")).toBe("payment.unknown");
    expect(finalEventType("expired")).toBe("payment.unknown");
    expect(finalEventType("pending")).toBeNull();
  });
});

describe("routing audité (US-15) + webhook tardif (§5.4)", () => {
  test("updateRouting réordonne + AuditLog avant/après", async () => {
    const store = new MemoryStore();
    seedMemory(store);
    const engine = new PaymentEngine({ store, providers: registry(), expirationHoursRaw: "24" });
    const order = await engine.updateRouting({
      country: "CD",
      network: "AIRTEL",
      providers: ["mocksecondary", "mockprimary"],
      actor: "admin:test",
      requestId: "req-1",
    });
    expect(order).toEqual(["mocksecondary", "mockprimary"]);
    const route = await store.findRoute("c-cd", "n-cd-airtel");
    expect(route.map((e) => e.provider_code)).toEqual(["mocksecondary", "mockprimary"]);
    expect(store.audits).toHaveLength(1);
    expect(store.audits[0]).toMatchObject({
      action: "routing.updated",
      actor: "admin:test",
      resource_type: "routing_rule",
      resource_id: "CD-AIRTEL",
    });
    expect(store.audits[0].old_value).toEqual({ providers: ["mockprimary", "mocksecondary"] });
    expect(store.audits[0].new_value).toEqual({ providers: ["mocksecondary", "mockprimary"] });
  });

  test("updateRouting refuse doublons et providers inconnus", async () => {
    const store = new MemoryStore();
    seedMemory(store);
    const engine = new PaymentEngine({ store, providers: registry(), expirationHoursRaw: "24" });
    let dup = "";
    try {
      await engine.updateRouting({ country: "CD", network: "AIRTEL", providers: ["mockprimary", "mockprimary"], actor: "a" });
    } catch (err) {
      dup = (err as { code?: string }).code ?? "";
    }
    expect(dup).toBe("INVALID_ROUTE");
    let unknown = "";
    try {
      await engine.updateRouting({ country: "CD", network: "AIRTEL", providers: ["nosuch"], actor: "a" });
    } catch (err) {
      unknown = (err as { code?: string }).code ?? "";
    }
    expect(unknown).toBe("PROVIDER_ERROR");
    expect(store.audits).toHaveLength(0);
  });

  test("webhook tardif après expired → is_late + AuditLog, pas de transition", async () => {
    const store = new MemoryStore();
    seedMemory(store);
    const providers = registry();
    (providers.get("mockprimary") as MockProvider).setScenario("pending");
    const engine = new PaymentEngine({ store, providers, expirationHoursRaw: "24" });
    const { payment } = await engine.create(input());
    store.geo.set(payment.id, { country: "CD", network: "AIRTEL" });
    await engine.initiate(payment.id);
    // Expire la fenêtre métier → unknown (scénario pending = incertain,
    // jamais failed — spec §9.2 step 6).
    await engine.expireDue(new Date(Date.now() + 25 * 3_600_000));
    expect((await store.findPaymentById(payment.id))?.status).toBe("unknown");

    const attempts = await store.listAttempts(payment.id);
    const ref = attempts[0].provider_reference!;
    const primary = providers.get("mockprimary") as MockProvider;
    const body = JSON.stringify({ provider_reference: ref, status: "succeeded", event_id: "evt-late-1" });
    const out = await engine.applyInboundWebhook("mockprimary", body, {
      "x-webhook-signature": primary.signWebhook(body),
    }, { requestId: "req-late" });
    expect(out.result).toBe("late");
    expect((await store.findPaymentById(payment.id))?.status).toBe("unknown");
    const late = store.audits.filter((a) => a.action === "webhook.late_received");
    expect(late).toHaveLength(1);
    expect(late[0]).toMatchObject({ actor: "provider:mockprimary", resource_type: "payment", resource_id: payment.id });
  });
});
