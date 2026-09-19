// @payswitch/api — PII téléphone (spec §5.1) : hash de recherche + last4
// support + masquage logs. Le clair n'apparaît jamais dans les logs.

import { createHash } from "node:crypto";

/** SHA256 hex du numéro E.164 (recherche sans exposer le PII). */
export function hashPhone(phone: string): string {
  return createHash("sha256").update(phone, "utf8").digest("hex");
}

/** 4 derniers chiffres (support), "" si numéro trop court. */
export function last4(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  return digits.length >= 4 ? digits.slice(-4) : "";
}

/** Masquage logs : +243815678901 → +243****8901. */
export function maskPhone(phone: string): string {
  if (phone.length <= 6) return "****";
  return `${phone.slice(0, 4)}****${phone.slice(-4)}`;
}
