// @payswitch/api — webhooks sortants vers le marchand (spec §8.2, US-10).
// Secret généré serveur (whsec_...), affiché 1 fois, stocké hashé par la
// couche API ; le moteur signe ici le payload canonique en HMAC-SHA256
// (headers X-Webhook-Signature + X-Event-Id). Payload = event_id unique +
// attempt_id (idempotence marchand). Retry configurable :
// WEBHOOK_RETRY_SCHEDULE (défaut "1m,5m,15m,1h,6h,24h"), WEBHOOK_MAX_RETRIES.
// Pur, zéro I/O (le transport HTTP est injecté par l'appelant).

import { createHmac } from "node:crypto";
import type { PaymentStatus } from "@payswitch/core";
import type { MerchantEventType } from "./store.js";

/** Défaut spec §8.2. */
export const DEFAULT_RETRY_SCHEDULE = "1m,5m,15m,1h,6h,24h";
export const DEFAULT_MAX_RETRIES = 6;

const UNIT_MS: Record<string, number> = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/** Parse "1m,5m,15m,1h,6h,24h" → ms. Entrée invalide → défaut spec. */
export function parseRetrySchedule(raw: string | undefined): number[] {
  const fallback = parseRetryScheduleFallback();
  if (!raw || !raw.trim()) return fallback;
  const out: number[] = [];
  for (const part of raw.split(",")) {
    const m = part.trim().match(/^(\d+)\s*([smhd])$/i);
    if (!m) return fallback;
    out.push(Number(m[1]) * UNIT_MS[m[2].toLowerCase()]);
  }
  return out.length > 0 ? out : fallback;
}

function parseRetryScheduleFallback(): number[] {
  return [60_000, 300_000, 900_000, 3_600_000, 21_600_000, 86_400_000];
}

/** WEBHOOK_MAX_RETRIES : entier > 0, sinon défaut spec. */
export function maxRetries(raw: string | undefined): number {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_MAX_RETRIES;
}

/** Prochain retry après `failures` échecs (plafonné au dernier palier). */
export function computeNextRetryAt(nowMs: number, failures: number, schedule: number[]): string {
  const idx = Math.min(Math.max(failures - 1, 0), schedule.length - 1);
  return new Date(nowMs + schedule[idx]).toISOString();
}

/** HMAC-SHA256 hex du payload canonique (JSON stable, clés triées). */
export function signPayload(secret: string, payload: Record<string, unknown>): string {
  return createHmac("sha256", secret).update(canonicalJson(payload), "utf8").digest("hex");
}

export function canonicalJson(payload: Record<string, unknown>): string {
  return JSON.stringify(sortKeys(payload));
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v !== null && typeof v === "object") {
    return Object.fromEntries(
      Object.keys(v as Record<string, unknown>)
        .sort()
        .map((k) => [k, sortKeys((v as Record<string, unknown>)[k])]),
    );
  }
  return v;
}

/** État final → event marchand. expired/unknown → payment.unknown (spec §7.2 : seuls succeeded/failed/unknown sont notifiés). */
export function finalEventType(status: PaymentStatus): MerchantEventType | null {
  if (status === "succeeded") return "payment.succeeded";
  if (status === "failed") return "payment.failed";
  if (status === "unknown" || status === "expired") return "payment.unknown";
  return null;
}

/** Corps notifié : event_id + attempt_id + références traçables (US-10). */
export function buildPayload(args: {
  eventId: string;
  eventType: MerchantEventType;
  paymentId: string;
  attemptId?: string | null;
  status: PaymentStatus;
  amountMinor: string;
  currency: string;
  externalReference?: string | null;
  occurredAt: string;
}): Record<string, unknown> {
  return {
    attempt_id: args.attemptId ?? null,
    currency: args.currency,
    event_id: args.eventId,
    event_type: args.eventType,
    external_reference: args.externalReference ?? null,
    occurred_at: args.occurredAt,
    payment_id: args.paymentId,
    payment_status: args.status,
    amount_minor: args.amountMinor,
  };
}

/** Headers sortants (spec §8.2). */
export function deliveryHeaders(eventId: string, signature: string): Record<string, string> {
  return { "X-Event-Id": eventId, "X-Webhook-Signature": signature, "Content-Type": "application/json" };
}

/** Transport HTTP injecté (le moteur ne fait jamais de fetch direct). */
export type WebhookSender = (
  url: string,
  body: string,
  headers: Record<string, string>,
) => Promise<{ statusCode: number; body?: string }>;
