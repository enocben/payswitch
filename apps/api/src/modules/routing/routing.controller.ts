import { Body, Controller, Get, Header, Put, Query, Req, Res } from "@nestjs/common";
import { ApiSecurity, ApiTags } from "@nestjs/swagger";
import type { Request, Response } from "express";
import { UpdateRoutingDto } from "./dto/update-routing.dto";
import { RoutingService, type CollectionFilters } from "./routing.service";

@ApiTags("routing")
@ApiSecurity("api-key")
@Controller("api/v1")
export class RoutingController {
  constructor(private readonly routing: RoutingService) {}

  @Get("routing")
  getRouting() {
    return this.routing.routing();
  }

  @Put("routing")
  update(@Body() dto: UpdateRoutingDto, @Req() req: Request) {
    return this.routing.update(dto, req);
  }

  @Get("countries")
  countries() {
    return this.routing.countries();
  }

  @Get("networks")
  networks(@Query("country") country?: string) {
    return this.routing.networks(country);
  }

  @Get("collections")
  collections(@Query() q: CollectionFilters) {
    return this.routing.collections(q);
  }

  @Get("collections/export")
  @Header("Content-Type", "text/csv")
  @Header("Content-Disposition", "attachment; filename=collections.csv")
  async exportCsv(@Query() q: CollectionFilters, @Res({ passthrough: true }) res: Response): Promise<string> {
    void res;
    return this.routing.collectionsCsv(q);
  }

  @Get("audit-logs")
  auditLogs(@Query("limit") limit?: string) {
    return this.routing.auditLogs(limit ? Number(limit) : 50);
  }
}
