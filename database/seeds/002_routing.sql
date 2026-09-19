-- Payswitch v1 — seed 002 : routage complet + capabilities numériques (spec §9.2, §13).
-- Idempotent : ré-exécutable (ON CONFLICT DO UPDATE).
-- v1 = Mock seul : chaque réseau seedé route [mockprimary (1), mocksecondary (2)].
-- Les montants capabilities passent en nombres (spec §6.2 : 100, pas "100").

-- --------------------------------- Capabilities : min/max en nombres (spec §6.2)
UPDATE providers
   SET capabilities = jsonb_set(
         jsonb_set(capabilities, '{min_amount_minor}', to_jsonb(100)),
         '{max_amount_minor}', to_jsonb(100000000)),
       updated_at = now()
 WHERE code IN ('mockprimary', 'mocksecondary');

-- --------------------------------- Routage CD-ORANGE / CG-AIRTEL / CI-WAVE
-- CD-AIRTEL reste couvert par 001. UNIQUE(country_id, network_id, priority)
-- respectée : priorités 1, 2 par couple pays-réseau.
INSERT INTO routing_rules (id, country_id, network_id, provider_id, priority)
SELECT gen_random_uuid(), c.id, n.id, p.id, r.priority
FROM (VALUES
  ('CD', 'ORANGE', 'mockprimary', 1),
  ('CD', 'ORANGE', 'mocksecondary', 2),
  ('CG', 'AIRTEL', 'mockprimary', 1),
  ('CG', 'AIRTEL', 'mocksecondary', 2),
  ('CI', 'WAVE',   'mockprimary', 1),
  ('CI', 'WAVE',   'mocksecondary', 2)
) AS r(country, network, provider, priority)
JOIN countries c ON c.code = r.country
JOIN networks n ON n.country_id = c.id AND n.code = r.network
JOIN providers p ON p.code = r.provider
ON CONFLICT (country_id, network_id, provider_id) DO UPDATE SET
  priority = EXCLUDED.priority,
  updated_at = now();
