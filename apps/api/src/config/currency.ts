// @payswitch/api — conversion humain ↔ minor (spec §7.4).
// Interne : BIGINT amount_minor partout. Frontière API : montant humain
// converti via le nombre de décimales ISO 4217 (XAF/XOF/UGX = 0, CDF = 2).

/** Décimales ISO 4217 ; défaut 2 pour les devises non listées. */
const MINOR_DIGITS: Record<string, number> = {
  XAF: 0,
  XOF: 0,
  UGX: 0,
  CDF: 2,
  USD: 2,
  EUR: 2,
};

export function minorDigits(currency: string): number {
  return MINOR_DIGITS[currency.toUpperCase()] ?? 2;
}

/** "5000" CDF → 500000n ; "5000" XAF → 5000n. Rejette > décimales autorisées. */
export function toMinor(amount: string, currency: string): bigint {
  const digits = minorDigits(currency);
  const m = /^(-?\d+)(?:\.(\d+))?$/.exec(amount.trim());
  if (!m) throw new Error(`Invalid amount: ${amount}`);
  if ((m[2] ?? "").length > digits) {
    throw new Error(`Too many decimals for ${currency}: ${amount}`);
  }
  const frac = (m[2] ?? "").padEnd(digits, "0");
  const minor = BigInt(m[1] + frac);
  if (minor <= 0n) throw new Error(`Amount must be > 0: ${amount}`);
  return minor;
}

/** 500000n CDF → "5000" ; 5000n XAF → "5000". */
export function fromMinor(amountMinor: bigint, currency: string): string {
  const digits = minorDigits(currency);
  if (digits === 0) return amountMinor.toString();
  const neg = amountMinor < 0n;
  const abs = neg ? -amountMinor : amountMinor;
  const s = abs.toString().padStart(digits + 1, "0");
  const head = s.slice(0, -digits);
  const tail = s.slice(-digits).replace(/0+$/, "");
  return `${neg ? "-" : ""}${head}${tail ? `.${tail}` : ""}`;
}
