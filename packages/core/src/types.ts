// @payswitch/core — shared provider contract types (spec §6.1, collect only).
// Framework-agnostic, zero I/O. Amounts are BIGINT minor units (bigint, never float).

/** Collect-only operation. Payout/refund are out of v1 scope. */
export type CollectOperation = "collect";

export interface ProviderCapabilities {
  supported_countries: string[];
  /** Networks per country code, e.g. { CD: ["AIRTEL", "ORANGE"] }. */
  supported_networks: Record<string, string[]>;
  supported_currencies: string[];
  /** BIGINT minor units. */
  min_amount_minor: bigint;
  max_amount_minor: bigint;
  operations: CollectOperation[];
  supports_idempotency: boolean;
}

export interface SupportParams {
  country: string;
  network: string;
  currency: string;
  /** BIGINT minor units — never float. */
  amountMinor: bigint;
  operation?: CollectOperation;
}

export interface InitiateParams {
  amountMinor: bigint;
  currency: string;
  phone: string;
  country: string;
  network: string;
  paymentId: string;
  idempotencyKey: string;
  /** Deterministic per attempt, persisted on PaymentAttempt. */
  providerIdempotencyKey: string;
  externalReference?: string;
  metadata?: Record<string, unknown>;
  correlationId: string;
}

export type InitiateOutcome =
  | "success"
  | "definitive_failure"
  | "temporary_failure"
  | "unknown";

export interface InitiateResult {
  providerReference: string;
  status: "pending" | "failed" | "unknown";
  rawRequest: unknown;
  rawResponse: unknown;
  outcome: InitiateOutcome;
  /** true = failure confirmed by provider, false = ambiguous. */
  confirmed: boolean;
}

export interface VerifyParams {
  providerReference: string;
  paymentId: string;
  providerIdempotencyKey?: string;
}

export interface VerifyResult {
  status: "succeeded" | "confirmed_failed" | "pending" | "unknown";
  rawResponse: unknown;
}

export interface NormalizedWebhookEvent {
  providerReference: string;
  providerEventId: string;
  status: "succeeded" | "confirmed_failed" | "unknown";
  rawBody: unknown;
}

export type ErrorOutcome =
  | "definitive_failure"
  | "temporary_failure"
  | "unknown";

export interface NormalizedError {
  code: string;
  message: string;
  outcome: ErrorOutcome;
  confirmed: boolean;
  canRetry: boolean;
  canFallback: boolean;
  requiresVerification: boolean;
  rawError?: unknown;
}
