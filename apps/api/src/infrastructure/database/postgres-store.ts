// @payswitch/api — PaymentStore Postgres (bun:sql, spec §5.3).
// Transactions via BEGIN/COMMIT sur connexion réservée ; concurrence via
// SELECT ... FOR UPDATE (lockPayment, valide uniquement dans withTransaction).
// Montants BIGINT ↔ bigint (le driver rend string → BigInt() strict).
// Timestamps ↔ ISO strings. UNIQUE → UniqueViolationError (SQLSTATE 23505).

import { SQL } from "bun";
import type { AttemptStatus, PaymentStatus } from "@payswitch/core";
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
} from "../../engine/store.js";
import type { EngineStore } from "../../engine/payment-engine.js";

function isUniqueViolation(err: unknown): boolean {
  // bun:sql enveloppe l'erreur PG : SQLSTATE dans `errno`
  // (ex. "23505"), `code` valant "ERR_POSTGRES_SERVER_ERROR".
  // node-postgres expose SQLSTATE dans `code`. On couvre les deux.
  if (typeof err !== "object" || err === null) return false;
  const e = err as { code?: unknown; errno?: unknown };
  return e.code === "23505" || Number(e.errno) === 23505;
}

async function run<T>(sql: SQL, fn: (tx: PaymentStore) => Promise<T>): Promise<T> {
  try {
    return await fn(new PostgresStore(sql));
  } catch (err) {
    if (isUniqueViolation(err)) {
      const constraint =
        (err as { constraint?: string }).constraint ??
        (err as Error).message ??
        "unknown";
      throw new UniqueViolationError(String(constraint));
    }
    throw err;
  }
}

const asBigint = (v: unknown): bigint => BigInt(v as string | number | bigint);
const asISO = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v));
const asJSON = (v: unknown): Record<string, unknown> =>
  (v ?? {}) as Record<string, unknown>;

function mapPayment(r: Record<string, unknown>): PaymentRow {
  return {
    id: String(r.id),
    idempotency_key: String(r.idempotency_key),
    request_hash: String(r.request_hash),
    external_reference: (r.external_reference as string | null) ?? null,
    amount_minor: asBigint(r.amount_minor),
    currency: String(r.currency),
    phone: String(r.phone),
    phone_hash: String(r.phone_hash),
    phone_last4: (r.phone_last4 as string | null) ?? null,
    country_id: String(r.country_id),
    network_id: String(r.network_id),
    status: r.status as PaymentStatus,
    metadata: asJSON(r.metadata),
    correlation_id: String(r.correlation_id),
    request_id: String(r.request_id),
    expires_at: asISO(r.expires_at),
    poll_attempts: Number(r.poll_attempts),
    next_poll_at: r.next_poll_at == null ? null : asISO(r.next_poll_at),
    created_at: asISO(r.created_at),
    updated_at: asISO(r.updated_at),
  };
}

function mapAttempt(r: Record<string, unknown>): AttemptRow {
  return {
    id: String(r.id),
    payment_id: String(r.payment_id),
    provider_id: String(r.provider_id),
    attempt_number: Number(r.attempt_number),
    status: r.status as AttemptStatus,
    provider_reference: (r.provider_reference as string | null) ?? null,
    provider_idempotency_key: String(r.provider_idempotency_key),
    provider_raw_request: (r.provider_raw_request as unknown) ?? null,
    provider_raw_response: (r.provider_raw_response as unknown) ?? null,
    normalized_response: (r.normalized_response as unknown) ?? null,
    error_code: (r.error_code as string | null) ?? null,
    error_message: (r.error_message as string | null) ?? null,
    error_outcome: (r.error_outcome as AttemptRow["error_outcome"]) ?? null,
    confirmed: Boolean(r.confirmed),
    created_at: asISO(r.created_at),
    updated_at: asISO(r.updated_at),
  };
}

function mapDelivery(r: Record<string, unknown>): WebhookDeliveryRow {
  return {
    id: String(r.id),
    event_id: String(r.event_id),
    payment_id: String(r.payment_id),
    attempt_id: (r.attempt_id as string | null) ?? null,
    url: String(r.url),
    event_type: r.event_type as MerchantEventType,
    payload: asJSON(r.payload),
    signature: String(r.signature),
    status: r.status as WebhookDeliveryRow["status"],
    attempts: Number(r.attempts),
    next_retry_at: r.next_retry_at == null ? null : asISO(r.next_retry_at),
    last_response_code: (r.last_response_code as number | null) ?? null,
    last_response_body: (r.last_response_body as string | null) ?? null,
    created_at: asISO(r.created_at),
    updated_at: asISO(r.updated_at),
  };
}

export class PostgresStore implements EngineStore {
  constructor(private readonly sql: SQL) {}

  async withTransaction<T>(fn: (tx: PaymentStore) => Promise<T>): Promise<T> {
    const sql = this.sql;
    // bun:sql : transaction via BEGIN/COMMIT sur connexion réservée.
    const reserved = await sql.reserve();
    try {
      await reserved`BEGIN`;
      const store = new PostgresStore(reserved as unknown as SQL);
      try {
        const out = await run(reserved as unknown as SQL, () => fn(store));
        await reserved`COMMIT`;
        return out;
      } catch (err) {
        await reserved`ROLLBACK`;
        throw err;
      }
    } finally {
      await (reserved as unknown as { release(): Promise<void> }).release();
    }
  }

  async findCountry(code: string): Promise<CountryRow | null> {
    const rows = await this.sql`SELECT * FROM countries WHERE code = ${code}`;
    const r = rows[0] as Record<string, unknown> | undefined;
    if (!r) return null;
    return {
      id: String(r.id),
      code: String(r.code),
      name: String(r.name),
      currency_default: String(r.currency_default),
    };
  }

  async findNetwork(countryId: string, code: string): Promise<NetworkRow | null> {
    const rows = await this
      .sql`SELECT * FROM networks WHERE country_id = ${countryId} AND code = ${code}`;
    const r = rows[0] as Record<string, unknown> | undefined;
    if (!r) return null;
    return {
      id: String(r.id),
      country_id: String(r.country_id),
      code: String(r.code),
      display_name: String(r.display_name),
    };
  }

  async findProviderByCode(code: string): Promise<ProviderRow | null> {
    const rows = await this.sql`SELECT * FROM providers WHERE code = ${code}`;
    const r = rows[0] as Record<string, unknown> | undefined;
    if (!r) return null;
    return {
      id: String(r.id),
      code: String(r.code),
      display_name: String(r.display_name),
      is_enabled: Boolean(r.is_enabled),
      is_healthy: Boolean(r.is_healthy),
      capabilities: asJSON(r.capabilities),
      supports_idempotency: Boolean(r.supports_idempotency),
    };
  }

  async findProviderCodeById(id: string): Promise<string | null> {
    const rows = await this.sql`SELECT code FROM providers WHERE id = ${id}`;
    const r = rows[0] as Record<string, unknown> | undefined;
    return r ? String(r.code) : null;
  }

  async findRoute(countryId: string, networkId: string): Promise<RouteEntry[]> {
    const rows = await this.sql`
      SELECT r.provider_id, p.code AS provider_code, r.priority
        FROM routing_rules r
        JOIN providers p ON p.id = r.provider_id
       WHERE r.country_id = ${countryId} AND r.network_id = ${networkId}
       ORDER BY r.priority ASC`;
    return (rows as Record<string, unknown>[]).map((r: Record<string, unknown>) => ({
      provider_id: String((r as Record<string, unknown>).provider_id),
      provider_code: String((r as Record<string, unknown>).provider_code),
      priority: Number((r as Record<string, unknown>).priority),
    }));
  }

  async findPaymentByIdem(key: string): Promise<PaymentRow | null> {
    const rows = await this.sql`SELECT * FROM payments WHERE idempotency_key = ${key}`;
    const r = rows[0] as Record<string, unknown> | undefined;
    return r ? mapPayment(r) : null;
  }

  async findPaymentById(id: string): Promise<PaymentRow | null> {
    const rows = await this.sql`SELECT * FROM payments WHERE id = ${id}`;
    const r = rows[0] as Record<string, unknown> | undefined;
    return r ? mapPayment(r) : null;
  }

  async lockPayment(id: string): Promise<PaymentRow | null> {
    const rows = await this.sql`SELECT * FROM payments WHERE id = ${id} FOR UPDATE`;
    const r = rows[0] as Record<string, unknown> | undefined;
    return r ? mapPayment(r) : null;
  }

  async insertPayment(p: NewPayment): Promise<PaymentRow> {
    return await run(this.sql, async (s) => {
      void s;
      const rows = await this.sql`
        INSERT INTO payments (id, idempotency_key, request_hash, external_reference,
          amount_minor, currency, phone, phone_hash, phone_last4, country_id, network_id,
          metadata, correlation_id, request_id, expires_at)
        VALUES (${p.id}, ${p.idempotency_key}, ${p.request_hash}, ${p.external_reference ?? null},
          ${p.amount_minor.toString()}, ${p.currency}, ${p.phone}, ${p.phone_hash}, ${p.phone_last4},
          ${p.country_id}, ${p.network_id}, ${JSON.stringify(p.metadata)},
          ${p.correlation_id}, ${p.request_id}, ${p.expires_at})
        RETURNING *`;
      return mapPayment(rows[0] as Record<string, unknown>);
    });
  }

  async updatePayment(id: string, patch: Partial<PaymentRow>): Promise<PaymentRow> {
    const clauses: string[] = [];
    const params: unknown[] = [];
    const push = (col: string, v: unknown) => {
      params.push(v);
      clauses.push(`${col} = $${params.length}`);
    };
    if (patch.status !== undefined) push("status", patch.status);
    if (patch.next_poll_at !== undefined) push("next_poll_at", patch.next_poll_at);
    if (patch.poll_attempts !== undefined) push("poll_attempts", patch.poll_attempts);
    clauses.push("updated_at = now()");
    params.push(id);
    const rows = await this.sql.unsafe(
      `UPDATE payments SET ${clauses.join(", ")} WHERE id = $${params.length} RETURNING *`,
      params as (string | number)[],
    );
    const r = (rows as unknown[])[0] as Record<string, unknown> | undefined;
    if (!r) throw new Error(`Payment not found: ${id}`);
    return mapPayment(r);
  }

  async listAttempts(paymentId: string): Promise<AttemptRow[]> {
    const rows = await this.sql`
      SELECT * FROM payment_attempts WHERE payment_id = ${paymentId} ORDER BY attempt_number ASC`;
    return (rows as Record<string, unknown>[]).map((r: Record<string, unknown>) => mapAttempt(r));
  }

  async insertAttempt(a: {
    id: string;
    payment_id: string;
    provider_id: string;
    attempt_number: number;
    provider_idempotency_key: string;
  }): Promise<AttemptRow> {
    return await run(this.sql, async (s) => {
      void s;
      const rows = await this.sql`
        INSERT INTO payment_attempts (id, payment_id, provider_id, attempt_number, provider_idempotency_key)
        VALUES (${a.id}, ${a.payment_id}, ${a.provider_id}, ${a.attempt_number}, ${a.provider_idempotency_key})
        RETURNING *`;
      return mapAttempt(rows[0] as Record<string, unknown>);
    });
  }

  async updateAttempt(id: string, patch: Partial<AttemptRow>): Promise<AttemptRow> {
    const rows = await this.sql`
      UPDATE payment_attempts SET
        status = COALESCE(${patch.status ?? null}, status),
        provider_reference = COALESCE(${patch.provider_reference ?? null}, provider_reference),
        provider_raw_request = COALESCE(${patch.provider_raw_request === undefined ? null : JSON.stringify(patch.provider_raw_request)}::jsonb, provider_raw_request),
        provider_raw_response = COALESCE(${patch.provider_raw_response === undefined ? null : JSON.stringify(patch.provider_raw_response)}::jsonb, provider_raw_response),
        error_outcome = COALESCE(${patch.error_outcome === undefined ? null : patch.error_outcome}, error_outcome),
        confirmed = COALESCE(${patch.confirmed ?? null}, confirmed),
        updated_at = now()
      WHERE id = ${id} RETURNING *`;
    const r = rows[0] as Record<string, unknown> | undefined;
    if (!r) throw new Error(`Attempt not found: ${id}`);
    return mapAttempt(r);
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
    return await run(this.sql, async (s) => {
      void s;
      const rows = await this.sql`
        INSERT INTO webhook_events (id, provider_id, payment_id, provider_event_id,
          signature_valid, normalized_status, is_late)
        VALUES (${w.id}, ${w.provider_id}, ${w.payment_id}, ${w.provider_event_id},
          ${w.signature_valid}, ${w.normalized_status}, ${w.is_late})
        RETURNING *`;
      const r = rows[0] as Record<string, unknown>;
      return {
        id: String(r.id),
        provider_id: String(r.provider_id),
        payment_id: (r.payment_id as string | null) ?? null,
        provider_event_id: String(r.provider_event_id),
        signature_valid: Boolean(r.signature_valid),
        normalized_status: (r.normalized_status as string | null) ?? null,
        is_late: Boolean(r.is_late),
        processed_at: r.processed_at == null ? null : asISO(r.processed_at),
      };
    });
  }

  async markWebhookProcessed(id: string, at: string): Promise<void> {
    await this.sql`UPDATE webhook_events SET processed_at = ${at} WHERE id = ${id}`;
  }

  async listDuePayments(now: string, limit: number): Promise<PaymentRow[]> {
    const rows = await this.sql`
      SELECT * FROM payments
       WHERE status IN ('pending', 'processing')
         AND next_poll_at IS NOT NULL AND next_poll_at <= ${now}
       ORDER BY next_poll_at ASC LIMIT ${limit}`;
    return (rows as Record<string, unknown>[]).map((r: Record<string, unknown>) => mapPayment(r));
  }

  async listExpiredPayments(now: string, limit: number): Promise<PaymentRow[]> {
    const rows = await this.sql`
      SELECT * FROM payments
       WHERE status IN ('created', 'processing', 'pending')
         AND expires_at <= ${now}
       ORDER BY expires_at ASC LIMIT ${limit}`;
    return (rows as Record<string, unknown>[]).map((r: Record<string, unknown>) => mapPayment(r));
  }

  async findPaymentByProviderReference(reference: string): Promise<PaymentRow | null> {
    const rows = await this.sql`
      SELECT p.* FROM payments p
        JOIN payment_attempts a ON a.payment_id = p.id
       WHERE a.provider_reference = ${reference}
       ORDER BY a.attempt_number DESC LIMIT 1`;
    const r = rows[0] as Record<string, unknown> | undefined;
    return r ? mapPayment(r) : null;
  }

  async geoOf(payment: PaymentRow): Promise<{ country: string; network: string }> {
    const rows = await this.sql`
      SELECT c.code AS country, n.code AS network
        FROM payments p
        JOIN countries c ON c.id = p.country_id
        JOIN networks n ON n.id = p.network_id
       WHERE p.id = ${payment.id}`;
    const r = rows[0] as Record<string, unknown> | undefined;
    if (!r) throw new Error("Country/network reference broken");
    return { country: String(r.country), network: String(r.network) };
  }

  async replaceRoute(
    countryId: string,
    networkId: string,
    entries: { provider_id: string; priority: number }[],
  ): Promise<void> {
    await run(this.sql, async (s) => {
      void s;
      await this.sql`DELETE FROM routing_rules WHERE country_id = ${countryId} AND network_id = ${networkId}`;
      for (const e of entries) {
        await this.sql`
          INSERT INTO routing_rules (id, country_id, network_id, provider_id, priority)
          VALUES (gen_random_uuid(), ${countryId}, ${networkId}, ${e.provider_id}, ${e.priority})`;
      }
    });
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
    return await run(this.sql, async (s) => {
      void s;
      const rows = await this.sql`
        INSERT INTO audit_logs (id, action, actor, resource_type, resource_id,
          old_value, new_value, ip, request_id)
        VALUES (${a.id}, ${a.action}, ${a.actor}, ${a.resource_type}, ${a.resource_id ?? null},
          ${JSON.stringify(a.old_value ?? null)}, ${JSON.stringify(a.new_value ?? null)},
          ${a.ip ?? null}, ${a.request_id ?? null})
        RETURNING *`;
      const r = rows[0] as Record<string, unknown>;
      return {
        id: String(r.id),
        action: String(r.action),
        actor: String(r.actor),
        resource_type: String(r.resource_type),
        resource_id: (r.resource_id as string | null) ?? null,
        old_value: r.old_value,
        new_value: r.new_value,
        ip: (r.ip as string | null) ?? null,
        request_id: (r.request_id as string | null) ?? null,
        created_at: asISO(r.created_at),
      };
    });
  }

  async insertWebhookDelivery(d: {
    id: string;
    event_id: string;
    payment_id: string;
    attempt_id?: string | null;
    url: string;
    event_type: MerchantEventType;
    payload: Record<string, unknown>;
    signature: string;
    next_retry_at: string | null;
  }): Promise<WebhookDeliveryRow> {
    return await run(this.sql, async (s) => {
      void s;
      const rows = await this.sql`
        INSERT INTO webhook_deliveries (id, event_id, payment_id, attempt_id, url,
          event_type, payload, signature, next_retry_at)
        VALUES (${d.id}, ${d.event_id}, ${d.payment_id}, ${d.attempt_id ?? null}, ${d.url},
          ${d.event_type}, ${JSON.stringify(d.payload)}, ${d.signature}, ${d.next_retry_at})
        RETURNING *`;
      return mapDelivery(rows[0] as Record<string, unknown>);
    });
  }

  async listDueWebhookDeliveries(now: string, limit: number): Promise<WebhookDeliveryRow[]> {
    const rows = await this.sql`
      SELECT * FROM webhook_deliveries
       WHERE status IN ('pending', 'retrying')
         AND next_retry_at IS NOT NULL AND next_retry_at <= ${now}
       ORDER BY next_retry_at ASC LIMIT ${limit}`;
    return (rows as Record<string, unknown>[]).map((r: Record<string, unknown>) => mapDelivery(r));
  }

  async updateWebhookDelivery(id: string, patch: Partial<WebhookDeliveryRow>): Promise<WebhookDeliveryRow> {
    const rows = await this.sql`
      UPDATE webhook_deliveries SET
        status = COALESCE(${patch.status ?? null}, status),
        attempts = COALESCE(${patch.attempts ?? null}, attempts),
        next_retry_at = COALESCE(${patch.next_retry_at === undefined ? null : patch.next_retry_at}, next_retry_at),
        last_response_code = COALESCE(${patch.last_response_code ?? null}, last_response_code),
        last_response_body = COALESCE(${patch.last_response_body ?? null}, last_response_body),
        updated_at = now()
      WHERE id = ${id} RETURNING *`;
    const r = rows[0] as Record<string, unknown> | undefined;
    if (!r) throw new Error(`Delivery not found: ${id}`);
    // next_retry_at = NULL explicite (livré/échoué) : COALESCE ci-dessus garde
    // l'ancienne valeur — on force NULL quand demandé.
    if (patch.next_retry_at === null && r.next_retry_at !== null) {
      const cleared = await this.sql`
        UPDATE webhook_deliveries SET next_retry_at = NULL, updated_at = now()
        WHERE id = ${id} RETURNING *`;
      return mapDelivery(cleared[0] as Record<string, unknown>);
    }
    return mapDelivery(r);
  }
}
