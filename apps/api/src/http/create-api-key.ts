// @payswitch/api — forge une clé API mg_live_/mg_test_ (spec §7.1).
// La clé complète s'affiche UNE SEULE FOIS ; seul le hash Argon2 + préfixe
// sont persistés (lookup préfixe + verify + revoked_at côté HTTP).
// Usage : bun src/http/create-api-key.ts --name backoffice [--live] [--scopes '["payments:write"]']

import { SQL } from "bun";
import { db, closeDb } from "../infrastructure/database/client.js";
import { RestStore } from "./rest.js";
import { hashSecret, mintKey } from "./auth.js";

const args = process.argv.slice(2);
const opt = (flag: string): string | undefined => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};

const name = opt("--name") ?? "dev";
const live = args.includes("--live");
const scopes = JSON.parse(opt("--scopes") ?? '["payments:read","payments:write","webhooks:write","admin"]') as string[];

const sql: SQL = db();
const rest = new RestStore(sql);
const { key, prefix } = mintKey(!live);
const keyHash = await hashSecret(key);
const { id } = await rest.createApiKey(name, prefix, keyHash, scopes);
console.log(JSON.stringify({ id, name, prefix, key, mode: live ? "live" : "test" }));
console.log("STORE THIS KEY NOW — it will never be shown again (only prefix+hash persist).");
await closeDb();
