// @payswitch/api — GET /health (public, spec §12).
// DB ping + résumé providers. Pas de PII, pas de secrets.

import { Controller, Get } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { HealthService } from "./health.service";
import { Public } from "../api-keys/api-key.guard";

@ApiTags("health")
@Controller("health")
export class HealthController {
  constructor(private readonly health: HealthService) {}

  @Get()
  @Public()
  check() {
    return this.health.check();
  }
}
