// @payswitch/api — accès REST Postgres (spec §5.1/§7.2/§10).
// Séparé du PaymentStore moteur (aucun SQL métier hors infra) : requêtes
// lecture/écriture des endpoints (clés, users, abonnements, deliveries,
// audit, routing, collections, recherche paiements). Montants BIGINT → number
// (bornés aux réalités mobile-money) ; horodatages → ISO.

import { SQL } from "bun";
import type { ApiKeyRow } from "./auth.js";

const asISO = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v));

/** bun:sql rend JSONB en texte : parse défensif (jamais de throw). */
export function asJson<T>(v: unknown, fallback: T): T {
  if (v === null || v === undefined) return fallback;
  if (typeof v === "string") {
    try {
      return JSON.parse(v) as T;
    } catch {
      return fallback;
    }
  }
  return v as T;
}

export interface SubscriptionRow {
  id: string;
  url: string;
  events: string[];
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface DeliveryRow {
  id: string;
  event_id: string;
  subscription_id: string;
  payment_id: string | null;
  attempt_id: string | null;
  url: string;
  event_type: string;
  payload: Record<string, unknown>;
  signature: string;
  status: string;
  attempts: number;
  next_retry_at: string | null;
  last_response_code: number | null;
  last_response_body: string | null;
  created_at: string;
  updated_at: string;
}

export interface PaymentListFilters {
  status?: string;
  country?: string; // code
  network?: string; // code
  provider?: string; // code
  phoneHash?: string;
  externalReference?: string;
  from?: string;
  to?: string;
  page: number;
  perPage: number;
}

function mapDelivery(r: Record<string, unknown>): DeliveryRow {
  return {
    id: String(r.id),
    event_id: String(r.event_id),
    subscription_id: String(r.subscription_id),
    payment_id: (r.payment_id as string | null) ?? null,
    attempt_id: (r.attempt_id as string | null) ?? null,
    url: String(r.url),
    event_type: String(r.event_type),
    payload: asJson<Record<string, unknown>>(r.payload, {}),
    signature: String(r.signature),
    status: String(r.status),
    attempts: Number(r.attempts),
    next_retry_at: r.next_retry_at == null ? null : asISO(r.next_retry_at),
    last_response_code: r.last_response_code == null ? null : Number(r.last_response_code),
    last_response_body: (r.last_response_body as string | null) ?? null,
    created_at: asISO(r.created_at),
    updated_at: asISO(r.updated_at),
  };
}

export class RestStore {
  constructor(private readonly sql: SQL) {}

  // ------------------------------------------------------------ api keys
  async findApiKeyCandidates(prefix: string): Promise<ApiKeyRow[]> {
    const rows = await this.sql`SELECT * FROM api_keys WHERE prefix = ${prefix}`;
    return (rows as Record<string, unknown>[]).map((r) => ({
      id: String(r.id),
      name: String(r.name),
      key_hash: String(r.key_hash),
      prefix: String(r.prefix),
      scopes: (r.scopes ?? []) as unknown,
      revoked_at: r.revoked_at == null ? null : asISO(r.revoked_at),
    }));
  }

  async touchApiKey(id: string): Promise<void> {
    await this.sql`UPDATE api_keys SET last_used_at = now() WHERE id = ${id}`;
  }

  async createApiKey(name: string, prefix: string, keyHash: string, scopes: string[]): Promise<{ id: string }> {
    const rows = await this.sql`
      INSERT INTO api_keys (id, name, key_hash, prefix, scopes)
      VALUES (gen_random_uuid(), ${name}, ${keyHash}, ${prefix}, ${JSON.stringify(scopes)})
      RETURNING id`;
    return { id: String((rows[0] as Record<string, unknown>).id) };
  }

  // ------------------------------------------------------ dashboard users
  async findUserByEmail(email: string): Promise<{ id: string; email: string; password_hash: string } | null> {
    const rows = await this.sql`SELECT id, email, password_hash FROM dashboard_users WHERE email = ${email}`;
    const r = rows[0] as Record<string, unknown> | undefined;
    if (!r) return null;
    return { id: String(r.id), email: String(r.email), password_hash: String(r.password_hash) };
  }

  // ----------------------------------------------------------------- audit
  async insertAudit(a: {
    action: string;
    actor: string;
    resourceType?: string;
    resourceId?: string;
    oldValue?: unknown;
    newValue?: unknown;
    ip?: string;
    requestId: string;
  }): Promise<void> {
    await this.sql`
      INSERT INTO audit_logs (id, action, actor, resource_type, resource_id, old_value, new_value, ip, request_id)
      VALUES (gen_random_uuid(), ${a.action}, ${a.actor}, ${a.resourceType ?? null},
        ${a.resourceId ?? null}, ${a.oldValue === undefined ? null : JSON.stringify(a.oldValue)},
        ${a.newValue === undefined ? null : JSON.stringify(a.newValue)}, ${a.ip ?? null}, ${a.requestId})`;
  }

  async listAudit(limit: number): Promise<Record<string, unknown>[]> {
    const rows = await this.sql`SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT ${limit}`;
    return rows as Record<string, unknown>[];
  }

  // ------------------------------------------------------- geo / providers
  async listCountries(): Promise<Record<string, unknown>[]> {
    const rows = await this.sql`SELECT code, name, currency_default, phone_prefix FROM countries ORDER BY code ASC`;
    return rows as Record<string, unknown>[];
  }

  async listNetworks(country?: string): Promise<Record<string, unknown>[]> {
    if (country) {
      const rows = await this.sql`
        SELECT n.code, n.display_name, n.logo_url, n.is_active, c.code AS country
          FROM networks n JOIN countries c ON c.id = n.country_id
         WHERE c.code = ${country} ORDER BY n.code ASC`;
      return rows as Record<string, unknown>[];
    }
    const rows = await this.sql`
      SELECT n.code, n.display_name, n.logo_url, n.is_active, c.code AS country
        FROM networks n JOIN countries c ON c.id = n.country_id
       ORDER BY c.code ASC, n.code ASC`;
    return rows as Record<string, unknown>[];
  }

  async providerExists(code: string): Promise<boolean> {
    const rows = await this.sql`SELECT 1 FROM providers WHERE code = ${code}`;
    return rows.length > 0;
  }

  async geoIds(country: string, network: string): Promise<{ countryId: string; networkId: string } | null> {
    const rows = await this.sql`
      SELECT c.id AS country_id, n.id AS network_id
        FROM countries c JOIN networks n ON n.country_id = c.id AND n.code = ${network}
       WHERE c.code = ${country}`;
    const r = rows[0] as Record<string, unknown> | undefined;
    if (!r) return null;
    return { countryId: String(r.country_id), networkId: String(r.network_id) };
  }

  /** Routage complet groupé : [{ country, network, providers: [codes...] }]. */
  async getRouting(): Promise<{ country: string; network: string; providers: string[] }[]> {
    const rows = await this.sql`
      SELECT c.code AS country, n.code AS network, p.code AS provider, r.priority
        FROM routing_rules r
        JOIN countries c ON c.id = r.country_id
        JOIN networks n ON n.id = r.network_id
        JOIN providers p ON p.id = r.provider_id
       ORDER BY c.code ASC, n.code ASC, r.priority ASC`;
    const groups = new Map<string, { country: string; network: string; providers: string[] }>();
    for (const row of rows as Record<string, unknown>[]) {
      const key = `${row.country}:${row.network}`;
      let g = groups.get(key);
      if (!g) {
        g = { country: String(row.country), network: String(row.network), providers: [] };
        groups.set(key, g);
      }
      g.providers.push(String(row.provider));
    }
    return [...groups.values()];
  }

  /**
   * Remplace les priorités des paires (country, network) fournies.
   * Transactionnel : DELETE ciblé + INSERT ordonné. Retourne l'ancien routage
   * des paires touchées (pour audit avant/après).
   */
  async replaceRouting(
    entries: { countryId: string; networkId: string; providerIds: string[] }[],
  ): Promise<void> {
    const sql = this.sql;
    const reserved = await sql.reserve();
    try {
      await reserved`BEGIN`;
      for (const e of entries) {
        await reserved`DELETE FROM routing_rules WHERE country_id = ${e.countryId} AND network_id = ${e.networkId}`;
        let prio = 1;
        for (const pid of e.providerIds) {
          await reserved`INSERT INTO routing_rules (id, country_id, network_id, provider_id, priority)
            VALUES (gen_random_uuid(), ${e.countryId}, ${e.networkId}, ${pid}, ${prio})`;
          prio++;
        }
      }
      await reserved`COMMIT`;
    } catch (err) {
      await reserved`ROLLBACK`;
      throw err;
    } finally {
      await (reserved as unknown as { release(): Promise<void> }).release();
    }
  }

  // --------------------------------------------------------------- payments
  async listPayments(f: PaymentListFilters): Promise<{ rows: Record<string, unknown>[]; total: number }> {
    const conds: string[] = [];
    const params: (string | number)[] = [];
    const push = (cond: string, v: string | number) => {
      params.push(v);
      conds.push(`${cond} $${params.length}`);
    };
    if (f.status) push("p.status =", f.status);
    if (f.country) {
      const c = await this.sql`SELECT id FROM countries WHERE code = ${f.country}`;
      if (c.length === 0) return { rows: [], total: 0 };
      push("p.country_id =", String((c[0] as Record<string, unknown>).id));
    }
    if (f.network) {
      // Filtre réseau : jointure pays si country donné, sinon tous pays.
      if (f.country) {
        const nn = await this.sql`SELECT n.id FROM networks n JOIN countries c ON c.id = n.country_id
          WHERE n.code = ${f.network} AND c.code = ${f.country}`;
        if (nn.length === 0) return { rows: [], total: 0 };
        push("p.network_id =", String((nn[0] as Record<string, unknown>).id));
      } else {
        const ids = (await this.sql`SELECT id FROM networks WHERE code = ${f.network}`).map(
          (r: Record<string, unknown>) => String(r.id),
        );
        if (ids.length === 0) return { rows: [], total: 0 };
        params.push(...ids);
        const placeholders = ids.map((_: string, i: number) => `$${params.length - ids.length + i + 1}`).join(",");
        conds.push(`p.network_id IN (${placeholders})`);
      }
    }
    if (f.phoneHash) push("p.phone_hash =", f.phoneHash);
    if (f.externalReference) push("p.external_reference =", f.externalReference);
    if (f.from) push("p.created_at >=", f.from);
    if (f.to) push("p.created_at <=", f.to);

    let providerJoin = "";
    if (f.provider) {
      const p = await this.sql`SELECT id FROM providers WHERE code = ${f.provider}`;
      if (p.length === 0) return { rows: [], total: 0 };
      params.push(String((p[0] as Record<string, unknown>).id));
      providerJoin = `JOIN payment_attempts a ON a.payment_id = p.id AND a.provider_id = $${params.length}`;
    }
    const where = conds.length > 0 ? `WHERE ${conds.join(" AND ")}` : "";
    const limit = Math.min(Math.max(f.perPage, 1), 100);
    const page = Math.max(f.page, 1);
    const offset = (page - 1) * limit;
    const countRows = (await this.sql.unsafe(
      `SELECT COUNT(DISTINCT p.id)::int AS total FROM payments p ${providerJoin} ${where}`,
      params as (string | number)[],
    )) as unknown[];
    const total = Number((countRows[0] as Record<string, unknown>).total ?? 0);
    const rows = (await this.sql.unsafe(
      `SELECT DISTINCT p.*, c.code AS country, n.code AS network FROM payments p
         JOIN countries c ON c.id = p.country_id
         JOIN networks n ON n.id = p.network_id
         ${providerJoin} ${where} ORDER BY p.created_at DESC LIMIT ${limit} OFFSET ${offset}`,
      params as (string | number)[],
    )) as unknown[];
    return { rows: rows as Record<string, unknown>[], total };
  }

  /** Détail paiement : geo + tentatives (codes provider), même état que webhook. */
  async findPaymentFull(id: string): Promise<Record<string, unknown> | null> {
    const rows = await this.sql`
      SELECT p.*, c.code AS country, n.code AS network, n.display_name AS network_name
        FROM payments p
        JOIN countries c ON c.id = p.country_id
        JOIN networks n ON n.id = p.network_id
       WHERE p.id = ${id}`;
    const p = rows[0] as Record<string, unknown> | undefined;
    if (!p) return null;
    const attempts = (await this.sql`
      SELECT a.*, pr.code AS provider FROM payment_attempts a
        JOIN providers pr ON pr.id = a.provider_id
       WHERE a.payment_id = ${id} ORDER BY a.attempt_number ASC`) as Record<string, unknown>[];
    return { ...p, attempts };
  }

  // --------------------------------------------------------- subscriptions
  async createSubscription(url: string, events: string[], secretHash: string): Promise<SubscriptionRow> {
    const rows = await this.sql`
      INSERT INTO webhook_subscriptions (id, url, events, secret_hash)
      VALUES (gen_random_uuid(), ${url}, ${JSON.stringify(events)}, ${secretHash})
      RETURNING *`;
    return this.mapSub(rows[0] as Record<string, unknown>);
  }

  private mapSub(r: Record<string, unknown>): SubscriptionRow {
    return {
      id: String(r.id),
      url: String(r.url),
      events: asJson<string[]>(r.events, []),
      is_active: Boolean(r.is_active),
      created_at: asISO(r.created_at),
      updated_at: asISO(r.updated_at),
    };
  }

  async listSubscriptions(): Promise<SubscriptionRow[]> {
    const rows = await this.sql`SELECT * FROM webhook_subscriptions ORDER BY created_at DESC`;
    return (rows as Record<string, unknown>[]).map((r) => this.mapSub(r));
  }

  async findSubscription(id: string): Promise<SubscriptionRow | null> {
    const rows = await this.sql`SELECT * FROM webhook_subscriptions WHERE id = ${id}`;
    const r = rows[0] as Record<string, unknown> | undefined;
    return r ? this.mapSub(r) : null;
  }

  async deleteSubscription(id: string): Promise<boolean> {
    const rows = await this.sql`DELETE FROM webhook_subscriptions WHERE id = ${id} RETURNING id`;
    return rows.length > 0;
  }

  async activeSubscriptionsFor(eventType: string): Promise<SubscriptionRow[]> {
    const rows = await this.sql`SELECT * FROM webhook_subscriptions WHERE is_active = TRUE ORDER BY created_at ASC`;
    return (rows as Record<string, unknown>[])
      .map((r) => this.mapSub(r))
      .filter((s) => s.events.includes(eventType));
  }

  // ------------------------------------------------------------ deliveries
  async enqueueDelivery(d: {
    eventId: string;
    subscriptionId: string;
    paymentId: string;
    url: string;
    eventType: string;
    payload: Record<string, unknown>;
    signature: string;
  }): Promise<DeliveryRow> {
    const rows = await this.sql`
      INSERT INTO webhook_deliveries (id, event_id, subscription_id, payment_id, url, event_type, payload, signature, status, next_retry_at)
      VALUES (gen_random_uuid(), ${d.eventId}, ${d.subscriptionId}, ${d.paymentId}, ${d.url}, ${d.eventType}, ${JSON.stringify(d.payload)}, ${d.signature}, 'pending', now())
      RETURNING *`;
    return mapDelivery(rows[0] as Record<string, unknown>);
  }

  async claimDueDeliveries(limit: number): Promise<DeliveryRow[]> {
    const rows = await this.sql`
      UPDATE webhook_deliveries SET status = 'retrying', updated_at = now()
       WHERE id IN (
         SELECT id FROM webhook_deliveries
          WHERE status IN ('pending','retrying') AND next_retry_at IS NOT NULL AND next_retry_at <= now()
          ORDER BY next_retry_at ASC LIMIT ${limit} FOR UPDATE SKIP LOCKED
       ) RETURNING *`;
    return (rows as Record<string, unknown>[]).map(mapDelivery);
  }

  async updateDelivery(
    id: string,
    patch: { status: string; attempts: number; nextRetryAt: string | null; code: number | null; body: string | null },
  ): Promise<void> {
    await this.sql`
      UPDATE webhook_deliveries SET status = ${patch.status}, attempts = ${patch.attempts},
        next_retry_at = ${patch.nextRetryAt}, last_response_code = ${patch.code},
        last_response_body = ${patch.body}, updated_at = now() WHERE id = ${id}`;
  }

  async listDeliveries(filters: { subscriptionId?: string; status?: string; limit: number }): Promise<DeliveryRow[]> {
    const limit = Math.min(Math.max(filters.limit, 1), 100);
    let rows;
    if (filters.subscriptionId && filters.status) {
      rows = await this.sql`SELECT * FROM webhook_deliveries WHERE subscription_id = ${filters.subscriptionId} AND status = ${filters.status} ORDER BY created_at DESC LIMIT ${limit}`;
    } else if (filters.subscriptionId) {
      rows = await this.sql`SELECT * FROM webhook_deliveries WHERE subscription_id = ${filters.subscriptionId} ORDER BY created_at DESC LIMIT ${limit}`;
    } else if (filters.status) {
      rows = await this.sql`SELECT * FROM webhook_deliveries WHERE status = ${filters.status} ORDER BY created_at DESC LIMIT ${limit}`;
    } else {
      rows = await this.sql`SELECT * FROM webhook_deliveries ORDER BY created_at DESC LIMIT ${limit}`;
    }
    return (rows as Record<string, unknown>[]).map(mapDelivery);
  }

  /** Replay : clone une delivery (nouvel event_id) repassée en pending. */
  async replayDelivery(deliveryId: string, newEventId: string): Promise<DeliveryRow | null> {
    const rows = await this.sql`SELECT * FROM webhook_deliveries WHERE id = ${deliveryId}`;
    const src = rows[0] as Record<string, unknown> | undefined;
    if (!src) return null;
    const payload = { ...asJson<Record<string, unknown>>(src.payload, {}), event_id: newEventId };
    const fresh = await this.sql`
      INSERT INTO webhook_deliveries (id, event_id, subscription_id, payment_id, attempt_id, url, event_type, payload, signature, status, next_retry_at)
      VALUES (gen_random_uuid(), ${newEventId}, ${String(src.subscription_id)}, ${(src.payment_id as string | null) ?? null},
        ${(src.attempt_id as string | null) ?? null}, ${String(src.url)}, ${String(src.event_type)},
        ${JSON.stringify(payload)}, ${String(src.signature)}, 'pending', now())
      RETURNING *`;
    return mapDelivery(fresh[0] as Record<string, unknown>);
  }

  // ----------------------------------------------------------- collections
  /** Agrégats lecture seuleRepublic : SUM succeeded GROUP BY (jamais un solde). */
  async collections(f: { country?: string; network?: string; provider?: string; from?: string; to?: string }): Promise<{
    by_country: { country: string; total_minor: number; count: number }[];
    by_network: { country: string; network: string; total_minor: number; count: number }[];
    by_provider: { provider: string; total_minor: number; count: number }[];
  }> {
    const conds: string[] = ["p.status = 'succeeded'"];
    const params: (string | number)[] = [];
    if (f.country) {
      params.push(f.country);
      conds.push(`c.code = $${params.length}`);
    }
    if (f.network) {
      params.push(f.network);
      conds.push(`n.code = $${params.length}`);
    }
    if (f.from) {
      params.push(f.from);
      conds.push(`p.created_at >= $${params.length}`);
    }
    if (f.to) {
      params.push(f.to);
      conds.push(`p.created_at <= $${params.length}`);
    }
    const where = `WHERE ${conds.join(" AND ")}`;
    const byCountry = (await this.sql.unsafe(
      `SELECT c.code AS country, SUM(p.amount_minor)::text AS total_minor, COUNT(*)::int AS count
         FROM payments p JOIN countries c ON c.id = p.country_id JOIN networks n ON n.id = p.network_id
         ${where} GROUP BY c.code ORDER BY c.code ASC`,
      params as (string | number)[],
    )) as unknown as { country: string; total_minor: string; count: number }[];
    const byNetwork = (await this.sql.unsafe(
      `SELECT c.code AS country, n.code AS network, SUM(p.amount_minor)::text AS total_minor, COUNT(*)::int AS count
         FROM payments p JOIN countries c ON c.id = p.country_id JOIN networks n ON n.id = p.network_id
         ${where} GROUP BY c.code, n.code ORDER BY c.code ASC, n.code ASC`,
      params as (string | number)[],
    )) as unknown as { country: string; network: string; total_minor: string; count: number }[];
    let byProvider = (await this.sql.unsafe(
      `SELECT pr.code AS provider, SUM(p.amount_minor)::text AS total_minor, COUNT(DISTINCT p.id)::int AS count
         FROM payments p JOIN countries c ON c.id = p.country_id JOIN networks n ON n.id = p.network_id
         JOIN payment_attempts a ON a.payment_id = p.id
         JOIN providers pr ON pr.id = a.provider_id
         ${where} AND a.attempt_number = (SELECT MAX(attempt_number) FROM payment_attempts WHERE payment_id = p.id)
         GROUP BY pr.code ORDER BY pr.code ASC`,
      params as (string | number)[],
    )) as unknown as { provider: string; total_minor: string; count: number }[];
    if (f.provider) byProvider = byProvider.filter((r) => r.provider === f.provider);
    return {
      by_country: byCountry.map((r) => ({ country: r.country, total_minor: Number(r.total_minor), count: r.count })),
      by_network: byNetwork.map((r) => ({ country: r.country, network: r.network, total_minor: Number(r.total_minor), count: r.count })),
      by_provider: byProvider.map((r) => ({ provider: r.provider, total_minor: Number(r.total_minor), count: r.count })),
    };
  }
}
