# AGENTS.md — Payswitch

> Orchestrateur mobile-money mono-tenant, self-hostable. Un déploiement = un marchand.
> Repo : `enocben/payswitch` — monorepo Bun, licence Apache-2.0. Spec faisant foi : `~/Projet/cahier-de-charge-orchestrateur-mobile-money-v1.3.md` + `corrections_cahier_charge_orchestrateur_v1_2.pdf`.
> Bun monorepo : `apps/api` (NestJS) + `apps/dashboard` (React + Tailwind + Vite) + `packages/core` (domaine agnostique, `@payswitch/core` v0.1.0, importé en `workspace:*`).
> Scope v1 = encaissement (collect) uniquement. Hors v1 : payout, remboursement, routing dynamique, multi-tenant, billing, ledger complet, hot reload, 2FA (v2).

## Structure monorepo

```
payswitch/                           # enocben/payswitch — Apache 2.0
├── AGENTS.md                  # ce fichier (conventions globales, priorité BASSE)
├── apps/api/AGENTS.md         # règles NestJS (priorité HAUTE sur apps/api/**)
├── apps/dashboard/AGENTS.md   # règles React/Tailwind (priorité HAUTE sur apps/dashboard/**)
├── packages/core/AGENTS.md    # règles domaine pur (priorité HAUTE sur packages/core/**)
├── apps/api/                  # NestJS + Bun, importe core via `workspace:*`
│   └── src/
│       ├── modules/           # payments, webhooks (entrants + sortants), routing, providers (adapters Nest), api-keys, health
│       ├── jobs/              # polling, webhook-delivery (BullMQ)
│       └── infrastructure/    # database (client/config TypeORM/Prisma), queue
├── apps/dashboard/            # React + Tailwind + Vite → pages Transactions, Détail, Routing, Collections
├── packages/core/             # @payswitch/core — framework agnostic, exportable npm
│   └── src/                   # domain (payment, attempt, country, network, state-machine), engine (payment-engine, routing-engine, idempotency, verification), providers (contract, mock), errors, types, index.ts (barrel)
├── database/migrations/ + database/seeds/  # racine, partagée (countries, networks, routing)
├── tests/                     # unit + intégration (MockProvider)
├── docs/                      # cahier v1.3
├── docker/                    # Dockerfile api + dashboard + compose
├── package.json               # workspaces: ["apps/*", "packages/*"], packageManager: bun
└── bun.lockb
```

Résolution conflits : `AGENTS.md` le plus proche du fichier édité gagne. Prompt chat explicite > tout fichier.

## Commandes build / dev

```bash
bun install
bun run dev          # api + dashboard en parallèle
bun run build
bun run lint
bun run test
bun run test:e2e
```

- Runtime/PM : Bun (`bun.lockb`). Ne pas introduire npm/yarn/pnpm.
- Licence : Apache-2.0.
- DB locale : PostgreSQL + Redis (BullMQ/polling). Voir `docker-compose.yml` à la racine.

## Base de données
- Migrations + seeds à la racine : `database/migrations`, `database/seeds`.
- `apps/api/src/infrastructure/database` = client/config uniquement, jamais de SQL métier éparpillé.
- Montants internes : `BIGINT amount_minor` partout. Conversion humain ↔ minor à la frontière API (facteur par devise). Jamais `decimal`/`float` dans le moteur.
- Tables clés : `Country {code, name, currency_default}`, `Network {code, display_name, logo, country_id, UNIQUE(country_id, code)}` — `CD-AIRTEL ≠ CG-AIRTEL`.
- Contraintes : `UNIQUE(country_id, code)` sur Network, `UNIQUE(provider_id, provider_event_id)` sur events webhook, index sur `status`, `next_poll_at`, `idempotency_key`.
- `RoutingRule` : `UNIQUE(country_id, network_id, provider_id)` + `UNIQUE(country_id, network_id, priority)`. Seed via `config/routing.ts`.
- États provider : `configured / enabled / healthy / available` (`healthy` lecture seule en v1).
- PII : phone masqué en logs, prévoir `phone_hash`/`last4`. `raw` provider expurgé, rétention 30j.
- Seeds (spec §13) : pays `CD/RDC/CDF, CG/Congo/XAF, UG/Ouganda/UGX, CI/Côte d'Ivoire/XOF` ; réseaux `CD-AIRTEL, CD-ORANGE, CG-AIRTEL, CI-WAVE` avec logos. Routage exemple : `CD-AIRTEL → [pawapay, cinetpay]`, `CG-AIRTEL → [cinetpay, pawapay]`, `UG-AIRTEL → [flutterwave]`.

## Invariants domaine (ne jamais violer)

1. Activation provider = **config-driven** (`config/providers.ts` + `.env`). La DB ne stocke que l'ordre de priorité. Le dashboard ne fait que réordonner, jamais activer/désactiver.
2. `supports()` est **synchrone et local** (capabilities in-memory : pays, réseaux, devises, min/max minor, opérations). Aucun appel réseau dedans. HTTP réel uniquement dans `initiate()`/`verify()`.
3. Mapping réseau = **par adapter** via `mapNetwork({country, network})`. Le core ne contient aucun identifiant provider.
4. Réponses provider **typées et normalisées** avant persistance ; payloads `raw` expurgés (ni secrets, ni clés, ni headers auth).
5. `providerIdempotencyKey` **déterministe et persisté par tentative** (`SHA256(paymentId + ":" + attemptNumber)`), réutilisé à l'identique sur retry.
6. États finaux `Payment` terminaux, jamais rétrogradés. Webhook tardif après `expired`/`unknown` → `is_late=true` + `AuditLog`, pas de mutation aveugle.

## Contrat provider

Tout adapter implémente :

```ts
supports({ country, network, currency, amountMinor, operation? }): boolean
supportsIdempotency(): boolean
initiate({ amountMinor, currency, phone, country, network, paymentId, idempotencyKey, providerIdempotencyKey, externalReference?, metadata?, correlationId }): Promise<{ providerReference, status, rawRequest, rawResponse, outcome, confirmed }>
verify({ providerReference, paymentId, providerIdempotencyKey? }): Promise<{ status, rawResponse }>
verifyWebhookSignature(rawBody, headers): boolean
parseWebhook(rawBody, headers): { providerReference, providerEventId, status, rawBody }
normalizeError(raw): { code, message, outcome, confirmed, canRetry, canFallback, requiresVerification }
mapNetwork?({ country, network }): string
```

- Si `supportsIdempotency() === false` : jamais de retry aveugle, `verify()` d'abord.
- Seul `confirmed_failed` + `canFallback` autorise le fallback.

## Cycle de vie

**Payment** : `created → processing → pending → succeeded | failed | unknown | expired`
- `unknown` = impossible de confirmer côté provider. `expired` = fenêtre métier (`PAYMENT_EXPIRATION_HOURS`, défaut 24h) dépassée. Ne jamais mapper `expired`/`unknown` vers `failed`.

**PaymentAttempt** (par tentative) : `created → sending → accepted → pending → succeeded | failed | timeout | unknown | cancelled`

## Retry / fallback (provider-safe)

```
initiate() → temporary_failure → 1 retry même providerIdempotencyKey → si toujours temporaire + canFallback → fallback
initiate() → unknown/timeout → verify() OBLIGATOIRE
  verify() → succeeded → terminé
  verify() → confirmed_failed + canFallback → fallback provider suivant
  verify() → confirmed_failed + !canFallback → failed
  verify() → unknown/pending → reste pending, planifie next_poll_at (backoff), PAS de fallback
initiate() → definitive_failure + confirmed + canFallback → fallback
initiate() → definitive_failure + !confirmed → reste unknown, verify
```

Aucun fallback tant que le premier provider est `unknown`/`pending`.

## Polling / expiration

- File d'attente : `next_poll_at` + `poll_attempts`, backoff configurable (`30s, 2m, 5m, 10m, 30m, 1h, 2h`). Jamais de polling bloquant dans la requête HTTP.
- À l'expiration : `pending → expired`, incertain → `unknown`. Jamais `failed`.

## Idempotence

- Clé marchand `idempotency_key` libre (uuid7 recommandé). Stocker `request_hash = SHA256(payload normalisé)`.
- Même clé + même hash → retourne le Payment existant (200). Même clé + hash différent → `409 IDEMPOTENCY_KEY_REUSED`.

## Webhooks

**Inbound** `POST /webhooks/:provider` : vérifie signature AVANT normalisation → invalide = `401/403` ; doublon `UNIQUE(provider_id, provider_event_id)` = `200` idempotent ; Payment final `expired`/`unknown` = `is_late=true` + `AuditLog` → `200` ; erreur DB temporaire = `500` (pour retry provider) ; sinon traitement transactionnel → `200`.

**Outbound** (vers marchand) : secret généré serveur (`whsec_...`), affiché une fois, stocké hashé (Argon2). Payload signé HMAC-SHA256 (`X-Webhook-Signature`, `X-Event-Id`), avec `event_id` unique + `attempt_id`. Retry via `WEBHOOK_RETRY_SCHEDULE` / `WEBHOOK_MAX_RETRIES`, Replay depuis dashboard.

Concurrence webhook + polling + doublon = exactement un changement d'état + une notification : transaction DB + `SELECT FOR UPDATE` (ou locking optimiste) + validation transitions + contraintes uniques.

## API REST (apps/api)

- Clés `mg_live_` / `mg_test_`, préfixe + `key_hash` stockés, révocation immédiate.
- Erreurs uniformes `{ error: { code, message, details }, request_id }` + `correlation_id`.
- `request_id` / `correlation_id` (uuid7) par requête → header `X-Request-Id` + logs.
- Validation : `phone` E.164, `amount` > 0, `currency` ISO 4217, `country+network` existants + au moins un provider avec `supports() === true` → sinon `422`.
- Rate limiting sur `POST /payments`.
- Endpoints v1 (cf. spec §7.2) :

```
POST   /api/v1/payments        # {amount, currency, phone, country, network, external_reference?, metadata?, idempotency_key} → 201 {id, status, amount_minor, currency, provider, external_reference, request_id} | 200 même key+hash | 409 IDEMPOTENCY_KEY_REUSED | 422
GET    /api/v1/payments/:id    # état final identique au webhook marchand
GET    /api/v1/payments        # ?status=&country=&network=&provider=&phone=&external_reference=&from=&to=&page=&per_page=
POST   /api/v1/webhooks        # {url, events: [payment.succeeded, payment.failed, payment.unknown]} → 201 {id, url, events, secret: whsec_...}
GET    /api/v1/webhooks
DELETE /api/v1/webhooks/:id
GET    /api/v1/countries
GET    /api/v1/networks?country=CD
GET    /api/v1/routing
PUT    /api/v1/routing         # [{country, network, providers: [...]}]
POST   /webhooks/:provider     # entrant provider, public
GET    /api/v1/collections     # {by_country, by_network, by_provider}
GET    /api/v1/collections/export?format=csv&...
GET    /health
```
- Ordre d'implémentation : domaine → state machine → contrat provider → MockProvider → PostgreSQL/contraintes → moteur → idempotence/concurrence → webhooks → queue/polling/expiration → 1er vrai provider E2E → REST → dashboard → providers suivants un par un.

## Dashboard (apps/dashboard)

- Liste transactions traçable : téléphone masqué (`+243****678`), pays, réseau, provider utilisé, tentatives (avec `providerIdempotencyKey`), metadata, `correlation_id`, timeline.
- Éditeur priorité routage par `pays-réseau` (capabilities + `supportsIdempotency` visibles), audit-logué (avant/après, acteur, IP, `request_id`).
- Assignation `provider ↔ network` sans toggle on/off.
- Vue Collections (ex-Wallet) = **agrégat lecture seule** `SUM(amount_minor) WHERE succeeded GROUP BY pays, pays-réseau, provider, période`. Jamais présenté comme solde disponible. Export CSV avec mêmes filtres.
- Auth : hash Argon2, cookies session HttpOnly + Secure + SameSite, CSRF, rate-limit login (5/15min/IP) + backoff/lockout progressif, tokens reset one-time, 2FA prévu v2.

## Testing

```bash
bun run test              # unitaires (services, moteur, MockProvider)
bun run test:e2e           # contrôleurs + cycle complet via mg_test_
```

- `MockProvider` obligatoire : simule `success, confirmed_failed, temporary_failure, timeout/unknown, pending, webhook dupliqué, webhook retardé`, respecte `supports()` / `supportsIdempotency()` / `mapNetwork()`.
- Mode `TEST` (`mg_test_`) = cycle complet sans appel provider réel.
- Après chaque changement : `bun run lint` + `bun run test` + vérif graphe DI (`nest info`).

## Code style

- NestJS : `@Injectable()` + injection constructeur, jamais `new`. DTOs `class-validator` sur tous les bodies, `ValidationPipe` global. Exceptions HTTP typées. Endpoints documentés Swagger (`@ApiTags`, `@ApiOperation`).
- Ordre par feature : `.module.ts` → `.controller.ts` → `.service.ts` → `dto/*.dto.ts` → `*.service.spec.ts`.
- Config via `ConfigModule` + `process.env`, jamais en dur. Pas de `any` non documenté. Pas de dépendance circulaire (`forwardRef()` dernier recours).
- Dashboard : React + Tailwind + Vite, composants par feature.

## Sécurité

- Ne jamais exposer secrets, clés provider, traces internes dans réponses/logs/DB (`raw` expurgé).
- Valider tout input (`ValidationPipe`, DTOs). Vérifier signatures webhooks avant tout traitement.
- AuditLog pour chaque action admin.

## Observabilité & ops

- Logs structurés (Pino) avec `request_id, payment_id, attempt_id, provider_reference, providerIdempotencyKey, webhook_event_id`.
- Health : `GET /health`.
- Déploiement : Bun + Docker (ou Dokploy), PostgreSQL, queue BullMQ / `@nestjs/schedule` pour polling + retries.
- `package.json` racine : `"workspaces": ["apps/*", "packages/*"]`, `"packageManager": "bun"`. 1 `bun install` à la racine, `bun run dev` lance api + dashboard.

## Definition of Done v1

- Référence : critères d'acceptation spec §17 + scénarios de tests obligatoires §18 + checklist §20. Extraits critiques :
  - `supports()` ne fait jamais d'appel réseau ; provider incompatible non appelé.
  - `temporary → retry` même clé ; `unknown/timeout → verify()` obligatoire, pas de fallback si `verify=unknown/pending`.
  - `definitive + confirmed_failed → fallback` possible ; `definitive + !confirmed → unknown`, pas de fallback.
  - `succeeded` jamais rétrogradé ; webhook tardif après `expired` → `is_late=true` + AuditLog, pas de transition.
  - Webhook dupliqué → traité 1 seule fois ; erreur interne temporaire → `500`.
  - `GET` et webhook marchand exposent le même état final ; polling + webhooks concurrents → pas d'incohérence.
  - Système OK si un provider est down ; expiration → `expired`/`unknown`, jamais `failed` auto.

## Workflow git

- Rebase avant modif, push direct. Commits courts et ciblés avec le code associé.
- Toute modif routage/priorité = audit-log + migration/seed si structurelle.

## Pièges connus (ne pas reproduire)

- on/off provider en DB → dérive config↔DB, trous de routage silencieux.
- Réseau modélisé en string unique ("airtel") → `CD` vs `CG` inroutable.
- Pas de `PaymentAttempt` persisté → debug fallback et collections par provider impossibles.
- `supports()` async/réseau → latence + pannes sur le chemin de routage.
- `failed` ambigu traité comme fallback-éligible → doubles débits.
