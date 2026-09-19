// @payswitch/api — RoutingService : matrice Pays×Réseau, réordonnancement
// audit-logué (US-15), countries/networks seedés (§13), Collections lecture
// seule + export CSV (US-14 : agrégat succeeded, jamais un solde).

import { Inject, Injectable } from "@nestjs/common";
import type { PaymentEngine } from "../../engine/payment-engine";
import { TEST_ENGINE } from "../../engine/engine.provider";
import { TypeOrmStore } from "../../infrastructure/database/typeorm-store";
import { requestIdOf } from "../../common/request-id.middleware";
import { apiKeyOf } from "../api-keys/api-key.guard";
import { UpdateRoutingDto } from "./dto/update-routing.dto";

export interface CollectionFilters {
  country?: string;
  network?: string;
  provider?: string;
  from?: string;
  to?: string;
}

@Injectable()
export class RoutingService {
  // Le routage est store-level (même store pour TEST/LIVE) : TEST par convention.
  constructor(
    @Inject(TEST_ENGINE) private readonly engine: PaymentEngine,
    @Inject(TypeOrmStore) private readonly store: TypeOrmStore,
  ) {}

  routing() {
    return this.store.routingMatrix();
  }

  async update(dto: UpdateRoutingDto, req: unknown): Promise<string[]> {
    return this.engine.updateRouting({
      country: dto.country,
      network: dto.network,
      providers: dto.providers,
      actor: apiKeyOf(req).name,
      ip: (req as { ip?: string }).ip,
      requestId: requestIdOf(req),
    });
  }

  countries() {
    return this.store.listCountries();
  }

  networks(country?: string) {
    return this.store.listNetworks(country?.toUpperCase());
  }

  collections(f: CollectionFilters) {
    return this.store.collections({
      country: f.country?.toUpperCase(),
      network: f.network?.toUpperCase(),
      provider: f.provider,
      from: f.from ? new Date(f.from) : undefined,
      to: f.to ? new Date(f.to) : undefined,
    });
  }

  /** Export CSV avec les mêmes filtres (US-14). */
  async collectionsCsv(f: CollectionFilters): Promise<string> {
    const c = await this.collections(f);
    const lines = ["scope,key,total_minor,count"];
    for (const r of c.by_country) lines.push(`country,${r.country},${r.total_minor},${r.count}`);
    for (const r of c.by_network) lines.push(`network,${r.country}-${r.network},${r.total_minor},${r.count}`);
    for (const r of c.by_provider) lines.push(`provider,${r.provider},${r.total_minor},${r.count}`);
    return `${lines.join("\n")}\n`;
  }

  auditLogs(limit = 50) {
    return this.store.listAuditLogs(Math.min(limit, 200));
  }
}
