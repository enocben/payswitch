-- Payswitch v1 — seed 002 : admin dashboard local (spec §10.1).
-- Idempotent (ON CONFLICT DO NOTHING). Dev local uniquement :
--   email    : admin@payswitch.local
--   password : ChangeMe123!  (à changer immédiatement en déploiement réel)
-- Hash Argon2id (Bun.password). Ne jamais réutiliser en production.
INSERT INTO dashboard_users (id, email, password_hash)
VALUES (
  '00000000-0000-7000-8000-000000000001',
  'admin@payswitch.local',
  '$argon2id$v=19$m=65536,t=2,p=1$n5cIBd63Kxzdoh5HTtPvykY36TibuHSR0TqK4c9NFhg$OeyNmbAyP3I8YuA6x4WrhWk/tEcutzrs9R2RK/2CJzM'
)
ON CONFLICT (email) DO NOTHING;
