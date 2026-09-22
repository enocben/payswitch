#!/usr/bin/env node
// Wrapper TypeORM migration:generate -> avec DATABASE_URL + bon dossier
// Usage: DATABASE_URL=postgresql://... npm run migration:generate -- MaMigration
import { execSync, spawnSync } from "node:child_process";

const name = process.argv[2];
if (!name || name.startsWith("-")) {
  console.error("Usage: DATABASE_URL=... npm run migration:generate -- <NomMigration>");
  console.error("Ex: DATABASE_URL=... npm run migration:generate -- AddPayoutTable");
  process.exit(1);
}
if (!process.env.DATABASE_URL) {
  console.error("ERROR: DATABASE_URL is not set");
  console.error("Ex: DATABASE_URL=postgresql://payswitch:payswitch@127.0.0.1:5432/payswitch npm run migration:generate -- MaMigration");
  process.exit(1);
}
const extra = process.argv.slice(3).join(" ");
const target = `src/infrastructure/database/migrations/${name}`;
const cmd = `npx typeorm-ts-node-commonjs migration:generate -d src/infrastructure/database/typeorm-datasource.ts ${target} ${extra}`.trim();
console.log(`> ${cmd}`);
const r = spawnSync("npx", ["typeorm-ts-node-commonjs", "migration:generate", "-d", "src/infrastructure/database/typeorm-datasource.ts", target, ...process.argv.slice(3)], { stdio: "inherit" });
process.exit(r.status ?? 0);
