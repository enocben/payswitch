// @payswitch/core — static routing (spec §9.2).
// RoutingRule order comes from config/DB priority; the core filters by
// supports() LOCAL (sync, in-memory — never network). Pure, zero I/O.

import { NoSupportedProviderError } from "../errors.js";
import type { SupportParams } from "../types.js";

export interface RoutingRule {
  country: string;
  network: string;
  /** Ordered provider codes, priority 1 first. */
  providers: string[];
}

export interface RoutableProvider {
  code: string;
  supports(params: SupportParams): boolean;
}

/**
 * Resolve Country+Network → ordered provider list, filtered by local supports().
 * Returns codes in priority order. Throws NO_SUPPORTED_PROVIDER when empty.
 */
export function resolveRoute(
  rule: RoutingRule | undefined,
  candidates: RoutableProvider[],
  params: Omit<SupportParams, "country" | "network"> & {
    country?: string;
    network?: string;
  },
): string[] {
  const country = (rule?.country ?? params.country ?? "").toUpperCase();
  const network = (rule?.network ?? params.network ?? "").toUpperCase();
  if (!rule || rule.providers.length === 0) {
    throw new NoSupportedProviderError(country, network);
  }
  const byCode = new Map(candidates.map((p) => [p.code, p]));
  const full: SupportParams = {
    country,
    network,
    currency: params.currency,
    amountMinor: params.amountMinor,
    operation: params.operation ?? "collect",
  };
  const eligible = rule.providers.filter((code) => {
    const provider = byCode.get(code);
    if (!provider) return false;
    return provider.supports(full) === true;
  });
  if (eligible.length === 0) {
    throw new NoSupportedProviderError(country, network);
  }
  return eligible;
}
