-- Payswitch v1 — migration 002 : audit + sortant webhooks (spec §5.1).
-- Suit le style de 001 (IF NOT EXISTS, commentaires spec, PK UUID).
-- Ajoute :
--   audit_logs            — toute action admin (routing PUT, webhook tardif, révocations)
--   webhook_subscriptions — abonnements marchands (POST/GET/DELETE /api/v1/webhooks) ;
--                           secret whsec_... affiché une fois, seul secret_hash persisté
--                           (la signature HMAC est re-dérivable : HMAC(master, sub_id))
--   webhook_deliveries    — tentatives sortantes (spec §5.1 : event_id UNIQUE, retry)
--   dashboard_users       — auth dashboard locale (Argon2, session cookie HttpOnly)
-- Rétention 30j : purge étendue aux deliveries.payload (fonction purge_outbound_raw()).

-- --------------------------------------------------------------- AuditLogs
CREATE TABLE IF NOT EXISTS audit_logs (
  id            UUID PRIMARY KEY,
  action        TEXT NOT NULL,                     -- ex. routing.updated, webhook.late
  actor         TEXT NOT NULL,                     -- nom clé API / email dashboard / system
  resource_type TEXT,                              -- ex. routing, payment, webhook
  resource_id   TEXT,
  old_value     JSONB,
  new_value     JSONB,
  ip            TEXT,
  request_id    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_audit_action ON audit_logs(action);
CREATE INDEX IF NOT EXISTS ix_audit_resource ON audit_logs(resource_type, resource_id)
  WHERE resource_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_audit_created ON audit_logs(created_at);

-- ------------------------------------------------- WebhookSubscriptions
-- Abonnement marchand aux événements sortants. Le secret clair n'est JAMAIS
-- persisté : seul secret_hash (Argon2) est stocké ; la signature HMAC
-- X-Webhook-Signature est re-dérivée côté serveur via
-- HMAC_SHA256(master_secret, subscription_id) (cf. http/outbound.ts).
CREATE TABLE IF NOT EXISTS webhook_subscriptions (
  id          UUID PRIMARY KEY,
  url         TEXT NOT NULL,
  events      JSONB NOT NULL DEFAULT '[]',        -- ex. ["payment.succeeded","payment.failed"]
  secret_hash TEXT NOT NULL,                      -- Argon2 du secret whsec_... (affiché 1 fois)
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_websub_active ON webhook_subscriptions(is_active)
  WHERE is_active = TRUE;

-- ---------------------------------------------------- WebhookDeliveries
-- (spec §5.1 : WebhookDelivery sortant — event_id UNIQUE, retry planifié)
CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id                 UUID PRIMARY KEY,
  event_id           UUID NOT NULL UNIQUE,        -- X-Event-Id, idempotence marchand
  subscription_id    UUID NOT NULL REFERENCES webhook_subscriptions(id) ON DELETE CASCADE,
  payment_id         UUID REFERENCES payments(id) ON DELETE SET NULL,
  attempt_id         UUID REFERENCES payment_attempts(id) ON DELETE SET NULL,
  url                TEXT NOT NULL,               -- snapshot URL au moment de l'enqueue
  event_type         TEXT NOT NULL,               -- payment.succeeded | payment.failed | payment.unknown
  payload            JSONB NOT NULL DEFAULT '{}',
  signature          TEXT NOT NULL,               -- HMAC-SHA256 hex du payload canonique
  status             TEXT NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending','delivered','failed','retrying')),
  attempts           INT NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_retry_at      TIMESTAMPTZ,
  last_response_code INT,
  last_response_body TEXT,                        -- tronqué (jamais de secret)
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_webdel_status_retry ON webhook_deliveries(status, next_retry_at);
CREATE INDEX IF NOT EXISTS ix_webdel_subscription ON webhook_deliveries(subscription_id);
CREATE INDEX IF NOT EXISTS ix_webdel_payment ON webhook_deliveries(payment_id)
  WHERE payment_id IS NOT NULL;

-- --------------------------------------------------------- DashboardUsers
-- Auth dashboard mono-tenant (spec §10.1) : mot de passe Argon2, session
-- cookie HttpOnly + SameSite côté HTTP. 2FA prévu v2 (colonne totp_secret).
CREATE TABLE IF NOT EXISTS dashboard_users (
  id            UUID PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,                    -- Argon2 (Bun.password)
  totp_secret   TEXT,                             -- v2, NULL en v1
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ------------------------------------------- Rétention 30j (sortant)
-- Expurge les payloads sortants après 30j (PII potentielle) ; les statuts
-- et compteurs sont conservés pour l'audit.
CREATE OR REPLACE FUNCTION purge_outbound_raw(retention INTERVAL DEFAULT INTERVAL '30 days')
RETURNS TABLE (deliveries_cleared INT) AS $$
DECLARE
  d INT;
BEGIN
  UPDATE webhook_deliveries
     SET payload = '{}'::jsonb, last_response_body = NULL, updated_at = now()
   WHERE created_at < now() - retention
     AND (payload <> '{}'::jsonb OR last_response_body IS NOT NULL);
  GET DIAGNOSTICS d = ROW_COUNT;
  RETURN QUERY SELECT d;
END;
$$ LANGUAGE plpgsql;
COMMENT ON FUNCTION purge_outbound_raw(INTERVAL) IS
  'Rétention 30j (spec §5.1) : expurge les payloads sortants. Cron/queue, jamais bloquant HTTP.';
