// @payswitch/api — EngineModule global : registre providers (config-driven)
// + engines TEST/LIVE (même store). Injecté par tous les modules métier
// (Nest : les providers d'AppModule ne descendent pas dans les feature modules).

import { Global, Module } from "@nestjs/common";
import { PayswitchConfig } from "../config/payswitch-config";
import { PayswitchConfigModule } from "../config/payswitch-config.module";
import { PAYMENT_PROVIDERS, buildProviderRegistry } from "../config/providers";
import { DatabaseModule } from "../infrastructure/database/database.module";
import { TypeOrmStore } from "../infrastructure/database/typeorm-store";
import { LIVE_ENGINE, TEST_ENGINE, buildEngines } from "./engine.provider";

@Global()
@Module({
  imports: [PayswitchConfigModule, DatabaseModule],
  providers: [
    {
      provide: PAYMENT_PROVIDERS,
      inject: [PayswitchConfig],
      useFactory: (cfg: PayswitchConfig) => buildProviderRegistry(cfg),
    },
    {
      provide: TEST_ENGINE,
      inject: [TypeOrmStore, PayswitchConfig],
      useFactory: (store: TypeOrmStore, cfg: PayswitchConfig) => buildEngines(store, cfg).test,
    },
    {
      provide: LIVE_ENGINE,
      inject: [TypeOrmStore, PayswitchConfig],
      useFactory: (store: TypeOrmStore, cfg: PayswitchConfig) => buildEngines(store, cfg).live,
    },
  ],
  exports: [PAYMENT_PROVIDERS, TEST_ENGINE, LIVE_ENGINE],
})
export class EngineModule {}
