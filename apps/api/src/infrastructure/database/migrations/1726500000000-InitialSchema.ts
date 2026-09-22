import { MigrationInterface, QueryRunner } from "typeorm";

export class InitialSchema1726500000000 implements MigrationInterface {
  name = "InitialSchema1726500000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS countries (
  id               UUID PRIMARY KEY,
  code             TEXT NOT NULL UNIQUE,
  name             TEXT NOT NULL,
  currency_default CHAR(3) NOT NULL,
  phone_prefix     TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS networks (
  id           UUID PRIMARY KEY,
  country_id   UUID NOT NULL REFERENCES countries(id) ON DELETE RESTRICT,
  code         TEXT NOT NULL,
  display_name TEXT NOT NULL,
  logo_url     TEXT,
  is_active    BOOLEAN NOT NULL DEFAULT TRUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_network_country_code UNIQUE (country_id, code)
);
CREATE INDEX IF NOT EXISTS ix_networks_country ON networks(country_id);

CREATE TABLE IF NOT EXISTS providers (
  id                   UUID PRIMARY KEY,
  code                 TEXT NOT NULL UNIQUE,
  display_name         TEXT NOT NULL,
  is_enabled           BOOLEAN NOT NULL DEFAULT TRUE,
  is_healthy           BOOLEAN NOT NULL DEFAULT TRUE,
  capabilities         JSONB NOT NULL DEFAULT '{}',
  supports_idempotency BOOLEAN NOT NULL DEFAULT TRUE,
  config               JSONB NOT NULL DEFAULT '{}',
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS routing_rules (
  id          UUID PRIMARY KEY,
  country_id  UUID NOT NULL REFERENCES countries(id) ON DELETE RESTRICT,
  network_id  UUID NOT NULL REFERENCES networks(id) ON DELETE RESTRICT,
  provider_id UUID NOT NULL REFERENCES providers(id) ON DELETE RESTRICT,
  priority    INT NOT NULL CHECK (priority >= 1),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_routing_triplet UNIQUE (country_id, network_id, provider_id),
  CONSTRAINT uq_routing_priority UNIQUE (country_id, network_id, priority)
);
CREATE INDEX IF NOT EXISTS ix_routing_lookup ON routing_rules(country_id, network_id, priority);

CREATE TABLE IF NOT EXISTS payments (
  id                  UUID PRIMARY KEY,
  idempotency_key     TEXT NOT NULL UNIQUE,
  request_hash        TEXT NOT NULL,
  external_reference  TEXT,
  amount_minor        BIGINT NOT NULL CHECK (amount_minor > 0),
  currency            CHAR(3) NOT NULL,
  phone               TEXT NOT NULL,
  phone_hash          TEXT NOT NULL,
  phone_last4         CHAR(4) NOT NULL,
  country_id          UUID NOT NULL REFERENCES countries(id) ON DELETE RESTRICT,
  network_id          UUID NOT NULL REFERENCES networks(id) ON DELETE RESTRICT,
  status              TEXT NOT NULL DEFAULT 'created' CHECK (status IN ('created','processing','pending','succeeded','failed','unknown','expired')),
  gross_amount_minor  BIGINT CHECK (gross_amount_minor IS NULL OR gross_amount_minor > 0),
  provider_fee_minor  BIGINT CHECK (provider_fee_minor IS NULL OR provider_fee_minor >= 0),
  net_amount_minor    BIGINT CHECK (net_amount_minor IS NULL OR net_amount_minor > 0),
  metadata            JSONB NOT NULL DEFAULT '{}',
  correlation_id      TEXT NOT NULL,
  request_id          TEXT NOT NULL,
  expires_at          TIMESTAMPTZ NOT NULL,
  poll_attempts       INT NOT NULL DEFAULT 0 CHECK (poll_attempts >= 0),
  next_poll_at        TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_payments_status ON payments(status);
CREATE INDEX IF NOT EXISTS ix_payments_next_poll ON payments(next_poll_at) WHERE next_poll_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_payments_status_poll ON payments(status, next_poll_at);
CREATE INDEX IF NOT EXISTS ix_payments_idem ON payments(idempotency_key);
CREATE INDEX IF NOT EXISTS ix_payments_external_ref ON payments(external_reference) WHERE external_reference IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_payments_phone_hash ON payments(phone_hash);

CREATE TABLE IF NOT EXISTS payment_attempts (
  id                       UUID PRIMARY KEY,
  payment_id               UUID NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
  provider_id              UUID NOT NULL REFERENCES providers(id) ON DELETE RESTRICT,
  attempt_number           INT NOT NULL CHECK (attempt_number >= 1),
  status                   TEXT NOT NULL DEFAULT 'created' CHECK (status IN ('created','sending','accepted','pending','succeeded','failed','timeout','unknown','cancelled')),
  provider_reference       TEXT,
  provider_idempotency_key TEXT NOT NULL,
  provider_raw_request     JSONB,
  provider_raw_response    JSONB,
  normalized_response      JSONB,
  error_code               TEXT,
  error_message            TEXT,
  error_outcome            TEXT CHECK (error_outcome IS NULL OR error_outcome IN ('definitive_failure','temporary_failure','unknown')),
  confirmed                BOOLEAN NOT NULL DEFAULT FALSE,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_attempt_number UNIQUE (payment_id, attempt_number)
);
CREATE INDEX IF NOT EXISTS ix_attempts_payment ON payment_attempts(payment_id);
CREATE INDEX IF NOT EXISTS ix_attempts_provider_key ON payment_attempts(provider_idempotency_key);
CREATE INDEX IF NOT EXISTS ix_attempts_status ON payment_attempts(status);

CREATE TABLE IF NOT EXISTS webhook_events (
  id                UUID PRIMARY KEY,
  provider_id       UUID NOT NULL REFERENCES providers(id) ON DELETE RESTRICT,
  payment_id        UUID REFERENCES payments(id) ON DELETE SET NULL,
  provider_event_id TEXT NOT NULL,
  raw_body          JSONB,
  signature_valid   BOOLEAN NOT NULL DEFAULT FALSE,
  normalized_status TEXT CHECK (normalized_status IS NULL OR normalized_status IN ('succeeded','confirmed_failed','pending','unknown')),
  is_late           BOOLEAN NOT NULL DEFAULT FALSE,
  processed_at      TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_webhook_provider_event UNIQUE (provider_id, provider_event_id)
);
CREATE INDEX IF NOT EXISTS ix_webhook_payment ON webhook_events(payment_id) WHERE payment_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS api_keys (
  id           UUID PRIMARY KEY,
  name         TEXT NOT NULL,
  key_hash     TEXT NOT NULL,
  prefix       TEXT NOT NULL,
  scopes       JSONB NOT NULL DEFAULT '[]',
  last_used_at TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at   TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS ix_apikeys_prefix ON api_keys(prefix);

DROP FUNCTION IF EXISTS purge_provider_raw(INTERVAL);
CREATE OR REPLACE FUNCTION purge_provider_raw(retention INTERVAL DEFAULT INTERVAL '30 days')
RETURNS TABLE (attempts_cleared INT, events_cleared INT) AS $$
DECLARE
  a INT; e INT;
BEGIN
  UPDATE payment_attempts SET provider_raw_request = NULL, provider_raw_response = NULL, updated_at = now()
   WHERE created_at < now() - retention AND (provider_raw_request IS NOT NULL OR provider_raw_response IS NOT NULL);
  GET DIAGNOSTICS a = ROW_COUNT;
  UPDATE webhook_events SET raw_body = NULL WHERE created_at < now() - retention AND raw_body IS NOT NULL;
  GET DIAGNOSTICS e = ROW_COUNT;
  RETURN QUERY SELECT a, e;
END;
$$ LANGUAGE plpgsql;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS api_keys, webhook_events, payment_attempts, payments, routing_rules, providers, networks, countries CASCADE`);
  }
}
