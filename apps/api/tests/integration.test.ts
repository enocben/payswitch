// @payswitch/api tests — intégration Postgres (compose local, spec §18).
// Exécutés si DATABASE_URL est défini (compose PG16 loopback), sinon
// skip — `bun run test` reste vert sans infra, réel avec infra.
// Couvre : contraintes UNIQUE, cycle persisté, 409, concurrence réelle
// (SELECT FOR UPDATE), expiration, rétention raw 30j.

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import {
  MockProvider,
  type PaymentProvider,
  type ProviderCapabilities,
} from "@payswitch/core";
import { DataSource } from "typeorm";
import { PaymentEngine } from "../src/engine/payment-engine.js";
import { TypeOrmStore } from "../src/infrastructure/database/typeorm-store.js";
import { buildDataSource } from "../src/infrastructure/database/data-source.js";
import { uuidv7 } from "../src/common/ids.js";

const HAS_DB = !!process.env.DATABASE_URL;
const d = HAS_DB ? describe : describe.skip;

const CAPS: ProviderCapabilities = {
  supported_countries: ["CD", "CG", "CI"],
  supported_networks: { CD: ["AIRTEL", "ORANGE"], CG: ["AIRTEL"], CI: ["WAVE"] },
  supported_currencies: ["CDF", "XAF", "XOF"],
  min_amount_minor: 100n,
  max_amount_minor: 100_000_000n,
  operations: ["collect"],
  supports_idempotency: true,
};

function registry(primary: "success" | "temporary_failure" | "timeout_unknown" | "confirmed_failed" | "pending" = "success", secondary: typeof primary = "success") {
  const m = new Map<string, PaymentProvider>();
  m.set("mockprimary", new MockProvider({ code: "mockprimary", capabilities: CAPS, scenario: primary }));
  m.set("mocksecondary", new MockProvider({ code: "mocksecondary", capabilities: CAPS, scenario: secondary }));
  return m;
}

let n = 0;
const uid = (p: string) => `${p}-${Date.now()}-${n++}`;

d("intégration Postgres (compose local)", () => {
  let ds: DataSource;

  beforeAll(async () => {
    ds = buildDataSource();
    await ds.initialize();
    const reg = (await ds.query("SELECT to_regclass('public.payments') AS c")) as { c: string | null }[];
    if (reg[0].c === null) {
      throw new Error("migrations not applied — run: bun run db:migrate && bun run db:seed");
    }
  });

  afterAll(async () => {
    await ds.destroy();
  });

  async function clean(): Promise<void> {
    await ds.query("TRUNCATE webhook_deliveries, webhook_events, payment_attempts, payments, audit_logs CASCADE");
  }

  function engine(store: TypeOrmStore, providers: Map<string, PaymentProvider>, expirationHoursRaw = "24") {
    return new PaymentEngine({ store, providers, expirationHoursRaw });
  }

  test("contraintes : UNIQUE network/webhook/routing + index", async () => {
    await clean();
    // node-postgres (TypeORM/pg) expose SQLSTATE dans `code`.
    const sqlstate = (err: unknown) => (err as { code?: string }).code ?? "";
    // UNIQUE(country_id, code) — CD-AIRTEL existe déjà via seed.
    const cd = ((await ds.query("SELECT id FROM countries WHERE code = 'CD'")) as { id: string }[])[0];
    let dup = "";
    try {
      await ds.query("INSERT INTO networks (id, country_id, code, display_name) VALUES (gen_random_uuid(), $1, 'AIRTEL', 'dup')", [cd.id]);
    } catch (err) {
      dup = sqlstate(err);
    }
    expect(dup).toBe("23505");

    // UNIQUE(country_id, network_id, priority) — priorité 1 CD-AIRTEL prise.
    let dupPrio = "";
    try {
      const net = ((await ds.query("SELECT id FROM networks WHERE country_id = $1 AND code = 'AIRTEL'", [cd.id])) as { id: string }[])[0];
      const prov = ((await ds.query("SELECT id FROM providers WHERE code = 'mocksecondary'")) as { id: string }[])[0];
      await ds.query("INSERT INTO routing_rules (id, country_id, network_id, provider_id, priority) VALUES (gen_random_uuid(), $1, $2, $3, 1)", [cd.id, net.id, prov.id]);
    } catch (err) {
      dupPrio = sqlstate(err);
    }
    expect(dupPrio).toBe("23505");

    // Index requis présents.
    const idx = (await ds.query(
      "SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND tablename IN ('payments','payment_attempts','webhook_events','routing_rules','networks')",
    )) as { indexname: string }[];
    const names = idx.map((i) => i.indexname).join(",");
    for (const want of ["ix_payments_status", "ix_payments_next_poll", "ix_payments_status_poll", "ix_payments_idem"]) {
      expect(names).toContain(want);
    }
  });

  test("cycle persisté create→initiate→verify (BIGINT round-trip)", async () => {
    await clean();
    const store = TypeOrmStore.forRoot(ds);
    const eng = engine(store, registry("success", "success"));
    const { payment, httpStatus } = await eng.create({
      amount_minor: 2500n,
      currency: "CDF",
      phone: "+243815554433",
      country: "CD",
      network: "AIRTEL",
      idempotency_key: uid("cycle"),
      correlation_id: uid("corr"),
      request_id: uid("req"),
    });
    expect(httpStatus).toBe(201);
    expect(typeof payment.amount_minor).toBe("bigint");
    expect(payment.amount_minor).toBe(2500n);

    const initiated = await eng.initiate(payment.id);
    expect(initiated.status).toBe("pending");
    const verified = await eng.verify(payment.id);
    expect(verified.status).toBe("succeeded");

    // Raw expurgés (ni phone clair ni clé).
    const raw = ((await ds.query("SELECT provider_raw_request FROM payment_attempts WHERE payment_id = $1", [
      payment.id,
    ])) as {
      provider_raw_request: string;
    }[])[0];
    expect(JSON.stringify(raw.provider_raw_request)).not.toContain("243815554433");
  });

  test("409 + double create concurrent → un seul Payment", async () => {
    await clean();
    const store = TypeOrmStore.forRoot(ds);
    const eng = engine(store, registry());
    const key = uid("race");
    const base = {
      amount_minor: 1000n,
      currency: "CDF",
      phone: "+243820000001",
      country: "CD",
      network: "AIRTEL",
      idempotency_key: key,
      correlation_id: uid("corr"),
      request_id: uid("req"),
    };
    const [a, b] = await Promise.all([eng.create(base), eng.create(base)]);
    expect(a.payment.id).toBe(b.payment.id);
    const count = ((await ds.query("SELECT COUNT(*)::int AS c FROM payments WHERE idempotency_key = $1", [key])) as { c: number }[])[0];
    expect(count.c).toBe(1);

    let code = "";
    try {
      await eng.create({ ...base, amount_minor: 7777n });
    } catch (err) {
      code = (err as { code?: string }).code ?? "";
    }
    expect(code).toBe("IDEMPOTENCY_KEY_REUSED");
  });

  test("concurrence réelle webhook+polling → 1 seul changement d'état", async () => {
    await clean();
    const store = TypeOrmStore.forRoot(ds);
    const providers = registry("pending", "pending");
    const eng = engine(store, providers);
    const { payment } = await eng.create({
      amount_minor: 1000n,
      currency: "CDF",
      phone: "+243830000001",
      country: "CD",
      network: "AIRTEL",
      idempotency_key: uid("conc"),
      correlation_id: uid("corr"),
      request_id: uid("req"),
    });
    await eng.initiate(payment.id);
    const att = ((await ds.query(
      "SELECT provider_reference FROM payment_attempts WHERE payment_id = $1 ORDER BY attempt_number DESC LIMIT 1",
      [payment.id],
    )) as {
      provider_reference: string;
    }[])[0];
    const primary = providers.get("mockprimary") as MockProvider;
    const body = JSON.stringify({ provider_reference: att.provider_reference, status: "succeeded", event_id: uid("evt") });
    const headers = { "x-webhook-signature": primary.signWebhook(body) };

    // Webhook + 2 doublons + polling verify en concurrence réelle.
    const results = await Promise.all([
      eng.applyInboundWebhook("mockprimary", body, headers),
      eng.applyInboundWebhook("mockprimary", body, headers),
      eng.pollDue(new Date()),
    ]);
    const applied = (results.slice(0, 2) as { result: string }[]).filter((r) => r.result === "applied");
    expect(applied).toHaveLength(1);
    const fresh = await store.findPaymentById(payment.id);
    expect(fresh?.status).toBe("succeeded");
    const transitions = (await ds.query(
      "SELECT COUNT(*)::int AS c FROM webhook_events WHERE payment_id = $1 AND processed_at IS NOT NULL",
      [payment.id],
    )) as unknown as { c: number }[];
    expect(transitions[0].c).toBeGreaterThanOrEqual(1);
  });

  test("expiration persistée : incertain→unknown, jamais failed", async () => {
    await clean();
    const store = TypeOrmStore.forRoot(ds);
    const eng = engine(store, registry("timeout_unknown", "timeout_unknown"), "24");
    const { payment } = await eng.create({
      amount_minor: 1000n,
      currency: "CDF",
      phone: "+243840000001",
      country: "CD",
      network: "AIRTEL",
      idempotency_key: uid("exp"),
      correlation_id: uid("corr"),
      request_id: uid("req"),
    });
    await eng.initiate(payment.id);
    const res = await eng.expireDue(new Date(Date.now() + 25 * 3_600_000));
    expect(res.unknown).toBe(1);
    expect((await store.findPaymentById(payment.id))?.status).toBe("unknown");
  });

  test("rétention raw 30j : purge_provider_raw() expurge", async () => {
    await clean();
    const store = TypeOrmStore.forRoot(ds);
    const eng = engine(store, registry("success", "success"));
    const { payment } = await eng.create({
      amount_minor: 1000n,
      currency: "CDF",
      phone: "+243850000001",
      country: "CD",
      network: "AIRTEL",
      idempotency_key: uid("ret"),
      correlation_id: uid("corr"),
      request_id: uid("req"),
    });
    await eng.initiate(payment.id);
    // Vieillit artificiellement la tentative au-delà de 30j.
    await ds.query("UPDATE payment_attempts SET created_at = now() - INTERVAL '31 days' WHERE payment_id = $1", [payment.id]);
    const purged = (await ds.query("SELECT * FROM purge_provider_raw()")) as { attempts_cleared: string; events_cleared: string }[];
    expect(Number(purged[0].attempts_cleared)).toBeGreaterThanOrEqual(1);
    const raw = ((await ds.query("SELECT provider_raw_request FROM payment_attempts WHERE payment_id = $1", [
      payment.id,
    ])) as {
      provider_raw_request: string | null;
    }[])[0];
    expect(raw.provider_raw_request).toBeNull();
  });

  test("migration 002 : deliveries + audit persistés (PG réel)", async () => {
    await clean();
    const store = TypeOrmStore.forRoot(ds);
    const eng = engine(store, registry("success", "success"));

    // Routing reorder via moteur → replaceRoute + audit.
    const order = await eng.updateRouting({
      country: "CD",
      network: "AIRTEL",
      providers: ["mocksecondary", "mockprimary"],
      actor: "admin:pg",
    });
    expect(order).toEqual(["mocksecondary", "mockprimary"]);
    const audits = (await ds.query("SELECT action, resource_id FROM audit_logs")) as {
      action: string;
      resource_id: string;
    }[];
    expect(audits).toContainEqual({ action: "routing.updated", resource_id: "CD-AIRTEL" });

    // Restore l'ordre seed pour les autres tests.
    await eng.updateRouting({
      country: "CD",
      network: "AIRTEL",
      providers: ["mockprimary", "mocksecondary"],
      actor: "admin:pg",
    });

    // Delivery round-trip : insert → due → update delivered.
    const { payment } = await eng.create({
      amount_minor: 1000n,
      currency: "CDF",
      phone: "+243810000001",
      country: "CD",
      network: "AIRTEL",
      idempotency_key: uid("del"),
      correlation_id: uid("corr"),
      request_id: uid("req"),
    });
    const delivery = await store.insertWebhookDelivery({
      id: uuidv7(),
      event_id: uuidv7(),
      payment_id: payment.id,
      url: "https://merchant.example/hook",
      event_type: "payment.unknown",
      payload: { event_id: "e", attempt_id: null },
      signature: "sig",
      next_retry_at: new Date().toISOString(),
    });
    expect(delivery.status).toBe("pending");
    const dues = await store.listDueWebhookDeliveries(new Date().toISOString(), 10);
    expect(dues.map((d) => d.id)).toContain(delivery.id);
    const done = await store.updateWebhookDelivery(delivery.id, { status: "delivered", next_retry_at: null });
    expect(done.status).toBe("delivered");
    expect(done.next_retry_at).toBeNull();
  });
});
