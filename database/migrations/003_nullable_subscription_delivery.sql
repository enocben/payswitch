-- Payswitch v1 — migration 003 : align webhook_deliveries.subscription_id + payment_id nullable
-- Corrige le doublon 002 (002_webhook_delivery_audit supprimé) : les 2 colonnes
-- deviennent nullable pour que TypeORM (entities nullable) et RestStore (bun:sql)
-- puissent insérer via l'engine sans subscription (tests mémoire) sans violer NOT NULL.
ALTER TABLE webhook_deliveries ALTER COLUMN subscription_id DROP NOT NULL;
ALTER TABLE webhook_deliveries ALTER COLUMN payment_id DROP NOT NULL;
-- Nettoie l'entrée doublon (déjà supprimée en prod, IF EXISTS pour idempotence)
DELETE FROM schema_migrations WHERE version = '002_webhook_delivery_audit.sql';
