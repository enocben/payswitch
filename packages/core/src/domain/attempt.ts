// @payswitch/core — PaymentAttempt entity (spec §5.1). Pure, zero I/O.

import type { ErrorOutcome } from "../types.js";

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
  payment_id: string;
  provider_id: string;
  attempt_number: number;
  status: AttemptStatus;
  provider_reference?: string;
  /** Deterministic key, persisted per attempt, reused identically on retry. */
  provider_idempotency_key: string;
  provider_raw_request?: unknown;
  provider_raw_response?: unknown;
  normalized_response?: unknown;
  error_code?: string;
  error_message?: string;
  error_outcome?: ErrorOutcome;
  /** true = failure confirmed by provider, false = ambiguous. */
  confirmed: boolean;
  created_at: string;
  updated_at: string;
}

export function createAttempt(input: {
  id: string;
  payment_id: string;
  provider_id: string;
  attempt_number: number;
  provider_idempotency_key: string;
}): PaymentAttempt {
  if (!Number.isInteger(input.attempt_number) || input.attempt_number < 1) {
    throw new Error("attempt_number must be an integer >= 1");
  }
  if (!input.provider_idempotency_key) {
    throw new Error("provider_idempotency_key is required");
  }
  const now = new Date().toISOString();
  return {
    ...input,
    status: "created",
    confirmed: false,
    created_at: now,
    updated_at: now,
  };
}
