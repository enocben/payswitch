// @payswitch/api — config centralisée (ConfigModule + process.env, jamais en dur).
// Défauts spec : PAYMENT_EXPIRATION_HOURS=24 (§9.2, US-11), retry sortant
// 1m,5m,15m,1h,6h,24h / max 6 (§8.2). Vague 1 : Pawapay, CinetPay (§6.3).

import { Inject, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

@Injectable()
export class PayswitchConfig {
  constructor(@Inject(ConfigService) private readonly config: ConfigService) {}

  get databaseUrl(): string {
    const url = this.config.get<string>("DATABASE_URL");
    if (!url) throw new Error("DATABASE_URL is not set (see .env.example)");
    return url;
  }

  get apiPort(): number {
    return Number(this.config.get<string>("API_PORT") ?? 3456);
  }

  /** Heures avant expiration : pending → expired, incertain → unknown (défaut 24). */
  get paymentExpirationHoursRaw(): string | undefined {
    return this.config.get<string>("PAYMENT_EXPIRATION_HOURS") || undefined;
  }

  get webhookRetryScheduleRaw(): string | undefined {
    return this.config.get<string>("WEBHOOK_RETRY_SCHEDULE") || undefined;
  }

  get webhookMaxRetriesRaw(): string | undefined {
    return this.config.get<string>("WEBHOOK_MAX_RETRIES") || undefined;
  }

  /** Scénario Mock (dev/test uniquement) : success par défaut. */
  get mockScenario(): string {
    return this.config.get<string>("MOCK_SCENARIO") ?? "success";
  }

  providerSecret(code: "pawapay" | "cinetpay", kind: "apiKey" | "webhookSecret"): string | undefined {
    const prefix = code.toUpperCase();
    const suffix = kind === "apiKey" ? "API_KEY" : "WEBHOOK_SECRET";
    const value = this.config.get<string>(`${prefix}_${suffix}`);
    if (!value || value === "***") return undefined;
    return value;
  }
}
