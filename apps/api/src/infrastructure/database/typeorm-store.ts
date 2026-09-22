// @payswitch/api — PaymentStore/EngineStore sur TypeORM (PostgreSQL, spec §5.3).
// Remplace l'ancien PostgresStore (bun:sql, supprimé). Transactions via
// DataSource.transaction ; concurrence via SELECT ... FOR UPDATE
// (lockPayment, valide uniquement dans withTransaction). Montants BIGINT ↔
// bigint (transformer d'entité). UNIQUE → UniqueViolationError (SQLSTATE 23505).

import { Injectable } from "@nestjs/common";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource, EntityManager, QueryFailedError } from "typeorm";
import type { AttemptStatus, PaymentStatus } from "@payswitch/core";
import { uuidv7 } from "../../common/ids";
import type { EngineStore } from "../../engine/payment-engine";
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
} from "../../engine/store";
import {
  ApiKeyEntity,
  AuditLogEntity,
  CountryEntity,
  NetworkEntity,
  PaymentAttemptEntity,
  PaymentEntity,
  ProviderEntity,
  RoutingRuleEntity,
  WebhookDeliveryEntity,
  WebhookEventEntity,
} from "./entities";

const iso = (d: Date | string): string => (d instanceof Date ? d.toISOString() : String(d));
const toDate = (s: string): Date => new Date(s);

function mapPayment(e: PaymentEntity): PaymentRow {
  return {
    id: e.id,
    idempotency_key: e.idempotency_key,
    request_hash: e.request_hash,
    external_reference: e.external_reference,
    amount_minor: e.amount_minor,
    currency: e.currency,
    phone: e.phone,
    phone_hash: e.phone_hash,
    phone_last4: e.phone_last4,
    country_id: e.country_id,
    network_id: e.network_id,
    status: e.status as PaymentStatus,
    metadata: e.metadata ?? {},
    correlation_id: e.correlation_id,
    request_id: e.request_id,
    expires_at: iso(e.expires_at),
    poll_attempts: e.poll_attempts,
    next_poll_at: e.next_poll_at ? iso(e.next_poll_at) : null,
    created_at: iso(e.created_at),
    updated_at: iso(e.updated_at),
  };
}

function mapAttempt(e: PaymentAttemptEntity): AttemptRow {
  return {
    id: e.id,
    payment_id: e.payment_id,
    provider_id: e.provider_id,
    attempt_number: e.attempt_number,
    status: e.status as AttemptStatus,
    provider_reference: e.provider_reference,
    provider_idempotency_key: e.provider_idempotency_key,
    provider_raw_request: e.provider_raw_request ?? null,
    provider_raw_response: e.provider_raw_response ?? null,
    normalized_response: e.normalized_response ?? null,
    error_code: e.error_code,
    error_message: e.error_message,
    error_outcome: (e.error_outcome ?? null) as AttemptRow["error_outcome"],
    confirmed: e.confirmed,
    created_at: iso(e.created_at),
    updated_at: iso(e.updated_at),
  };
}

function asUniqueViolation(err: unknown): never {
  if (err instanceof QueryFailedError) {
    const driver = err.driverError as { code?: string; constraint?: string; detail?: string };
    if (driver?.code === "23505") {
      throw new UniqueViolationError(driver.constraint ?? driver.detail ?? "unique");
    }
  }
  throw err;
}

@Injectable()
export class TypeOrmStore implements EngineStore {
  private readonly em: EntityManager;
  private readonly ds: DataSource | null;

  private constructor(ds: DataSource | null, em: EntityManager) {
    this.ds = ds;
    this.em = em;
  }

  /** Racine : un seul param DI explicite (jamais de 2e param injecté). */
  static forRoot(@InjectDataSource() dataSource: DataSource): TypeOrmStore {
    return new TypeOrmStore(dataSource, dataSource.manager);
  }

  /** Copie liée à un manager transactionnel — jamais via DI. */
  private forManager(manager: EntityManager): TypeOrmStore {
    return new TypeOrmStore(null, manager);
  }

  async withTransaction<T>(fn: (tx: PaymentStore) => Promise<T>): Promise<T> {
    if (!this.ds) return fn(this);
    // QueryRunner explicite : le manager lié porte la transaction ouverte
    // (SELECT ... FOR UPDATE l'exige, spec §5.3).
    const runner = this.ds.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
    try {
      const out = await fn(this.forManager(runner.manager));
      await runner.commitTransaction();
      return out;
    } catch (err) {
      try {
        await runner.rollbackTransaction();
      } catch {
        // L'erreur d'origine prime sur l'échec du rollback.
      }
      asUniqueViolation(err);
    } finally {
      await runner.release();
    }
    throw new Error("unreachable");
  }

  async findCountry(code: string): Promise<CountryRow | null> {
    const e = await this.em.findOneBy(CountryEntity, { code });
    return e ? { id: e.id, code: e.code, name: e.name, currency_default: e.currency_default } : null;
  }

  async findNetwork(countryId: string, code: string): Promise<NetworkRow | null> {
    const e = await this.em.findOneBy(NetworkEntity, { country_id: countryId, code });
    return e ? { id: e.id, country_id: e.country_id, code: e.code, display_name: e.display_name } : null;
  }

  async findCountryById(id: string): Promise<CountryRow | null> {
    const e = await this.em.findOneBy(CountryEntity, { id });
    return e ? { id: e.id, code: e.code, name: e.name, currency_default: e.currency_default } : null;
  }

  async listCountries(): Promise<CountryRow[]> {
    const rows = await this.em.find(CountryEntity, { order: { code: "ASC" } });
    return rows.map((e) => ({ id: e.id, code: e.code, name: e.name, currency_default: e.currency_default }));
  }

  async findNetworkById(id: string): Promise<NetworkRow | null> {
    const e = await this.em.findOneBy(NetworkEntity, { id });
    return e ? { id: e.id, country_id: e.country_id, code: e.code, display_name: e.display_name } : null;
  }

  async listNetworks(countryCode?: string): Promise<(NetworkRow & { country: string })[]> {
    const qb = this.em
      .createQueryBuilder(NetworkEntity, "n")
      .innerJoin(CountryEntity, "c", "c.id = n.country_id")
      .select(["n.id AS id", "n.country_id AS country_id", "n.code AS code", "n.display_name AS display_name", "c.code AS country"])
      .orderBy("c.code", "ASC")
      .addOrderBy("n.code", "ASC");
    if (countryCode) qb.andWhere("c.code = :countryCode", { countryCode });
    const rows = await qb.getRawMany<{ id: string; country_id: string; code: string; display_name: string; country: string }>();
    return rows.map((r) => ({ id: String(r.id), country_id: String(r.country_id), code: String(r.code), display_name: String(r.display_name), country: String(r.country) }));
  }

  /** Matrice Pays×Réseau → providers ordonnés (dashboard routing, US-06). */
  async routingMatrix(): Promise<{ country: string; network: string; providers: string[] }[]> {
    const rows = await this.em.query(
      `SELECT c.code AS country, n.code AS network, p.code AS provider, r.priority AS priority
         FROM routing_rules r
         JOIN countries c ON c.id = r.country_id
         JOIN networks n ON n.id = r.network_id
         JOIN providers p ON p.id = r.provider_id
        ORDER BY c.code, n.code, r.priority`,
    );
    const matrix = new Map<string, { country: string; network: string; providers: string[] }>();
    for (const r of rows as { country: string; network: string; provider: string }[]) {
      const key = `${r.country}:${r.network}`;
      const entry = matrix.get(key) ?? { country: String(r.country), network: String(r.network), providers: [] };
      entry.providers.push(String(r.provider));
      matrix.set(key, entry);
    }
    return [...matrix.values()];
  }

  async findProviderByCode(code: string): Promise<ProviderRow | null> {
    const e = await this.em.findOneBy(ProviderEntity, { code });
    return e
      ? {
          id: e.id,
          code: e.code,
          display_name: e.display_name,
          is_enabled: e.is_enabled,
          is_healthy: e.is_healthy,
          capabilities: e.capabilities ?? {},
          supports_idempotency: e.supports_idempotency,
        }
      : null;
  }

  async findProviderCodeById(id: string): Promise<string | null> {
    const e = await this.em.findOneBy(ProviderEntity, { id });
    return e ? e.code : null;
  }

  async findRoute(countryId: string, networkId: string): Promise<RouteEntry[]> {
    const rows = await this.em
      .createQueryBuilder(RoutingRuleEntity, "r")
      .innerJoin(ProviderEntity, "p", "p.id = r.provider_id")
      .select(["r.provider_id AS provider_id", "p.code AS provider_code", "r.priority AS priority"])
      .where("r.country_id = :countryId", { countryId })
      .andWhere("r.network_id = :networkId", { networkId })
      .orderBy("r.priority", "ASC")
      .getRawMany<{ provider_id: string; provider_code: string; priority: number }>();
    return rows.map((r) => ({
      provider_id: String(r.provider_id),
      provider_code: String(r.provider_code),
      priority: Number(r.priority),
    }));
  }

  async findPaymentByIdem(key: string): Promise<PaymentRow | null> {
    const e = await this.em.findOneBy(PaymentEntity, { idempotency_key: key });
    return e ? mapPayment(e) : null;
  }

  async findPaymentById(id: string): Promise<PaymentRow | null> {
    const e = await this.em.findOneBy(PaymentEntity, { id });
    return e ? mapPayment(e) : null;
  }

  async lockPayment(id: string): Promise<PaymentRow | null> {
    const e = await this.em.findOne(PaymentEntity, {
      where: { id },
      lock: { mode: "pessimistic_write" },
    });
    return e ? mapPayment(e) : null;
  }

  async insertPayment(p: NewPayment): Promise<PaymentRow> {
    try {
      const e = this.em.create(PaymentEntity, {
        id: p.id,
        idempotency_key: p.idempotency_key,
        request_hash: p.request_hash,
        external_reference: p.external_reference ?? null,
        amount_minor: p.amount_minor,
        currency: p.currency,
        phone: p.phone,
        phone_hash: p.phone_hash,
        phone_last4: p.phone_last4,
        country_id: p.country_id,
        network_id: p.network_id,
        metadata: p.metadata,
        correlation_id: p.correlation_id,
        request_id: p.request_id,
        expires_at: toDate(p.expires_at),
      });
      return mapPayment(await this.em.save(e));
    } catch (err) {
      asUniqueViolation(err);
    }
  }

  async updatePayment(id: string, patch: Partial<PaymentRow>): Promise<PaymentRow> {
    const repo = this.em.getRepository(PaymentEntity);
    const e = await repo.findOneBy({ id });
    if (!e) throw new Error(`Payment not found: ${id}`);
    if (patch.status !== undefined) e.status = patch.status;
    if (patch.next_poll_at !== undefined) {
      e.next_poll_at = patch.next_poll_at ? toDate(patch.next_poll_at) : null;
    }
    if (patch.poll_attempts !== undefined) e.poll_attempts = patch.poll_attempts;
    e.updated_at = new Date();
    return mapPayment(await repo.save(e));
  }

  async listAttempts(paymentId: string): Promise<AttemptRow[]> {
    const rows = await this.em.find(PaymentAttemptEntity, {
      where: { payment_id: paymentId },
      order: { attempt_number: "ASC" },
    });
    return rows.map(mapAttempt);
  }

  async insertAttempt(a: {
    id: string;
    payment_id: string;
    provider_id: string;
    attempt_number: number;
    provider_idempotency_key: string;
  }): Promise<AttemptRow> {
    try {
      const e = this.em.create(PaymentAttemptEntity, { ...a });
      return mapAttempt(await this.em.save(e));
    } catch (err) {
      asUniqueViolation(err);
    }
  }

  async updateAttempt(id: string, patch: Partial<AttemptRow>): Promise<AttemptRow> {
    const repo = this.em.getRepository(PaymentAttemptEntity);
    const e = await repo.findOneBy({ id });
    if (!e) throw new Error(`Attempt not found: ${id}`);
    if (patch.status !== undefined) e.status = patch.status;
    if (patch.provider_reference !== undefined) e.provider_reference = patch.provider_reference;
    if (patch.provider_raw_request !== undefined) e.provider_raw_request = patch.provider_raw_request;
    if (patch.provider_raw_response !== undefined) e.provider_raw_response = patch.provider_raw_response;
    if (patch.error_outcome !== undefined) e.error_outcome = patch.error_outcome;
    if (patch.confirmed !== undefined) e.confirmed = patch.confirmed;
    e.updated_at = new Date();
    return mapAttempt(await repo.save(e));
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
    try {
      const e = this.em.create(WebhookEventEntity, { ...w });
      const saved = await this.em.save(e);
      return {
        id: saved.id,
        provider_id: saved.provider_id,
        payment_id: saved.payment_id,
        provider_event_id: saved.provider_event_id,
        signature_valid: saved.signature_valid,
        normalized_status: saved.normalized_status,
        is_late: saved.is_late,
        processed_at: saved.processed_at ? iso(saved.processed_at) : null,
      };
    } catch (err) {
      asUniqueViolation(err);
    }
  }

  async markWebhookProcessed(id: string, at: string): Promise<void> {
    await this.em.update(WebhookEventEntity, { id }, { processed_at: toDate(at) });
  }

  async listDuePayments(now: string, limit: number): Promise<PaymentRow[]> {
    const rows = await this.em
      .createQueryBuilder(PaymentEntity, "p")
      .where("p.status IN (:...s)", { s: ["pending", "processing"] })
      .andWhere("p.next_poll_at IS NOT NULL")
      .andWhere("p.next_poll_at <= :now", { now: toDate(now) })
      .orderBy("p.next_poll_at", "ASC")
      .limit(limit)
      .getMany();
    return rows.map(mapPayment);
  }

  async listExpiredPayments(now: string, limit: number): Promise<PaymentRow[]> {
    const rows = await this.em
      .createQueryBuilder(PaymentEntity, "p")
      .where("p.status IN (:...s)", { s: ["created", "processing", "pending"] })
      .andWhere("p.expires_at <= :now", { now: toDate(now) })
      .orderBy("p.expires_at", "ASC")
      .limit(limit)
      .getMany();
    return rows.map(mapPayment);
  }

  async findPaymentByProviderReference(reference: string): Promise<PaymentRow | null> {
    const attempt = await this.em.findOne(PaymentAttemptEntity, {
      where: { provider_reference: reference },
      order: { attempt_number: "DESC" },
    });
    if (!attempt) return null;
    return this.findPaymentById(attempt.payment_id);
  }

  async geoOf(payment: PaymentRow): Promise<{ country: string; network: string }> {
    const row = await this.em
      .createQueryBuilder(PaymentEntity, "p")
      .innerJoin(CountryEntity, "c", "c.id = p.country_id")
      .innerJoin(NetworkEntity, "n", "n.id = p.network_id")
      .select(["c.code AS country", "n.code AS network"])
      .where("p.id = :id", { id: payment.id })
      .getRawOne<{ country: string; network: string }>();
    if (!row) throw new Error("Country/network reference broken");
    return { country: String(row.country), network: String(row.network) };
  }

  async replaceRoute(
    countryId: string,
    networkId: string,
    entries: { provider_id: string; priority: number }[],
  ): Promise<void> {
    try {
      await this.em.delete(RoutingRuleEntity, { country_id: countryId, network_id: networkId });
      for (const e of entries) {
        await this.em.save(
          this.em.create(RoutingRuleEntity, {
            id: uuidv7(),
            country_id: countryId,
            network_id: networkId,
            provider_id: e.provider_id,
            priority: e.priority,
          }),
        );
      }
    } catch (err) {
      asUniqueViolation(err);
    }
  }

  async insertAuditLog(a: {
    id: string;
    action: string;
    actor: string;
    resource_type: string | null;
    resource_id?: string | null;
    old_value?: unknown;
    new_value?: unknown;
    ip?: string | null;
    request_id?: string | null;
  }): Promise<AuditLogRow> {
    const e = this.em.create(AuditLogEntity, {
      id: a.id,
      action: a.action,
      actor: a.actor,
      resource_type: a.resource_type,
      resource_id: a.resource_id ?? null,
      old_value: (a.old_value ?? null) as AuditLogEntity["old_value"],
      new_value: (a.new_value ?? null) as AuditLogEntity["new_value"],
      ip: a.ip ?? null,
      request_id: a.request_id ?? null,
    });
    const saved = await this.em.save(e);
    return {
      id: saved.id,
      action: saved.action,
      actor: saved.actor,
      resource_type: saved.resource_type,
      resource_id: saved.resource_id,
      old_value: saved.old_value,
      new_value: saved.new_value,
      ip: saved.ip,
      request_id: saved.request_id,
      created_at: iso(saved.created_at),
    };
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
    try {
      const e = this.em.create(WebhookDeliveryEntity, {
        id: d.id,
        event_id: d.event_id,
        subscription_id: d.subscription_id ?? null,
        payment_id: d.payment_id ?? null,
        attempt_id: d.attempt_id ?? null,
        url: d.url,
        event_type: d.event_type,
        payload: d.payload,
        signature: d.signature,
        next_retry_at: d.next_retry_at ? toDate(d.next_retry_at) : null,
      });
      return mapDelivery(await this.em.save(e));
    } catch (err) {
      asUniqueViolation(err);
    }
  }

  async listDueWebhookDeliveries(now: string, limit: number): Promise<WebhookDeliveryRow[]> {
    const rows = await this.em
      .createQueryBuilder(WebhookDeliveryEntity, "d")
      .where("d.status IN (:...s)", { s: ["pending", "retrying"] })
      .andWhere("d.next_retry_at IS NOT NULL")
      .andWhere("d.next_retry_at <= :now", { now: toDate(now) })
      .orderBy("d.next_retry_at", "ASC")
      .limit(limit)
      .getMany();
    return rows.map(mapDelivery);
  }

  async updateWebhookDelivery(id: string, patch: Partial<WebhookDeliveryRow>): Promise<WebhookDeliveryRow> {
    const repo = this.em.getRepository(WebhookDeliveryEntity);
    const e = await repo.findOneBy({ id });
    if (!e) throw new Error(`Delivery not found: ${id}`);
    if (patch.status !== undefined) e.status = patch.status;
    if (patch.attempts !== undefined) e.attempts = patch.attempts;
    // NULL explicite (livré/échoué définitif) doit écraser, pas COALESCE.
    if (patch.next_retry_at !== undefined) {
      e.next_retry_at = patch.next_retry_at ? toDate(patch.next_retry_at) : null;
    }
    if (patch.last_response_code !== undefined) e.last_response_code = patch.last_response_code;
    if (patch.last_response_body !== undefined) e.last_response_body = patch.last_response_body;
    e.updated_at = new Date();
    return mapDelivery(await repo.save(e));
  }

  // ---- Lectures utilitaires (dashboard / admin, hors ports moteur) ----

  async listApiKeys(): Promise<ApiKeyEntity[]> {
    return this.em.find(ApiKeyEntity, { order: { created_at: "DESC" } });
  }

  async insertApiKey(a: {
    id: string;
    name: string;
    key_hash: string;
    prefix: string;
    scopes: string[];
  }): Promise<ApiKeyEntity> {
    const e = this.em.create(ApiKeyEntity, { ...a });
    return this.em.save(e);
  }

  /** Révocation immédiate : revoked_at = now() (spec §5.1). */
  async revokeApiKey(id: string): Promise<void> {
    await this.em.update(ApiKeyEntity, { id }, { revoked_at: new Date() });
  }

  async touchApiKey(id: string): Promise<void> {
    await this.em.update(ApiKeyEntity, { id }, { last_used_at: new Date() });
  }

  async findApiKeyByPrefix(prefix: string): Promise<ApiKeyEntity[]> {
    return this.em.find(ApiKeyEntity, { where: { prefix } });
  }

  async listDeliveries(limit: number): Promise<WebhookDeliveryRow[]> {
    const rows = await this.em.find(WebhookDeliveryEntity, {
      order: { created_at: "DESC" },
      take: limit,
    });
    return rows.map(mapDelivery);
  }

  async findDeliveryById(id: string): Promise<WebhookDeliveryRow | null> {
    const e = await this.em.findOneBy(WebhookDeliveryEntity, { id });
    return e ? mapDelivery(e) : null;
  }

  async listAuditLogs(limit: number): Promise<AuditLogRow[]> {
    const rows = await this.em.find(AuditLogEntity, {
      order: { created_at: "DESC" },
      take: limit,
    });
    return rows.map((e) => ({
      id: e.id,
      action: e.action,
      actor: e.actor,
      resource_type: e.resource_type,
      resource_id: e.resource_id,
      old_value: e.old_value,
      new_value: e.new_value,
      ip: e.ip,
      request_id: e.request_id,
      created_at: iso(e.created_at),
    }));
  }

  async listPaymentsByFilter(f: {
    status?: string;
    country?: string;
    network?: string;
    providerCode?: string;
    phoneHash?: string;
    externalReference?: string;
    from?: Date;
    to?: Date;
    page: number;
    perPage: number;
  }): Promise<{ rows: PaymentRow[]; total: number }> {
    const qb = this.em.createQueryBuilder(PaymentEntity, "p");
    if (f.status) qb.andWhere("p.status = :status", { status: f.status });
    if (f.country) {
      qb.innerJoin(CountryEntity, "c", "c.id = p.country_id").andWhere("c.code = :country", { country: f.country });
    }
    if (f.network) {
      qb.innerJoin(NetworkEntity, "n", "n.id = p.network_id").andWhere("n.code = :network", { network: f.network });
    }
    if (f.providerCode) {
      qb.andWhere(
        `EXISTS (SELECT 1 FROM payment_attempts a JOIN providers pr ON pr.id = a.provider_id
          WHERE a.payment_id = p.id AND pr.code = :providerCode)`,
        { providerCode: f.providerCode },
      );
    }
    if (f.phoneHash) qb.andWhere("p.phone_hash = :phoneHash", { phoneHash: f.phoneHash });
    if (f.externalReference) qb.andWhere("p.external_reference = :externalReference", { externalReference: f.externalReference });
    if (f.from) qb.andWhere("p.created_at >= :from", { from: f.from });
    if (f.to) qb.andWhere("p.created_at <= :to", { to: f.to });
    const total = await qb.getCount();
    const rows = await qb
      .orderBy("p.created_at", "DESC")
      .skip((f.page - 1) * f.perPage)
      .take(f.perPage)
      .getMany();
    return { rows: rows.map(mapPayment), total };
  }

  async collections(f: { country?: string; network?: string; provider?: string; from?: Date; to?: Date }): Promise<{
    by_country: { country: string; total_minor: string; count: number }[];
    by_network: { country: string; network: string; total_minor: string; count: number }[];
    by_provider: { provider: string; total_minor: string; count: number }[];
  }> {
    // Conditions positionnelles ($1, $2, ...) partagées par les 3 requêtes.
    const conds: string[] = ["p.status = 'succeeded'"];
    const vals: unknown[] = [];
    const push = (sql: string, v: unknown) => {
      vals.push(v);
      conds.push(`${sql} $${vals.length}`);
    };
    if (f.country) push("c.code =", f.country);
    if (f.network) push("n.code =", f.network);
    if (f.from) push("p.created_at >=", f.from);
    if (f.to) push("p.created_at <=", f.to);
    const w = conds.join(" AND ");
    const byCountry = await this.em.query(
      `SELECT c.code AS country, SUM(p.amount_minor)::text AS total_minor, COUNT(*)::int AS count
         FROM payments p JOIN countries c ON c.id = p.country_id JOIN networks n ON n.id = p.network_id
        WHERE ${w} GROUP BY c.code ORDER BY c.code`,
      vals,
    );
    const byNetwork = await this.em.query(
      `SELECT c.code AS country, n.code AS network, SUM(p.amount_minor)::text AS total_minor, COUNT(*)::int AS count
         FROM payments p JOIN countries c ON c.id = p.country_id JOIN networks n ON n.id = p.network_id
        WHERE ${w} GROUP BY c.code, n.code ORDER BY c.code, n.code`,
      vals,
    );
    const providerVals = [...vals];
    let providerCond = "";
    if (f.provider) {
      providerVals.push(f.provider);
      providerCond = `AND pr.code = $${providerVals.length}`;
    }
    const byProvider = await this.em.query(
      `SELECT pr.code AS provider, SUM(p.amount_minor)::text AS total_minor, COUNT(*)::int AS count
         FROM payments p
         JOIN payment_attempts a ON a.payment_id = p.id AND a.status = 'succeeded'
         JOIN providers pr ON pr.id = a.provider_id
         JOIN countries c ON c.id = p.country_id JOIN networks n ON n.id = p.network_id
        WHERE ${w} ${providerCond} GROUP BY pr.code ORDER BY pr.code`,
      providerVals,
    );
    return { by_country: byCountry, by_network: byNetwork, by_provider: byProvider };
  }
}

function mapDelivery(e: WebhookDeliveryEntity): WebhookDeliveryRow {
  return {
    id: e.id,
    event_id: e.event_id,
    subscription_id: e.subscription_id,
    payment_id: e.payment_id,
    attempt_id: e.attempt_id,
    url: e.url,
    event_type: e.event_type as MerchantEventType,
    payload: e.payload ?? {},
    signature: e.signature,
    status: e.status as WebhookDeliveryRow["status"],
    attempts: e.attempts,
    next_retry_at: e.next_retry_at ? iso(e.next_retry_at) : null,
    last_response_code: e.last_response_code,
    last_response_body: e.last_response_body,
    created_at: iso(e.created_at),
    updated_at: iso(e.updated_at),
  };
}
