// @payswitch/api E2E — cycle HTTP complet sur PG isolée (payswitch_nest).
// DATABASE_URL requise (base migrée + seedée) ; sinon suite skippée.
// Couvre : health public, 401 sans clé, POST 201 → GET même état (US-02),
// idempotence 200/409 (US-03), 422 validation, webhook 403 (US-09),
// routing réordonné + audit (US-15), collections, clés Admin.

import { INestApplication } from "@nestjs/common";
import { Test, TestingModule } from "@nestjs/testing";
import request from "supertest";
import { AppModule } from "../src/app.module";
import { setupApp } from "../src/main";
import { ApiKeysService } from "../src/modules/api-keys/api-keys.service";

const HAS_DB = !!process.env.DATABASE_URL;
const d = HAS_DB ? describe : describe.skip;

d("payswitch api (NestJS, PG isolée)", () => {
  let app: INestApplication;
  let key: string;
  const auth = (r: request.Test) => r.set("X-API-Key", key);
  let n = 0;
  const uid = (p: string) => `${p}-e2e-${Date.now()}-${n++}`;

  const payload = (over: Record<string, unknown> = {}) => ({
    amount: "5000",
    currency: "CDF",
    phone: "+243810000001",
    country: "CD",
    network: "AIRTEL",
    idempotency_key: uid("idem"),
    ...over,
  });

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = module.createNestApplication();
    setupApp(app);
    await app.init();
    const keys = app.get(ApiKeysService);
    const created = await keys.create("e2e", "test");
    key = created.secret;
  });

  afterAll(async () => {
    await app?.close();
  });

  it("GET /health public, sans clé", async () => {
    const res = await request(app.getHttpServer()).get("/health");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(res.body.db).toBe("up");
  });

  it("401 sans X-API-Key", async () => {
    const res = await request(app.getHttpServer()).get("/api/v1/payments");
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBeDefined();
    expect(res.body.error.request_id).toBeDefined();
  });

  it("POST /payments → 201 (5000 CDF = 500000 minor, mockprimary)", async () => {
    const res = await auth(request(app.getHttpServer()).post("/api/v1/payments")).send(payload());
    expect(res.status).toBe(201);
    expect(res.body.amount_minor).toBe(500000);
    expect(res.body.currency).toBe("CDF");
    expect(res.body.provider).toBe("mockprimary");
    expect(res.body.id).toBeDefined();
    expect(res.body.request_id).toBeDefined();
    expect(res.headers["x-request-id"]).toBeDefined();
  });

  it("même clé + même hash → 200 même Payment ; hash différent → 409 (US-03)", async () => {
    const server = app.getHttpServer();
    const body = payload({ idempotency_key: uid("idem3") });
    const first = await auth(request(server).post("/api/v1/payments")).send(body);
    expect(first.status).toBe(201);
    const second = await auth(request(server).post("/api/v1/payments")).send(body);
    expect(second.status).toBe(200);
    expect(second.body.id).toBe(first.body.id);
    const conflict = await auth(request(server).post("/api/v1/payments")).send({ ...body, amount: "6000" });
    expect(conflict.status).toBe(409);
    expect(conflict.body.error.code).toBe("IDEMPOTENCY_KEY_REUSED");
  });

  it("GET /payments/:id = même état que le webhook (US-02)", async () => {
    const server = app.getHttpServer();
    const created = await auth(request(server).post("/api/v1/payments")).send(payload());
    const res = await auth(request(server).get(`/api/v1/payments/${created.body.id}`));
    expect(res.status).toBe(200);
    expect(res.body.status).toBe(created.body.status);
    expect(res.body.phone_masked).toContain("****");
    expect(res.body.attempts.length).toBeGreaterThanOrEqual(1);
    expect(res.body.attempts[0].provider_idempotency_key).toHaveLength(64);
  });

  it("GET /payments paginé + 422 téléphone invalide", async () => {
    const server = app.getHttpServer();
    const list = await auth(request(server).get("/api/v1/payments?country=CD&page=1&per_page=5"));
    expect(list.status).toBe(200);
    expect(list.body.meta.total).toBeGreaterThanOrEqual(1);
    expect(list.body.meta.per_page).toBe(5);
    const bad = await auth(request(server).post("/api/v1/payments")).send(payload({ phone: "not-a-phone" }));
    expect(bad.status).toBe(422);
  });

  it("POST /webhooks/mockprimary signature invalide → 403 (US-09)", async () => {
    const res = await request(app.getHttpServer())
      .post("/webhooks/mockprimary")
      .set("x-webhook-signature", "bogus")
      .send({ provider_reference: "mock_nope", status: "succeeded" });
    expect(res.status).toBe(403);
  });

  it("routing : GET matrice + PUT réordonne (US-15)", async () => {
    const server = app.getHttpServer();
    const before = await auth(request(server).get("/api/v1/routing"));
    expect(before.status).toBe(200);
    const cd = before.body.find((r: { country: string; network: string }) => r.country === "CD" && r.network === "AIRTEL");
    expect(cd.providers).toEqual(["mockprimary", "mocksecondary"]);
    const put = await auth(request(server).put("/api/v1/routing")).send({
      country: "CD",
      network: "AIRTEL",
      providers: ["mocksecondary", "mockprimary"],
    });
    expect(put.status).toBe(200);
    const after = await auth(request(server).get("/api/v1/routing"));
    const cdAfter = after.body.find((r: { country: string; network: string }) => r.country === "CD" && r.network === "AIRTEL");
    expect(cdAfter.providers).toEqual(["mocksecondary", "mockprimary"]);
    // Restore l'ordre seed pour les autres suites.
    await auth(request(server).put("/api/v1/routing")).send({
      country: "CD",
      network: "AIRTEL",
      providers: ["mockprimary", "mocksecondary"],
    });
    const audit = await auth(request(server).get("/api/v1/audit-logs?limit=5"));
    expect(audit.body.some((a: { action: string }) => a.action === "routing.updated")).toBe(true);
  });

  it("référentiels + providers + collections", async () => {
    const server = app.getHttpServer();
    const countries = await auth(request(server).get("/api/v1/countries"));
    expect(countries.body.map((c: { code: string }) => c.code)).toEqual(expect.arrayContaining(["CD", "CG", "CI"]));
    const networks = await auth(request(server).get("/api/v1/networks?country=CD"));
    expect(networks.body.map((x: { code: string }) => x.code)).toEqual(expect.arrayContaining(["AIRTEL"]));
    const providers = await auth(request(server).get("/api/v1/providers"));
    expect(providers.body.map((p: { code: string }) => p.code)).toEqual(
      expect.arrayContaining(["mockprimary", "mocksecondary"]),
    );
    const collections = await auth(request(server).get("/api/v1/collections"));
    expect(collections.status).toBe(200);
    expect(collections.body.by_country).toBeDefined();
    const csv = await auth(request(server).get("/api/v1/collections/export"));
    expect(csv.status).toBe(200);
    expect(csv.text).toContain("scope,key,total_minor,count");
  });

  it("admin clés : création (secret 1 fois) + révocation immédiate", async () => {
    const server = app.getHttpServer();
    const created = await auth(request(server).post("/api/v1/api-keys")).send({ name: "e2e-second", mode: "test" });
    expect(created.status).toBe(201);
    expect(created.body.secret.startsWith("mg_test_")).toBe(true);
    const listed = await auth(request(server).get("/api/v1/api-keys"));
    expect(JSON.stringify(listed.body)).not.toContain(created.body.secret.slice(9, 20));
    const row = listed.body.find((k: { name: string }) => k.name === "e2e-second");
    const del = await auth(request(server).delete(`/api/v1/api-keys/${row.id}`));
    expect(del.status).toBe(204);
    const reuse = await request(server).get("/api/v1/payments").set("X-API-Key", created.body.secret);
    expect(reuse.status).toBe(401);
  });
});
