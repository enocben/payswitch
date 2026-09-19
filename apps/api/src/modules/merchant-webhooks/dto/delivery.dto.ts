// @payswitch/api — DTOs webhooks sortants (spec §8.2, US-10).
// Le secret whsec_... est fourni par l'appelant à chaque enqueue (registre
// d'abonnements = migration 003) ; le serveur signe HMAC et persiste.

import { ApiProperty } from "@nestjs/swagger";
import { IsIn, IsOptional, IsString, IsUrl, MinLength } from "class-validator";

export class EnqueueDeliveryDto {
  @ApiProperty({ example: "01K..." })
  @IsString()
  payment_id!: string;

  @ApiProperty({ example: "https://marchand.example/wh/payswitch" })
  @IsUrl({ require_tld: false })
  url!: string;

  @ApiProperty({ example: "whsec_..." })
  @IsString()
  @MinLength(8)
  secret!: string;

  @ApiProperty({ required: false, enum: ["payment.succeeded", "payment.failed", "payment.unknown"] })
  @IsIn(["payment.succeeded", "payment.failed", "payment.unknown"])
  @IsOptional()
  event_type?: "payment.succeeded" | "payment.failed" | "payment.unknown";

  @ApiProperty({ required: false })
  @IsString()
  @IsOptional()
  attempt_id?: string;
}

export class ReplayDeliveryDto {
  @ApiProperty({ example: "whsec_..." })
  @IsString()
  @MinLength(8)
  secret!: string;
}
