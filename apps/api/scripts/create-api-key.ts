// @payswitch/api — crée une clé API (secret affiché 1 fois, jamais stocké).
// Usage : DATABASE_URL=... bun scripts/create-api-key.ts <name> [live|test]
// Pratique pour le 1er accès avant d'utiliser POST /api/v1/api-keys.

import * as argon2 from "argon2";
import { randomBytes } from "node:crypto";
import { buildDataSource } from "../src/infrastructure/database/data-source";
import { uuidv7 } from "../src/common/ids";

async function main(): Promise<void> {
  const [name, modeArg] = process.argv.slice(2);
  if (!name) {
    console.error("usage: bun scripts/create-api-key.ts <name> [live|test]");
    process.exit(1);
  }
  const mode = modeArg === "live" ? "live" : "test";
  const prefix0 = mode === "live" ? "mg_live_" : "mg_test_";
  const secret = `${prefix0}${randomBytes(24).toString("base64url")}`;
  const lookupPrefix = `${prefix0}${secret.slice(prefix0.length, prefix0.length + 8)}`;

  const ds = buildDataSource();
  await ds.initialize();
  try {
    await ds.query(
      "INSERT INTO api_keys (id, name, key_hash, prefix, scopes) VALUES ($1, $2, $3, $4, $5)",
      [uuidv7(), name, await argon2.hash(secret), lookupPrefix, JSON.stringify(["payments:write", "payments:read"])],
    );
    console.log(`created ${mode} key "${name}"`);
    console.log(`X-API-Key: ${secret}`);
    console.log("Conservez-la : elle ne sera plus jamais affichée.");
  } finally {
    await ds.destroy();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
