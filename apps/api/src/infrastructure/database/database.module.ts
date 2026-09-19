import { Global, Module } from "@nestjs/common";
import { TypeOrmModule, getDataSourceToken } from "@nestjs/typeorm";
import type { DataSource } from "typeorm";
import { PayswitchConfig } from "../../config/payswitch-config";
import { PayswitchConfigModule } from "../../config/payswitch-config.module";
import { ALL_ENTITIES } from "./entities";
import { TypeOrmStore } from "./typeorm-store";

/** Store partagé (transactions + SELECT FOR UPDATE) visible de tous les modules. */
@Global()
@Module({
  imports: [
    PayswitchConfigModule,
    TypeOrmModule.forRootAsync({
      inject: [PayswitchConfig],
      useFactory: (cfg: PayswitchConfig) => ({
        type: "postgres",
        url: cfg.databaseUrl,
        entities: ALL_ENTITIES,
        synchronize: false,
        logging: false,
        extra: { max: 10 },
      }),
    }),
  ],
  providers: [
    {
      provide: TypeOrmStore,
      inject: [getDataSourceToken()],
      useFactory: (ds: DataSource) => TypeOrmStore.forRoot(ds),
    },
  ],
  exports: [TypeOrmStore],
})
export class DatabaseModule {}
