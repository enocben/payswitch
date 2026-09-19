// @payswitch/api — instances PaymentEngine injectables (composition, pas `new`
// dans les services : la factory assemble store + adapters + config).
// TEST = mocks (mg_test_, cycle complet sans appel réel). LIVE = adapters
// réels uniquement (v1 : aucun → 422, jamais de faux débit sur Mock).

import { PaymentEngine } from "../engine/payment-engine";
import { TypeOrmStore } from "../infrastructure/database/typeorm-store";
import { PayswitchConfig } from "../config/payswitch-config";
import { buildProviderRegistry } from "../config/providers";

export const TEST_ENGINE = Symbol("TEST_ENGINE");
export const LIVE_ENGINE = Symbol("LIVE_ENGINE");

export function buildEngines(store: TypeOrmStore, cfg: PayswitchConfig): { test: PaymentEngine; live: PaymentEngine } {
  const registry = buildProviderRegistry(cfg);
  const common = {
    store,
    expirationHoursRaw: cfg.paymentExpirationHoursRaw,
  };
  return {
    test: new PaymentEngine({ ...common, providers: registry.test }),
    live: new PaymentEngine({ ...common, providers: registry.live }),
  };
}
