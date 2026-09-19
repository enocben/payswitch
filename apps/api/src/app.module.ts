// @payswitch/api — AppModule (spec §14).
// Config globale → Database (TypeORM PG) → Engine global (registre +
// TEST/LIVE) → modules métier → jobs. Guard X-API-Key global (sauf @Public),
// throttling, scheduling. Ordre Nest : module → controller → service → dto → spec.

import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { APP_GUARD } from "@nestjs/core";
import { ScheduleModule } from "@nestjs/schedule";
import { ThrottlerGuard, ThrottlerModule } from "@nestjs/throttler";
import { PayswitchConfigModule } from "./config/payswitch-config.module";
import { EngineModule } from "./engine/engine.module";
import { DatabaseModule } from "./infrastructure/database/database.module";
import { ApiKeysModule } from "./modules/api-keys/api-keys.module";
import { ApiKeyGuard } from "./modules/api-keys/api-key.guard";
import { HealthModule } from "./modules/health/health.module";
import { InboundWebhooksModule } from "./modules/webhooks-inbound/inbound-webhooks.module";
import { JobsModule } from "./jobs/jobs.module";
import { MerchantWebhooksModule } from "./modules/merchant-webhooks/merchant-webhooks.module";
import { PaymentsModule } from "./modules/payments/payments.module";
import { ProvidersModule } from "./modules/providers/providers.module";
import { RoutingModule } from "./modules/routing/routing.module";

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PayswitchConfigModule,
    ThrottlerModule.forRoot([{ name: "default", ttl: 60_000, limit: 300 }]),
    ScheduleModule.forRoot(),
    DatabaseModule,
    EngineModule,
    ApiKeysModule,
    HealthModule,
    PaymentsModule,
    InboundWebhooksModule,
    MerchantWebhooksModule,
    RoutingModule,
    ProvidersModule,
    JobsModule,
  ],
  providers: [{ provide: APP_GUARD, useExisting: ApiKeyGuard }],
})
export class AppModule {}
