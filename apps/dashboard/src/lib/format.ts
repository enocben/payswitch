/** Display helpers. Amounts: minor units are the source of truth (BIGINT). */

const CURRENCY_FRACTION: Record<string, number> = {
  CDF: 2,
  XAF: 0,
  UGX: 0,
  XOF: 0,
  USD: 2,
  EUR: 2,
};

export function fractionFor(currency: string): number {
  return CURRENCY_FRACTION[currency?.toUpperCase()] ?? 2;
}

/** 500000 minor CDF → "5 000,00 CDF"-style via Intl; falls back to raw minor on bad input. */
export function formatMinor(amountMinor: number, currency: string): string {
  if (!Number.isFinite(amountMinor)) return "—";
  try {
    const fraction = fractionFor(currency);
    const major = amountMinor / 10 ** fraction;
    return (
      new Intl.NumberFormat(undefined, {
        style: "currency",
        currency: currency.toUpperCase(),
        minimumFractionDigits: fraction,
        maximumFractionDigits: fraction,
      }).format(major) + ` (${amountMinor} minor)`
    );
  } catch {
    return `${amountMinor} minor ${currency}`;
  }
}

/**
 * Mask a phone for display: keep country prefix + last 3 digits.
 * "+243815556678" → "+243****678". Already-masked input passes through.
 */
export function maskPhone(phone: string | null | undefined): string {
  if (!phone) return "—";
  if (phone.includes("****")) return phone;
  const digits = phone.replace(/[^\d+]/g, "");
  // Keep the +CCC country prefix and the last 3 digits (e.g. +243****678).
  const m = digits.match(/^(\+\d{3})(\d+)(\d{3})$/);
  if (!m) return phone.length > 6 ? `${phone.slice(0, 3)}****${phone.slice(-3)}` : "****";
  return `${m[1]}****${m[3]}`;
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

/** "2026-09-19T12:00" (datetime-local input) → ISO string. */
export function inputToIso(v: string): string | undefined {
  if (!v) return undefined;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}
