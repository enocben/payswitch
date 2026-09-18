// @payswitch/core — Country entity (spec §5.1). Pure data + validation, zero I/O.

export interface Country {
  id: string;
  /** ISO country code, e.g. "CD". */
  code: string;
  name: string;
  /** Default ISO 4217 currency, e.g. "CDF". */
  currency_default: string;
  created_at: string;
  updated_at: string;
}

const ISO_COUNTRY = /^[A-Z]{2}$/;
const ISO_CURRENCY = /^[A-Z]{3}$/;

export function createCountry(input: {
  id: string;
  code: string;
  name: string;
  currency_default: string;
}): Country {
  const code = input.code.toUpperCase();
  const currency_default = input.currency_default.toUpperCase();
  if (!ISO_COUNTRY.test(code)) {
    throw new Error(`Invalid ISO country code: ${input.code}`);
  }
  if (!ISO_CURRENCY.test(currency_default)) {
    throw new Error(`Invalid ISO 4217 currency: ${input.currency_default}`);
  }
  if (!input.name.trim()) {
    throw new Error("Country name must not be empty");
  }
  const now = new Date().toISOString();
  return {
    id: input.id,
    code,
    name: input.name,
    currency_default,
    created_at: now,
    updated_at: now,
  };
}
