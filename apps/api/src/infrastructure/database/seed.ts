// @payswitch/api — applique database/seeds/*.sql (idempotents, spec §13).
// Usage : DATABASE_URL=... bun src/infrastructure/database/seed.ts

import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { db, closeDb } from "./client.js";

/** Remonte depuis ce fichier jusqu'à trouver database/seeds. */
function findDir(rel: string): string {
  let dir = import.meta.dir;
  for (let i = 0; i < 8; i++) {
    const candidate = join(dir, rel);
    if (existsSync(candidate)) return candidate;
    dir = dirname(dir);
  }
  throw new Error(`Cannot locate ${rel} from ${import.meta.dir}`);
}

const SEEDS_DIR = findDir(join("database", "seeds"));

const files = (await readdir(SEEDS_DIR))
  .filter((f) => f.endsWith(".sql"))
  .sort();

const sql = db();
for (const file of files) {
  const content = await readFile(join(SEEDS_DIR, file), "utf8");
  await sql.unsafe(content);
  console.log(`+ seeded ${file}`);
}
const counts = await sql`
  SELECT (SELECT COUNT(*) FROM countries) AS countries,
         (SELECT COUNT(*) FROM networks) AS networks,
         (SELECT COUNT(*) FROM providers) AS providers,
         (SELECT COUNT(*) FROM routing_rules) AS routing_rules`;
console.log(counts[0]);
await closeDb();
console.log("seed: done");
