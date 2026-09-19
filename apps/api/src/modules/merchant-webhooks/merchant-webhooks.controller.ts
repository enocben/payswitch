import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from "@nestjs/common";
import { ApiSecurity, ApiTags } from "@nestjs/swagger";
import { EnqueueDeliveryDto, ReplayDeliveryDto } from "./dto/delivery.dto";
import { MerchantWebhooksService } from "./merchant-webhooks.service";

@ApiTags("merchant-webhooks")
@ApiSecurity("api-key")
@Controller("api/v1/webhooks/deliveries")
export class MerchantWebhooksController {
  constructor(private readonly deliveries: MerchantWebhooksService) {}

  @Post()
  enqueue(@Body() dto: EnqueueDeliveryDto) {
    return this.deliveries.enqueue(dto);
  }

  @Get()
  list(@Query("limit") limit?: string) {
    return this.deliveries.list(limit ? Number(limit) : 50);
  }

  @Post(":id/replay")
  @HttpCode(HttpStatus.CREATED)
  replay(@Param("id") id: string, @Body() dto: ReplayDeliveryDto) {
    return this.deliveries.replay(id, dto.secret);
  }
}
