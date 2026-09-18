// @payswitch/core — Payment entity (spec §5.1).
// Amounts are BIGINT minor units (bigint, never float). Pure, zero I/O.

export type PaymentStatus =
  | "created"
  | "processing"
  | "pending"
  | "succeeded"
  | "failed"
  | "unknown"
  | "expired";

/** Terminal states: never downgraded, never left (spec §5.2). */
export const PAYMENT_FINAL_STATUSES: readonly PaymentStatus[] = [
  "succeeded",
  "failed",
  "unknown",
  "expired",
];

export function isPaymentFinal(status: PaymentStatus): boolean {
  return PAYMENT_FINAL_STATUSES.includes(status);
}

export interface Payment {
  id: string;
  idempotency_key: string;
  /** SHA256 of the normalized payload. */
  request_hash: string;
  external_reference?: string;
  /** BIGINT minor units — never float. */
  amount_minor: bigint;
  /** ISO 4217 effective currency. */
  currency: string;
  /** E.164 phone (masked in logs by the API layer). */
  phone: string;
  country_id: string;
  network_id: string;
  status: PaymentStatus;
  gross_amount_minor?: bigint;
  provider_fee_minor?: bigint;
  net_amount_minor?: bigint;
  metadata?: Record<string, unknown>;
  correlation_id: string;
  request_id: string;
  expires_at: string;
  poll_attempts: number;
  next_poll_at?: string;
  created_at: string;
  updated_at: string;
}

export function assertValidAmountMinor(amount: bigint): void {
  if (typeof amount !== "bigint") {
    throw new Error("amount_minor must be a bigint (minor units, never float)");
  }
  if (amount <= 0n) {
    throw new Error("amount_minor must be > 0");
  }
}

export function createPayment(input: {
  id: string;
  idempotency_key: string;
  request_hash: string;
  amount_minor: bigint;
  currency: string;
  phone: string;
  country_id: string;
  network_id: string;
  correlation_id: string;
  request_id: string;
  expires_at: string;
  external_reference?: string;
  metadata?: Record<string, unknown>;
}): Payment {
  assertValidAmountMinor(input.amount_minor);
  const now = new Date().toISOString();
  return {
    ...input,
    status: "created",
    poll_attempts: 0,
    created_at: now,
    updated_at: now,
  };
}
