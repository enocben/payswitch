// @payswitch/api — HTTP REST + webhooks (Bun.serve, spec §7/§8).
// Plain Bun TS (pas de NestJS). Routes : payments, webhooks in/out,
// countries/networks/routing, collections+export, health, auth dashboard.
// Erreurs uniformes + X-Request-Id ; phone masqué en logs ; rate limit
// POST /payments ; delivery sortante non-bloquante (worker retry/backoff).

import { SQL } from "bun";
import { CoreError, type PaymentProvider } from "@payswitch/core";
import { PaymentEngine } from "../engine/payment-engine.js";
import { PostgresStore } from "../infrastructure/database/postgres-store.js";
import { maskPhone, hashPhone } from "../engine/phone.js";
import {
  RateLimit,
  SessionStore,
  STORED_PREFIX_LEN,
  clearedSessionCookie,
  extractApiKey,
  parseCookies,
  sessionCookie,
  verifyApiKey,
  SESSION_COOKIE,
} from "./auth.js";
import { RestStore, asJson } from "./rest.js";
import {
  DEFAULT_RETRY_SCHEDULE,
  MAX_BODY_LOG,
  canonicalJson,
  deriveSubSecret,
  nextRetryAt,
  parseRetrySchedule,
  signPayload,
  type OutboundPayload,
} from "./outbound.js";
import {
  apiError,
  apiOk,
  csvCell,
  requestIdFrom,
  uuidv7,
  validateCreatePayment,
  validateSubscription,
} from "./validate.js";

export interface AppConfig {
  sql: SQL;
  providers: Map<string, PaymentProvider>;
  /** Secret maître HMAC sortant (WEBHOOK_OUTBOUND_SECRET). */
  masterSecret: string;
  sessionTtlMs?: number;
  /** POST /payments : requêtes max / minute / identité. */
  paymentsPerMin?: number;
  /** Login : max essais / fenêtre / IP. */
  loginMax?: number;
  loginWindowMs?: number;
  outboundIntervalMs?: number;
  retryScheduleRaw?: string;
  maxRetries?: number;
  pollingIntervalMs?: number;
  startWorkers?: boolean;
}

export interface Identity {
  kind: "key" | "session";
  label: string;
}

export interface App {
  fetch: (req: Request, server?: unknown) => Promise<Response>;
  close: () => void;
  engine: PaymentEngine;
  rest: RestStore;
}

/**
 * Une passe de delivery sortante (worker non-bloquant + tests).
 * Claim SKIP LOCKED → POST signé → delivered / retrying+backoff / failed.
 * Retourne le nombre de deliveries traitées.
 */
export async function runOutboundBatch(
  rest: RestStore,
  masterSecret: string,
  schedule: number[],
  maxRetries: number,
): Promise<number> {
  const due = await rest.claimDueDeliveries(20);
  for (const d of due) {
    const secret = deriveSubSecret(masterSecret, d.subscription_id);
    const body = canonicalJson(d.payload);
    const expected = signPayload(secret, body);
    let code: number | null = null;
    let ok = false;
    let note = "";
    if (expected !== d.signature) {
      note = "signature mismatch (master rotated?)";
    } else {
      try {
        const res = await fetch(d.url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-webhook-signature": d.signature,
            "x-event-id": d.event_id,
          },
          body,
          signal: AbortSignal.timeout(10_000),
        });
        code = res.status;
        const text = await res.text().catch(() => "");
        note = text.slice(0, MAX_BODY_LOG);
        ok = res.status >= 200 && res.status < 300;
      } catch (err) {
        note = String(err).slice(0, MAX_BODY_LOG);
      }
    }
    const attempts = d.attempts + 1;
    if (ok) {
      await rest.updateDelivery(d.id, { status: "delivered", attempts, nextRetryAt: null, code, body: note || null });
    } else if (attempts > maxRetries) {
      await rest.updateDelivery(d.id, { status: "failed", attempts, nextRetryAt: null, code, body: note || null });
    } else {
      await rest.updateDelivery(d.id, {
        status: "retrying", attempts, nextRetryAt: nextRetryAt(Date.now(), attempts, schedule), code, body: note || null,
      });
    }
  }
  return due.length;
}

export function createApp(cfg: AppConfig): App {
  const store = new PostgresStore(cfg.sql);
  const engine = new PaymentEngine({ store, providers: cfg.providers });
  const rest = new RestStore(cfg.sql);
  const sessions = new SessionStore(cfg.sessionTtlMs ?? 12 * 3_600_000);
  const payLimiter = new RateLimit(60_000, cfg.paymentsPerMin ?? 60);
  const loginLimiter = new RateLimit(cfg.loginWindowMs ?? 15 * 60_000, cfg.loginMax ?? 5);
  const schedule = parseRetrySchedule(cfg.retryScheduleRaw, DEFAULT_RETRY_SCHEDULE);
  const maxRetries = cfg.maxRetries ?? 6;
  const timers: ReturnType<typeof setInterval>[] = [];
  let pollingBusy = false;
  let outboundBusy = false;

  function log(reqId: string, method: string, path: string, status: number, extra?: Record<string, unknown>): void {
    console.log(JSON.stringify({ ts: new Date().toISOString(), request_id: reqId, method, path, status, ...extra }));
  }

  function clientIp(req: Request, server: unknown): string {
    try {
      const s = server as { requestIP?: (r: Request) => { address: string } | null };
      return s?.requestIP?.(req)?.address ?? req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
    } catch {
      return "local";
    }
  }

  async function identityOf(req: Request): Promise<Identity | null> {
    const key = extractApiKey(req);
    if (key && (key.startsWith("mg_live_") || key.startsWith("mg_test_"))) {
      const candidates = await rest.findApiKeyCandidates(key.slice(0, STORED_PREFIX_LEN));
      const hit = await verifyApiKey(key, candidates);
      if (hit) {
        void rest.touchApiKey(hit.id).catch(() => undefined);
        return { kind: "key", label: `apikey:${hit.name}` };
      }
      return null;
    }
    const cookies = parseCookies(req);
    const token = cookies[SESSION_COOKIE];
    if (token) {
      const s = sessions.get(token);
      if (s) return { kind: "session", label: `user:${s.email}` };
    }
    return null;
  }

  async function readJson(req: Request): Promise<unknown> {
    const text = await req.text();
    if (!text) return {};
    try {
      return JSON.parse(text);
    } catch {
      throw { status: 400, code: "INVALID_JSON", message: "Body must be valid JSON" };
    }
  }

  function paymentEventType(status: string): string | null {
    if (status === "succeeded") return "payment.succeeded";
    if (status === "failed") return "payment.failed";
    if (status === "unknown") return "payment.unknown";
    return null;
  }

  /** Enqueue sortant vers les abonnés (insert DB awaited, POST marchand en worker). */
  async function notifySubscribers(paymentId: string, eventType: string): Promise<number> {
    const subs = await rest.activeSubscriptionsFor(eventType);
    if (subs.length === 0) return 0;
    const full = await rest.findPaymentFull(paymentId);
    if (!full) return 0;
    let n = 0;
    for (const sub of subs) {
      const eventId = uuidv7();
      const payload: OutboundPayload = {
        event_id: eventId,
        event_type: eventType,
        payment_id: paymentId,
        status: String(full.status),
        amount_minor: Number(full.amount_minor as bigint),
        currency: String(full.currency),
        country: String(full.country),
        network: String(full.network),
        external_reference: (full.external_reference as string | null) ?? null,
        occurred_at: new Date().toISOString(),
      };
      const record = payload as unknown as Record<string, unknown>;
      const secret = deriveSubSecret(cfg.masterSecret, sub.id);
      const signature = signPayload(secret, canonicalJson(record));
      await rest.enqueueDelivery({
        eventId, subscriptionId: sub.id, paymentId, url: sub.url, eventType, payload: record, signature,
      });
      n++;
    }
    return n;
  }

  // ---------------------------------------------------------- workers
  async function tickPolling(): Promise<void> {
    if (pollingBusy) return;
    pollingBusy = true;
    try {
      const now = new Date();
      await engine.pollDue(now, 50);
      await engine.expireDue(now, 100);
    } catch (err) {
      console.log(JSON.stringify({ ts: new Date().toISOString(), worker: "polling", error: String(err) }));
    } finally {
      pollingBusy = false;
    }
  }

  async function tickOutbound(): Promise<void> {
    if (outboundBusy) return;
    outboundBusy = true;
    try {
      await runOutboundBatch(rest, cfg.masterSecret, schedule, maxRetries);
    } catch (err) {
      console.log(JSON.stringify({ ts: new Date().toISOString(), worker: "outbound", error: String(err) }));
    } finally {
      outboundBusy = false;
    }
  }

  if (cfg.startWorkers !== false) {
    const poll = setInterval(() => void tickPolling(), cfg.pollingIntervalMs ?? 15_000);
    const out = setInterval(() => void tickOutbound(), cfg.outboundIntervalMs ?? 5_000);
    (poll as unknown as { unref?: () => void }).unref?.();
    (out as unknown as { unref?: () => void }).unref?.();
    timers.push(poll, out);
  }

  // ------------------------------------------------------------ fetch
  async function fetchHandler(req: Request, server?: unknown): Promise<Response> {
    const requestId = requestIdFrom(req);
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const method = req.method.toUpperCase();
    const ip = clientIp(req, server);

    const ok = (status: number, data: unknown, extra?: Record<string, string>) => {
      log(requestId, method, path, status);
      const withId =
        typeof data === "object" && data !== null && !Array.isArray(data)
          ? { ...(data as Record<string, unknown>), request_id: requestId }
          : data;
      return apiOk(requestId, status, withId, extra);
    };
    const fail = (status: number, code: string, message: string, details?: Record<string, unknown>) => {
      log(requestId, method, path, status, { error: code });
      return apiError(requestId, status, code, message, details);
    };

    try {
      // -------------------------------------------------- public
      if (method === "GET" && path === "/health") {
        try {
          await cfg.sql`SELECT 1`;
          return ok(200, { status: "ok", db: "up", version: "0.1.0", time: new Date().toISOString() });
        } catch {
          log(requestId, method, path, 503);
          return apiError(requestId, 503, "DB_UNAVAILABLE", "Database unreachable");
        }
      }

      if (method === "POST" && path === "/api/v1/auth/login") {
        if (!loginLimiter.check(`login:${ip}`)) return fail(429, "RATE_LIMITED", "Too many login attempts");
        const body = (await readJson(req)) as { email?: unknown; password?: unknown };
        if (typeof body.email !== "string" || typeof body.password !== "string") {
          return fail(401, "INVALID_CREDENTIALS", "Invalid email or password");
        }
        const user = await rest.findUserByEmail(body.email.toLowerCase());
        const valid = user ? await Bun.password.verify(body.password, user.password_hash).catch(() => false) : false;
        if (!user || !valid) return fail(401, "INVALID_CREDENTIALS", "Invalid email or password");
        const { token } = sessions.create(user.id, user.email);
        log(requestId, method, path, 200, { actor: user.email });
        return apiOk(requestId, 200, { id: user.id, email: user.email }, {
          "set-cookie": sessionCookie(token, Math.floor((cfg.sessionTtlMs ?? 12 * 3_600_000) / 1000)),
        });
      }

      if (method === "POST" && path === "/api/v1/auth/logout") {
        const token = parseCookies(req)[SESSION_COOKIE];
        if (token) sessions.destroy(token);
        return ok(200, { ok: true }, { "set-cookie": clearedSessionCookie() });
      }

      if (method === "GET" && path === "/api/v1/auth/me") {
        const token = parseCookies(req)[SESSION_COOKIE];
        const s = token ? sessions.get(token) : null;
        if (!s) return fail(401, "UNAUTHORIZED", "Not authenticated");
        return ok(200, { id: s.userId, email: s.email });
      }

      // Inbound provider (public, signature AVANT normalisation — moteur).
      const inbound = /^\/webhooks\/([A-Za-z0-9_-]+)$/.exec(path);
      if (method === "POST" && inbound) {
        const providerCode = inbound[1].toLowerCase();
        const adapter = cfg.providers.get(providerCode);
        let known = false;
        try {
          known = !adapter ? false : !!(await store.findProviderByCode(providerCode));
        } catch (err) {
          // DB inaccessible → 500 pour retry provider (spec §8.1).
          log(requestId, method, path, 500, { provider: providerCode, error: String(err) });
          return apiError(requestId, 500, "PROVIDER_RETRY", "Temporary error, please retry");
        }
        if (!adapter || !known) {
          return fail(404, "PROVIDER_NOT_FOUND", `Unknown provider: ${providerCode}`);
        }
        const rawBody = await req.text();
        const headers: Record<string, string> = {};
        req.headers.forEach((v, k) => {
          headers[k.toLowerCase()] = v;
        });
        let out: Awaited<ReturnType<PaymentEngine["applyInboundWebhook"]>>;
        try {
          out = await engine.applyInboundWebhook(providerCode, rawBody, headers);
        } catch (err) {
          // Erreur DB temporaire → 500 pour retry provider (spec §8.1).
          log(requestId, method, path, 500, { provider: providerCode, error: String(err) });
          return apiError(requestId, 500, "PROVIDER_RETRY", "Temporary error, please retry");
        }
        if (out.result === "invalid_signature") {
          return fail(403, "WEBHOOK_SIGNATURE_INVALID", `Invalid webhook signature for provider ${providerCode}`);
        }
        if (out.result === "late" && out.payment_id) {
          await rest.insertAudit({
            action: "webhook.late", actor: "system", resourceType: "payment",
            resourceId: out.payment_id, newValue: { status: out.payment_status }, ip, requestId,
          }).catch(() => undefined);
        }
        if (out.result === "applied" && out.payment_status) {
          const evt = paymentEventType(out.payment_status);
          if (evt && out.payment_id) await notifySubscribers(out.payment_id, evt).catch(() => undefined);
        }
        return ok(200, { result: out.result, payment_id: out.payment_id ?? null, payment_status: out.payment_status ?? null });
      }

      // -------------------------------------------------- auth requis
      const me = await identityOf(req);
      if (!me) return fail(401, "UNAUTHORIZED", "Missing or invalid API key or session");

      // -------------------------------------------------- payments
      if (path === "/api/v1/payments" && method === "POST") {
        if (!payLimiter.check(me.label)) return fail(429, "RATE_LIMITED", "Rate limit exceeded on POST /payments");
        const body = await readJson(req);
        const valid = validateCreatePayment(body);
        let created: { payment: { id: string }; created: boolean; httpStatus: 200 | 201 };
        try {
          const res = await engine.create({
            amount_minor: valid.amountMinor,
            currency: valid.currency,
            phone: valid.phone,
            country: valid.country,
            network: valid.network,
            idempotency_key: valid.idempotencyKey,
            external_reference: valid.externalReference,
            metadata: valid.metadata,
            correlation_id: requestId,
            request_id: requestId,
          });
          created = { payment: res.payment, created: res.created, httpStatus: res.httpStatus };
        } catch (err) {
          if (err instanceof CoreError && err.code === "IDEMPOTENCY_KEY_REUSED") {
            return fail(409, "IDEMPOTENCY_KEY_REUSED", err.message);
          }
          if (err instanceof CoreError && (err.code === "NO_SUPPORTED_PROVIDER" || err.code === "UNKNOWN_NETWORK")) {
            return fail(422, err.code, err.message, err.details);
          }
          throw err;
        }
        // Initiate synchrone (Mock instantané) ; le polling/verify reste async.
        // Replay idempotent (200) : relit l'état courant, jamais de ré-initiate.
        let status = "created";
        let provider: string | null = null;
        if (!created.created) {
          const current = await store.findPaymentById(created.payment.id);
          status = current?.status ?? "created";
          const attempts = await store.listAttempts(created.payment.id);
          if (attempts.length > 0) provider = await store.findProviderCodeById(attempts[attempts.length - 1].provider_id);
        } else {
          try {
            const initiated = await engine.initiate(created.payment.id);
            status = initiated.status;
            const attempts = await store.listAttempts(created.payment.id);
            if (attempts.length > 0) provider = await store.findProviderCodeById(attempts[0].provider_id);
          } catch (err) {
            log(requestId, method, path, 201, { phone: maskPhone(valid.phone), initiate_error: String(err) });
          }
        }
        const evt = paymentEventType(status);
        if (evt) await notifySubscribers(created.payment.id, evt).catch(() => undefined);
        log(requestId, method, path, created.httpStatus, { phone: maskPhone(valid.phone), payment_status: status });
        return apiOk(requestId, created.httpStatus, {
          id: created.payment.id,
          status,
          amount_minor: Number(valid.amountMinor),
          currency: valid.currency,
          provider,
          external_reference: valid.externalReference ?? null,
          request_id: requestId,
        });
      }

      if (path === "/api/v1/payments" && method === "GET") {
        const q = url.searchParams;
        const page = Number(q.get("page") ?? "1") || 1;
        const perPage = Number(q.get("per_page") ?? "20") || 20;
        const phone = q.get("phone");
        const { rows, total } = await rest.listPayments({
          status: q.get("status") ?? undefined,
          country: q.get("country")?.toUpperCase() || undefined,
          network: q.get("network")?.toUpperCase() || undefined,
          provider: q.get("provider")?.toLowerCase() || undefined,
          phoneHash: phone ? hashPhone(phone) : undefined,
          externalReference: q.get("external_reference") ?? undefined,
          from: q.get("from") ?? undefined,
          to: q.get("to") ?? undefined,
          page, perPage,
        });
        const data = rows.map((r) => ({
          id: String(r.id),
          status: String(r.status),
          amount_minor: Number(r.amount_minor as bigint),
          currency: String(r.currency),
          phone_masked: maskPhone(String(r.phone)),
          country: String(r.country),
          network: String(r.network),
          external_reference: (r.external_reference as string | null) ?? null,
          created_at: String(r.created_at),
        }));
        return ok(200, { data, meta: { total, page: Math.max(page, 1), per_page: Math.min(Math.max(perPage, 1), 100) } });
      }

      const payOne = /^\/api\/v1\/payments\/([A-Za-z0-9-]+)$/.exec(path);
      if (payOne && method === "GET") {
        const full = await rest.findPaymentFull(payOne[1]);
        if (!full) return fail(404, "NOT_FOUND", "Payment not found");
        const attempts = (full.attempts as Record<string, unknown>[]).map((a) => ({
          id: String(a.id),
          attempt_number: Number(a.attempt_number),
          provider: String(a.provider),
          status: String(a.status),
          provider_reference: (a.provider_reference as string | null) ?? null,
          provider_idempotency_key: String(a.provider_idempotency_key),
          error_code: (a.error_code as string | null) ?? null,
          error_message: (a.error_message as string | null) ?? null,
          error_outcome: (a.error_outcome as string | null) ?? null,
        }));
        const latest = attempts[attempts.length - 1];
        return ok(200, {
          id: String(full.id),
          idempotency_key: String(full.idempotency_key),
          external_reference: (full.external_reference as string | null) ?? null,
          amount_minor: Number(full.amount_minor as bigint),
          currency: String(full.currency),
          phone_masked: maskPhone(String(full.phone)),
          country: String(full.country),
          network: String(full.network),
          status: String(full.status),
          provider: latest?.provider ?? null,
          provider_reference: latest?.provider_reference ?? null,
          attempts,
          metadata: asJson<Record<string, unknown>>(full.metadata, {}),
          correlation_id: String(full.correlation_id),
        });
      }

      // -------------------------------------------------- subscriptions sortantes
      if (path === "/api/v1/webhooks" && method === "POST") {
        const body = await readJson(req);
        const sub = validateSubscription(body);
        const row = await rest.createSubscription(sub.url, sub.events, "pending");
        // Secret dérivé déterministe (recalculable) ; seul le hash est persisté.
        const secret = deriveSubSecret(cfg.masterSecret, row.id);
        const secretHash = await Bun.password.hash(secret, { algorithm: "argon2id" });
        await cfg.sql`UPDATE webhook_subscriptions SET secret_hash = ${secretHash} WHERE id = ${row.id}`;
        log(requestId, method, path, 201, { subscription: row.id });
        return apiOk(requestId, 201, { id: row.id, url: row.url, events: row.events, secret });
      }

      if (path === "/api/v1/webhooks" && method === "GET") {
        const subs = await rest.listSubscriptions();
        return ok(200, {
          data: subs.map((s) => ({ id: s.id, url: s.url, events: s.events, is_active: s.is_active, created_at: s.created_at })),
        });
      }

      const subDel = /^\/api\/v1\/webhooks\/([A-Za-z0-9-]+)$/.exec(path);
      if (subDel && method === "DELETE") {
        const gone = await rest.deleteSubscription(subDel[1]);
        if (!gone) return fail(404, "NOT_FOUND", "Webhook subscription not found");
        await rest.insertAudit({
          action: "webhook.deleted", actor: me.label, resourceType: "webhook",
          resourceId: subDel[1], ip, requestId,
        }).catch(() => undefined);
        log(requestId, method, path, 204);
        return new Response(null, { status: 204, headers: { "x-request-id": requestId } });
      }

      const subReplay = /^\/api\/v1\/webhooks\/([A-Za-z0-9-]+)\/replay$/.exec(path);
      if (subReplay && method === "POST") {
        const sub = await rest.findSubscription(subReplay[1]);
        if (!sub) return fail(404, "NOT_FOUND", "Webhook subscription not found");
        const body = (await readJson(req)) as { payment_id?: unknown };
        if (typeof body.payment_id !== "string") {
          return fail(422, "VALIDATION_ERROR", "payment_id is required", { field: "payment_id" });
        }
        const full = await rest.findPaymentFull(body.payment_id);
        if (!full) return fail(404, "NOT_FOUND", "Payment not found");
        const evt = paymentEventType(String(full.status));
        if (!evt) return fail(422, "VALIDATION_ERROR", `Payment status ${full.status} has no outbound event`);
        if (!sub.events.includes(evt)) return fail(422, "VALIDATION_ERROR", `Subscription not subscribed to ${evt}`);
        const eventId = uuidv7();
        const record = {
          event_id: eventId, event_type: evt, payment_id: body.payment_id, status: String(full.status),
          amount_minor: Number(full.amount_minor as bigint), currency: String(full.currency),
          country: String(full.country), network: String(full.network),
          external_reference: (full.external_reference as string | null) ?? null,
          occurred_at: new Date().toISOString(),
        } as unknown as Record<string, unknown>;
        const signature = signPayload(deriveSubSecret(cfg.masterSecret, sub.id), canonicalJson(record));
        const d = await rest.enqueueDelivery({
          eventId, subscriptionId: sub.id, paymentId: body.payment_id, url: sub.url, eventType: evt, payload: record, signature,
        });
        return ok(201, { event_id: d.event_id, delivery_id: d.id, status: d.status });
      }

      // -------------------------------------------------- deliveries
      if (path === "/api/v1/webhook-deliveries" && method === "GET") {
        const q = url.searchParams;
        const list = await rest.listDeliveries({
          subscriptionId: q.get("subscription_id") ?? undefined,
          status: q.get("status") ?? undefined,
          limit: Number(q.get("limit") ?? "20") || 20,
        });
        return ok(200, {
          data: list.map((d) => ({
            id: d.id, event_id: d.event_id, subscription_id: d.subscription_id, payment_id: d.payment_id,
            url: d.url, event_type: d.event_type, status: d.status, attempts: d.attempts,
            next_retry_at: d.next_retry_at, last_response_code: d.last_response_code, created_at: d.created_at,
          })),
        });
      }

      const delReplay = /^\/api\/v1\/webhook-deliveries\/([A-Za-z0-9-]+)\/replay$/.exec(path);
      if (delReplay && method === "POST") {
        const clone = await rest.replayDelivery(delReplay[1], uuidv7());
        if (!clone) return fail(404, "NOT_FOUND", "Delivery not found");
        // La signature est re-scellee sur le nouvel event_id (secret re-dérivé).
        const sub = await rest.findSubscription(clone.subscription_id);
        if (sub) {
          const fixed = { ...clone.payload, event_id: clone.event_id };
          const sig = signPayload(deriveSubSecret(cfg.masterSecret, sub.id), canonicalJson(fixed));
          await cfg.sql`UPDATE webhook_deliveries SET payload = ${JSON.stringify(fixed)}, signature = ${sig} WHERE id = ${clone.id}`;
        }
        return ok(201, { event_id: clone.event_id, delivery_id: clone.id, status: "pending" });
      }

      // -------------------------------------------------- geo / routing
      if (path === "/api/v1/countries" && method === "GET") {
        return ok(200, { data: await rest.listCountries() });
      }

      if (path === "/api/v1/networks" && method === "GET") {
        const country = url.searchParams.get("country")?.toUpperCase() || undefined;
        return ok(200, { data: await rest.listNetworks(country) });
      }

      if (path === "/api/v1/routing" && method === "GET") {
        return ok(200, { data: await rest.getRouting() });
      }

      if (path === "/api/v1/routing" && method === "PUT") {
        const body = await readJson(req);
        if (!Array.isArray(body) || body.length === 0) {
          return fail(422, "VALIDATION_ERROR", "Body must be a non-empty array", { field: "routing" });
        }
        const entries: { country: string; network: string; providers: string[] }[] = [];
        for (const e of body as { country?: unknown; network?: unknown; providers?: unknown }[]) {
          const country = typeof e.country === "string" ? e.country.toUpperCase() : "";
          const network = typeof e.network === "string" ? e.network.toUpperCase() : "";
          if (!country || !network || !Array.isArray(e.providers) || e.providers.length === 0) {
            return fail(422, "VALIDATION_ERROR", "Each entry needs {country, network, providers[]}", { entry: e });
          }
          const providers = [...new Set(e.providers as string[])].map((p) => String(p).toLowerCase());
          entries.push({ country, network, providers });
        }
        const before = await rest.getRouting();
        const resolved: { countryId: string; networkId: string; providerIds: string[] }[] = [];
        for (const e of entries) {
          const geo = await rest.geoIds(e.country, e.network);
          if (!geo) return fail(422, "UNKNOWN_NETWORK", `Unknown network: ${e.country}-${e.network}`);
          const pids: string[] = [];
          for (const code of e.providers) {
            const rows = await cfg.sql`SELECT id FROM providers WHERE code = ${code}`;
            if (rows.length === 0) return fail(422, "VALIDATION_ERROR", `Unknown provider: ${code}`);
            pids.push(String((rows[0] as Record<string, unknown>).id));
          }
          resolved.push({ countryId: geo.countryId, networkId: geo.networkId, providerIds: pids });
        }
        await rest.replaceRouting(resolved);
        const after = await rest.getRouting();
        const touched = new Set(entries.map((e) => `${e.country}:${e.network}`));
        await rest.insertAudit({
          action: "routing.updated", actor: me.label, resourceType: "routing",
          oldValue: before.filter((r) => touched.has(`${r.country}:${r.network}`)),
          newValue: after.filter((r) => touched.has(`${r.country}:${r.network}`)),
          ip, requestId,
        }).catch(() => undefined);
        return ok(200, { data: after });
      }

      // -------------------------------------------------- collections
      if ((path === "/api/v1/collections" || path === "/api/v1/collections/export") && method === "GET") {
        const q = url.searchParams;
        const f = {
          country: q.get("country")?.toUpperCase() || undefined,
          network: q.get("network")?.toUpperCase() || undefined,
          provider: q.get("provider")?.toLowerCase() || undefined,
          from: q.get("from") ?? undefined,
          to: q.get("to") ?? undefined,
        };
        const agg = await rest.collections(f);
        if (path.endsWith("/export")) {
          const format = q.get("format") ?? "csv";
          if (format !== "csv") return fail(422, "VALIDATION_ERROR", "Only format=csv is supported");
          const lines = ["scope,key,total_minor,count"];
          for (const r of agg.by_country) lines.push(["country", r.country, r.total_minor, r.count].map(csvCell).join(","));
          for (const r of agg.by_network) {
            lines.push(["network", `${r.country}-${r.network}`, r.total_minor, r.count].map(csvCell).join(","));
          }
          for (const r of agg.by_provider) lines.push(["provider", r.provider, r.total_minor, r.count].map(csvCell).join(","));
          log(requestId, method, path, 200);
          return new Response(lines.join("\n") + "\n", {
            status: 200,
            headers: {
              "content-type": "text/csv; charset=utf-8",
              "content-disposition": 'attachment; filename="collections.csv"',
              "x-request-id": requestId,
            },
          });
        }
        return ok(200, agg);
      }

      return fail(404, "NOT_FOUND", `No route: ${method} ${path}`);
    } catch (err) {
      if (err && typeof err === "object" && "status" in err) {
        const e = err as { status: number; code: string; message: string; details?: Record<string, unknown> };
        return fail(e.status, e.code, e.message, e.details);
      }
      if (err instanceof CoreError) {
        if (err.code === "IDEMPOTENCY_KEY_REUSED") return fail(409, err.code, err.message);
        if (err.code === "NO_SUPPORTED_PROVIDER" || err.code === "UNKNOWN_NETWORK" || err.code === "INVALID_AMOUNT") {
          return fail(422, err.code, err.message, err.details);
        }
        log(requestId, method, path, 500, { error: err.code });
        return apiError(requestId, 500, "INTERNAL_ERROR", "Internal error");
      }
      log(requestId, method, path, 500, { error: String(err) });
      return apiError(requestId, 500, "INTERNAL_ERROR", "Internal error");
    }
  }

  return {
    fetch: fetchHandler,
    close: () => {
      for (const t of timers) clearInterval(t);
    },
    engine,
    rest,
  };
}
