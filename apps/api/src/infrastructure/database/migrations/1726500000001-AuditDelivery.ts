import { MigrationInterface, QueryRunner } from "typeorm";

export class AuditDelivery1726500000001 implements MigrationInterface {
  name = "AuditDelivery1726500000001";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
CREATE TABLE IF NOT EXISTS audit_logs (
  id            UUID PRIMARY KEY,
  action        TEXT NOT NULL,
  actor         TEXT NOT NULL,
  resource_type TEXT,
  resource_id   TEXT,
  old_value     JSONB,
  new_value     JSONB,
  ip            TEXT,
  request_id    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_audit_action ON audit_logs(action);
CREATE INDEX IF NOT EXISTS ix_audit_resource ON audit_logs(resource_type, resource_id) WHERE resource_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_audit_created ON audit_logs(created_at);

CREATE TABLE IF NOT EXISTS webhook_subscriptions (
  id          UUID PRIMARY KEY,
  url         TEXT NOT NULL,
  events      JSONB NOT NULL DEFAULT '[]',
  secret_hash TEXT NOT NULL,
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_websub_active ON webhook_subscriptions(is_active) WHERE is_active = TRUE;

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id                 UUID PRIMARY KEY,
  event_id           UUID NOT NULL UNIQUE,
  subscription_id    UUID NOT NULL REFERENCES webhook_subscriptions(id) ON DELETE CASCADE,
  payment_id         UUID REFERENCES payments(id) ON DELETE SET NULL,
  attempt_id         UUID REFERENCES payment_attempts(id) ON DELETE SET NULL,
  url                TEXT NOT NULL,
  event_type         TEXT NOT NULL,
  payload            JSONB NOT NULL DEFAULT '{}',
  signature          TEXT NOT NULL,
  status             TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','delivered','failed','retrying')),
  attempts           INT NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_retry_at      TIMESTAMPTZ,
  last_response_code INT,
  last_response_body TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_webdel_status_retry ON webhook_deliveries(status, next_retry_at);
CREATE INDEX IF NOT EXISTS ix_webdel_subscription ON webhook_deliveries(subscription_id);
CREATE INDEX IF NOT EXISTS ix_webdel_payment ON webhook_deliveries(payment_id) WHERE payment_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS dashboard_users (
  id            UUID PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  totp_secret   TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION purge_outbound_raw(retention INTERVAL DEFAULT INTERVAL '30 days')
RETURNS TABLE (deliveries_cleared INT) AS $$
DECLARE
  d INT;
BEGIN
  UPDATE webhook_deliveries SET payload = '{}'::jsonb, last_response_body = NULL, updated_at = now()
   WHERE created_at < now() - retention AND (payload <> '{}'::jsonb OR last_response_body IS NOT NULL);
  GET DIAGNOSTICS d = ROW_COUNT;
  RETURN QUERY SELECT d;
END;
$$ LANGUAGE plpgsql;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS dashboard_users, webhook_deliveries, webhook_subscriptions, audit_logs CASCADE`);
  }
}
