// @payswitch/api tests — HTTP pur (sans DB, toujours verts).
// Validation, erreurs uniformes, HMAC sortant, planning retry, rate limit.

import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import {
  RateLimit,
  STORED_PREFIX_LEN,
  extractApiKey,
  hashSecret,
  mintKey,
  parseCookies,
  verifyApiKey,
} from "../src/http/auth.js";
import {
  canonicalJson,
  deriveSubSecret,
  nextRetryAt,
  parseRetrySchedule,
  signPayload,
} from "../src/http/outbound.js";
import {
  apiError,
  csvCell,
  toMinor,
  validateCreatePayment,
  validateSubscription,
} from "../src/http/validate.js";

describe("validation payments", () => {
  const base = {
    amount_minor: 2500,
    currency: "CDF",
    phone: "+243815554433",
    country: "CD",
    network: "AIRTEL",
    idempotency_key: "k-1",
  };

  test("body valide → normalisé (codes en majuscules)", () => {
    const v = validateCreatePayment({ ...base, country: "cd", network: "airtel", currency: "cdf" });
    expect(v.amountMinor).toBe(2500n);
    expect(v.currency).toBe("CDF");
    expect(v.country).toBe("CD");
    expect(v.network).toBe("AIRTEL");
  });

  test("amount humain → minor via décimales devise", () => {
    expect(toMinor(5000, "CDF")).toBe(500_000n); // 2 décimales par défaut
    expect(validateCreatePayment({ ...base, amount_minor: undefined, amount: 100 }).amountMinor).toBe(10_000n);
  });

  test("idempotency_key générée si absente", () => {
    const { idempotency_key, ...rest } = base;
    void idempotency_key;
    expect(validateCreatePayment(rest).idempotencyKey).toBeString();
  });

  for (const [label, patch] of [
    ["phone non-E.164", { phone: "0815554433" }],
    ["phone vide", { phone: "" }],
    ["montant nul", { amount_minor: 0 }],
    ["montant négatif", { amount_minor: -5 }],
    ["montant non-entier", { amount_minor: 10.5 }],
    ["devise basse-casse-invalide", { currency: "cd" }],
    ["devise 4 lettres", { currency: "CDFX" }],
    ["country manquant", { country: "" }],
  ] as [string, Record<string, unknown>][]) {
    test(`422 : ${label}`, () => {
      let err: { status: number; code: string } | null = null;
      try {
        validateCreatePayment({ ...base, ...patch });
      } catch (e) {
        err = e as { status: number; code: string };
      }
      expect(err?.status).toBe(422);
    });
  }

  test("metadata doit être un objet", () => {
    let code = "";
    try {
      validateCreatePayment({ ...base, metadata: [1, 2] });
    } catch (e) {
      code = (e as { code: string }).code;
    }
    expect(code).toBe("VALIDATION_ERROR");
  });
});

describe("validation subscriptions", () => {
  test("ok + dédupe events", () => {
    const s = validateSubscription({
      url: "https://m.example/wh",
      events: ["payment.succeeded", "payment.succeeded", "payment.failed"],
    });
    expect(s.events).toEqual(["payment.succeeded", "payment.failed"]);
  });

  test("422 : url/event invalides", () => {
    for (const body of [
      { url: "not-a-url", events: ["payment.succeeded"] },
      { url: "ftp://x/y", events: ["payment.succeeded"] },
      { url: "https://x/y", events: [] },
      { url: "https://x/y", events: ["payment.refunded"] },
      { url: "https://x/y" },
    ]) {
      expect(() => validateSubscription(body)).toThrow();
    }
  });

  test("http local accepté (tests/dev)", () => {
    expect(validateSubscription({ url: "http://127.0.0.1:9/wh", events: ["payment.unknown"] }).url).toContain("127.0.0.1");
  });
});

describe("erreurs uniformes", () => {
  test("{error:{code,message,details},request_id} + X-Request-Id", async () => {
    const res = apiError("req-123", 422, "INVALID_PHONE", "bad", { field: "phone" });
    expect(res.status).toBe(422);
    expect(res.headers.get("x-request-id")).toBe("req-123");
    const body = (await res.json()) as {
      error: { code: string; message: string; details: { field: string } };
      request_id: string;
    };
    expect(body.error.code).toBe("INVALID_PHONE");
    expect(body.error.details.field).toBe("phone");
    expect(body.request_id).toBe("req-123");
  });

  test("csvCell échappe RFC 4180", () => {
    expect(csvCell("a,b")).toBe('"a,b"');
    expect(csvCell('q"q')).toBe('"q""q"');
    expect(csvCell("plain")).toBe("plain");
  });
});

describe("HMAC sortant", () => {
  test("secret dérivé déterministe + jamais égal au master", () => {
    const a = deriveSubSecret("master", "sub-1");
    expect(a).toBe(deriveSubSecret("master", "sub-1"));
    expect(a.startsWith("whsec_")).toBe(true);
    expect(a).not.toContain("master");
    expect(deriveSubSecret("master", "sub-2")).not.toBe(a);
  });

  test("signature vérifiable par le marchand (HMAC brut)", () => {
    const secret = deriveSubSecret("master", "sub-1");
    const body = canonicalJson({ b: 1, a: [3, 2] });
    expect(body).toBe('{"a":[3,2],"b":1}');
    const sig = signPayload(secret, body);
    const expected = createHmac("sha256", secret).update(body, "utf8").digest("hex");
    expect(sig).toBe(expected);
  });

  test("planning retry : parse + plafond + défaut", () => {
    expect(parseRetrySchedule("1m,5m,15m,1h,6h,24h", [])).toEqual([60_000, 300_000, 900_000, 3_600_000, 21_600_000, 86_400_000]);
    expect(parseRetrySchedule("30s,2d", [])).toEqual([30_000, 172_800_000]);
    expect(parseRetrySchedule("garbage", [7])).toEqual([7]);
    const t0 = Date.now();
    expect(nextRetryAt(t0, 1, [60_000, 300_000])).toBe(new Date(t0 + 60_000).toISOString());
    expect(nextRetryAt(t0, 99, [60_000, 300_000])).toBe(new Date(t0 + 300_000).toISOString());
  });
});

describe("auth helpers", () => {
  test("mint : préfixe mg_test_/mg_live_ + lookup 12 chars", () => {
    const t = mintKey(true);
    const l = mintKey(false);
    expect(t.key.startsWith("mg_test_")).toBe(true);
    expect(l.key.startsWith("mg_live_")).toBe(true);
    expect(t.prefix).toBe(t.key.slice(0, STORED_PREFIX_LEN));
    expect(t.key).not.toBe(mintKey(true).key);
  });

  test("verify : bon hash ok, révoquée refusée, mauvaise clé refusée", async () => {
    const { key, prefix } = mintKey(true);
    const row = {
      id: "k1", name: "t", key_hash: await hashSecret(key), prefix,
      scopes: [], revoked_at: null,
    };
    expect(await verifyApiKey(key, [row])).not.toBeNull();
    expect(await verifyApiKey("mg_test_wrong", [row])).toBeNull();
    expect(await verifyApiKey(key, [{ ...row, revoked_at: new Date().toISOString() }])).toBeNull();
  });

  test("extraction clé : X-API-Key prioritaire, Bearer sinon", () => {
    const r1 = new Request("http://x/", { headers: { "x-api-key": "mg_test_a", authorization: "Bearer mg_test_b" } });
    expect(extractApiKey(r1)).toBe("mg_test_a");
    const r2 = new Request("http://x/", { headers: { authorization: "Bearer mg_test_b" } });
    expect(extractApiKey(r2)).toBe("mg_test_b");
    expect(extractApiKey(new Request("http://x/"))).toBeNull();
  });

  test("cookies parsés", () => {
    const r = new Request("http://x/", { headers: { cookie: "ps_session=abc; other=1" } });
    expect(parseCookies(r).ps_session).toBe("abc");
  });

  test("rate limit : fenêtre glissante", () => {
    const rl = new RateLimit(60_000, 2);
    expect(rl.check("k")).toBe(true);
    expect(rl.check("k")).toBe(true);
    expect(rl.check("k")).toBe(false);
    expect(rl.check("other")).toBe(true);
  });
});
