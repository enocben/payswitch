// @payswitch/api — REST payments (spec §7.2).
// POST /api/v1/payments (rate-limité, 201/200/409/422), GET /:id (même état
// final que le webhook marchand, US-02), GET / (filtres + pagination).

import { Body, Controller, Get, Param, Post, Query, Req, Res } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { ApiQuery, ApiSecurity, ApiTags } from "@nestjs/swagger";
import type { Request, Response } from "express";
import { CreatePaymentDto } from "./dto/create-payment.dto";
import { ListPaymentsDto } from "./dto/list-payments.dto";
import { PaymentsService } from "./payments.service";

@ApiTags("payments")
@ApiSecurity("api-key")
@Controller("api/v1/payments")
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  @Post()
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  async create(@Body() dto: CreatePaymentDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const { body, status } = await this.payments.create(dto, req);
    res.status(status);
    return body;
  }

  @Get()
  @ApiQuery({ name: "status", required: false })
  @ApiQuery({ name: "country", required: false })
  @ApiQuery({ name: "network", required: false })
  list(@Query() dto: ListPaymentsDto) {
    return this.payments.list(dto);
  }

  @Get(":id")
  getById(@Param("id") id: string) {
    return this.payments.getById(id);
  }
}
