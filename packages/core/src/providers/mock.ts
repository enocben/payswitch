// @payswitch/core — MockProvider (spec §6.4, mandatory).
// Simulates: success, confirmed_failed, temporary_failure, timeout/unknown,
// pending, duplicate webhook, delayed webhook. Local in-memory only —
// never network. Respects supports() / supportsIdempotency() / mapNetwork().

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type {
  InitiateParams,
  InitiateResult,
  NormalizedError,
  NormalizedWebhookEvent,
  ProviderCapabilities,
  SupportParams,
  VerifyParams,
  VerifyResult,
} from "../types.js";
import type { PaymentProvider } from "./contract.js";

export type MockScenario =
  | "success"
  | "confirmed_failed"
  | "temporary_failure"
  | "timeout_unknown"
  | "pending";

export interface MockProviderOptions {
  code?: string;
  displayName?: string;
  capabilities: ProviderCapabilities;
  /** Defaults to capabilities.supports_idempotency. */
  supportsIdempotencyOverride?: boolean;
  scenario?: MockScenario;
  /** Local-only webhook secret for HMAC tests. */
  webhookSecret?: string;
}

const REDACTED = "[redacted]";

export class MockProvider implements PaymentProvider {
  readonly code: string;
  readonly displayName: string;
  private readonly capabilities: ProviderCapabilities;
  private readonly idempotent: boolean;
  private scenario: MockScenario;
  private readonly webhookSecret: string;
  /** Tracks initiate calls per providerIdempotencyKey (retry-same-key proof). */
  private readonly seenKeys = new Map<string, number>();

  constructor(options: MockProviderOptions) {
    this.code = options.code ?? "mock";
    this.displayName = options.displayName ?? "Mock Provider";
    this.capabilities = options.capabilities;
    this.idempotent =
      options.supportsIdempotencyOverride ??
      options.capabilities.supports_idempotency;
    this.scenario = options.scenario ?? "success";
    this.webhookSecret = options.webhookSecret ?? "mock-webhook-secret";
  }

  setScenario(scenario: MockScenario): void {
    this.scenario = scenario;
  }

  getScenario(): MockScenario {
    return this.scenario;
  }

  /** SYNC local capability check — no network, no async. */
  supports(params: SupportParams): boolean {
    const caps = this.capabilities;
    const country = params.country.toUpperCase();
    const network = params.network.toUpperCase();
    const currency = params.currency.toUpperCase();
    if (!caps.supported_countries.map((c) => c.toUpperCase()).includes(country)) {
      return false;
    }
    const networks = (caps.supported_networks[country] ?? []).map((n) =>
      n.toUpperCase(),
    );
    if (!networks.includes(network)) return false;
    if (
      !caps.supported_currencies.map((c) => c.toUpperCase()).includes(currency)
    ) {
      return false;
    }
    if (typeof params.amountMinor !== "bigint") return false;
    if (
      params.amountMinor < caps.min_amount_minor ||
      params.amountMinor > caps.max_amount_minor
    ) {
      return false;
    }
    const op = params.operation ?? "collect";
    if (!caps.operations.includes(op)) return false;
    return true;
  }

  supportsIdempotency(): boolean {
    return this.idempotent;
  }

  mapNetwork(internal: { country: string; network: string }): string {
    return `${internal.country.toUpperCase()}-${internal.network.toUpperCase()}`;
  }

  private referenceFor(params: InitiateParams): string {
    return `mock_${createHash("sha256")
      .update(params.providerIdempotencyKey, "utf8")
      .digest("hex")
      .slice(0, 16)}`;
  }

  async initiate(params: InitiateParams): Promise<InitiateResult> {
    const count = (this.seenKeys.get(params.providerIdempotencyKey) ?? 0) + 1;
    this.seenKeys.set(params.providerIdempotencyKey, count);
    const rawRequest = {
      provider: this.code,
      network: this.mapNetwork({
        country: params.country,
        network: params.network,
      }),
      amountMinor: params.amountMinor.toString(),
      currency: params.currency,
      phone: REDACTED,
      idempotencyKey: REDACTED,
    };

    switch (this.scenario) {
      case "success":
        return {
          providerReference: this.referenceFor(params),
          status: "pending",
          rawRequest,
          rawResponse: { accepted: true, scenario: this.scenario },
          outcome: "success",
          confirmed: false,
        };
      case "confirmed_failed":
        return {
          providerReference: this.referenceFor(params),
          status: "failed",
          rawRequest,
          rawResponse: {
            accepted: false,
            code: "MOCK_CONFIRMED_FAILED",
            scenario: this.scenario,
          },
          outcome: "definitive_failure",
          confirmed: true,
        };
      case "temporary_failure":
        return {
          providerReference: "",
          status: "unknown",
          rawRequest,
          rawResponse: {
            accepted: false,
            code: "MOCK_TEMPORARY",
            scenario: this.scenario,
          },
          outcome: "temporary_failure",
          confirmed: false,
        };
      case "timeout_unknown":
        return {
          providerReference: "",
          status: "unknown",
          rawRequest,
          rawResponse: {
            accepted: false,
            code: "MOCK_TIMEOUT",
            scenario: this.scenario,
          },
          outcome: "unknown",
          confirmed: false,
        };
      case "pending":
      default:
        return {
          providerReference: this.referenceFor(params),
          status: "pending",
          rawRequest,
          rawResponse: { accepted: true, scenario: this.scenario },
          outcome: "unknown",
          confirmed: false,
        };
    }
  }

  async verify(params: VerifyParams): Promise<VerifyResult> {
    const rawResponse = {
      providerReference: params.providerReference,
      scenario: this.scenario,
    };
    switch (this.scenario) {
      case "success":
        return { status: "succeeded", rawResponse };
      case "confirmed_failed":
        return { status: "confirmed_failed", rawResponse };
      case "timeout_unknown":
        return { status: "unknown", rawResponse };
      case "temporary_failure":
      case "pending":
      default:
        return { status: "pending", rawResponse };
    }
  }

  /** HMAC-SHA256 over rawBody, header `x-webhook-signature`. Sync, local. */
  signWebhook(rawBody: string): string {
    return createHmac("sha256", this.webhookSecret)
      .update(rawBody, "utf8")
      .digest("hex");
  }

  verifyWebhookSignature(
    rawBody: string,
    headers: Record<string, string>,
  ): boolean {
    const given = headers["x-webhook-signature"] ?? "";
    const expected = this.signWebhook(rawBody);
    if (given.length !== expected.length) return false;
    return timingSafeEqual(Buffer.from(given), Buffer.from(expected));
  }

  /**
   * Parse a mock webhook. providerEventId is deterministic (hash of rawBody),
   * so re-delivery of the same body yields the same id → duplicate detection
   * via UNIQUE(provider_id, provider_event_id). `occurred_at` in the body is
   * preserved for delayed-webhook tests.
   */
  parseWebhook(
    rawBody: string,
    _headers: Record<string, string>,
  ): NormalizedWebhookEvent {
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(rawBody) as Record<string, unknown>;
    } catch {
      throw new Error("Invalid mock webhook body: not JSON");
    }
    const providerReference = String(body["provider_reference"] ?? "");
    if (!providerReference) {
      throw new Error("Invalid mock webhook body: missing provider_reference");
    }
    const providerEventId =
      typeof body["event_id"] === "string" && body["event_id"]
        ? (body["event_id"] as string)
        : `mock_${createHash("sha256").update(rawBody, "utf8").digest("hex").slice(0, 16)}`;
    const rawStatus = String(body["status"] ?? "unknown");
    const status =
      rawStatus === "succeeded"
        ? "succeeded"
        : rawStatus === "confirmed_failed"
          ? "confirmed_failed"
          : "unknown";
    return { providerReference, providerEventId, status, rawBody: body };
  }

  normalizeError(rawError: unknown): NormalizedError {
    const err = (rawError ?? {}) as Record<string, unknown>;
    const code = String(err["code"] ?? "MOCK_UNKNOWN");
    switch (code) {
      case "MOCK_CONFIRMED_FAILED":
        return {
          code,
          message: "Mock definitive confirmed failure",
          outcome: "definitive_failure",
          confirmed: true,
          canRetry: false,
          canFallback: true,
          requiresVerification: false,
          rawError,
        };
      case "MOCK_TEMPORARY":
        return {
          code,
          message: "Mock temporary failure",
          outcome: "temporary_failure",
          confirmed: false,
          canRetry: true,
          canFallback: true,
          requiresVerification: false,
          rawError,
        };
      case "MOCK_TIMEOUT":
        return {
          code,
          message: "Mock timeout — state unknown",
          outcome: "unknown",
          confirmed: false,
          canRetry: false,
          canFallback: false,
          requiresVerification: true,
          rawError,
        };
      default:
        return {
          code,
          message: "Mock unknown error",
          outcome: "unknown",
          confirmed: false,
          canRetry: false,
          canFallback: false,
          requiresVerification: true,
          rawError,
        };
    }
  }

  /** Test helper: how many times initiate saw a given providerIdempotencyKey. */
  seenKeyCount(key: string): number {
    return this.seenKeys.get(key) ?? 0;
  }
}
