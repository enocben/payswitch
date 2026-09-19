/**
 * Typed mirrors of the REST contract (spec §7.2, implemented by the sibling
 * `feat/webhooks-rest` wave). Amounts are BIGINT minor units server-side.
 */

export type PaymentStatus =
  | "created"
  | "processing"
  | "pending"
  | "succeeded"
  | "failed"
  | "unknown"
  | "expired";

export type AttemptStatus =
  | "created"
  | "sending"
  | "accepted"
  | "pending"
  | "succeeded"
  | "failed"
  | "timeout"
  | "unknown"
  | "cancelled";

export interface PaymentAttempt {
  id: string;
  attemptNumber: number;
  provider: string;
  status: AttemptStatus;
  providerReference: string | null;
  /** Deterministic per attempt: SHA256(paymentId + ":" + attemptNumber). */
  providerIdempotencyKey: string;
  createdAt: string;
  updatedAt: string;
}

export interface Payment {
  id: string;
  idempotencyKey?: string | null;
  externalReference?: string | null;
  amountMinor: number;
  /** Minor-units breakdown; present on the detail endpoint. */
  amountGrossMinor?: number | null;
  amountNetMinor?: number | null;
  amountFeeMinor?: number | null;
  currency: string;
  /** Server-masked already (e.g. +243****678); masked again client-side as a safety net. */
  phoneMasked: string;
  country: string;
  network: string;
  status: PaymentStatus;
  /** Provider serving (or last serving) this payment. */
  provider?: string | null;
  providerReference?: string | null;
  metadata?: Record<string, unknown> | null;
  correlationId: string;
  createdAt: string;
  updatedAt: string;
  attempts?: PaymentAttempt[];
}

export interface Paginated<T> {
  data: T[];
  meta: { total: number; page: number; perPage: number };
}

export interface PaymentFilters {
  status?: string;
  country?: string;
  network?: string;
  provider?: string;
  phone?: string;
  externalReference?: string;
  from?: string;
  to?: string;
  page?: number;
  perPage?: number;
}

export interface RoutingEntry {
  country: string;
  network: string;
  /** Provider codes ordered by priority (index 0 = highest). */
  providers: string[];
  /** Capability flags, informational (activation stays config-driven). */
  supportsIdempotency?: Record<string, boolean>;
}

export interface CollectionBucket {
  key: string;
  /** SUM(amount_minor) WHERE succeeded — read-only aggregate, never a balance. */
  totalMinor: number;
  count: number;
  currency?: string;
}

export interface Collections {
  byCountry: CollectionBucket[];
  byNetwork: CollectionBucket[];
  byProvider: CollectionBucket[];
  period?: { from?: string; to?: string };
}

export interface ApiErrorBody {
  error: { code: string; message: string; details?: unknown; request_id?: string };
}

export interface Country {
  code: string;
  name: string;
  currencyDefault?: string;
}

export interface Network {
  code: string;
  displayName?: string;
  country?: string;
  logoUrl?: string | null;
}
