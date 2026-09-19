// @payswitch/api — enregistrement providers (spec §6.3, invariant 1).
// Activation = config-driven : config/providers.ts + .env. La DB ne stocke
// que l'ordre de priorité. v1 : Mock seul (TEST illimité, LIVE sans provider
// réel → 422 NO_SUPPORTED_PROVIDER, jamais de faux débit réel).

import { MockProvider, type PaymentProvider, type ProviderCapabilities } from "@payswitch/core";
import { PayswitchConfig } from "./payswitch-config";

export const PAYMENT_PROVIDERS = Symbol("PAYMENT_PROVIDERS");
export const LIVE_PROVIDERS = Symbol("LIVE_PROVIDERS");

export interface ProviderRegistry {
  /** code → adapter (Mock : mockprimary, mocksecondary). */
  test: Map<string, PaymentProvider>;
  /** v1 : vide (1er provider réel = étape 10, un seul, E2E). */
  live: Map<string, PaymentProvider>;
}

const MOCK_CAPABILITIES: ProviderCapabilities = {
  supported_countries: ["CD", "CG", "CI"],
  supported_networks: { CD: ["AIRTEL", "ORANGE"], CG: ["AIRTEL"], CI: ["WAVE"] },
  supported_currencies: ["CDF", "XAF", "XOF"],
  min_amount_minor: 100n,
  max_amount_minor: 100_000_000n,
  operations: ["collect"],
  supports_idempotency: true,
};

const SCENARIOS = ["success", "confirmed_failed", "temporary_failure", "timeout_unknown", "pending"] as const;

/** Instancie les adapters avec secrets process.env (spec §6.3). */
export function buildProviderRegistry(cfg: PayswitchConfig): ProviderRegistry {
  const raw = cfg.mockScenario;
  const scenario = (SCENARIOS as readonly string[]).includes(raw) ? (raw as (typeof SCENARIOS)[number]) : "success";
  const test = new Map<string, PaymentProvider>([
    [
      "mockprimary",
      new MockProvider({
        code: "mockprimary",
        displayName: "Mock Primary",
        capabilities: { ...MOCK_CAPABILITIES },
        scenario,
      }),
    ],
    [
      "mocksecondary",
      new MockProvider({
        code: "mocksecondary",
        displayName: "Mock Secondary",
        capabilities: { ...MOCK_CAPABILITIES },
        scenario,
      }),
    ],
  ]);
  // Étape 10 : enregistrer ici le 1er adapter réel (pawapay OU cinetpay,
  // construit avec cfg.providerSecret(code, "apiKey")). Jamais les deux
  // d'un coup : un seul, E2E, puis les suivants un par un.
  const live = new Map<string, PaymentProvider>();
  return { test, live };
}
