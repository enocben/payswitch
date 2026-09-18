// @payswitch/core — PaymentProvider contract (spec §6.1, corrigé).
// supports() is SYNC + local (in-memory capabilities — never network).
// The core holds NO provider identifier: network mapping is per-adapter.

import type {
  InitiateParams,
  InitiateResult,
  NormalizedError,
  NormalizedWebhookEvent,
  SupportParams,
  VerifyParams,
  VerifyResult,
} from "../types.js";

export interface PaymentProvider {
  readonly code: string;
  readonly displayName: string;

  /** Sync local capability check — MUST NOT do network I/O. */
  supports(params: SupportParams): boolean;

  /** Native idempotency support. false → verify() before any blind retry. */
  supportsIdempotency(): boolean;

  initiate(params: InitiateParams): Promise<InitiateResult>;
  verify(params: VerifyParams): Promise<VerifyResult>;

  verifyWebhookSignature(
    rawBody: string,
    headers: Record<string, string>,
  ): boolean;

  parseWebhook(
    rawBody: string,
    headers: Record<string, string>,
  ): NormalizedWebhookEvent;

  normalizeError(rawError: unknown): NormalizedError;

  /** Map internal {country, network} to the provider's network id. */
  mapNetwork?(internal: { country: string; network: string }): string;
}

export type {
  InitiateParams,
  InitiateResult,
  NormalizedError,
  NormalizedWebhookEvent,
  SupportParams,
  VerifyParams,
  VerifyResult,
};
