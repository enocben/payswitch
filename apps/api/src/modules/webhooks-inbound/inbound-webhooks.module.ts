import { Module } from "@nestjs/common";
import { InboundWebhooksController } from "./inbound-webhooks.controller";
import { InboundWebhooksService } from "./inbound-webhooks.service";

@Module({
  controllers: [InboundWebhooksController],
  providers: [InboundWebhooksService],
})
export class InboundWebhooksModule {}
