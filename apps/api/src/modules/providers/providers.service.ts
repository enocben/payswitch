// @payswitch/api — providers (spec §6.3, invariant 1).
// Expose la config (adapters instanciés, capabilities, supportsIdempotency)
// + le miroir DB (is_enabled/is_healthy, lecture seule v1).
// Le dashboard réordonne, jamais active/désactive.

import { Inject, Injectable } from "@nestjs/common";
import { PAYMENT_PROVIDERS, type ProviderRegistry } from "../../config/providers";
import { TypeOrmStore } from "../../infrastructure/database/typeorm-store";

@Injectable()
export class ProvidersService {
  constructor(
    @Inject(PAYMENT_PROVIDERS) private readonly registry: ProviderRegistry,
    @Inject(TypeOrmStore) private readonly store: TypeOrmStore,
  ) {}

  async list() {
    const codes = new Set([...this.registry.test.keys(), ...this.registry.live.keys()]);
    const rows = await Promise.all(
      [...codes].map(async (code) => {
        const adapter = this.registry.test.get(code) ?? this.registry.live.get(code);
        const db = await this.store.findProviderByCode(code).catch(() => null);
        return {
          code,
          display_name: adapter?.displayName ?? db?.display_name ?? code,
          mode: this.registry.live.has(code) ? "live" : "test",
          configured: true,
          enabled: db?.is_enabled ?? true,
          healthy: db?.is_healthy ?? true,
          supports_idempotency: adapter?.supportsIdempotency() ?? db?.supports_idempotency ?? false,
          capabilities: db?.capabilities ?? {},
        };
      }),
    );
    return rows;
  }
}
