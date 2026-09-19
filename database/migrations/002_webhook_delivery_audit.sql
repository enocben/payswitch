-- Payswitch v1 — migration 002 : webhooks sortants + audit (spec §5.1, §5.4, §8.2, US-10, US-15).
-- webhook_deliveries : 1 ligne par notification marchand (event_id UNIQUE,
-- attempt_id, HMAC-SHA256, retry configurable via next_retry_at/attempts).
-- audit_logs : webhook tardif après expired/unknown + réordonnancement routing.

-- ------------------------------------------------------- WebhookDeliveries
-- Sortant (Nous → Marchand). Le secret est généré à la création du webhook
-- (whsec_...), affiché 1 fois, stocké hashé ; la signature HMAC est calculée
-- par le moteur à l'enqueue et persistée ici (spec §8.2, US-10).
CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id                 UUID PRIMARY KEY,
  event_id           UUID NOT NULL UNIQUE,      -- idempotence marchand
  payment_id         UUID NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
  attempt_id         UUID REFERENCES payment_attempts(id) ON DELETE SET NULL,
  url                TEXT NOT NULL,             -- URL marchand
  event_type         TEXT NOT NULL              -- payment.succeeded / payment.failed / payment.unknown
                   CHECK (event_type IN ('payment.succeeded', 'payment.failed', 'payment.unknown')),
  payload            JSONB NOT NULL,            -- {event_id, event_type, payment_id, attempt_id, ...}
  signature          TEXT NOT NULL,             -- HMAC-SHA256 hex du payload canonique
  status             TEXT NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending', 'delivered', 'failed', 'retrying')),
  attempts           INT NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_retry_at      TIMESTAMPTZ,               -- NULL = livré/échoué définitif
  last_response_code INT,
  last_response_body TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_deliveries_status_retry ON webhook_deliveries(status, next_retry_at);
CREATE INDEX IF NOT EXISTS ix_deliveries_payment ON webhook_deliveries(payment_id);

-- --------------------------------------------------------------- AuditLogs
-- Traçabilité admin : webhook tardif (is_late, spec §5.4), réordonnancement
-- routing (US-15), révocation/création clés. Append-only (jamais d'UPDATE).
CREATE TABLE IF NOT EXISTS audit_logs (
  id            UUID PRIMARY KEY,
  action        TEXT NOT NULL,                 -- webhook.late_received, routing.updated, ...
  actor         TEXT NOT NULL,                 -- admin, provider:<code>, system
  resource_type TEXT NOT NULL,                 -- payment, routing_rule, api_key, ...
  resource_id   TEXT,                          -- id ou pays-réseau concerné
  old_value     JSONB,
  new_value     JSONB,
  ip            TEXT,
  request_id    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_audit_resource ON audit_logs(resource_type, resource_id);
CREATE INDEX IF NOT EXISTS ix_audit_created ON audit_logs(created_at);

-- ------------------------------------------- Rétention 30j des raw provider
-- Étendue aux payloads sortants (données paiement) : passés à NULL après
-- 30 jours ; statuts et signatures conservés (spec §5.1, §11).
-- DROP préalable : la 001 définissait 2 colonnes OUT, la 002 en ajoute une
-- 3e (deliveries_cleared) — CREATE OR REPLACE seul est refusé (42P13).
DROP FUNCTION IF EXISTS purge_provider_raw(INTERVAL);
CREATE OR REPLACE FUNCTION purge_provider_raw(retention INTERVAL DEFAULT INTERVAL '30 days')
RETURNS TABLE (attempts_cleared INT, events_cleared INT, deliveries_cleared INT) AS $$
DECLARE
  a INT; e INT; d INT;
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
  UPDATE webhook_deliveries
     SET payload = '{}', last_response_body = NULL, updated_at = now()
   WHERE created_at < now() - retention AND payload <> '{}';
  GET DIAGNOSTICS d = ROW_COUNT;
  RETURN QUERY SELECT a, e, d;
END;
$$ LANGUAGE plpgsql;
COMMENT ON FUNCTION purge_provider_raw(INTERVAL) IS
  'Rétention 30j (spec §5.1, §11) : expurge les raw provider + payloads sortants. À appeler via cron/queue, jamais bloquant HTTP.';
