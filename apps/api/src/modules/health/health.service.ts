import { Inject, Injectable } from "@nestjs/common";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import { PAYMENT_PROVIDERS, type ProviderRegistry } from "../../config/providers";

@Injectable()
export class HealthService {
  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    @Inject(PAYMENT_PROVIDERS) private readonly registry: ProviderRegistry,
  ) {}

  async check(): Promise<Record<string, unknown>> {
    let db = "down";
    try {
      await this.ds.query("SELECT 1");
      db = "up";
    } catch {
      db = "down";
    }
    return {
      status: db === "up" ? "ok" : "degraded",
      db,
      providers: {
        test: [...this.registry.test.keys()],
        live: [...this.registry.live.keys()],
      },
      version: "0.1.0",
    };
  }
}
