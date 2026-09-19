import { Module } from "@nestjs/common";
import { MerchantWebhooksController } from "./merchant-webhooks.controller";
import { MerchantWebhooksService } from "./merchant-webhooks.service";

@Module({
  controllers: [MerchantWebhooksController],
  providers: [MerchantWebhooksService],
  exports: [MerchantWebhooksService],
})
export class MerchantWebhooksModule {}
