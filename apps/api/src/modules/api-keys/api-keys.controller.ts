// @payswitch/api — admin clés API : création (secret affiché 1 fois),
// liste (jamais de secret), révocation immédiate.

import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post } from "@nestjs/common";
import { ApiSecurity, ApiTags } from "@nestjs/swagger";
import { ApiKeysService } from "./api-keys.service";
import { CreateApiKeyDto } from "./dto/create-api-key.dto";

@ApiTags("api-keys")
@ApiSecurity("api-key")
@Controller("api/v1/api-keys")
export class ApiKeysController {
  constructor(private readonly keys: ApiKeysService) {}

  @Post()
  async create(@Body() dto: CreateApiKeyDto) {
    const { secret, record } = await this.keys.create(dto.name, dto.mode ?? "test");
    // secret en clair UNE SEULE FOIS (spec §7.1) — le GET ne le rend jamais.
    return { ...record, secret };
  }

  @Get()
  list() {
    return this.keys.list();
  }

  @Delete(":id")
  @HttpCode(HttpStatus.NO_CONTENT)
  async revoke(@Param("id") id: string): Promise<void> {
    await this.keys.revoke(id);
  }
}
