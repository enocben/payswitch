// @payswitch/api — sortant marchand (spec §8.2).
// Secret whsec_... : généré serveur, affiché 1 fois, seul le hash Argon2 est
// persisté. La signature HMAC-SHA256 reste re-dérivable après restart via
//   secret = "whsec_" + hex(HMAC_SHA256(master, subscription_id))
// (master = WEBHOOK_OUTBOUND_SECRET, jamais en DB/logs).
// Worker non-bloquant : fetch marchand hors requête, retry backoff configurable.

import { createHmac } from "node:crypto";

/** Dérive le secret signataire d'un abonnement (recalculable, jamais stocké). */
export function deriveSubSecret(master: string, subscriptionId: string): string {
  const hex = createHmac("sha256", master).update(subscriptionId, "utf8").digest("hex").slice(0, 32);
  return `whsec_${hex}`;
}

/** JSON canonique (clés triées, récursif) — la signature porte sur ces octets. */
export function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** Signature HMAC-SHA256 hex du body canonique (header X-Webhook-Signature). */
export function signPayload(secret: string, canonicalBody: string): string {
  return createHmac("sha256", secret).update(canonicalBody, "utf8").digest("hex");
}

export interface OutboundPayload {
  event_id: string;
  event_type: string;
  payment_id: string;
  status: string;
  amount_minor: number;
  currency: string;
  country: string;
  network: string;
  external_reference: string | null;
  occurred_at: string;
}

/** Durées "1m,5m,15m,1h,6h,24h" → ms. Unités : s/m/h/d. */
export function parseRetrySchedule(raw: string | undefined, fallback: number[]): number[] {
  if (!raw?.trim()) return fallback;
  const out: number[] = [];
  for (const part of raw.split(",")) {
    const m = /^\s*(\d+)\s*([smhd])\s*$/i.exec(part);
    if (!m) continue;
    const n = Number(m[1]);
    const mult = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2].toLowerCase() as "s" | "m" | "h" | "d"];
    out.push(n * mult);
  }
  return out.length > 0 ? out : fallback;
}

export const DEFAULT_RETRY_SCHEDULE = [60_000, 300_000, 900_000, 3_600_000, 21_600_000, 86_400_000];
export const MAX_BODY_LOG = 2000;

export function nextRetryAt(nowMs: number, attempts: number, schedule: number[]): string {
  const delay = schedule[Math.min(Math.max(attempts - 1, 0), schedule.length - 1)];
  return new Date(nowMs + delay).toISOString();
}
