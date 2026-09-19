// @payswitch/api — applique database/seeds/*.sql (idempotents, spec §13).
// Usage : DATABASE_URL=... bun scripts/seed.ts (ou bun run db:seed)

import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
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
  const SEEDS_DIR = findDir(join("database", "seeds"));
  const files = (await readdir(SEEDS_DIR)).filter((f) => f.endsWith(".sql")).sort();

  const ds = buildDataSource();
  await ds.initialize();
  try {
    for (const file of files) {
      const content = await readFile(join(SEEDS_DIR, file), "utf8");
      await ds.query(content);
      console.log(`+ seeded ${file}`);
    }
    const counts = (await ds.query(
      "SELECT (SELECT COUNT(*) FROM countries) AS countries, (SELECT COUNT(*) FROM networks) AS networks, (SELECT COUNT(*) FROM providers) AS providers, (SELECT COUNT(*) FROM routing_rules) AS routing_rules",
    )) as unknown[];
    console.log(counts[0]);
    console.log("seed: done");
  } finally {
    await ds.destroy();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
