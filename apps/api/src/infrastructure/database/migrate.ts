// @payswitch/api — applique database/migrations/*.sql dans l'ordre.
// Suivi via table schema_migrations (fichier = version). Usage :
//   DATABASE_URL=... bun src/infrastructure/database/migrate.ts

import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { db, closeDb } from "./client.js";

/** Remonte depuis ce fichier jusqu'à trouver database/migrations. */
function findDir(rel: string): string {
  let dir = import.meta.dir;
  for (let i = 0; i < 8; i++) {
    const candidate = join(dir, rel);
    if (existsSync(candidate)) return candidate;
    dir = dirname(dir);
  }
  throw new Error(`Cannot locate ${rel} from ${import.meta.dir}`);
}

const MIGRATIONS_DIR = findDir(join("database", "migrations"));

const files = (await readdir(MIGRATIONS_DIR))
  .filter((f) => f.endsWith(".sql"))
  .sort();

const sql = db();
await sql`CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`;
const applied = await sql`SELECT version FROM schema_migrations`;
const done = new Set((applied as { version: string }[]).map((r) => r.version));

for (const file of files) {
  if (done.has(file)) {
    console.log(`- skip ${file} (already applied)`);
    continue;
  }
  const content = await readFile(join(MIGRATIONS_DIR, file), "utf8");
  await sql.unsafe(content);
  await sql`INSERT INTO schema_migrations (version) VALUES (${file})`;
  console.log(`+ applied ${file}`);
}
await closeDb();
console.log("migrate: done");
