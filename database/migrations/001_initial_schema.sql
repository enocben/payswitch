-- Payswitch v1 — migration 001 : schéma initial (spec §5.1, corrigé).
-- Règles : BIGINT amount_minor partout (jamais decimal/float) ;
-- Network UNIQUE(country_id, code) ; WebhookEvent UNIQUE(provider_id, provider_event_id) ;
-- RoutingRule UNIQUE(country_id, network_id, provider_id) + UNIQUE(country_id, network_id, priority) ;
-- index status / next_poll_at / idempotency_key ; PII phone_hash + last4 ;
-- raw provider expurgés, rétention 30j (fonction purge_provider_raw()).

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ---------------------------------------------------------------- Countries
CREATE TABLE IF NOT EXISTS countries (
  id               UUID PRIMARY KEY,
  code             TEXT NOT NULL UNIQUE,          -- ISO : CD, CG, UG, CI
  name             TEXT NOT NULL,                 -- RDC, Congo, Ouganda, Côte d'Ivoire
  currency_default CHAR(3) NOT NULL,             -- CDF, XAF, UGX, XOF
  phone_prefix     TEXT,                          -- indicatif : +243, +242, +256, +225
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- Networks
CREATE TABLE IF NOT EXISTS networks (
  id           UUID PRIMARY KEY,
  country_id   UUID NOT NULL REFERENCES countries(id) ON DELETE RESTRICT,
  code         TEXT NOT NULL,                     -- AIRTEL, ORANGE, WAVE (portée pays)
  display_name TEXT NOT NULL,
  logo_url     TEXT,
  is_active    BOOLEAN NOT NULL DEFAULT TRUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_network_country_code UNIQUE (country_id, code)  -- CD-AIRTEL ≠ CG-AIRTEL
);
CREATE INDEX IF NOT EXISTS ix_networks_country ON networks(country_id);

-- ---------------------------------------------------------------- Providers
-- Activation = config-driven (.env + config/providers.ts). La DB ne stocke
-- que l'identité, les capabilities (miroir lecture) et la santé runtime ;
-- l'ordre de priorité vit dans routing_rules (spec §5.1, invariants).
CREATE TABLE IF NOT EXISTS providers (
  id                   UUID PRIMARY KEY,
  code                 TEXT NOT NULL UNIQUE,    -- mockprimary, mocksecondary (v1 : Mock seul)
  display_name         TEXT NOT NULL,
  is_enabled           BOOLEAN NOT NULL DEFAULT TRUE,   -- miroir config, jamais toggled par dashboard en v1
  is_healthy           BOOLEAN NOT NULL DEFAULT TRUE,   -- runtime, lecture seule en v1
  capabilities         JSONB NOT NULL DEFAULT '{}',     -- supported_countries/networks/currencies, min/max minor, operations
  supports_idempotency BOOLEAN NOT NULL DEFAULT TRUE,
  config               JSONB NOT NULL DEFAULT '{}',     -- JSON non sensible uniquement
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------- RoutingRules
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

-- ----------------------------------------------------------------- Payments
CREATE TABLE IF NOT EXISTS payments (
  id                  UUID PRIMARY KEY,
  idempotency_key     TEXT NOT NULL UNIQUE,      -- clé métier libre (uuid7 recommandé)
  request_hash        TEXT NOT NULL,             -- SHA256(payload normalisé)
  external_reference  TEXT,
  amount_minor        BIGINT NOT NULL CHECK (amount_minor > 0),
  currency            CHAR(3) NOT NULL,          -- ISO 4217 effective
  phone               TEXT NOT NULL,             -- E.164 (masqué en logs par l'API)
  phone_hash          TEXT NOT NULL,             -- SHA256(phone), recherche sans PII
  phone_last4         CHAR(4) NOT NULL,          -- 4 derniers chiffres (support)
  country_id          UUID NOT NULL REFERENCES countries(id) ON DELETE RESTRICT,
  network_id          UUID NOT NULL REFERENCES networks(id) ON DELETE RESTRICT,
  status              TEXT NOT NULL DEFAULT 'created'
                      CHECK (status IN ('created','processing','pending','succeeded','failed','unknown','expired')),
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

-- ---------------------------------------------------------- PaymentAttempts
CREATE TABLE IF NOT EXISTS payment_attempts (
  id                       UUID PRIMARY KEY,
  payment_id               UUID NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
  provider_id              UUID NOT NULL REFERENCES providers(id) ON DELETE RESTRICT,
  attempt_number           INT NOT NULL CHECK (attempt_number >= 1),
  status                   TEXT NOT NULL DEFAULT 'created'
                           CHECK (status IN ('created','sending','accepted','pending','succeeded','failed','timeout','unknown','cancelled')),
  provider_reference       TEXT,
  provider_idempotency_key TEXT NOT NULL,        -- SHA256(paymentId:attemptNumber), réutilisé à l'identique sur retry
  provider_raw_request     JSONB,                -- expurgé, rétention 30j
  provider_raw_response    JSONB,                -- expurgé, rétention 30j
  normalized_response      JSONB,
  error_code               TEXT,
  error_message            TEXT,
  error_outcome            TEXT CHECK (error_outcome IS NULL OR error_outcome IN ('definitive_failure','temporary_failure','unknown')),
  confirmed                BOOLEAN NOT NULL DEFAULT FALSE,  -- true = échec confirmé provider, false = ambigu
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_attempt_number UNIQUE (payment_id, attempt_number)
);
CREATE INDEX IF NOT EXISTS ix_attempts_payment ON payment_attempts(payment_id);
CREATE INDEX IF NOT EXISTS ix_attempts_provider_key ON payment_attempts(provider_idempotency_key);
CREATE INDEX IF NOT EXISTS ix_attempts_status ON payment_attempts(status);

-- ------------------------------------------------------------ WebhookEvents
CREATE TABLE IF NOT EXISTS webhook_events (
  id                UUID PRIMARY KEY,
  provider_id       UUID NOT NULL REFERENCES providers(id) ON DELETE RESTRICT,
  payment_id        UUID REFERENCES payments(id) ON DELETE SET NULL,
  provider_event_id TEXT NOT NULL,
  raw_body          JSONB,                       -- expurgé, rétention 30j
  signature_valid   BOOLEAN NOT NULL DEFAULT FALSE,
  normalized_status TEXT CHECK (normalized_status IS NULL OR normalized_status IN ('succeeded','confirmed_failed','pending','unknown')),
  is_late           BOOLEAN NOT NULL DEFAULT FALSE,  -- true si arrivé après expired/unknown
  processed_at      TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_webhook_provider_event UNIQUE (provider_id, provider_event_id)
);
CREATE INDEX IF NOT EXISTS ix_webhook_payment ON webhook_events(payment_id) WHERE payment_id IS NOT NULL;

-- ------------------------------------------------------------------ ApiKeys
CREATE TABLE IF NOT EXISTS api_keys (
  id           UUID PRIMARY KEY,
  name         TEXT NOT NULL,
  key_hash     TEXT NOT NULL,                   -- Argon2 (clé complète affichée une seule fois)
  prefix       TEXT NOT NULL,                   -- mg_live_ / mg_test_
  scopes       JSONB NOT NULL DEFAULT '[]',
  last_used_at TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at   TIMESTAMPTZ                      -- révocation immédiate : revoked_at = now()
);
CREATE INDEX IF NOT EXISTS ix_apikeys_prefix ON api_keys(prefix);

-- ------------------------------------------- Rétention 30j des raw provider
-- Purge les payloads bruts (PII/secrets potentiels) après 30 jours ;
-- les colonnes passent à NULL, les statuts normalisés sont conservés.
CREATE OR REPLACE FUNCTION purge_provider_raw(retention INTERVAL DEFAULT INTERVAL '30 days')
RETURNS TABLE (attempts_cleared INT, events_cleared INT) AS $$
DECLARE
  a INT; e INT;
BEGIN
  UPDATE payment_attempts
     SET provider_raw_request = NULL, provider_raw_response = NULL, updated_at = now()
   WHERE created_at < now() - retention
     AND (provider_raw_request IS NOT NULL OR provider_raw_response IS NOT NULL);
  GET DIAGNOSTICS a = ROW_COUNT;
  UPDATE webhook_events
     SET raw_body = NULL
   WHERE created_at < now() - retention AND raw_body IS NOT NULL;
  GET DIAGNOSTICS e = ROW_COUNT;
  RETURN QUERY SELECT a, e;
END;
$$ LANGUAGE plpgsql;
COMMENT ON FUNCTION purge_provider_raw(INTERVAL) IS
  'Rétention 30j (spec §5.1) : expurge les raw provider. À appeler via cron/queue, jamais bloquant HTTP.';
