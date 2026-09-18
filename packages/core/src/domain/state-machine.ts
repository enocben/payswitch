// @payswitch/core — state machines (spec §5.2, §5.4).
// Payment: created → processing → pending → succeeded | failed | unknown | expired
// Attempt: created → sending → accepted → pending → succeeded | failed | timeout | unknown | cancelled
// Golden rule: final states are terminal, never downgraded.
// expired/unknown are NEVER mapped to failed. Pure, zero I/O.

import { InvalidTransitionError, PaymentFinalError } from "../errors.js";
import {
  isPaymentFinal,
  type Payment,
  type PaymentStatus,
} from "./payment.js";
import type { PaymentAttempt, AttemptStatus } from "./attempt.js";

const PAYMENT_TRANSITIONS: Record<PaymentStatus, readonly PaymentStatus[]> = {
  created: ["processing"],
  processing: ["pending", "failed", "unknown", "expired"],
  pending: ["succeeded", "failed", "unknown", "expired"],
  succeeded: [],
  failed: [],
  unknown: [],
  expired: [],
};

const ATTEMPT_TRANSITIONS: Record<AttemptStatus, readonly AttemptStatus[]> = {
  created: ["sending", "cancelled"],
  sending: ["accepted", "failed", "timeout", "unknown", "cancelled"],
  accepted: ["pending", "failed", "timeout", "unknown", "cancelled"],
  pending: ["succeeded", "failed", "timeout", "unknown", "cancelled"],
  succeeded: [],
  failed: [],
  timeout: [],
  unknown: [],
  cancelled: [],
};

export function canTransitionPayment(
  from: PaymentStatus,
  to: PaymentStatus,
): boolean {
  if (from === to) return true;
  return PAYMENT_TRANSITIONS[from].includes(to);
}

export function canTransitionAttempt(
  from: AttemptStatus,
  to: AttemptStatus,
): boolean {
  if (from === to) return true;
  return ATTEMPT_TRANSITIONS[from].includes(to);
}

/** Transition a Payment, throwing on illegal moves (incl. retrograde from finals). */
export function transitionPayment(
  payment: Payment,
  to: PaymentStatus,
): Payment {
  if (isPaymentFinal(payment.status) && payment.status !== to) {
    throw new PaymentFinalError(payment.id, payment.status);
  }
  if (!canTransitionPayment(payment.status, to)) {
    throw new InvalidTransitionError(payment.status, to);
  }
  return { ...payment, status: to, updated_at: new Date().toISOString() };
}

/** Transition an Attempt, throwing on illegal moves. */
export function transitionAttempt(
  attempt: PaymentAttempt,
  to: AttemptStatus,
): PaymentAttempt {
  if (!canTransitionAttempt(attempt.status, to)) {
    throw new InvalidTransitionError(attempt.status, to);
  }
  return { ...attempt, status: to, updated_at: new Date().toISOString() };
}

/**
 * Resolve expiration (spec §9.2 step 6): pending → expired, uncertain → unknown.
 * NEVER failed — expired/unknown are never mapped to failed.
 */
export function resolveExpiration(isUncertain: boolean): "expired" | "unknown" {
  return isUncertain ? "unknown" : "expired";
}

/**
 * Late-webhook policy (spec §5.4): any webhook arriving after a final
 * expired/unknown Payment is logged (is_late=true + AuditLog by the API layer)
 * but must NOT mutate the Payment without an explicit rule.
 */
export function isLateWebhook(paymentStatus: PaymentStatus): boolean {
  return paymentStatus === "expired" || paymentStatus === "unknown";
}

/**
 * Guard the API/webhook layer: returns true when a webhook for `to` status
 * may mutate the payment, false when it must be recorded as late only.
 */
export function mayApplyWebhook(
  paymentStatus: PaymentStatus,
  _to: PaymentStatus,
): boolean {
  if (isPaymentFinal(paymentStatus)) return false;
  return true;
}
