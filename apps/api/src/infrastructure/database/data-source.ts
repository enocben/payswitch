// @payswitch/api — DataSource TypeORM (PostgreSQL, spec §14).
// synchronize: false — le schéma est possédé par les migrations TypeORM
// (apps/api/src/infrastructure/database/migrations/*.ts, table typeorm_migrations).
// Ce module = client/config uniquement, jamais de SQL métier éparpillé.

import { DataSource } from "typeorm";
import { ALL_ENTITIES } from "./entities";

export function buildDataSource(url?: string): DataSource {
  const databaseUrl = url ?? process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is not set (see .env.example)");
  return new DataSource({
    type: "postgres",
    url: databaseUrl,
    entities: ALL_ENTITIES,
    migrations: [__dirname + "/migrations/*.{ts,js}"],
    migrationsTableName: "typeorm_migrations",
    synchronize: false,
    logging: false,
    extra: { max: 10 },
  });
}

/** DataSource partagé du processus (migrations/seeds/scripts). */
let shared: DataSource | null = null;

export async function sharedDataSource(): Promise<DataSource> {
  if (shared?.isInitialized) return shared;
  shared = buildDataSource();
  await shared.initialize();
  return shared;
}

export async function closeSharedDataSource(): Promise<void> {
  if (shared?.isInitialized) await shared.destroy();
  shared = null;
}
