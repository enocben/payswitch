// @payswitch/api — REST validation + erreurs uniformes (spec §7.3).
// Erreurs : { error: { code, message, details }, request_id } + header X-Request-Id.
// Validation : phone E.164, amount > 0, currency ISO 4217, country/network/provider.

export const E164 = /^\+[1-9]\d{7,14}$/;
export const ISO4217 = /^[A-Z]{3}$/;

/** Décimales humaines par devise (défaut 2) pour amount → amount_minor. */
const CURRENCY_DECIMALS: Record<string, number> = {
  CDF: 2, XAF: 0, XOF: 0, UGX: 0, USD: 2, EUR: 2,
};

export function decimalsFor(currency: string): number {
  return CURRENCY_DECIMALS[currency.toUpperCase()] ?? 2;
}

/** Convertit un montant humain (ex. 5000) en minor (ex. 500000, 2 décimales). */
export function toMinor(amount: number, currency: string): bigint {
  const factor = 10n ** BigInt(decimalsFor(currency));
  return BigInt(Math.round(amount * Number(factor)));
}

export function uuidv7(): string {
  const ms = Date.now();
  const hi = Math.floor(ms / 2 ** 32);
  const lo = ms >>> 0;
  const rnd = crypto.getRandomValues(new Uint8Array(8));
  const b = new Uint8Array(16);
  b[0] = (hi >>> 24) & 0xff;
  b[1] = (hi >>> 16) & 0xff;
  b[2] = (hi >>> 8) & 0xff;
  b[3] = hi & 0xff;
  b[4] = (lo >>> 24) & 0xff;
  b[5] = (lo >>> 16) & 0xff;
  b[6] = ((lo >>> 8) & 0x0f) | 0x70;
  b[7] = lo & 0xff;
  b[8] = (rnd[0] & 0x3f) | 0x80;
  b[9] = rnd[1];
  b.set(rnd.subarray(2), 10);
  const hex = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export interface ApiErrorBody {
  error: { code: string; message: string; details?: Record<string, unknown> };
  request_id: string;
}

/** Réponse d'erreur uniforme + X-Request-Id (spec §7.3). */
export function apiError(
  requestId: string,
  status: number,
  code: string,
  message: string,
  details?: Record<string, unknown>,
): Response {
  const body: ApiErrorBody = { error: { code, message, ...(details ? { details } : {}) }, request_id: requestId };
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "x-request-id": requestId },
  });
}

/** Réponse JSON ok (+ X-Request-Id). */
export function apiOk(requestId: string, status: number, data: unknown, extraHeaders?: Record<string, string>): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "x-request-id": requestId, ...extraHeaders },
  });
}

export function requestIdFrom(req: Request): string {
  return req.headers.get("x-request-id")?.trim() || uuidv7();
}

export interface CreatePaymentBody {
  amount?: unknown;
  amount_minor?: unknown;
  currency?: unknown;
  phone?: unknown;
  country?: unknown;
  network?: unknown;
  external_reference?: unknown;
  metadata?: unknown;
  idempotency_key?: unknown;
}

export interface ValidPayment {
  amountMinor: bigint;
  currency: string;
  phone: string;
  country: string;
  network: string;
  externalReference?: string;
  metadata: Record<string, unknown>;
  idempotencyKey: string;
}

/** Valide un body POST /payments. Throw { status, code, message, details }. */
export function validateCreatePayment(body: unknown): ValidPayment {
  const fail = (code: string, message: string, details?: Record<string, unknown>): never => {
    throw { status: 422, code, message, details };
  };
  if (typeof body !== "object" || body === null) fail("VALIDATION_ERROR", "Body must be a JSON object");
  const b = body as CreatePaymentBody;

  const currency = typeof b.currency === "string" ? b.currency.toUpperCase() : "";
  if (!ISO4217.test(currency)) fail("INVALID_CURRENCY", `Invalid ISO 4217 currency`, { field: "currency" });

  let amountMinor: bigint | null = null;
  if (b.amount_minor !== undefined && b.amount_minor !== null) {
    const n = typeof b.amount_minor === "string" ? Number(b.amount_minor) : b.amount_minor;
    if (typeof n !== "number" || !Number.isInteger(n) || n <= 0) {
      fail("INVALID_AMOUNT", "amount_minor must be an integer > 0", { field: "amount_minor" });
    }
    amountMinor = BigInt(n as number);
  } else if (b.amount !== undefined && b.amount !== null) {
    if (typeof b.amount !== "number" || !(b.amount as number > 0)) {
      fail("INVALID_AMOUNT", "amount must be a number > 0", { field: "amount" });
    }
    amountMinor = toMinor(b.amount as number, currency);
    if (amountMinor <= 0n) fail("INVALID_AMOUNT", "amount must be > 0", { field: "amount" });
  } else {
    fail("INVALID_AMOUNT", "amount or amount_minor is required", { field: "amount" });
  }

  if (typeof b.phone !== "string" || !E164.test(b.phone)) {
    fail("INVALID_PHONE", "Invalid E.164 phone number", { field: "phone" });
  }
  const country = typeof b.country === "string" ? b.country.toUpperCase() : "";
  const network = typeof b.network === "string" ? b.network.toUpperCase() : "";
  if (!country) fail("UNKNOWN_NETWORK", "country is required", { field: "country" });
  if (!network) fail("UNKNOWN_NETWORK", "network is required", { field: "network" });

  let metadata: Record<string, unknown> = {};
  if (b.metadata !== undefined) {
    if (typeof b.metadata !== "object" || b.metadata === null || Array.isArray(b.metadata)) {
      fail("VALIDATION_ERROR", "metadata must be an object", { field: "metadata" });
    }
    metadata = b.metadata as Record<string, unknown>;
  }
  const idempotencyKey =
    typeof b.idempotency_key === "string" && b.idempotency_key ? b.idempotency_key : uuidv7();

  return {
    amountMinor: amountMinor!,
    currency,
    phone: b.phone as string,
    country,
    network,
    externalReference: typeof b.external_reference === "string" ? b.external_reference : undefined,
    metadata,
    idempotencyKey,
  };
}

export const OUTBOUND_EVENTS = ["payment.succeeded", "payment.failed", "payment.unknown"] as const;

export function validateSubscription(body: unknown): { url: string; events: string[] } {
  if (typeof body !== "object" || body === null) {
    throw { status: 422, code: "VALIDATION_ERROR", message: "Body must be a JSON object" };
  }
  const b = body as { url?: unknown; events?: unknown };
  if (typeof b.url !== "string" || !b.url) {
    throw { status: 422, code: "VALIDATION_ERROR", message: "url is required", details: { field: "url" } };
  }
  const url: string = b.url;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw { status: 422, code: "VALIDATION_ERROR", message: "url must be a valid URL", details: { field: "url" } };
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw { status: 422, code: "VALIDATION_ERROR", message: "url must be http(s)", details: { field: "url" } };
  }
  if (!Array.isArray(b.events) || b.events.length === 0) {
    throw { status: 422, code: "VALIDATION_ERROR", message: "events must be a non-empty array", details: { field: "events" } };
  }
  const events: unknown[] = b.events;
  for (const e of events) {
    if (typeof e !== "string" || !(OUTBOUND_EVENTS as readonly string[]).includes(e)) {
      throw { status: 422, code: "VALIDATION_ERROR", message: `unsupported event: ${String(e)}`, details: { field: "events" } };
    }
  }
  return { url, events: [...new Set(events as string[])] };
}

/** Échappe une valeur CSV (RFC 4180). */
export function csvCell(v: unknown): string {
  const s = String(v ?? "");
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
