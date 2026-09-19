import { Controller, Param, Post, Req, Res } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import type { Request, Response } from "express";
import { Public } from "../api-keys/api-key.guard";
import { InboundWebhooksService } from "./inbound-webhooks.service";

@ApiTags("webhooks-inbound")
@Controller("webhooks")
export class InboundWebhooksController {
  constructor(private readonly inbound: InboundWebhooksService) {}

  @Post(":provider")
  @Public()
  async handle(@Param("provider") provider: string, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const { body, status } = await this.inbound.handle(provider, req);
    res.status(status);
    return body;
  }
}
