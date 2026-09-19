// @payswitch/api — client SQL (bun:sql, spec §14).
// Config via DATABASE_URL uniquement, jamais en dur. Le SQL métier vit
// dans postgres-store.ts ; les migrations/seeds à la racine database/.

import { SQL } from "bun";

let client: SQL | null = null;

/** Client partagé (bun:sql pool). Throw si DATABASE_URL absent. */
export function db(): SQL {
  if (!client) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set (see .env.example)");
    client = new SQL(url);
  }
  return client;
}

export async function closeDb(): Promise<void> {
  if (client) {
    await client.close();
    client = null;
  }
}
