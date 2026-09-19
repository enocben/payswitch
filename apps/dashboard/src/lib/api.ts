/**
 * Typed API client strictly against the documented REST contract (spec §7.2).
 * Base URL via VITE_API_URL. Session auth uses HttpOnly cookies, hence
 * `credentials: "include"` on every call. No fake data is ever produced here:
 * on network/API errors the caller renders an honest error/empty state.
 */
import type {
  CollectionBucket,
  Collections,
  Country,
  Network,
  Paginated,
  Payment,
  PaymentFilters,
  RoutingEntry,
} from "./types";

function readEnvBase(): string {
  try {
    const v = (import.meta as unknown as { env?: Record<string, string | undefined> }).env
      ?.VITE_API_URL as string | undefined;
    return (v ?? "").replace(/\/$/, "");
  } catch {
    return "";
  }
}

export const API_BASE: string = readEnvBase();

export class ApiError extends Error {
  status: number;
  code?: string;
  requestId?: string;
  constructor(status: number, message: string, code?: string, requestId?: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.requestId = requestId;
  }
}

function url(path: string): string {
  return `${API_BASE}${path}`;
}

/** Exported for unit tests (pure URL building). */
export function buildUrl(path: string, base: string): string {
  return `${base.replace(/\/$/, "")}${path}`;
}

function query(params: Record<string, string | number | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== "") sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : "";
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url(path), {
      credentials: "include",
      ...init,
      headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    });
  } catch (e) {
    throw new ApiError(0, `API unreachable (${API_BASE || "same-origin"}): ${(e as Error).message}`, "NETWORK_ERROR");
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  const body = text ? (JSON.parse(text) as unknown) : undefined;
  if (!res.ok) {
    const err = (body as { error?: { code?: string; message?: string; request_id?: string } } | undefined)?.error;
    throw new ApiError(res.status, err?.message ?? `Request failed (${res.status})`, err?.code, err?.request_id);
  }
  return body as T;
}

/* ---------- auth (session cookies; login rate-limited server-side) ---------- */

export interface LoginResponse {
  ok: boolean;
  /** Present only when the API opts into a JSON session marker (cookies remain the session). */
  user?: { email?: string };
}

/** Assumed contract: POST /api/v1/auth/login {email, password} → 200 + HttpOnly session cookie. */
export function login(email: string, password: string): Promise<LoginResponse> {
  return request<LoginResponse>("/api/v1/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });
}

export function logout(): Promise<void> {
  return request<void>("/api/v1/auth/logout", { method: "POST", body: "{}" });
}

/* ---------- payments ---------- */

export function listPayments(filters: PaymentFilters = {}): Promise<Paginated<Payment>> {
  const q = query({
    status: filters.status,
    country: filters.country,
    network: filters.network,
    provider: filters.provider,
    phone: filters.phone,
    external_reference: filters.externalReference,
    from: filters.from,
    to: filters.to,
    page: filters.page,
    per_page: filters.perPage,
  });
  return request<Paginated<Payment>>(`/api/v1/payments${q}`);
}

export function getPayment(id: string): Promise<Payment> {
  return request<Payment>(`/api/v1/payments/${encodeURIComponent(id)}`);
}

/* ---------- reference data ---------- */

export function listCountries(): Promise<Country[] | { data: Country[] }> {
  return request<Country[] | { data: Country[] }>("/api/v1/countries");
}

export function listNetworks(country?: string): Promise<Network[] | { data: Network[] }> {
  return request<Network[] | { data: Network[] }>(`/api/v1/networks${query({ country })}`);
}

/* ---------- routing (priority reorder only; no enable/disable in v1) ---------- */

export function getRouting(): Promise<RoutingEntry[] | { data: RoutingEntry[] }> {
  return request<RoutingEntry[] | { data: RoutingEntry[] }>("/api/v1/routing");
}

export interface RoutingUpdate {
  country: string;
  network: string;
  providers: string[];
  /** Free-text audit note recorded server-side in AuditLog. */
  auditNote?: string;
}

export function putRouting(entries: RoutingUpdate[]): Promise<RoutingEntry[]> {
  return request<RoutingEntry[]>("/api/v1/routing", {
    method: "PUT",
    body: JSON.stringify(entries),
  });
}

/* ---------- collections (read-only aggregates) ---------- */

export interface CollectionFilters {
  country?: string;
  network?: string;
  provider?: string;
  from?: string;
  to?: string;
}

export function getCollections(filters: CollectionFilters = {}): Promise<Collections> {
  const q = query({ ...filters });
  return request<Collections>(`/api/v1/collections${q}`);
}

/** CSV export shares the same filters; returns a same-origin/absolute link for download. */
export function collectionsExportLink(filters: CollectionFilters = {}): string {
  const q = query({ format: "csv", ...filters });
  return url(`/api/v1/collections/export${q}`);
}

/** Buckets may arrive shaped {key,...} or as record maps; normalize defensively. */
export function normalizeBuckets(raw: unknown): CollectionBucket[] {
  if (Array.isArray(raw)) return raw as CollectionBucket[];
  if (raw && typeof raw === "object") {
    return Object.entries(raw as Record<string, number | { totalMinor?: number; total_minor?: number; count?: number; currency?: string }>).map(
      ([key, v]) => {
        if (typeof v === "number") return { key, totalMinor: v, count: 0 };
        return {
          key,
          totalMinor: v.totalMinor ?? v.total_minor ?? 0,
          count: v.count ?? 0,
          currency: v.currency,
        };
      },
    );
  }
  return [];
}
