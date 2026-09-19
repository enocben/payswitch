import { Module } from "@nestjs/common";
import { MerchantWebhooksModule } from "../modules/merchant-webhooks/merchant-webhooks.module";
import { JobsService } from "./jobs.service";

@Module({
  imports: [MerchantWebhooksModule],
  providers: [JobsService],
})
export class JobsModule {}
