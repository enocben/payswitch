// @payswitch/api — DTO PUT /api/v1/routing (spec §7.2, US-15).
// Réordonne UNIQUEMENT (jamais d'activation — invariant 1).

import { ApiProperty } from "@nestjs/swagger";
import { ArrayMinSize, IsArray, IsString } from "class-validator";

export class UpdateRoutingDto {
  @ApiProperty({ example: "CD" })
  @IsString()
  country!: string;

  @ApiProperty({ example: "AIRTEL" })
  @IsString()
  network!: string;

  @ApiProperty({ example: ["mockprimary", "mocksecondary"] })
  @IsArray()
  @ArrayMinSize(1)
  @IsString({ each: true })
  providers!: string[];
}
