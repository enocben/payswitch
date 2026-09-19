// @payswitch/api — store ports (spec §5.3 : transactions + verrous + transitions).
// Lignes DB brutes (montants BIGINT → bigint côté moteur). Le moteur ne
// connaît que ces ports ; PostgresStore (bun:sql) et MemoryStore (tests)
// les implémentent. Aucun SQL métier hors infrastructure/database.

import type { AttemptStatus } from "@payswitch/core";
import type { PaymentStatus } from "@payswitch/core";

export interface CountryRow {
  id: string;
  code: string;
  name: string;
  currency_default: string;
}

export interface NetworkRow {
  id: string;
  country_id: string;
  code: string;
  display_name: string;
}

export interface ProviderRow {
  id: string;
  code: string;
  display_name: string;
  is_enabled: boolean;
  is_healthy: boolean;
  capabilities: Record<string, unknown>;
  supports_idempotency: boolean;
}

export interface RouteEntry {
  provider_id: string;
  provider_code: string;
  priority: number;
}

export interface PaymentRow {
  id: string;
  idempotency_key: string;
  request_hash: string;
  external_reference: string | null;
  amount_minor: bigint;
  currency: string;
  phone: string;
  phone_hash: string;
  phone_last4: string | null;
  country_id: string;
  network_id: string;
  status: PaymentStatus;
  metadata: Record<string, unknown>;
  correlation_id: string;
  request_id: string;
  expires_at: string;
  poll_attempts: number;
  next_poll_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface AttemptRow {
  id: string;
  payment_id: string;
  provider_id: string;
  attempt_number: number;
  status: AttemptStatus;
  provider_reference: string | null;
  provider_idempotency_key: string;
  provider_raw_request: unknown;
  provider_raw_response: unknown;
  normalized_response: unknown;
  error_code: string | null;
  error_message: string | null;
  error_outcome: "definitive_failure" | "temporary_failure" | "unknown" | null;
  confirmed: boolean;
  created_at: string;
  updated_at: string;
}

export interface WebhookRow {
  id: string;
  provider_id: string;
  payment_id: string | null;
  provider_event_id: string;
  signature_valid: boolean;
  normalized_status: string | null;
  is_late: boolean;
  processed_at: string | null;
}

/** Erreur unique portée par le store quand une contrainte UNIQUE casse (SQLSTATE 23505). */
export class UniqueViolationError extends Error {
  readonly constraint: string;
  constructor(constraint: string) {
    super(`Unique violation: ${constraint}`);
    this.name = "UniqueViolationError";
    this.constraint = constraint;
  }
}

export interface NewPayment {
  id: string;
  idempotency_key: string;
  request_hash: string;
  external_reference?: string;
  amount_minor: bigint;
  currency: string;
  phone: string;
  phone_hash: string;
  phone_last4: string;
  country_id: string;
  network_id: string;
  metadata: Record<string, unknown>;
  correlation_id: string;
  request_id: string;
  expires_at: string;
}

export interface PaymentStore {
  /** Transaction : tout le travail concurrence (lock + transition) passe ici. */
  withTransaction<T>(fn: (tx: PaymentStore) => Promise<T>): Promise<T>;
  findCountry(code: string): Promise<CountryRow | null>;
  findNetwork(countryId: string, code: string): Promise<NetworkRow | null>;
  findProviderByCode(code: string): Promise<ProviderRow | null>;
  findRoute(countryId: string, networkId: string): Promise<RouteEntry[]>;
  findPaymentByIdem(key: string): Promise<PaymentRow | null>;
  findPaymentById(id: string): Promise<PaymentRow | null>;
  /** SELECT ... FOR UPDATE — valide uniquement dans withTransaction. */
  lockPayment(id: string): Promise<PaymentRow | null>;
  insertPayment(p: NewPayment): Promise<PaymentRow>;
  updatePayment(id: string, patch: Partial<PaymentRow>): Promise<PaymentRow>;
  listAttempts(paymentId: string): Promise<AttemptRow[]>;
  insertAttempt(a: {
    id: string;
    payment_id: string;
    provider_id: string;
    attempt_number: number;
    provider_idempotency_key: string;
  }): Promise<AttemptRow>;
  updateAttempt(id: string, patch: Partial<AttemptRow>): Promise<AttemptRow>;
  /** Insert webhook ; lève UniqueViolationError si doublon (200 idempotent). */
  insertWebhookEvent(w: {
    id: string;
    provider_id: string;
    payment_id: string | null;
    provider_event_id: string;
    signature_valid: boolean;
    normalized_status: string | null;
    is_late: boolean;
  }): Promise<WebhookRow>;
  markWebhookProcessed(id: string, at: string): Promise<void>;
  /** Paiements à vérifier : pending + next_poll_at due (polling non bloquant). */
  listDuePayments(now: string, limit: number): Promise<PaymentRow[]>;
  /** Paiements à expirer : non-finaux + expires_at dépassé. */
  listExpiredPayments(now: string, limit: number): Promise<PaymentRow[]>;
}
