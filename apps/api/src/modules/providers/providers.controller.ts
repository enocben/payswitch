import { Controller, Get } from "@nestjs/common";
import { ApiSecurity, ApiTags } from "@nestjs/swagger";
import { ProvidersService } from "./providers.service";

@ApiTags("providers")
@ApiSecurity("api-key")
@Controller("api/v1/providers")
export class ProvidersController {
  constructor(private readonly providers: ProvidersService) {}

  @Get()
  list() {
    return this.providers.list();
  }
}
