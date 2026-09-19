// @payswitch/api — moteur de paiement persistant (spec §5, §9.2, §18).
// Orchestre : create (idempotent) → initiate/verify via adapters Mock
// (supports() sync local uniquement) → retry/fallback provider-safe →
// polling (next_poll_at, non bloquant) → expiration (jamais failed).
// Concurrence : toute mutation passe par withTransaction + lockPayment
// (SELECT FOR UPDATE) + validation canTransition* — webhook + polling +
// duplicata = exactement un changement d'état.

import {
  CoreError,
  IdempotencyKeyReusedError,
  NoSupportedProviderError,
  VerificationRequiredError,
  buildProviderIdempotencyKey,
  canTransitionAttempt,
  canTransitionPayment,
  computeRequestHash,
  decideAfterInitiate,
  decideAfterVerify,
  isPaymentFinal,
  mayApplyWebhook,
  resolveExpiration,
  type AttemptStatus,
  type InitiateResult,
  type PaymentProvider,
  type PaymentStatus,
} from "@payswitch/core";
import { computeExpiresAt, computeNextPollAt, expirationHours } from "./polling.js";
import { hashPhone, last4 } from "./phone.js";
import {
  UniqueViolationError,
  type AttemptRow,
  type PaymentRow,
  type PaymentStore,
} from "./store.js";

/** Extension webhook/verify : résolution par référence et provider id. */
export interface EngineStore extends PaymentStore {
  findPaymentByProviderReference(reference: string): Promise<PaymentRow | null>;
  findProviderCodeById(id: string): Promise<string | null>;
  /** Codes pays/réseau d'un paiement (JOIN côté PG, champ direct en mémoire). */
  geoOf(payment: PaymentRow): Promise<{ country: string; network: string }>;
}

export interface EngineOptions {
  store: EngineStore;
  /** code → adapter. v1 : Mock seul (mockprimary, mocksecondary). */
  providers: Map<string, PaymentProvider>;
  now?: () => Date;
  uuid?: () => string;
  /** Défaut : PAYMENT_EXPIRATION_HOURS, sinon 24h (spec US-11). */
  expirationHoursRaw?: string;
  /** Redacteur de raw provider (défaut : expurge secrets/headers/PII). */
  redactRaw?: (raw: unknown) => unknown;
}

export interface CreatePaymentInput {
  amount_minor: bigint;
  currency: string;
  phone: string;
  country: string;
  network: string;
  idempotency_key: string;
  external_reference?: string;
  metadata?: Record<string, unknown>;
  correlation_id: string;
  request_id: string;
}

export interface WebhookOutcome {
  httpStatus: 200 | 403 | 500;
  result:
    | "applied"
    | "duplicate"
    | "late"
    | "already_final"
    | "unlinked"
    | "invalid_signature";
  payment_id?: string;
  payment_status?: PaymentStatus;
}

const SENSITIVE_KEYS = new Set([
  "secret",
  "api_key",
  "apikey",
  "authorization",
  "token",
  "password",
  "signature",
  "phone",
  "msisdn",
  "idempotencykey",
]);

function defaultRedact(raw: unknown): unknown {
  if (raw === null || raw === undefined) return raw;
  if (Array.isArray(raw)) return raw.map(defaultRedact);
  if (typeof raw === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEYS.has(k.toLowerCase()) ? "[redacted]" : defaultRedact(v);
    }
    return out;
  }
  return raw;
}

function uuidv7(): string {
  const ms = Date.now();
  const hi = Math.floor(ms / 2 ** 32);
  const lo = ms >>> 0;
  const rnd = crypto.getRandomValues(new Uint8Array(8));
  const b = new Uint8Array(16);
  b[0] = (hi >>> 24) & 0xff;
  b[1] = (hi >>> 16) & 0xff;
  b[2] = (hi >>> 8) & 0xff;
  b[3] = hi & 0xff;
  b[4] = (lo >>> 24) & 0xff;
  b[5] = (lo >>> 16) & 0xff;
  b[6] = ((lo >>> 8) & 0x0f) | 0x70;
  b[7] = lo & 0xff;
  b[8] = (rnd[0] & 0x3f) | 0x80;
  b[9] = rnd[1];
  b.set(rnd.subarray(2), 10);
  const hex = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const E164 = /^\+[1-9]\d{7,14}$/;
const ISO4217 = /^[A-Z]{3}$/;

type InitiateCall = InitiateResult & { canRetry: boolean; canFallback: boolean };

export class PaymentEngine {
  private readonly expirationH: number;

  constructor(private readonly opts: EngineOptions) {
    this.expirationH = expirationHours(
      opts.expirationHoursRaw ?? process.env.PAYMENT_EXPIRATION_HOURS,
    );
  }

  get store(): EngineStore {
    return this.opts.store;
  }

  private now(): Date {
    return this.opts.now?.() ?? new Date();
  }

  private uuid(): string {
    return this.opts.uuid?.() ?? uuidv7();
  }

  private redact(raw: unknown): unknown {
    return (this.opts.redactRaw ?? defaultRedact)(raw);
  }

  // --------------------------------------------------------------- create
  /**
   * Crée un Payment (spec §6 idempotence) : même clé + même hash → existant
   * (200) ; même clé + hash différent → 409 IDEMPOTENCY_KEY_REUSED.
   * La course concurrente (double INSERT) est résorbée via la contrainte
   * UNIQUE : relecture + même règle, un seul Payment gagnant.
   */
  async create(
    input: CreatePaymentInput,
  ): Promise<{ payment: PaymentRow; created: boolean; httpStatus: 200 | 201 }> {
    const { store } = this.opts;
    if (typeof input.amount_minor !== "bigint" || input.amount_minor <= 0n) {
      throw new CoreError("INVALID_AMOUNT", "amount_minor must be a bigint > 0");
    }
    if (!E164.test(input.phone)) {
      throw new CoreError("INVALID_AMOUNT", "Invalid E.164 phone");
    }
    const currency = input.currency.toUpperCase();
    if (!ISO4217.test(currency)) {
      throw new CoreError("INVALID_AMOUNT", `Invalid ISO 4217 currency: ${currency}`);
    }
    const countryCode = input.country.toUpperCase();
    const networkCode = input.network.toUpperCase();
    const country = await store.findCountry(countryCode);
    if (!country) throw new CoreError("UNKNOWN_NETWORK", `Unknown country: ${countryCode}`);
    const network = await store.findNetwork(country.id, networkCode);
    if (!network) throw new CoreError("UNKNOWN_NETWORK", `Unknown network: ${countryCode}-${networkCode}`);

    // Au moins un provider avec supports() === true, sinon 422 (spec §7.2).
    await this.resolveAdapters(countryCode, networkCode, currency, input.amount_minor);

    const request_hash = computeRequestHash({
      amount_minor: `bigint:${input.amount_minor.toString()}`,
      currency,
      phone: input.phone,
      country: countryCode,
      network: networkCode,
      external_reference: input.external_reference ?? "",
      metadata: JSON.stringify(input.metadata ?? {}),
    });

    const build = () => ({
      id: this.uuid(),
      idempotency_key: input.idempotency_key,
      request_hash,
      external_reference: input.external_reference,
      amount_minor: input.amount_minor,
      currency,
      phone: input.phone,
      phone_hash: hashPhone(input.phone),
      phone_last4: last4(input.phone),
      country_id: country.id,
      network_id: network.id,
      metadata: input.metadata ?? {},
      correlation_id: input.correlation_id,
      request_id: input.request_id,
      expires_at: computeExpiresAt(this.now().getTime(), this.expirationH),
    });

    const decide = (existing: PaymentRow) => {
      if (existing.request_hash !== request_hash) throw new IdempotencyKeyReusedError();
      return { payment: existing, created: false as const, httpStatus: 200 as const };
    };

    try {
      return await store.withTransaction(async (tx) => {
        const existing = await tx.findPaymentByIdem(input.idempotency_key);
        if (existing) return decide(existing);
        const payment = await tx.insertPayment(build());
        return { payment, created: true as const, httpStatus: 201 as const };
      });
    } catch (err) {
      if (err instanceof UniqueViolationError) {
        // Course : un autre thread a gagné — relecture + règle idempotence.
        const existing = await store.findPaymentByIdem(input.idempotency_key);
        if (existing) return decide(existing);
      }
      throw err;
    }
  }

  // -------------------------------------------------------------- routing
  /** Règles DB (priorité) filtrées par supports() sync local — jamais réseau. */
  async resolveAdapters(
    country: string,
    network: string,
    currency: string,
    amountMinor: bigint,
  ): Promise<PaymentProvider[]> {
    const { store, providers } = this.opts;
    const countryRow = await store.findCountry(country);
    if (!countryRow) throw new NoSupportedProviderError(country, network);
    const networkRow = await store.findNetwork(countryRow.id, network);
    if (!networkRow) throw new NoSupportedProviderError(country, network);
    const route = await store.findRoute(countryRow.id, networkRow.id);
    const eligible: PaymentProvider[] = [];
    for (const entry of route) {
      const adapter = providers.get(entry.provider_code);
      if (!adapter) continue;
      if (
        adapter.supports({ country, network, currency, amountMinor, operation: "collect" }) === true
      ) {
        eligible.push(adapter);
      }
    }
    if (eligible.length === 0) throw new NoSupportedProviderError(country, network);
    return eligible;
  }

  // ------------------------------------------------------------- initiate
  /**
   * Cycle initiate → retry/fallback provider-safe (spec §9.2) :
   * temporary → 1 retry même providerIdempotencyKey → fallback si canFallback ;
   * unknown/timeout → verify() OBLIGATOIRE ; AUCUN fallback si
   * verify = unknown/pending ; definitive confirmée → fallback.
   */
  async initiate(paymentId: string): Promise<PaymentRow> {
    const { store } = this.opts;
    const payment = await store.findPaymentById(paymentId);
    if (!payment) throw new CoreError("PROVIDER_ERROR", `Payment not found: ${paymentId}`);
    if (isPaymentFinal(payment.status)) return payment;

    const { country, network } = await store.geoOf(payment);
    const adapters = await this.resolveAdapters(country, network, payment.currency, payment.amount_minor);
    const existing = await store.listAttempts(paymentId);
    let nextNumber = existing.reduce((m, a) => Math.max(m, a.attempt_number), 0) + 1;

    await this.setPaymentStatus(paymentId, "processing");

    for (let i = 0; i < adapters.length; i++) {
      const adapter = adapters[i];
      const hasNext = i < adapters.length - 1;
      const providerId = await this.requireProviderId(adapter.code);
      const attempt = await store.insertAttempt({
        id: this.uuid(),
        payment_id: paymentId,
        provider_id: providerId,
        attempt_number: nextNumber++,
        provider_idempotency_key: buildProviderIdempotencyKey(paymentId, nextNumber - 1),
      });

      let call = await this.callInitiate(adapter, attempt, payment);
      let decision = decideAfterInitiate({
        outcome: call.outcome,
        confirmed: call.confirmed,
        canRetry: call.canRetry,
        canFallback: call.canFallback,
        supportsIdempotency: adapter.supportsIdempotency(),
        retryCount: 0,
      });

      if (decision === "retry_same_key") {
        // 1 retry, MÊME providerIdempotencyKey (spec §9.2, invariant §5).
        call = await this.callInitiate(adapter, attempt, payment);
        decision = decideAfterInitiate({
          outcome: call.outcome,
          confirmed: call.confirmed,
          canRetry: call.canRetry,
          canFallback: call.canFallback,
          supportsIdempotency: adapter.supportsIdempotency(),
          retryCount: 1,
        });
        if (decision === "retry_same_key") {
          decision = call.canFallback && hasNext ? "fallback" : "verify_required";
        }
      }

      if (decision === "accept_pending") {
        await this.markAttempt(paymentId, attempt.id, call, "pending");
        await this.setPaymentPending(paymentId);
        return (await store.findPaymentById(paymentId))!;
      }
      if (decision === "verify_required") {
        const settled = await this.runVerify(adapter, attempt, payment, hasNext);
        if (settled !== "fallback") return (await store.findPaymentById(paymentId))!;
        continue; // verify confirmed_failed + fallback → provider suivant
      }
      if (decision === "fail") {
        await this.markAttempt(paymentId, attempt.id, call, "failed");
        await this.setPaymentStatus(paymentId, "failed");
        return (await store.findPaymentById(paymentId))!;
      }
      // fallback → échec confirmé enregistré, tentative suivante.
      await this.markAttempt(paymentId, attempt.id, call, call.confirmed ? "failed" : "unknown");
    }

    // Providers épuisés sans décision finale → reste pending + polling.
    const current = await store.findPaymentById(paymentId);
    if (current && !isPaymentFinal(current.status)) await this.setPaymentPending(paymentId);
    return (await store.findPaymentById(paymentId))!;
  }

  // --------------------------------------------------------------- verify
  /**
   * verify() obligatoire sur unknown/timeout (spec §9.2) : succeeded →
   * terminé ; confirmed_failed + fallback possible → "fallback" (la boucle
   * initiate avance) sinon failed ; unknown/pending → reste pending +
   * next_poll_at, PAS de fallback — le polling replanifie.
   */
  async verify(paymentId: string): Promise<PaymentRow> {
    const { store } = this.opts;
    const payment = await store.findPaymentById(paymentId);
    if (!payment) throw new CoreError("PROVIDER_ERROR", `Payment not found: ${paymentId}`);
    if (isPaymentFinal(payment.status)) return payment;
    const attempts = await store.listAttempts(paymentId);
    const latest = attempts[attempts.length - 1];
    if (!latest?.provider_reference) throw new VerificationRequiredError(paymentId);
    const adapter = await this.adapterForAttempt(latest);
    const { country, network } = await store.geoOf(payment);
    const adapters = await this.resolveAdapters(country, network, payment.currency, payment.amount_minor);
    const hasNext = adapters.findIndex((a) => a === adapter) < adapters.length - 1;
    await this.runVerify(adapter, latest, payment, hasNext);
    return (await store.findPaymentById(paymentId))!;
  }

  // -------------------------------------------------------------- webhook
  /**
   * Webhook entrant (spec §5.3/§5.4) : signature AVANT normalisation
   * (invalide → 403) ; doublon UNIQUE → 200 idempotent ; final
   * expired/unknown → is_late=true sans mutation ; sinon transition
   * transactionnelle verrouillée → 200. Erreur DB temporaire → throw
   * (la couche HTTP répond 500 pour retry provider).
   */
  async applyInboundWebhook(
    providerCode: string,
    rawBody: string,
    headers: Record<string, string>,
  ): Promise<WebhookOutcome> {
    const { store } = this.opts;
    const adapter = this.opts.providers.get(providerCode);
    if (!adapter) throw new CoreError("PROVIDER_ERROR", `Unknown provider: ${providerCode}`);
    if (!adapter.verifyWebhookSignature(rawBody, headers)) {
      return { httpStatus: 403, result: "invalid_signature" };
    }
    const parsed = adapter.parseWebhook(rawBody, headers);
    const providerId = await this.requireProviderId(providerCode);
    const linked = await store.findPaymentByProviderReference(parsed.providerReference);

    return await store.withTransaction(async (tx) => {
      // Verrou d'abord (si paiement connu) pour décider is_late avant insert.
      const locked = linked ? await tx.lockPayment(linked.id) : null;
      if (linked && !locked) throw new CoreError("PROVIDER_ERROR", "Payment vanished mid-webhook");
      const late = locked !== null && (locked.status === "expired" || locked.status === "unknown");
      const final = locked !== null && isPaymentFinal(locked.status);

      let eventId: string;
      try {
        const inserted = await tx.insertWebhookEvent({
          id: this.uuid(),
          provider_id: providerId,
          payment_id: linked?.id ?? null,
          provider_event_id: parsed.providerEventId,
          signature_valid: true,
          normalized_status: parsed.status,
          is_late: late,
        });
        eventId = inserted.id;
      } catch (err) {
        if (err instanceof UniqueViolationError) {
          return { httpStatus: 200 as const, result: "duplicate" as const, payment_id: linked?.id };
        }
        throw err;
      }

      if (!locked) {
        await tx.markWebhookProcessed(eventId, this.now().toISOString());
        return { httpStatus: 200 as const, result: "unlinked" as const };
      }
      if (final) {
        // Final : journalisé (is_late si expired/unknown, spec §5.4), jamais muté.
        await tx.markWebhookProcessed(eventId, this.now().toISOString());
        return {
          httpStatus: 200 as const,
          result: (late ? "late" : "already_final") as "late" | "already_final",
          payment_id: locked.id,
          payment_status: locked.status,
        };
      }
      if (!mayApplyWebhook(locked.status, "succeeded")) {
        await tx.markWebhookProcessed(eventId, this.now().toISOString());
        return {
          httpStatus: 200 as const,
          result: "already_final" as const,
          payment_id: locked.id,
          payment_status: locked.status,
        };
      }
      const target: PaymentStatus =
        parsed.status === "succeeded"
          ? "succeeded"
          : parsed.status === "confirmed_failed"
            ? "failed"
            : "pending";
      if (target !== locked.status) {
        if (!canTransitionPayment(locked.status, target)) {
          throw new CoreError("INVALID_TRANSITION", `Webhook transition ${locked.status} → ${target} refused`);
        }
        await tx.updatePayment(
          locked.id,
          target === "pending"
            ? {
                status: "pending",
                poll_attempts: locked.poll_attempts + 1,
                next_poll_at: computeNextPollAt(this.now().getTime(), locked.poll_attempts),
              }
            : { status: target, next_poll_at: null },
        );
      }
      await tx.markWebhookProcessed(eventId, this.now().toISOString());
      const fresh = await tx.findPaymentById(locked.id);
      return {
        httpStatus: 200 as const,
        result: "applied" as const,
        payment_id: locked.id,
        payment_status: fresh?.status,
      };
    });
  }

  // -------------------------------------------------------------- polling
  /**
   * Queue polling (spec §9.2 step 5) : vérifie les due (next_poll_at dépassé)
   * via verify() — jamais bloquant HTTP (appelé par le worker, erreurs
   * isolées par paiement, aucune exception fatale).
   */
  async pollDue(now: Date, limit = 50): Promise<{ checked: number; settled: number }> {
    const dues = await this.opts.store.listDuePayments(now.toISOString(), limit);
    let settled = 0;
    for (const due of dues) {
      try {
        const after = await this.verify(due.id);
        if (isPaymentFinal(after.status) && !isPaymentFinal(due.status)) settled++;
      } catch {
        // Isolé : un paiement en échec ne bloque jamais les autres.
      }
    }
    return { checked: dues.length, settled };
  }

  /**
   * Expiration (spec US-11, §9.2 step 6) : pending → expired, incertain
   * (dernière tentative unknown/timeout, outcome inconnu non confirmé, ou
   * aucune tentative) → unknown. Jamais failed. `created` transite via
   * processing (machine §5.2).
   */
  async expireDue(now: Date, limit = 100): Promise<{ expired: number; unknown: number }> {
    const { store } = this.opts;
    const olds = await store.listExpiredPayments(now.toISOString(), limit);
    let expired = 0;
    let unknown = 0;
    for (const row of olds) {
      try {
        const res = await store.withTransaction(async (tx) => {
          const locked = await tx.lockPayment(row.id);
          if (!locked || isPaymentFinal(locked.status)) return null;
          const attempts = await tx.listAttempts(row.id);
          const last = attempts[attempts.length - 1];
          const uncertain =
            last === undefined ||
            last.status === "unknown" ||
            last.status === "timeout" ||
            (last.error_outcome === "unknown" && !last.confirmed);
          const target = resolveExpiration(uncertain);
          if (locked.status === "created") {
            await tx.updatePayment(row.id, { status: "processing" });
          }
          const mid = (await tx.findPaymentById(row.id))!;
          if (mid.status === target) return target;
          if (!canTransitionPayment(mid.status, target)) return null;
          await tx.updatePayment(row.id, { status: target, next_poll_at: null });
          return target;
        });
        if (res === "expired") expired++;
        else if (res === "unknown") unknown++;
      } catch {
        // Isolé : ne bloque jamais le reste du batch.
      }
    }
    return { expired, unknown };
  }

  // -------------------------------------------------------------- helpers
  private async callInitiate(
    adapter: PaymentProvider,
    attempt: AttemptRow,
    payment: PaymentRow,
  ): Promise<InitiateCall> {
    const { store } = this.opts;
    await store.updateAttempt(attempt.id, { status: "sending" });
    const { country, network } = await store.geoOf(payment);
    const res = await adapter.initiate({
      amountMinor: payment.amount_minor,
      currency: payment.currency,
      phone: payment.phone,
      country,
      network,
      paymentId: payment.id,
      idempotencyKey: payment.idempotency_key,
      providerIdempotencyKey: attempt.provider_idempotency_key,
      externalReference: payment.external_reference ?? undefined,
      metadata: payment.metadata,
      correlationId: payment.correlation_id,
    });
    let canRetry = false;
    let canFallback = false;
    if (res.outcome !== "success") {
      const normalized = adapter.normalizeError(res.rawResponse);
      canRetry = normalized.canRetry;
      canFallback = normalized.canFallback;
    }
    await store.updateAttempt(attempt.id, {
      status: "accepted",
      provider_reference: res.providerReference || null,
      provider_raw_request: this.redact(res.rawRequest),
      provider_raw_response: this.redact(res.rawResponse),
      error_outcome: res.outcome === "success" ? null : res.outcome,
      confirmed: res.confirmed,
    });
    return { ...res, canRetry, canFallback };
  }

  /** runVerify → "settled" (final ou replanifié) ou "fallback" (continuer la route). */
  private async runVerify(
    adapter: PaymentProvider,
    attempt: AttemptRow,
    payment: PaymentRow,
    hasNextProvider: boolean,
  ): Promise<"settled" | "fallback"> {
    const res = await adapter.verify({
      providerReference: attempt.provider_reference!,
      paymentId: payment.id,
      providerIdempotencyKey: attempt.provider_idempotency_key,
    });
    const normalized = adapter.normalizeError(res.rawResponse);
    // Fallback autorisé si le provider l'autorise OU si la route offre une
    // alternative et l'échec est confirmé — jamais sur unknown/pending.
    const canFallback = normalized.canFallback || (res.status === "confirmed_failed" && hasNextProvider);
    const decision = decideAfterVerify(res.status, canFallback);
    if (decision === "succeed") {
      await this.markAttempt(payment.id, attempt.id, null, "succeeded");
      await this.setPaymentStatus(payment.id, "succeeded");
      return "settled";
    }
    if (decision === "fail") {
      await this.markAttempt(payment.id, attempt.id, null, "failed");
      await this.setPaymentStatus(payment.id, "failed");
      return "settled";
    }
    if (decision === "fallback") {
      await this.markAttempt(payment.id, attempt.id, null, "failed");
      return "fallback";
    }
    // stay_pending : PAS de fallback (spec §9.2) → pending + backoff.
    await this.markAttempt(payment.id, attempt.id, null, "pending");
    const current = await this.opts.store.findPaymentById(payment.id);
    if (current && !isPaymentFinal(current.status)) await this.setPaymentPending(payment.id);
    return "settled";
  }

  private async markAttempt(
    paymentId: string,
    attemptId: string,
    res: InitiateResult | null,
    status: AttemptStatus,
  ): Promise<void> {
    const attempts = await this.opts.store.listAttempts(paymentId);
    const current = attempts.find((a) => a.id === attemptId);
    if (!current) throw new CoreError("PROVIDER_ERROR", `Attempt not found: ${attemptId}`);
    const patch: Partial<AttemptRow> = {};
    if (res) {
      patch.provider_reference = res.providerReference || current.provider_reference;
      patch.provider_raw_request = this.redact(res.rawRequest);
      patch.provider_raw_response = this.redact(res.rawResponse);
      patch.error_outcome = res.outcome === "success" ? null : res.outcome;
      patch.confirmed = res.confirmed;
    }
    patch.status = canTransitionAttempt(current.status, status) ? status : current.status;
    await this.opts.store.updateAttempt(attemptId, patch);
  }

  /** created → processing → cible, en une transaction (machine §5.2). */
  private async setPaymentStatus(paymentId: string, to: PaymentStatus): Promise<void> {
    const { store } = this.opts;
    await store.withTransaction(async (tx) => {
      const locked = await tx.lockPayment(paymentId);
      if (!locked) throw new CoreError("PROVIDER_ERROR", `Payment not found: ${paymentId}`);
      if (locked.status === to) return;
      if (isPaymentFinal(locked.status)) return; // final : jamais rétrogradé
      let from = locked.status;
      if (from === "created" && to !== "processing") {
        await tx.updatePayment(paymentId, { status: "processing" });
        from = "processing";
      }
      if (from === to) return;
      if (!canTransitionPayment(from, to)) {
        throw new CoreError("INVALID_TRANSITION", `Invalid transition ${locked.status} → ${to}`);
      }
      await tx.updatePayment(
        paymentId,
        to === "succeeded" || to === "failed" || to === "unknown" || to === "expired"
          ? { status: to, next_poll_at: null }
          : { status: to },
      );
    });
  }

  private async setPaymentPending(paymentId: string): Promise<void> {
    const { store } = this.opts;
    await store.withTransaction(async (tx) => {
      const locked = await tx.lockPayment(paymentId);
      if (!locked || isPaymentFinal(locked.status)) return;
      let from = locked.status;
      if (from === "created") {
        await tx.updatePayment(paymentId, { status: "processing" });
        from = "processing";
      }
      if (from !== "pending" && !canTransitionPayment(from, "pending")) return;
      await tx.updatePayment(paymentId, {
        status: "pending",
        poll_attempts: locked.poll_attempts + 1,
        next_poll_at: computeNextPollAt(this.now().getTime(), locked.poll_attempts),
      });
    });
  }

  private async requireProviderId(code: string): Promise<string> {
    const row = await this.opts.store.findProviderByCode(code);
    if (!row) throw new CoreError("PROVIDER_ERROR", `Provider not seeded: ${code}`);
    return row.id;
  }

  private async adapterForAttempt(attempt: AttemptRow): Promise<PaymentProvider> {
    const code = await this.opts.store.findProviderCodeById(attempt.provider_id);
    const adapter = code ? this.opts.providers.get(code) : undefined;
    if (!adapter) throw new VerificationRequiredError(attempt.provider_reference ?? attempt.id);
    return adapter;
  }
}
