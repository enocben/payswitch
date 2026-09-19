// @payswitch/core — typed domain errors (spec §7.3 / §17).
// Stable machine-readable codes; no secrets, no provider internals.

export type CoreErrorCode =
  | "IDEMPOTENCY_KEY_REUSED"
  | "INVALID_TRANSITION"
  | "NO_SUPPORTED_PROVIDER"
  | "VERIFICATION_REQUIRED"
  | "PROVIDER_ERROR"
  | "WEBHOOK_SIGNATURE_INVALID"
  | "WEBHOOK_DUPLICATE"
  | "PAYMENT_FINAL"
  | "INVALID_AMOUNT"
  | "INVALID_ROUTE"
  | "UNKNOWN_NETWORK";

export class CoreError extends Error {
  readonly code: CoreErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(
    code: CoreErrorCode,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.details = details;
  }
}

/** Same idempotency key reused with a different payload hash → 409. */
export class IdempotencyKeyReusedError extends CoreError {
  constructor(details?: Record<string, unknown>) {
    super(
      "IDEMPOTENCY_KEY_REUSED",
      "Idempotency key already used with a different payload",
      details,
    );
  }
}

/** Illegal state-machine transition (incl. retrograde from a final state). */
export class InvalidTransitionError extends CoreError {
  constructor(from: string, to: string) {
    super("INVALID_TRANSITION", `Invalid transition ${from} → ${to}`, {
      from,
      to,
    });
  }
}

/** No provider with supports() === true for country+network. */
export class NoSupportedProviderError extends CoreError {
  constructor(country: string, network: string) {
    super(
      "NO_SUPPORTED_PROVIDER",
      `No supported provider for ${country}-${network}`,
      { country, network },
    );
  }
}

/** verify() must run before any retry/fallback decision. */
export class VerificationRequiredError extends CoreError {
  constructor(providerReference: string) {
    super(
      "VERIFICATION_REQUIRED",
      "Provider state ambiguous — verify() required before retry/fallback",
      { providerReference },
    );
  }
}

export class ProviderError extends CoreError {
  constructor(message: string, details?: Record<string, unknown>) {
    super("PROVIDER_ERROR", message, details);
  }
}

export class WebhookSignatureInvalidError extends CoreError {
  constructor(provider: string) {
    super(
      "WEBHOOK_SIGNATURE_INVALID",
      `Invalid webhook signature for provider ${provider}`,
      { provider },
    );
  }
}

/** Mutation attempted on a terminal Payment (except audited late-webhook log). */
export class PaymentFinalError extends CoreError {
  constructor(paymentId: string, status: string) {
    super(
      "PAYMENT_FINAL",
      `Payment ${paymentId} is in final state ${status}`,
      { paymentId, status },
    );
  }
}
