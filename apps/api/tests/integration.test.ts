// @payswitch/api tests — intégration Postgres (compose local, spec §18).
// Exécutés si DATABASE_URL est défini (compose PG16 loopback), sinon
// skip — `bun run test` reste vert sans infra, réel avec infra.
// Couvre : contraintes UNIQUE, cycle persisté, 409, concurrence réelle
// (SELECT FOR UPDATE), expiration, rétention raw 30j.

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { SQL } from "bun";
import {
  MockProvider,
  type PaymentProvider,
  type ProviderCapabilities,
} from "@payswitch/core";
import { PaymentEngine } from "../src/engine/payment-engine.js";
import { PostgresStore } from "../src/infrastructure/database/postgres-store.js";
import { db, closeDb } from "../src/infrastructure/database/client.js";

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
  let sql: SQL;

  beforeAll(async () => {
    sql = db();
    const reg = await sql`SELECT to_regclass('public.payments') AS c`;
    if ((reg[0] as { c: string | null }).c === null) {
      throw new Error("migrations not applied — run: bun run db:migrate && bun run db:seed");
    }
  });

  afterAll(async () => {
    await closeDb();
  });

  async function clean(): Promise<void> {
    await sql`TRUNCATE webhook_deliveries, webhook_events, payment_attempts, payments, audit_logs CASCADE`;
  }

  function engine(store: PostgresStore, providers: Map<string, PaymentProvider>, expirationHoursRaw = "24") {
    return new PaymentEngine({ store, providers, expirationHoursRaw });
  }

  test("contraintes : UNIQUE network/webhook/routing + index", async () => {
    await clean();
    // bun:sql expose SQLSTATE dans `errno` (pas `code`).
    const sqlstate = (err: unknown) =>
      (err as { code?: string; errno?: string }).errno ??
      (err as { code?: string }).code ??
      "";
    // UNIQUE(country_id, code) — CD-AIRTEL existe déjà via seed.
    const cd = (await sql`SELECT id FROM countries WHERE code = 'CD'`)[0] as { id: string };
    let dup = "";
    try {
      await sql`INSERT INTO networks (id, country_id, code, display_name) VALUES (gen_random_uuid(), ${cd.id}, 'AIRTEL', 'dup')`;
    } catch (err) {
      dup = sqlstate(err);
    }
    expect(dup).toBe("23505");

    // UNIQUE(country_id, network_id, priority) — priorité 1 CD-AIRTEL prise.
    let dupPrio = "";
    try {
      const net = (await sql`SELECT id FROM networks WHERE country_id = ${cd.id} AND code = 'AIRTEL'`)[0] as { id: string };
      const prov = (await sql`SELECT id FROM providers WHERE code = 'mocksecondary'`)[0] as { id: string };
      await sql`INSERT INTO routing_rules (id, country_id, network_id, provider_id, priority) VALUES (gen_random_uuid(), ${cd.id}, ${net.id}, ${prov.id}, 1)`;
    } catch (err) {
      dupPrio = sqlstate(err);
    }
    expect(dupPrio).toBe("23505");

    // Index requis présents.
    const idx = (await sql`
      SELECT indexname FROM pg_indexes WHERE schemaname = 'public'
        AND tablename IN ('payments','payment_attempts','webhook_events','routing_rules','networks')
    `) as { indexname: string }[];
    const names = idx.map((i) => i.indexname).join(",");
    for (const want of ["ix_payments_status", "ix_payments_next_poll", "ix_payments_status_poll", "ix_payments_idem"]) {
      expect(names).toContain(want);
    }
  });

  test("cycle persisté create→initiate→verify (BIGINT round-trip)", async () => {
    await clean();
    const store = new PostgresStore(sql);
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
    const raw = (await sql`SELECT provider_raw_request FROM payment_attempts WHERE payment_id = ${payment.id}`)[0] as {
      provider_raw_request: string;
    };
    expect(JSON.stringify(raw.provider_raw_request)).not.toContain("243815554433");
  });

  test("409 + double create concurrent → un seul Payment", async () => {
    await clean();
    const store = new PostgresStore(sql);
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
    const count = (await sql`SELECT COUNT(*)::int AS c FROM payments WHERE idempotency_key = ${key}`)[0] as { c: number };
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
    const store = new PostgresStore(sql);
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
    const att = (await sql`SELECT provider_reference FROM payment_attempts WHERE payment_id = ${payment.id} ORDER BY attempt_number DESC LIMIT 1`)[0] as {
      provider_reference: string;
    };
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
    const transitions = (await sql`SELECT COUNT(*)::int AS c FROM webhook_events WHERE payment_id = ${payment.id} AND processed_at IS NOT NULL`) as unknown as { c: number }[];
    expect(transitions[0].c).toBeGreaterThanOrEqual(1);
  });

  test("expiration persistée : incertain→unknown, jamais failed", async () => {
    await clean();
    const store = new PostgresStore(sql);
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
    const store = new PostgresStore(sql);
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
    await sql`UPDATE payment_attempts SET created_at = now() - INTERVAL '31 days' WHERE payment_id = ${payment.id}`;
    const purged = (await sql`SELECT * FROM purge_provider_raw()`) as { attempts_cleared: string; events_cleared: string }[];
    expect(Number(purged[0].attempts_cleared)).toBeGreaterThanOrEqual(1);
    const raw = (await sql`SELECT provider_raw_request FROM payment_attempts WHERE payment_id = ${payment.id}`)[0] as {
      provider_raw_request: string | null;
    };
    expect(raw.provider_raw_request).toBeNull();
  });

  test("migration 002 : deliveries + audit persistés (PG réel)", async () => {
    await clean();
    const store = new PostgresStore(sql);
    const eng = engine(store, registry("success", "success"));

    // Routing reorder via moteur → replaceRoute + audit.
    const order = await eng.updateRouting({
      country: "CD",
      network: "AIRTEL",
      providers: ["mocksecondary", "mockprimary"],
      actor: "admin:pg",
    });
    expect(order).toEqual(["mocksecondary", "mockprimary"]);
    const audits = (await sql`SELECT action, resource_id FROM audit_logs`) as {
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
      id: crypto.randomUUID(),
      event_id: crypto.randomUUID(),
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
