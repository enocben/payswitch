// @payswitch/api — DTO POST /api/v1/payments (spec §7.2).
// amount = format humain ("5000" ou 5000) converti en amount_minor via le
// facteur devise ISO 4217 (config/currency.ts). Jamais de float interne.

import { ApiProperty } from "@nestjs/swagger";
import {
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsPhoneNumber,
  IsString,
  Matches,
  ValidateIf,
} from "class-validator";

export class CreatePaymentDto {
  @ApiProperty({ example: "5000", description: "Montant humain (string décimale ou nombre entier)" })
  @ValidateIf((_, v) => typeof v === "string")
  @IsString()
  @Matches(/^\d+(?:\.\d+)?$/, { message: "amount must be a positive decimal string" })
  amount!: string | number;

  @ApiProperty({ example: "CDF" })
  @IsString()
  @Matches(/^[A-Za-z]{3}$/, { message: "currency must be ISO 4217 (3 letters)" })
  currency!: string;

  @ApiProperty({ example: "+243810000001" })
  @IsPhoneNumber()
  phone!: string;

  @ApiProperty({ example: "CD" })
  @IsString()
  @IsNotEmpty()
  country!: string;

  @ApiProperty({ example: "AIRTEL" })
  @IsString()
  @IsNotEmpty()
  network!: string;

  @ApiProperty({ required: false, example: "ORDER-2026-00123" })
  @IsString()
  @IsOptional()
  external_reference?: string;

  @ApiProperty({ required: false })
  @IsObject()
  @IsOptional()
  metadata?: Record<string, unknown>;

  @ApiProperty({ example: "ORDER-2026-00123-PAYMENT" })
  @IsString()
  @IsNotEmpty()
  idempotency_key!: string;
}
