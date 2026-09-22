# Migrations — déprécié

Ce dossier contenait les migrations SQL brutes (`*.sql`) + le runner `apps/api/scripts/migrate.ts` (table `schema_migrations`).

Depuis le passage à **TypeORM entièrement**, la source de vérité est :

```
apps/api/src/infrastructure/database/migrations/*.ts
```

Table de suivi : `typeorm_migrations` (gérée par TypeORM, `synchronize: false`).

- Générer : `DATABASE_URL=... npm run migration:generate -- NomMigration`
- Lister : `npm run db:migrate:show`
- Appliquer : `npm run db:migrate`
- Revert : `npm run db:migrate:revert`

Les seeds SQL restent dans `database/seeds/*.sql` (`npm run db:seed`).
