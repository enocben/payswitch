// @payswitch/api tests — REST + webhooks E2E (Postgres réel, spec §7/§8/§18).
// PG-gatés comme integration.test.ts : skip sans DATABASE_URL, réels sinon.
// Couvre : health, auth clés/sessions, payments 201/200/409/422 + filtres,
// routing audit-loggé, subscriptions secret-once, inbound 403/200/500,
// outbound HMAC + retry + replay, collections + CSV, rate limit.

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { SQL } from "bun";
import { MockProvider, type PaymentProvider, type ProviderCapabilities } from "@payswitch/core";
import { createApp, runOutboundBatch, type App } from "../src/http/server.js";
import { RestStore } from "../src/http/rest.js";
import { hashSecret, mintKey } from "../src/http/auth.js";
import { canonicalJson, deriveSubSecret, signPayload } from "../src/http/outbound.js";
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

const MASTER = "test-master-secret-rest";
let n = 0;
const uid = (p: string) => `${p}-${Date.now()}-${n++}`;

function registry(): Map<string, PaymentProvider> {
  const m = new Map<string, PaymentProvider>();
  m.set("mockprimary", new MockProvider({ code: "mockprimary", capabilities: CAPS, scenario: "success" }));
  m.set("mocksecondary", new MockProvider({ code: "mocksecondary", capabilities: CAPS, scenario: "success" }));
  return m;
}

d("REST + webhooks (Bun.serve, Postgres réel)", () => {
  let sql: SQL;
  let app: App;
  let server: ReturnType<typeof Bun.serve>;
  let base: string;
  let KEY = "";
  let rest: RestStore;

  async function call(method: string, path: string, opts: { body?: unknown; rawBody?: string; key?: string | null; cookie?: string; requestId?: string } = {}) {
    const headers: Record<string, string> = {};
    const k = opts.key === undefined ? KEY : opts.key;
    if (k) headers["x-api-key"] = k;
    if (opts.cookie) headers["cookie"] = opts.cookie;
    if (opts.requestId) headers["x-request-id"] = opts.requestId;
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { ...headers, ...(opts.body !== undefined || opts.rawBody !== undefined ? { "content-type": "application/json" } : {}) },
      body: opts.rawBody ?? (opts.body !== undefined ? JSON.stringify(opts.body) : undefined),
    });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { status: res.status, headers: res.headers, text, json: json as any };
  }

  beforeAll(async () => {
    sql = db();
    rest = new RestStore(sql);
    const reg = await sql`SELECT to_regclass('public.audit_logs') AS c`;
    if ((reg[0] as { c: string | null }).c === null) {
      throw new Error("migration 002 not applied — run: bun run db:migrate && bun run db:seed");
    }
    await sql`TRUNCATE webhook_deliveries, webhook_events, payment_attempts, payments, audit_logs, webhook_subscriptions CASCADE`;
    await sql`DELETE FROM api_keys`;
    const minted = mintKey(true);
    await rest.createApiKey("rest-tests", minted.prefix, await hashSecret(minted.key), ["*"]);
    KEY = minted.key;

    app = createApp({ sql, providers: registry(), masterSecret: MASTER, startWorkers: false, paymentsPerMin: 1000 });
    server = Bun.serve({ port: 0, fetch: app.fetch });
    base = `http://127.0.0.1:${server.port}`;
  });

  afterAll(async () => {
    server?.stop();
    app?.close();
    await closeDb();
  });

  test("GET /health → 200 + X-Request-Id", async () => {
    const r = await call("GET", "/health", { key: null });
    expect(r.status).toBe(200);
    expect((r.json as { status: string }).status).toBe("ok");
    expect(typeof r.headers.get("x-request-id")).toBe("string");
  });

  test("401 sans clé + format d'erreur uniforme", async () => {
    const r = await call("GET", "/api/v1/payments", { key: null });
    expect(r.status).toBe(401);
    expect(r.json?.error).toMatchObject({ code: "UNAUTHORIZED" });
    expect(typeof r.json?.request_id).toBe("string");
    expect(r.headers.get("x-request-id")).toBe(r.json?.request_id);
    const bad = await call("GET", "/api/v1/payments", { key: "mg_test_wrongkey" });
    expect(bad.status).toBe(401);
  });

  test("X-Request-Id entrant répercuté", async () => {
    const r = await call("GET", "/api/v1/countries", { requestId: "req-echo-1" });
    expect(r.headers.get("x-request-id")).toBe("req-echo-1");
    expect(r.json?.request_id).toBe("req-echo-1");
  });

  test("POST /payments → 201 (+200 replay, 409 conflit)", async () => {
    const key = uid("idem");
    const body = {
      amount_minor: 2500, currency: "CDF", phone: "+243815554433",
      country: "CD", network: "AIRTEL", idempotency_key: key, external_reference: "ext-1",
    };
    const r1 = await call("POST", "/api/v1/payments", { body });
    expect(r1.status).toBe(201);
    const p1 = r1.json as { id: string; status: string; amount_minor: number; provider: string; request_id: string };
    expect(p1.status).toBe("pending");
    expect(p1.amount_minor).toBe(2500);
    expect(p1.provider).toBe("mockprimary");

    const r2 = await call("POST", "/api/v1/payments", { body });
    expect(r2.status).toBe(200);
    expect((r2.json as { id: string }).id).toBe(p1.id);

    const r3 = await call("POST", "/api/v1/payments", { body: { ...body, amount_minor: 9999 } });
    expect(r3.status).toBe(409);
    expect(r3.json?.error).toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
  });

  test("POST /payments → 422 (phone/devise/montant/réseau)", async () => {
    const good = { amount_minor: 1000, currency: "CDF", phone: "+243815554433", country: "CD", network: "AIRTEL" };
    for (const [label, patch, code] of [
      ["phone", { phone: "0815" }, "INVALID_PHONE"],
      ["devise", { currency: "XX1" }, "INVALID_CURRENCY"],
      ["montant", { amount_minor: 0 }, "INVALID_AMOUNT"],
      ["réseau inconnu", { network: "MTN" }, "UNKNOWN_NETWORK"],
      ["pays sans route", { country: "UG", network: "AIRTEL" }, "UNKNOWN_NETWORK"],
    ] as [string, Record<string, unknown>, string][]) {
      const r = await call("POST", "/api/v1/payments", { body: { ...good, ...patch, idempotency_key: uid("bad") } });
      expect(r.status).toBe(422); // {label}
      expect((r.json?.error as { code: string }).code).toBe(code);
    }
  });

  test("POST /payments accepte amount humain → minor", async () => {
    const r = await call("POST", "/api/v1/payments", {
      body: { amount: 100, currency: "CDF", phone: "+243815554434", country: "CD", network: "AIRTEL", idempotency_key: uid("human") },
    });
    expect(r.status).toBe(201);
    expect((r.json as { amount_minor: number }).amount_minor).toBe(10_000);
  });

  test("GET /payments/:id → détail masqué, même état que webhook", async () => {
    const created = await call("POST", "/api/v1/payments", {
      body: { amount_minor: 1200, currency: "CDF", phone: "+243815554435", country: "CD", network: "AIRTEL", idempotency_key: uid("det") },
    });
    const id = (created.json as { id: string }).id;
    const r = await call("GET", `/api/v1/payments/${id}`);
    expect(r.status).toBe(200);
    const p = r.json as Record<string, unknown>;
    expect(p.status).toBe("pending");
    expect(String(p.phone_masked)).toContain("****");
    expect(String(p.phone_masked)).not.toContain("5554433");
    expect(p.attempts).toHaveLength(1);
    expect(((p.attempts as unknown[])[0] as { provider_idempotency_key: string }).provider_idempotency_key).toHaveLength(64);
    const miss = await call("GET", "/api/v1/payments/00000000-0000-7000-8000-000000000000");
    expect(miss.status).toBe(404);
  });

  test("GET /payments filtres + pagination", async () => {
    const ext = uid("flt");
    await call("POST", "/api/v1/payments", {
      body: { amount_minor: 1300, currency: "CDF", phone: "+243815554436", country: "CD", network: "AIRTEL", external_reference: ext, idempotency_key: uid("fl") },
    });
    const byExt = await call("GET", `/api/v1/payments?external_reference=${ext}`);
    expect((byExt.json as { meta: { total: number } }).meta.total).toBe(1);
    const byStatus = await call("GET", "/api/v1/payments?status=pending&page=1&per_page=2");
    const js = byStatus.json as { data: unknown[]; meta: { total: number; page: number; per_page: number } };
    expect(js.meta.page).toBe(1);
    expect(js.meta.per_page).toBe(2);
    expect(js.data.length).toBeLessThanOrEqual(2);
    const byPhone = await call("GET", "/api/v1/payments?phone=%2B243815554436");
    expect((byPhone.json as { meta: { total: number } }).meta.total).toBe(1);
    const byProvider = await call("GET", "/api/v1/payments?provider=mockprimary");
    expect((byProvider.json as { meta: { total: number } }).meta.total).toBeGreaterThanOrEqual(1);
  });

  test("countries + networks", async () => {
    const c = await call("GET", "/api/v1/countries");
    expect((c.json as { data: { code: string }[] }).data.map((x) => x.code)).toContain("CD");
    const n = await call("GET", "/api/v1/networks?country=CD");
    expect((n.json as { data: { code: string }[] }).data.map((x) => x.code)).toContain("AIRTEL");
    const all = await call("GET", "/api/v1/networks");
    expect((all.json as { data: unknown[] }).data.length).toBeGreaterThanOrEqual(4);
  });

  test("routing GET + PUT audit-loggé (+422 provider inconnu)", async () => {
    const before = await call("GET", "/api/v1/routing");
    const cdAirtel = ((before.json as { data: { country: string; network: string; providers: string[] }[] }).data)
      .find((r) => r.country === "CD" && r.network === "AIRTEL");
    expect(cdAirtel?.providers).toEqual(["mockprimary", "mocksecondary"]);

    const bad = await call("PUT", "/api/v1/routing", {
      body: [{ country: "CD", network: "AIRTEL", providers: ["nosuch"] }],
    });
    expect(bad.status).toBe(422);

    const swapped = await call("PUT", "/api/v1/routing", {
      body: [{ country: "CD", network: "AIRTEL", providers: ["mocksecondary", "mockprimary"] }],
    });
    expect(swapped.status).toBe(200);
    const audit = await sql`SELECT action, actor, old_value, new_value FROM audit_logs WHERE action = 'routing.updated' ORDER BY created_at DESC LIMIT 1`;
    expect(audit.length).toBe(1);
    expect((audit[0] as { actor: string }).actor).toContain("rest-tests");
    expect(JSON.stringify((audit[0] as { old_value: unknown }).old_value)).toContain("mockprimary");

    // Restaure l'ordre (les autres tests supposent mockprimary en 1er).
    await call("PUT", "/api/v1/routing", {
      body: [{ country: "CD", network: "AIRTEL", providers: ["mockprimary", "mocksecondary"] }],
    });
  });

  test("subscriptions : secret affiché 1 fois, jamais en GET ni en DB", async () => {
    const created = await call("POST", "/api/v1/webhooks", {
      body: { url: "http://127.0.0.1:9/hook", events: ["payment.succeeded"] },
    });
    expect(created.status).toBe(201);
    const sub = created.json as { id: string; secret: string };
    expect(sub.secret.startsWith("whsec_")).toBe(true);
    const row = (await sql`SELECT secret_hash FROM webhook_subscriptions WHERE id = ${sub.id}`)[0] as { secret_hash: string };
    expect(row.secret_hash).toContain("$argon2");
    expect(row.secret_hash).not.toContain(sub.secret);
    const listed = await call("GET", "/api/v1/webhooks");
    const found = ((listed.json as { data: Record<string, unknown>[] }).data).find((s) => s.id === sub.id) as Record<string, unknown>;
    expect(found.secret).toBeUndefined();
    const del = await call("DELETE", `/api/v1/webhooks/${sub.id}`);
    expect(del.status).toBe(204);
    const gone = await call("DELETE", `/api/v1/webhooks/${sub.id}`);
    expect(gone.status).toBe(404);
    const badUrl = await call("POST", "/api/v1/webhooks", { body: { url: "nope", events: ["payment.succeeded"] } });
    expect(badUrl.status).toBe(422);
  });

  test("inbound : 403 mauvaise signature, 200 applied→duplicate→unlinked", async () => {
    const signer = new MockProvider({ code: "mockprimary", capabilities: CAPS });
    const created = await call("POST", "/api/v1/payments", {
      body: { amount_minor: 1400, currency: "CDF", phone: "+243815554437", country: "CD", network: "AIRTEL", idempotency_key: uid("wh") },
    });
    const id = (created.json as { id: string }).id;
    const detail = (await call("GET", `/api/v1/payments/${id}`)).json as { provider_reference: string };
    const body = JSON.stringify({ provider_reference: detail.provider_reference, status: "succeeded", event_id: uid("evt") });

    const badSig = await fetch(`${base}/webhooks/mockprimary`, {
      method: "POST", headers: { "content-type": "application/json", "x-webhook-signature": "wrong" }, body,
    });
    expect(badSig.status).toBe(403);

    const goodHeaders = { "content-type": "application/json", "x-webhook-signature": signer.signWebhook(body) };
    const applied = await fetch(`${base}/webhooks/mockprimary`, { method: "POST", headers: goodHeaders, body });
    expect(applied.status).toBe(200);
    expect(((await applied.json()) as { result: string }).result).toBe("applied");
    const dup = await fetch(`${base}/webhooks/mockprimary`, { method: "POST", headers: goodHeaders, body });
    expect(((await dup.json()) as { result: string }).result).toBe("duplicate");

    // GET /payments/:id expose le même état final que le webhook.
    const after = (await call("GET", `/api/v1/payments/${id}`)).json as { status: string };
    expect(after.status).toBe("succeeded");

    const orphanBody = JSON.stringify({ provider_reference: "mock_deadbeefdeadbeef", status: "succeeded", event_id: uid("evt") });
    const orphan = await fetch(`${base}/webhooks/mockprimary`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-webhook-signature": signer.signWebhook(orphanBody) },
      body: orphanBody,
    });
    expect(((await orphan.json()) as { result: string }).result).toBe("unlinked");

    const unknown = await fetch(`${base}/webhooks/nosuch`, { method: "POST", body: "{}" });
    expect(unknown.status).toBe(404);
  });

  test("inbound tardif après expiration → late + AuditLog, sans mutation", async () => {
    const signer = new MockProvider({ code: "mockprimary", capabilities: CAPS });
    const created = await call("POST", "/api/v1/payments", {
      body: { amount_minor: 1500, currency: "CDF", phone: "+243815554438", country: "CD", network: "AIRTEL", idempotency_key: uid("late") },
    });
    const id = (created.json as { id: string }).id;
    await app.engine.expireDue(new Date(Date.now() + 25 * 3_600_000));
    const expired = (await call("GET", `/api/v1/payments/${id}`)).json as { status: string };
    expect(["expired", "unknown"]).toContain(expired.status);
    const detail = (await call("GET", `/api/v1/payments/${id}`)).json as { provider_reference: string };
    const body = JSON.stringify({ provider_reference: detail.provider_reference, status: "succeeded", event_id: uid("evt") });
    const r = await fetch(`${base}/webhooks/mockprimary`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-webhook-signature": signer.signWebhook(body) },
      body,
    });
    expect(((await r.json()) as { result: string }).result).toBe("late");
    const still = (await call("GET", `/api/v1/payments/${id}`)).json as { status: string };
    expect(still.status).toBe(expired.status);
    const audit = await sql`SELECT COUNT(*)::int AS c FROM audit_logs WHERE action = 'webhook.late'`;
    expect(Number((audit[0] as { c: number }).c)).toBeGreaterThanOrEqual(1);
  });

  test("inbound : 500 sur erreur DB transitoire (retry provider)", async () => {
    const broken = new SQL("postgres://payswitch:payswitch@127.0.0.1:1/payswitch");
    const app2 = createApp({ sql: broken, providers: registry(), masterSecret: MASTER, startWorkers: false });
    const s2 = Bun.serve({ port: 0, fetch: app2.fetch });
    try {
      const r = await fetch(`http://127.0.0.1:${s2.port}/webhooks/mockprimary`, { method: "POST", body: "{}" });
      expect(r.status).toBe(500);
      expect(((await r.json()) as { error: { code: string } }).error.code).toBe("PROVIDER_RETRY");
    } finally {
      s2.stop();
      app2.close();
      await broken.close().catch(() => undefined);
    }
  });

  test("outbound : HMAC + X-Event-Id + retry + replay", async () => {
    const received: { headers: Record<string, string>; body: string }[] = [];
    const sink = Bun.serve({
      port: 0,
      fetch: async (req) => {
        const h: Record<string, string> = {};
        req.headers.forEach((v, k) => {
          h[k] = v;
        });
        received.push({ headers: h, body: await req.text() });
        return new Response("ok");
      },
    });
    const hookUrl = `http://127.0.0.1:${sink.port}/hook`;
    try {
      const sub = (await call("POST", "/api/v1/webhooks", {
        body: { url: hookUrl, events: ["payment.succeeded"] },
      })).json as { id: string; secret: string };

      // Déclenche succeeded via webhook entrant → enqueue sortant.
      const signer = new MockProvider({ code: "mockprimary", capabilities: CAPS });
      const created = await call("POST", "/api/v1/payments", {
        body: { amount_minor: 1600, currency: "CDF", phone: "+243815554439", country: "CD", network: "AIRTEL", idempotency_key: uid("out") },
      });
      const id = (created.json as { id: string }).id;
      const detail = (await call("GET", `/api/v1/payments/${id}`)).json as { provider_reference: string };
      const inbound = JSON.stringify({ provider_reference: detail.provider_reference, status: "succeeded", event_id: uid("evt") });
      await fetch(`${base}/webhooks/mockprimary`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-webhook-signature": signer.signWebhook(inbound) },
        body: inbound,
      });

      const treated = await runOutboundBatch(rest, MASTER, [50], 6);
      expect(treated).toBeGreaterThanOrEqual(1);
      expect(received.length).toBeGreaterThanOrEqual(1);
      const hit = received[received.length - 1];
      expect(typeof hit.headers["x-event-id"]).toBe("string");
      // Le marchand revérifie la signature sur les octets reçus.
      const recomputed = signPayload(sub.secret, hit.body);
      expect(hit.headers["x-webhook-signature"]).toBe(recomputed);
      expect(canonicalJson(JSON.parse(hit.body))).toBe(hit.body);
      const parsed = JSON.parse(hit.body) as { event_type: string; payment_id: string };
      expect(parsed.event_type).toBe("payment.succeeded");
      expect(parsed.payment_id).toBe(id);

      const list = (await call("GET", "/api/v1/webhook-deliveries?status=delivered")).json as { data: { id: string }[] };
      expect(list.data.length).toBeGreaterThanOrEqual(1);
      const replay = await call("POST", `/api/v1/webhook-deliveries/${list.data[0].id}/replay`);
      expect(replay.status).toBe(201);
      const replayed = (replay.json as { event_id: string }).event_id;
      expect(replayed).not.toBe(JSON.parse(hit.body).event_id);
      await runOutboundBatch(rest, MASTER, [50], 6);
      expect(received.length).toBeGreaterThanOrEqual(2);

      await call("DELETE", `/api/v1/webhooks/${sub.id}`);
    } finally {
      sink.stop();
    }
  });

  test("collections + export CSV (succeeded uniquement)", async () => {
    const agg = (await call("GET", "/api/v1/collections")).json as {
      by_country: { country: string; total_minor: number; count: number }[];
      by_network: unknown[];
      by_provider: unknown[];
    };
    const cd = agg.by_country.find((r) => r.country === "CD");
    expect(cd).toBeDefined();
    expect(cd!.count).toBeGreaterThanOrEqual(2);
    expect(cd!.total_minor).toBeGreaterThanOrEqual(1400 + 1600);
    const csv = await call("GET", "/api/v1/collections/export?format=csv");
    expect(csv.status).toBe(200);
    expect(csv.headers.get("content-type")).toContain("text/csv");
    expect(csv.text.split("\n")[0]).toBe("scope,key,total_minor,count");
    expect(csv.text).toContain("CD");
    const badFmt = await call("GET", "/api/v1/collections/export?format=json");
    expect(badFmt.status).toBe(422);
  });

  test("auth dashboard : login → me → logout", async () => {
    const bad = await call("POST", "/api/v1/auth/login", {
      key: null, body: { email: "admin@payswitch.local", password: "wrong" },
    });
    expect(bad.status).toBe(401);
    const login = await call("POST", "/api/v1/auth/login", {
      key: null, body: { email: "admin@payswitch.local", password: "ChangeMe123!" },
    });
    expect(login.status).toBe(200);
    const setCookie = login.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("ps_session=");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Lax");
    const cookie = setCookie.split(";")[0];
    const me = await call("GET", "/api/v1/auth/me", { key: null, cookie });
    expect(me.status).toBe(200);
    expect((me.json as { email: string }).email).toBe("admin@payswitch.local");
    // La session ouvre aussi l'API (dashboard).
    const viaSession = await call("GET", "/api/v1/countries", { key: null, cookie });
    expect(viaSession.status).toBe(200);
    const logout = await call("POST", "/api/v1/auth/logout", { key: null, cookie });
    expect(logout.status).toBe(200);
    const after = await call("GET", "/api/v1/auth/me", { key: null, cookie });
    expect(after.status).toBe(401);
  });

  test("clé révoquée → 401 immédiat", async () => {
    const minted = mintKey(true);
    const { id } = await rest.createApiKey("revoked-test", minted.prefix, await hashSecret(minted.key), ["*"]);
    const ok1 = await call("GET", "/api/v1/countries", { key: minted.key });
    expect(ok1.status).toBe(200);
    await sql`UPDATE api_keys SET revoked_at = now() WHERE id = ${id}`;
    const denied = await call("GET", "/api/v1/countries", { key: minted.key });
    expect(denied.status).toBe(401);
    await sql`DELETE FROM api_keys WHERE id = ${id}`;
  });

  test("rate limit POST /payments → 429", async () => {
    const appRL = createApp({ sql, providers: registry(), masterSecret: MASTER, startWorkers: false, paymentsPerMin: 2 });
    const sRL = Bun.serve({ port: 0, fetch: appRL.fetch });
    try {
      const mk = () => fetch(`http://127.0.0.1:${sRL.port}/api/v1/payments`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": KEY },
        body: JSON.stringify({ amount_minor: 1000, currency: "CDF", phone: "+243815554440", country: "CD", network: "AIRTEL", idempotency_key: uid("rl") }),
      });
      expect((await mk()).status).toBe(201);
      expect((await mk()).status).toBe(201);
      const limited = await mk();
      expect(limited.status).toBe(429);
      expect(((await limited.json()) as { error: { code: string } }).error.code).toBe("RATE_LIMITED");
    } finally {
      sRL.stop();
      appRL.close();
    }
  });
});
