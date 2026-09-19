// @payswitch/core — Network entity (spec §5.1).
// Identity is (country_id, code): CD-AIRTEL ≠ CG-AIRTEL. Pure, zero I/O.

export interface Network {
  id: string;
  country_id: string;
  /** Network code within the country, e.g. "AIRTEL". */
  code: string;
  display_name: string;
  logo_url?: string;
  is_active: boolean;
}

/**
 * Composite identity enforcing UNIQUE(country_id, code).
 * networkKey("CD","AIRTEL") !== networkKey("CG","AIRTEL").
 */
export function networkKey(countryCode: string, networkCode: string): string {
  return `${countryCode.toUpperCase()}-${networkCode.toUpperCase()}`;
}

export function createNetwork(input: {
  id: string;
  country_id: string;
  code: string;
  display_name: string;
  logo_url?: string;
  is_active?: boolean;
}): Network {
  const code = input.code.toUpperCase();
  if (!code.trim()) {
    throw new Error("Network code must not be empty");
  }
  if (!input.display_name.trim()) {
    throw new Error("Network display_name must not be empty");
  }
  return {
    id: input.id,
    country_id: input.country_id,
    code,
    display_name: input.display_name,
    logo_url: input.logo_url,
    is_active: input.is_active ?? true,
  };
}
