// @payswitch/api — applique database/migrations/*.sql dans l'ordre (TypeORM/pg,
// multi-statements OK via dataSource.query). Suivi via schema_migrations.
// Usage : DATABASE_URL=... bun scripts/migrate.ts (ou bun run db:migrate)

import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { buildDataSource } from "../src/infrastructure/database/data-source";

function findDir(rel: string): string {
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, rel);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`Cannot locate ${rel} from ${process.cwd()}`);
}

async function main(): Promise<void> {
  const MIGRATIONS_DIR = findDir(join("database", "migrations"));
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();

  const ds = buildDataSource();
  await ds.initialize();
  try {
    await ds.query(
      "CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())",
    );
    const applied = (await ds.query("SELECT version FROM schema_migrations")) as { version: string }[];
    const done = new Set(applied.map((r) => r.version));
    for (const file of files) {
      if (done.has(file)) {
        console.log(`- skip ${file} (already applied)`);
        continue;
      }
      const content = await readFile(join(MIGRATIONS_DIR, file), "utf8");
      await ds.query(content);
      await ds.query("INSERT INTO schema_migrations (version) VALUES ($1)", [file]);
      console.log(`+ applied ${file}`);
    }
    console.log(`migrate: done (${resolve(MIGRATIONS_DIR)})`);
  } finally {
    await ds.destroy();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
