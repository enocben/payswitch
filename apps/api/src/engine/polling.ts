// @payswitch/api — polling / expiration (spec §9.2 steps 5-6, US-11).
// Backoff : 30s, 2m, 5m, 10m, 30m, 1h, 2h. Le worker interroge
// listDuePayments() hors requête HTTP (jamais bloquant). Expiration :
// pending → expired, incertain → unknown, jamais failed.

/** Backoff verify/polling en millisecondes (spec §9.2). */
export const POLL_BACKOFF_MS: readonly number[] = [
  30_000,
  120_000,
  300_000,
  600_000,
  1_800_000,
  3_600_000,
  7_200_000,
];

/** Prochain poll après `failures` vérifications infructueuses (plafonné). */
export function computeNextPollAt(nowMs: number, failures: number): string {
  const idx = Math.min(Math.max(failures, 0), POLL_BACKOFF_MS.length - 1);
  return new Date(nowMs + POLL_BACKOFF_MS[idx]).toISOString();
}

/** Fenêtre métier : PAYMENT_EXPIRATION_HOURS, défaut spec 24h. */
export function expirationHours(raw: string | undefined): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 24;
}

export function computeExpiresAt(nowMs: number, hours: number): string {
  return new Date(nowMs + hours * 3_600_000).toISOString();
}
