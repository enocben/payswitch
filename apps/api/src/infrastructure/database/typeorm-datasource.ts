// @payswitch/api — DataSource CLI pour TypeORM (migration:generate / migration:run).
// Usage : DATABASE_URL=... bunx typeorm migration:run -d src/infrastructure/database/typeorm-datasource.ts
//         DATABASE_URL=... bunx typeorm migration:generate -d src/infrastructure/database/typeorm-datasource.ts -n NomMigration
// Le DataSource applicatif (buildDataSource) partage la même config (entities + migrations).

import "reflect-metadata";
import { DataSource } from "typeorm";
import { ALL_ENTITIES } from "./entities";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set (see .env.example)");

export default new DataSource({
  type: "postgres",
  url,
  entities: ALL_ENTITIES,
  // TypeORM migrations (TS) — source de vérité, synchronize:false
  migrations: [__dirname + "/migrations/*.{ts,js}"],
  migrationsTableName: "typeorm_migrations",
  synchronize: false,
  logging: false,
  extra: { max: 10 },
});
