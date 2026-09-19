-- Payswitch v1 — seed 001 : pays / réseaux / providers Mock / routage (spec §13).
-- Idempotent : ré-exécutable (INSERT ... ON CONFLICT DO NOTHING / UPDATE).
-- Mode Mock seul en v1 : aucun vrai provider, aucune vraie clé.

-- ------------------------------------------------------------ Pays (spec §13)
INSERT INTO countries (id, code, name, currency_default, phone_prefix) VALUES
  (gen_random_uuid(), 'CD', 'RDC',            'CDF', '+243'),
  (gen_random_uuid(), 'CG', 'Congo',          'XAF', '+242'),
  (gen_random_uuid(), 'UG', 'Ouganda',        'UGX', '+256'),
  (gen_random_uuid(), 'CI', 'Côte d''Ivoire', 'XOF', '+225')
ON CONFLICT (code) DO UPDATE SET
  name = EXCLUDED.name,
  currency_default = EXCLUDED.currency_default,
  phone_prefix = EXCLUDED.phone_prefix,
  updated_at = now();

-- ---------------------------------------------------------- Réseaux (spec §13)
INSERT INTO networks (id, country_id, code, display_name, logo_url, is_active)
SELECT gen_random_uuid(), c.id, n.code, n.display_name, n.logo_url, TRUE
FROM countries c
JOIN (VALUES
  ('CD', 'AIRTEL', 'Airtel RDC',   '/logos/airtel.png'),
  ('CD', 'ORANGE', 'Orange RDC',   '/logos/orange.png'),
  ('CG', 'AIRTEL', 'Airtel Congo', '/logos/airtel.png'),
  ('CI', 'WAVE',   'Wave CI',      '/logos/wave.png')
) AS n(country, code, display_name, logo_url) ON n.country = c.code
ON CONFLICT (country_id, code) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  logo_url = EXCLUDED.logo_url,
  is_active = TRUE,
  updated_at = now();

-- --------------------------------- Providers Mock (v1 : Mock seul, spec §6.4)
-- Activation réelle = config-driven ; ces lignes exposent les capabilities
-- locales utilisées par supports() et le mapping code → adapter Mock.
INSERT INTO providers (id, code, display_name, is_enabled, is_healthy, capabilities, supports_idempotency, config) VALUES
  (gen_random_uuid(), 'mockprimary', 'Mock Primary', TRUE, TRUE,
   '{"supported_countries": ["CD", "CG", "CI"], "supported_networks": {"CD": ["AIRTEL", "ORANGE"], "CG": ["AIRTEL"], "CI": ["WAVE"]}, "supported_currencies": ["CDF", "XAF", "XOF"], "min_amount_minor": "100", "max_amount_minor": "100000000", "operations": ["collect"], "supports_idempotency": true}',
   TRUE, '{}'),
  (gen_random_uuid(), 'mocksecondary', 'Mock Secondary', TRUE, TRUE,
   '{"supported_countries": ["CD", "CG", "CI"], "supported_networks": {"CD": ["AIRTEL", "ORANGE"], "CG": ["AIRTEL"], "CI": ["WAVE"]}, "supported_currencies": ["CDF", "XAF", "XOF"], "min_amount_minor": "100", "max_amount_minor": "100000000", "operations": ["collect"], "supports_idempotency": true}',
   TRUE, '{}')
ON CONFLICT (code) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  is_enabled = TRUE,
  is_healthy = TRUE,
  capabilities = EXCLUDED.capabilities,
  supports_idempotency = EXCLUDED.supports_idempotency,
  updated_at = now();

-- ------------------------------------------- Routage CD-AIRTEL (spec §9.2)
-- CD-AIRTEL → [mockprimary (priorité 1), mocksecondary (priorité 2)].
INSERT INTO routing_rules (id, country_id, network_id, provider_id, priority)
SELECT gen_random_uuid(), c.id, n.id, p.id, r.priority
FROM (VALUES
  ('CD', 'AIRTEL', 'mockprimary', 1),
  ('CD', 'AIRTEL', 'mocksecondary', 2)
) AS r(country, network, provider, priority)
JOIN countries c ON c.code = r.country
JOIN networks n ON n.country_id = c.id AND n.code = r.network
JOIN providers p ON p.code = r.provider
ON CONFLICT (country_id, network_id, provider_id) DO UPDATE SET
  priority = EXCLUDED.priority,
  updated_at = now();
