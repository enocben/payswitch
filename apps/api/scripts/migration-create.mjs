#!/usr/bin/env node
// Wrapper TypeORM migration:create -> toujours dans le bon dossier
// Usage: npm run migration:create -- MaMigration
//        npm run migration:create -- MaMigration -- --timestamp 123
import { execSync } from "node:child_process";

const name = process.argv[2];
if (!name || name.startsWith("-")) {
  console.error("Usage: npm run migration:create -- <NomMigration>");
  console.error("Ex: npm run migration:create -- AddPayoutTable");
  process.exit(1);
}
const extra = process.argv.slice(3).join(" ");
const target = `src/infrastructure/database/migrations/${name}`;
const cmd = `npx typeorm migration:create ${target} ${extra}`.trim();
console.log(`> ${cmd}`);
execSync(cmd, { stdio: "inherit" });
