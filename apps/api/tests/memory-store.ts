// @payswitch/api tests — MemoryStore : PaymentStore in-memory (tests uniquement).
// Transactions sérialisées (chaîne de promesses) : même garantie que
// SELECT FOR UPDATE côté PG — un seul changement d'état par événement.

import {
  UniqueViolationError,
  type AttemptRow,
  type AuditLogRow,
  type CountryRow,
  type MerchantEventType,
  type NetworkRow,
  type NewPayment,
  type PaymentRow,
  type PaymentStore,
  type ProviderRow,
  type RouteEntry,
  type WebhookDeliveryRow,
  type WebhookRow,
} from "../src/engine/store.js";
import type { EngineStore } from "../src/engine/payment-engine.js";

const nowISO = () => new Date().toISOString();

export class MemoryStore implements EngineStore {
  countries = new Map<string, CountryRow>();
  networks = new Map<string, NetworkRow>(); // `${countryId}:${code}`
  providersByCode = new Map<string, ProviderRow>();
  providersById = new Map<string, ProviderRow>();
  routes = new Map<string, RouteEntry[]>(); // `${countryId}:${networkId}`
  payments = new Map<string, PaymentRow>();
  paymentsByIdem = new Map<string, PaymentRow>();
  attempts = new Map<string, AttemptRow[]>(); // paymentId
  webhooks = new Map<string, WebhookRow>(); // `${providerId}:${eventId}`
  geo = new Map<string, { country: string; network: string }>(); // paymentId
  audits: AuditLogRow[] = [];
  deliveries = new Map<string, WebhookDeliveryRow>(); // id
  deliveriesByEvent = new Map<string, WebhookDeliveryRow>(); // event_id
  private queue: Promise<unknown> = Promise.resolve();

  async withTransaction<T>(fn: (tx: PaymentStore) => Promise<T>): Promise<T> {
    const run = this.queue.then(() => fn(this));
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async findCountry(code: string): Promise<CountryRow | null> {
    return [...this.countries.values()].find((c) => c.code === code) ?? null;
  }

  async findNetwork(countryId: string, code: string): Promise<NetworkRow | null> {
    return this.networks.get(`${countryId}:${code}`) ?? null;
  }

  async findProviderByCode(code: string): Promise<ProviderRow | null> {
    return this.providersByCode.get(code) ?? null;
  }

  async findProviderCodeById(id: string): Promise<string | null> {
    return this.providersById.get(id)?.code ?? null;
  }

  async findRoute(countryId: string, networkId: string): Promise<RouteEntry[]> {
    return [...(this.routes.get(`${countryId}:${networkId}`) ?? [])].sort(
      (a, b) => a.priority - b.priority,
    );
  }

  async findPaymentByIdem(key: string): Promise<PaymentRow | null> {
    return this.paymentsByIdem.get(key) ?? null;
  }

  async findPaymentById(id: string): Promise<PaymentRow | null> {
    return this.payments.get(id) ?? null;
  }

  async lockPayment(id: string): Promise<PaymentRow | null> {
    return this.findPaymentById(id);
  }

  async insertPayment(p: NewPayment): Promise<PaymentRow> {
    if (this.paymentsByIdem.has(p.idempotency_key)) {
      throw new UniqueViolationError("payments_idempotency_key_key");
    }
    const row: PaymentRow = {
      ...p,
      external_reference: p.external_reference ?? null,
      status: "created",
      metadata: p.metadata,
      poll_attempts: 0,
      next_poll_at: null,
      created_at: nowISO(),
      updated_at: nowISO(),
    };
    this.payments.set(row.id, row);
    this.paymentsByIdem.set(row.idempotency_key, row);
    return { ...row };
  }

  async updatePayment(id: string, patch: Partial<PaymentRow>): Promise<PaymentRow> {
    const row = this.payments.get(id);
    if (!row) throw new Error(`Payment not found: ${id}`);
    Object.assign(row, patch, { updated_at: nowISO() });
    return { ...row };
  }

  async listAttempts(paymentId: string): Promise<AttemptRow[]> {
    return (this.attempts.get(paymentId) ?? []).map((a) => ({ ...a }));
  }

  async insertAttempt(a: {
    id: string;
    payment_id: string;
    provider_id: string;
    attempt_number: number;
    provider_idempotency_key: string;
  }): Promise<AttemptRow> {
    const list = this.attempts.get(a.payment_id) ?? [];
    if (list.some((x) => x.attempt_number === a.attempt_number)) {
      throw new UniqueViolationError("uq_attempt_number");
    }
    const row: AttemptRow = {
      ...a,
      status: "created",
      provider_reference: null,
      provider_raw_request: null,
      provider_raw_response: null,
      normalized_response: null,
      error_code: null,
      error_message: null,
      error_outcome: null,
      confirmed: false,
      created_at: nowISO(),
      updated_at: nowISO(),
    };
    list.push(row);
    this.attempts.set(a.payment_id, list);
    return { ...row };
  }

  async updateAttempt(id: string, patch: Partial<AttemptRow>): Promise<AttemptRow> {
    for (const list of this.attempts.values()) {
      const row = list.find((a) => a.id === id);
      if (row) {
        Object.assign(row, patch, { updated_at: nowISO() });
        return { ...row };
      }
    }
    throw new Error(`Attempt not found: ${id}`);
  }

  async insertWebhookEvent(w: {
    id: string;
    provider_id: string;
    payment_id: string | null;
    provider_event_id: string;
    signature_valid: boolean;
    normalized_status: string | null;
    is_late: boolean;
  }): Promise<WebhookRow> {
    const key = `${w.provider_id}:${w.provider_event_id}`;
    if (this.webhooks.has(key)) {
      throw new UniqueViolationError("uq_webhook_provider_event");
    }
    const row: WebhookRow = { ...w, processed_at: null };
    this.webhooks.set(key, row);
    return { ...row };
  }

  async markWebhookProcessed(id: string, at: string): Promise<void> {
    for (const row of this.webhooks.values()) {
      if (row.id === id) {
        row.processed_at = at;
        return;
      }
    }
  }

  async listDuePayments(now: string, limit: number): Promise<PaymentRow[]> {
    return [...this.payments.values()]
      .filter(
        (p) =>
          (p.status === "pending" || p.status === "processing") &&
          p.next_poll_at !== null &&
          p.next_poll_at <= now,
      )
      .sort((a, b) => (a.next_poll_at! <= b.next_poll_at! ? -1 : 1))
      .slice(0, limit)
      .map((p) => ({ ...p }));
  }

  async listExpiredPayments(now: string, limit: number): Promise<PaymentRow[]> {
    return [...this.payments.values()]
      .filter(
        (p) =>
          (p.status === "created" || p.status === "processing" || p.status === "pending") &&
          p.expires_at <= now,
      )
      .sort((a, b) => (a.expires_at <= b.expires_at ? -1 : 1))
      .slice(0, limit)
      .map((p) => ({ ...p }));
  }

  async findPaymentByProviderReference(reference: string): Promise<PaymentRow | null> {
    let best: AttemptRow | null = null;
    for (const list of this.attempts.values()) {
      for (const a of list) {
        if (a.provider_reference === reference && (!best || a.attempt_number > best.attempt_number)) {
          best = a;
        }
      }
    }
    if (!best) return null;
    return this.findPaymentById(best.payment_id);
  }

  async geoOf(payment: PaymentRow): Promise<{ country: string; network: string }> {
    const geo = this.geo.get(payment.id);
    if (geo) return geo;
    // Repli : résout via les maps pays/réseaux (miroir du JOIN PG).
    const country = this.countries.get(payment.country_id);
    const network = [...this.networks.values()].find((n) => n.id === payment.network_id);
    if (!country || !network) throw new Error("Country/network reference broken");
    return { country: country.code, network: network.code };
  }

  async replaceRoute(
    countryId: string,
    networkId: string,
    entries: { provider_id: string; priority: number }[],
  ): Promise<void> {
    const key = `${countryId}:${networkId}`;
    const prios = entries.map((e) => e.priority);
    if (new Set(prios).size !== prios.length) {
      throw new UniqueViolationError("uq_routing_priority");
    }
    const ids = entries.map((e) => e.provider_id);
    if (new Set(ids).size !== ids.length) {
      throw new UniqueViolationError("uq_routing_triplet");
    }
    this.routes.set(
      key,
      entries.map((e) => ({
        provider_id: e.provider_id,
        provider_code: this.providersById.get(e.provider_id)?.code ?? e.provider_id,
        priority: e.priority,
      })),
    );
  }

  async insertAuditLog(a: {
    id: string;
    action: string;
    actor: string;
    resource_type: string;
    resource_id?: string | null;
    old_value?: unknown;
    new_value?: unknown;
    ip?: string | null;
    request_id?: string | null;
  }): Promise<AuditLogRow> {
    const row: AuditLogRow = {
      id: a.id,
      action: a.action,
      actor: a.actor,
      resource_type: a.resource_type,
      resource_id: a.resource_id ?? null,
      old_value: a.old_value ?? null,
      new_value: a.new_value ?? null,
      ip: a.ip ?? null,
      request_id: a.request_id ?? null,
      created_at: nowISO(),
    };
    this.audits.push(row);
    return { ...row };
  }

  async insertWebhookDelivery(d: {
    id: string;
    event_id: string;
    subscription_id?: string | null;
    payment_id: string | null;
    attempt_id?: string | null;
    url: string;
    event_type: MerchantEventType;
    payload: Record<string, unknown>;
    signature: string;
    next_retry_at: string | null;
  }): Promise<WebhookDeliveryRow> {
    if (this.deliveriesByEvent.has(d.event_id)) {
      throw new UniqueViolationError("uq_delivery_event_id");
    }
    const row: WebhookDeliveryRow = {
      id: d.id,
      event_id: d.event_id,
      subscription_id: d.subscription_id ?? null,
      payment_id: d.payment_id,
      attempt_id: d.attempt_id ?? null,
      url: d.url,
      event_type: d.event_type,
      payload: d.payload,
      signature: d.signature,
      status: "pending",
      attempts: 0,
      next_retry_at: d.next_retry_at,
      last_response_code: null,
      last_response_body: null,
      created_at: nowISO(),
      updated_at: nowISO(),
    };
    this.deliveries.set(row.id, row);
    this.deliveriesByEvent.set(row.event_id, row);
    return { ...row };
  }

  async listDueWebhookDeliveries(now: string, limit: number): Promise<WebhookDeliveryRow[]> {
    return [...this.deliveries.values()]
      .filter(
        (d) =>
          (d.status === "pending" || d.status === "retrying") &&
          d.next_retry_at !== null &&
          d.next_retry_at <= now,
      )
      .sort((a, b) => (a.next_retry_at! <= b.next_retry_at! ? -1 : 1))
      .slice(0, limit)
      .map((d) => ({ ...d }));
  }

  async updateWebhookDelivery(id: string, patch: Partial<WebhookDeliveryRow>): Promise<WebhookDeliveryRow> {
    const row = this.deliveries.get(id);
    if (!row) throw new Error(`Delivery not found: ${id}`);
    Object.assign(row, patch, { updated_at: nowISO() });
    return { ...row };
  }
}

/** Seed mémoire minimal : CD-AIRTEL → [mockprimary, mocksecondary] (spec §13). */
export function seedMemory(store: MemoryStore): void {
  store.countries.set("c-cd", { id: "c-cd", code: "CD", name: "RDC", currency_default: "CDF" });
  store.networks.set("c-cd:AIRTEL", {
    id: "n-cd-airtel",
    country_id: "c-cd",
    code: "AIRTEL",
    display_name: "Airtel RDC",
  });
  for (const code of ["mockprimary", "mocksecondary"]) {
    const row: ProviderRow = {
      id: `p-${code}`,
      code,
      display_name: code,
      is_enabled: true,
      is_healthy: true,
      capabilities: {},
      supports_idempotency: true,
    };
    store.providersByCode.set(code, row);
    store.providersById.set(row.id, row);
  }
  store.routes.set("c-cd:n-cd-airtel", [
    { provider_id: "p-mockprimary", provider_code: "mockprimary", priority: 1 },
    { provider_id: "p-mocksecondary", provider_code: "mocksecondary", priority: 2 },
  ]);
}

/** Attache le geo d'un paiement créé (le moteur le résout via geoOf). */
export function geoOfCD(): { country: string; network: string } {
  return { country: "CD", network: "AIRTEL" };
}
