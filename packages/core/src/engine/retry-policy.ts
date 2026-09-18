// @payswitch/core — provider-safe retry/fallback decisions (spec §9.2).
// Absolute rule: NO fallback while the first provider is unknown/pending.
// Pure decision functions, zero I/O.

import type { InitiateOutcome, VerifyResult } from "../types.js";

export type InitiateDecision =
  | "accept_pending"
  | "retry_same_key"
  | "fallback"
  | "verify_required"
  | "fail";

export interface InitiateDecisionInput {
  outcome: InitiateOutcome;
  confirmed: boolean;
  canRetry: boolean;
  canFallback: boolean;
  /** Native idempotency support of the provider. */
  supportsIdempotency: boolean;
  /** 0 = first attempt, >= 1 = already retried once. */
  retryCount: number;
}

/**
 * Decide after initiate() (spec §9.2 step 4):
 * - success → accept_pending (no fallback)
 * - definitive + confirmed + canFallback → fallback
 * - definitive + confirmed, no fallback → fail
 * - definitive + !confirmed → verify_required (→ unknown, verify)
 * - temporary → 1 retry same key, then fallback if canFallback;
 *   without native idempotency → verify first (never blind retry)
 * - unknown/timeout → verify_required (mandatory verify)
 */
export function decideAfterInitiate(
  input: InitiateDecisionInput,
): InitiateDecision {
  switch (input.outcome) {
    case "success":
      return "accept_pending";
    case "definitive_failure":
      if (input.confirmed) {
        return input.canFallback ? "fallback" : "fail";
      }
      return "verify_required";
    case "temporary_failure":
      if (!input.supportsIdempotency) {
        return "verify_required";
      }
      if (input.retryCount < 1 && input.canRetry) {
        return "retry_same_key";
      }
      if (input.retryCount >= 1) {
        return input.canFallback ? "fallback" : "verify_required";
      }
      return "verify_required";
    case "unknown":
    default:
      return "verify_required";
  }
}

export type VerifyDecision =
  | "succeed"
  | "fallback"
  | "fail"
  | "stay_pending";

/**
 * Decide after verify() (spec §9.2 step 4):
 * - succeeded → done
 * - confirmed_failed + canFallback → fallback
 * - confirmed_failed, no fallback → fail
 * - unknown/pending → stay pending (schedule next_poll_at), NO fallback
 */
export function decideAfterVerify(
  status: VerifyResult["status"],
  canFallback: boolean,
): VerifyDecision {
  switch (status) {
    case "succeeded":
      return "succeed";
    case "confirmed_failed":
      return canFallback ? "fallback" : "fail";
    case "pending":
    case "unknown":
    default:
      return "stay_pending";
  }
}
