// @payswitch/api — ApiKeysService (spec §5.1, §7.1).
// Clés mg_live_/mg_test_ : complète affichée 1 fois, seul key_hash (Argon2)
// + prefix persistés. Révocation immédiate (revoked_at). mg_test_ = Mock,
// aucun appel réel. Multi-clés même en mono-tenant.

import { Inject, Injectable, UnauthorizedException } from "@nestjs/common";
import * as argon2 from "argon2";
import { randomBytes } from "node:crypto";
import { TypeOrmStore } from "../../infrastructure/database/typeorm-store";
import { uuidv7 } from "../../common/ids";

export type ApiKeyMode = "live" | "test";

export interface ApiKeyRecord {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

export interface VerifiedKey {
  name: string;
  mode: ApiKeyMode;
  scopes: string[];
  testMode: boolean;
}

const PREFIX: Record<ApiKeyMode, string> = { live: "mg_live_", test: "mg_test_" };

@Injectable()
export class ApiKeysService {
  constructor(@Inject(TypeOrmStore) private readonly store: TypeOrmStore) {}

  /** Crée une clé ; `secret` (clair) n'est retourné qu'ici, jamais stocké. */
  async create(name: string, mode: ApiKeyMode, scopes: string[] = ["payments:write", "payments:read"]): Promise<{ secret: string; record: ApiKeyRecord }> {
    const secret = `${PREFIX[mode]}${randomBytes(24).toString("base64url")}`;
    const keyHash = await argon2.hash(secret);
    const lookupPrefix = `${PREFIX[mode]}${secret.slice(PREFIX[mode].length, PREFIX[mode].length + 8)}`;
    const created = await this.insertKey({ name, keyHash, prefix: lookupPrefix, scopes });
    return { secret, record: created };
  }

  /** Vérifie X-API-Key → VerifiedKey ou throw 401 (sans distinguer les causes). */
  async verify(raw: string): Promise<VerifiedKey> {
    const mode: ApiKeyMode | null = raw.startsWith(PREFIX.live)
      ? "live"
      : raw.startsWith(PREFIX.test)
        ? "test"
        : null;
    if (!mode) throw new UnauthorizedException("Invalid API key");
    const lookupPrefix = `${PREFIX[mode]}${raw.slice(PREFIX[mode].length, PREFIX[mode].length + 8)}`;
    const candidates = await this.store.findApiKeyByPrefix(lookupPrefix);
    for (const c of candidates) {
      if (c.revoked_at) continue;
      if (await argon2.verify(c.key_hash, raw)) {
        await this.store.touchApiKey(c.id);
        return { name: c.name, mode, scopes: c.scopes ?? [], testMode: mode === "test" };
      }
    }
    throw new UnauthorizedException("Invalid API key");
  }

  async list(): Promise<ApiKeyRecord[]> {
    const rows = await this.store.listApiKeys();
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      prefix: r.prefix,
      scopes: r.scopes ?? [],
      created_at: r.created_at.toISOString(),
      last_used_at: r.last_used_at ? r.last_used_at.toISOString() : null,
      revoked_at: r.revoked_at ? r.revoked_at.toISOString() : null,
    }));
  }

  async revoke(id: string): Promise<void> {
    await this.store.revokeApiKey(id);
  }

  private async insertKey(args: { name: string; keyHash: string; prefix: string; scopes: string[] }): Promise<ApiKeyRecord> {
    const created = await this.store.insertApiKey({
      id: uuidv7(),
      name: args.name,
      key_hash: args.keyHash,
      prefix: args.prefix,
      scopes: args.scopes,
    });
    return {
      id: created.id,
      name: created.name,
      prefix: created.prefix,
      scopes: created.scopes ?? [],
      created_at: created.created_at.toISOString(),
      last_used_at: null,
      revoked_at: null,
    };
  }
}
