// @payswitch/api — ApiKeysService : création (secret 1 fois), vérification
// Argon2, révocation immédiate. Store stubbé en mémoire (pas de PG).

import { UnauthorizedException } from "@nestjs/common";
import { Test, TestingModule } from "@nestjs/testing";
import { ApiKeysService } from "./api-keys.service";
import { TypeOrmStore } from "../../infrastructure/database/typeorm-store";

interface Row {
  id: string;
  name: string;
  key_hash: string;
  prefix: string;
  scopes: string[];
  created_at: Date;
  last_used_at: Date | null;
  revoked_at: Date | null;
}

describe("ApiKeysService", () => {
  let service: ApiKeysService;
  const rows: Row[] = [];
  const stub = {
    insertApiKey: async (a: Omit<Row, "created_at" | "last_used_at" | "revoked_at">) => {
      const row: Row = { ...a, created_at: new Date(), last_used_at: null, revoked_at: null };
      rows.push(row);
      return row;
    },
    findApiKeyByPrefix: async (prefix: string) => rows.filter((r) => r.prefix === prefix),
    touchApiKey: async (id: string) => {
      const r = rows.find((x) => x.id === id);
      if (r) r.last_used_at = new Date();
    },
    listApiKeys: async () => rows,
    revokeApiKey: async (id: string) => {
      const r = rows.find((x) => x.id === id);
      if (r) r.revoked_at = new Date();
    },
  };

  beforeEach(async () => {
    rows.length = 0;
    const module: TestingModule = await Test.createTestingModule({
      providers: [ApiKeysService, { provide: TypeOrmStore, useValue: stub }],
    }).compile();
    service = module.get(ApiKeysService);
  });

  it("create → secret mg_test_ vérifiable, list ne l'expose pas", async () => {
    const { secret, record } = await service.create("spec-key", "test");
    expect(secret.startsWith("mg_test_")).toBe(true);
    const verified = await service.verify(secret);
    expect(verified.testMode).toBe(true);
    expect(verified.name).toBe("spec-key");
    const list = await service.list();
    expect(list).toHaveLength(1);
    expect(record).not.toHaveProperty("secret");
    expect(JSON.stringify(list)).not.toContain(secret.slice(9, 20));
  });

  it("clé inconnue → 401, clé révoquée → 401", async () => {
    await expect(service.verify("mg_test_bogus")).rejects.toThrow(UnauthorizedException);
    const { secret } = await service.create("revoked", "test");
    const list = await service.list();
    await service.revoke(list[0].id);
    await expect(service.verify(secret)).rejects.toThrow(UnauthorizedException);
  });
});
