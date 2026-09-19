// @payswitch/api — DTOs clés API (spec §7.2 : POST /api/v1/api-keys).

import { ApiProperty } from "@nestjs/swagger";
import { IsIn, IsOptional, IsString, MinLength } from "class-validator";

export class CreateApiKeyDto {
  @ApiProperty({ example: "backend-prod" })
  @IsString()
  @MinLength(2)
  name!: string;

  @ApiProperty({ enum: ["live", "test"], default: "test" })
  @IsIn(["live", "test"])
  @IsOptional()
  mode?: "live" | "test";
}
