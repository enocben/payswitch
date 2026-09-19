# AGENTS.md — Payswitch

> Orchestrateur mobile-money mono-tenant, self-hostable. Un déploiement = un marchand.
> Repo : `enocben/payswitch` — monorepo Bun, licence Apache-2.0.
> Spec faisant foi : `docs/cahier-de-charge-orchestrateur-mobile-money-v1.3.md` (copie locale ; original : `~/Projet/…`) + `docs/corrections_cahier_charge_orchestrateur_v1_2.pdf` (12 points, déjà intégrés en v1.3).
> Stack figée : NestJS (API + jobs) + React + Tailwind + Vite (dashboard) + Bun (runtime + PM) + PostgreSQL + queue (BullMQ ou `@nestjs/schedule`).
> Package : `@payswitch/core` v0.1.0, framework agnostic, importé en `workspace:*` (extraction npm en v2 sans toucher au reste).
> Scope v1 = encaissement (collect) uniquement. Hors v1 : payout, remboursement, routing dynamique, multi-tenant, billing, ledger complet, hot reload, 2FA (v2).

## Structure monorepo

```
payswitch/                           # enocben/payswitch — Apache 2.0
├── AGENTS.md                  # ce fichier (conventions globales)
├── apps/api/                  # NestJS + Bun, importe core via `workspace:*`
│   └── src/
│       ├── modules/           # payments, webhooks (entrants + sortants), routing, providers (adapters Nest), api-keys, health
│       ├── jobs/              # polling, webhook-delivery (BullMQ)
│       └── infrastructure/    # database (client/config TypeORM/Prisma), queue
├── apps/dashboard/            # React + Tailwind + Vite → Transactions, Détail, Routing, Collections, Webhooks, Pays/Réseaux, Audit Log, API Keys
├── packages/core/             # @payswitch/core — framework agnostic, exportable npm
│   └── src/                   # domain (payment, attempt, country, network, state-machine), engine (payment-engine, routing-engine, idempotency, verification), providers (contract, mock), errors, types, index.ts (barrel)
├── database/migrations/ + database/seeds/  # racine, partagée (countries, networks, routing)
├── tests/                     # unit + intégration (MockProvider)
├── docs/                      # cahier v1.3 + corrections v1.2 (font foi)
├── docker/                    # Dockerfile api + dashboard + compose
├── package.json               # workspaces: ["apps/*", "packages/*"], packageManager: bun
└── bun.lockb
```

Prompt chat explicite > ce fichier. Toute modif routage/priorité = audit-log + migration/seed si structurelle.

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
- `package.json` racine : `"workspaces": ["apps/*", "packages/*"]`, `"packageManager": "bun"`. 1 `bun install` à la racine.
- Après chaque changement : `bun run lint` + `bun run test` + vérif graphe DI (`nest info`).

## Config / env (`.env`, jamais commité — voir `.env.example`)

| Variable | Défaut | Spec |
|---|---|---|
| `DATABASE_URL`, `REDIS_URL` | — | infra |
| `PAYMENT_EXPIRATION_HOURS` | `24` | §9.2, US-11 |
| `WEBHOOK_RETRY_SCHEDULE` | `1m,5m,15m,1h,6h,24h` | §8.2 |
| `WEBHOOK_MAX_RETRIES` | `6` | §8.2 |
| `PAWAPAY_API_KEY`, `PAWAPAY_WEBHOOK_SECRET` | — | §6.3 (vague 1) |
| `CINETPAY_API_KEY`, `CINETPAY_WEBHOOK_SECRET` | — | §6.3 (vague 1) |

Flutterwave = vague suivante (1er provider réel : un seul, E2E, puis les suivants un par un).

## Base de données (spec §5.1)

- Migrations + seeds à la racine : `database/migrations`, `database/seeds`.
- `apps/api/src/infrastructure/database` = client/config uniquement, jamais de SQL métier éparpillé.
- IDs : **uuid7 partout**. Montants internes : `BIGINT amount_minor` partout. Conversion humain ↔ minor à la frontière API (facteur par devise). Jamais `decimal`/`float` dans le moteur.
- `Country {code ISO, name, currency_default CHAR3}` ; `Network {country_id FK, code, display_name, logo_url, is_active, UNIQUE(country_id, code)}` — `CD-AIRTEL ≠ CG-AIRTEL`.
- `Provider {code, display_name, is_enabled (config), is_healthy (runtime, v1 lecture seule), capabilities JSON, supports_idempotency bool, config JSON non sensible}`.
- `RoutingRule {country_id, network_id, provider_id, priority}` : `UNIQUE(country_id, network_id, provider_id)` + `UNIQUE(country_id, network_id, priority)`. Seed via `config/routing.ts`.
- `Payment` : `idempotency_key UNIQUE`, `request_hash SHA256`, `external_reference` indexé nullable, `amount_minor BIGINT`, `currency CHAR3`, `phone E.164`, `gross_amount_minor / provider_fee_minor / net_amount_minor` (BIGINT nullable), `metadata JSONB`, `correlation_id / request_id`, `expires_at`, `poll_attempts`, `next_poll_at`, `INDEX(status, next_poll_at)`.
- `PaymentAttempt` : `attempt_number`, `provider_reference` nullable, `provider_idempotency_key` persisté, `provider_raw_request/response JSONB expurgés`, `normalized_response JSONB`, `error_code / error_message / error_outcome (definitive/temporary/unknown)`, `confirmed bool`.
- `WebhookEvent` (entrant) : `provider_event_id`, `raw_body JSONB expurgé`, `signature_valid bool`, `normalized_status`, `is_late bool`, `processed_at`, `UNIQUE(provider_id, provider_event_id)`.
- `WebhookDelivery` (sortant) : `event_id uuid7 UNIQUE`, `attempt_id` nullable, `event_type (payment.succeeded/failed/unknown)`, `payload JSONB`, `signature HMAC`, `status (pending/delivered/failed/retrying)`, `attempts, next_retry_at, last_response_code/body`.
- `ApiKey {name, key_hash Argon2, prefix mg_live_/mg_test_, scopes JSON, last_used_at, revoked_at}` — clé complète affichée 1 fois, révocation immédiate.
- `AuditLog {action, actor, resource_type, resource_id, old_value/new_value JSONB, ip, request_id}` — toute action admin + routing + webhook tardif.
- PII : phone masqué en logs, prévoir `phone_hash`/`last4`. `raw` provider expurgé, rétention 30j.
- Seeds (spec §13) : pays `CD/RDC/CDF, CG/Congo/XAF, UG/Ouganda/UGX, CI/Côte d'Ivoire/XOF` ; réseaux `CD-AIRTEL (Airtel RDC), CD-ORANGE (Orange RDC), CG-AIRTEL (Airtel Congo), CI-WAVE (Wave CI)` avec logos `/logos/*.png`. Routage exemple : `CD-AIRTEL → [pawapay, cinetpay]`, `CG-AIRTEL → [cinetpay, pawapay]`, `UG-AIRTEL → [flutterwave]`.

## Invariants domaine (ne jamais violer)

1. Activation provider = **config-driven** (`config/providers.ts` + `.env`). La DB ne stocke que l'ordre de priorité. Le dashboard ne fait que réordonner, jamais activer/désactiver.
2. `supports()` est **synchrone et local** (capabilities in-memory : pays, réseaux, devises, min/max minor, opérations). Aucun appel réseau dedans. HTTP réel uniquement dans `initiate()`/`verify()`.
3. Mapping réseau = **par adapter** via `mapNetwork({country, network})`. Le core ne contient aucun identifiant provider.
4. Réponses provider **typées et normalisées** avant persistance ; payloads `raw` expurgés (ni secrets, ni clés, ni headers auth).
5. `providerIdempotencyKey` **déterministe et persisté par tentative** (`SHA256(paymentId + ":" + attemptNumber)`), réutilisé à l'identique sur retry.
6. États finaux `Payment` terminaux, jamais rétrogradés. Webhook tardif après `expired`/`unknown` → `is_late=true` + `AuditLog`, pas de mutation aveugle (orienté réconciliation future, spec §5.4).
7. `available = configured + enabled + healthy + supports()`. Aucun fallback tant que le premier provider est `unknown`/`pending`.

## Contrat provider (spec §6 — types exacts)

```ts
interface PaymentProvider {
  readonly code: string
  readonly displayName: string
  supports(params: SupportParams): boolean                       // sync, local, sans réseau
  supportsIdempotency(): boolean
  initiate(params: InitiateParams): Promise<InitiateResult>
  verify(params: VerifyParams): Promise<VerifyResult>
  verifyWebhookSignature(rawBody: string, headers: Record<string, string>): boolean
  parseWebhook(rawBody: string, headers: Record<string, string>): NormalizedWebhookEvent
  normalizeError(rawError: unknown): NormalizedError
  mapNetwork?(internal: { country: string; network: string }): string
}
type SupportParams = { country: string; network: string; currency: string; amountMinor: number; operation?: 'collect' }
type InitiateParams = { amountMinor: number; currency: string; phone: string; country: string; network: string; paymentId: string; idempotencyKey: string; providerIdempotencyKey: string; externalReference?: string; metadata?: Record<string, unknown>; correlationId: string }
type InitiateResult = { providerReference: string; status: 'pending' | 'failed' | 'unknown'; rawRequest: unknown; rawResponse: unknown; outcome: 'success' | 'definitive_failure' | 'temporary_failure' | 'unknown'; confirmed: boolean }
type VerifyParams = { providerReference: string; paymentId: string; providerIdempotencyKey?: string }
type VerifyResult = { status: 'succeeded' | 'confirmed_failed' | 'pending' | 'unknown'; rawResponse: unknown }
type NormalizedWebhookEvent = { providerReference: string; providerEventId: string; status: 'succeeded' | 'confirmed_failed' | 'unknown'; rawBody: unknown }
type NormalizedError = { code: string; message: string; outcome: 'definitive_failure' | 'temporary_failure' | 'unknown'; confirmed: boolean; canRetry: boolean; canFallback: boolean; requiresVerification: boolean; rawError?: unknown }
```

- Si `supportsIdempotency() === false` : jamais de retry aveugle, `verify()` d'abord.
- Seul `confirmed_failed` + `canFallback` autorise le fallback. `definitive + !confirmed` → `unknown`, pas de fallback.
- Capabilities (config) : `{supported_countries, supported_networks: {CD: [...]}, supported_currencies, min_amount_minor, max_amount_minor, operations: ["collect"], supports_idempotency}`.
- Enregistrement NestJS : `config/providers.ts` instancie les adapters avec secrets `process.env` (spec §6.3).
- `MockProvider` obligatoire : `success, confirmed_failed, temporary_failure, timeout/unknown, pending, webhook dupliqué, webhook retardé`, respecte `supports()` / `supportsIdempotency()` / `mapNetwork()`. Mode `TEST` (`mg_test_`) = cycle complet sans appel réel.

## Cycle de vie (spec §5.2)

**Payment** : `created → processing → pending → succeeded | failed | unknown | expired`
- `unknown` = impossible de confirmer côté provider. `expired` = fenêtre métier (`PAYMENT_EXPIRATION_HOURS`, défaut 24h) dépassée. Ne jamais mapper `expired`/`unknown` vers `failed`.

**PaymentAttempt** (par tentative) : `created → sending → accepted → pending → succeeded | failed (confirmé) | timeout | unknown | cancelled`

## Retry / fallback (provider-safe, spec §9.2)

```
initiate() → success → pending (puis succeeded via verify/polling/webhook)
initiate() → temporary_failure → 1 retry même providerIdempotencyKey → si toujours temporaire + canFallback → fallback
initiate() → unknown/timeout → verify() OBLIGATOIRE (même providerReference/providerIdempotencyKey)
  verify() → succeeded → terminé
  verify() → confirmed_failed + canFallback → fallback provider suivant
  verify() → confirmed_failed + !canFallback → failed
  verify() → unknown/pending → reste pending, planifie next_poll_at (backoff), PAS de fallback
initiate() → definitive_failure + confirmed + canFallback → fallback
initiate() → definitive_failure + !confirmed → reste unknown, verify
```

## Polling / expiration

- File d'attente : `next_poll_at` + `poll_attempts`, backoff configurable (`30s, 2m, 5m, 10m, 30m, 1h, 2h`). Jamais de polling bloquant dans la requête HTTP.
- À l'expiration : `pending → expired`, incertain → `unknown`. Jamais `failed`.

## Idempotence

- Clé marchand `idempotency_key` libre (uuid7 recommandé). Stocker `request_hash = SHA256(payload normalisé)`.
- Même clé + même hash → retourne le Payment existant (200). Même clé + hash différent → `409 IDEMPOTENCY_KEY_REUSED`.

## Webhooks (spec §8)

**Inbound** `POST /webhooks/:provider` : signature AVANT normalisation → invalide = `401/403` ; doublon `UNIQUE(provider_id, provider_event_id)` = `200` idempotent ; Payment final `expired`/`unknown` = `is_late=true` + `AuditLog` → `200` ; erreur DB temporaire = `500` (pour retry provider) ; sinon transaction → `200`.

**Outbound** (vers marchand) : secret généré serveur (`whsec_...`), affiché une fois, stocké hashé (Argon2). Payload signé HMAC-SHA256 (`X-Webhook-Signature`, `X-Event-Id`), avec `event_id` unique + `attempt_id`. Retry `WEBHOOK_RETRY_SCHEDULE` / `WEBHOOK_MAX_RETRIES`, Replay depuis dashboard.

Concurrence webhook + polling + doublon = exactement un changement d'état + une notification : transaction DB + `SELECT FOR UPDATE` (ou locking optimiste) + validation transitions + contraintes uniques.

## API REST (apps/api, spec §7)

- Auth : header `X-API-Key` (`mg_live_` / `mg_test_`), `prefix` + `key_hash` stockés, révocation immédiate. `mg_test_` = MockProvider, aucun appel réel.
- Erreurs uniformes `{ error: { code, message, details, request_id } }` + `correlation_id`. `request_id` / `correlation_id` (uuid7) par requête → header `X-Request-Id` + logs.
- Validation : `phone` E.164, `amount` > 0, `currency` ISO 4217, `country+network` existants + au moins un provider avec `supports() === true` → sinon `422`. Montant API en format humain converti en `amount_minor` via facteur devise.
- Rate limiting sur `POST /payments`.
- Endpoints v1 (cf. spec §7.2) :

```
POST   /api/v1/payments        # {amount, currency, phone, country, network, external_reference?, metadata?, idempotency_key} → 201 {id, status, amount_minor, currency, provider, external_reference, request_id} | 200 même key+hash | 409 IDEMPOTENCY_KEY_REUSED | 422
GET    /api/v1/payments/:id    # {id, idempotency_key, external_reference, amount_minor, currency, phone_masked, country, network, status, provider, provider_reference, attempts[], metadata, correlation_id} — même état final que le webhook marchand
GET    /api/v1/payments        # ?status=&country=&network=&provider=&phone=&external_reference=&from=&to=&page=&per_page= → {data, meta: {total, page, per_page}}
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

## Dashboard (apps/dashboard, spec §10)

- Transactions : tableau paginé + filtres + recherche (`external_reference`/metadata/phone masqué `+243****678`), `amount_minor` formaté.
- Détail : timeline, `providerIdempotencyKey`, `is_late`, `gross/net/fee`, `providerReference`, `request_id`/`correlation_id`, metadata.
- Routing : matrice Pays×Réseau, capabilities + `supportsIdempotency` visibles, drag & drop, audit-logué (avant/après, acteur, IP, `request_id`). Assignation `provider ↔ network` sans toggle on/off.
- Collections (ex-Wallet) = **agrégat lecture seule** `SUM(amount_minor) WHERE succeeded GROUP BY pays, pays-réseau, provider, période`. Jamais présenté comme solde disponible. Export CSV avec mêmes filtres.
- Webhooks : URL, secret masqué après création, logs, Replay, badge `is_late`.
- Pays / Réseaux : seedés, logos. Audit Log : historique admin. API Keys : `mg_live_`/`mg_test_`, clé affichée 1 fois, révocation immédiate.
- Health : métriques par `provider × country × network × currency` (`success, p95 latency, timeout, error, fallback rate`).
- Auth : hash Argon2, cookies session HttpOnly + Secure + SameSite, CSRF, rate-limit login (5/15min/IP) + backoff/lockout progressif, tokens reset one-time, 2FA prévu v2.

## Testing

```bash
bun run test              # unitaires (services, moteur, MockProvider)
bun run test:e2e           # contrôleurs + cycle complet via mg_test_
```

- `MockProvider` couvre tous les cas (§18) : routing/prio, retry même clé, `verify` obligatoire, idempotence, concurrence, late webhook, signature invalide→401, retry+Replay marchand, `supportsIdempotency`.
- Mode `TEST` (`mg_test_`) = cycle complet sans appel provider réel.
- Tests concurrence + double débit automatisés obligatoires.

## Code style

- NestJS : `@Injectable()` + injection constructeur, jamais `new`. DTOs `class-validator` sur tous les bodies, `ValidationPipe` global. Exceptions HTTP typées. Endpoints documentés Swagger (`@ApiTags`, `@ApiOperation`).
- Ordre par feature : `.module.ts` → `.controller.ts` → `.service.ts` → `dto/*.dto.ts` → `*.service.spec.ts`.
- Config via `ConfigModule` + `process.env`, jamais en dur. Pas de `any` non documenté. Pas de dépendance circulaire (`forwardRef()` dernier recours).
- Dashboard : React + Tailwind + Vite, composants par feature.

## Sécurité

- Ne jamais exposer secrets, clés provider, traces internes dans réponses/logs/DB (`raw` expurgé, rétention 30j).
- Valider tout input (`ValidationPipe`, DTOs). Vérifier signatures webhooks avant tout traitement.
- AuditLog pour chaque action admin.

## Observabilité & ops

- Logs structurés (Pino) avec `request_id, payment_id, attempt_id, provider_reference, providerIdempotencyKey, webhook_event_id`.
- Health : `GET /health`.
- Déploiement : Bun + Docker (ou Dokploy), PostgreSQL, queue BullMQ / `@nestjs/schedule` pour polling + retries.

## Ordre d'implémentation (spec §19)

1. Domain model (Payment, Attempt, Provider, Country, Network, RoutingRule, ApiKey, AuditLog — BIGINT, uuid7)
2. State machine + invariants (transitions, `expired` vs `unknown`, late webhook)
3. Provider contract (`supports(): boolean` sync, `supportsIdempotency()`, `providerIdempotencyKey`, mapping)
4. MockProvider (tous cas + idempotence)
5. PostgreSQL + contraintes (UNIQUE, BIGINT, enums, `is_late`)
6. Payment engine (create, resolve, supports local, initiate, verify, retry/fallback sécurisé)
7. Idempotency + concurrence (`request_hash`, 409, transactions, verrous)
8. Webhooks (entrant idempotent + sortant secret généré)
9. Queue / polling / expiration (backoff, `next_poll_at`, `expired`/`unknown`)
10. Premier provider réel (1 seul, E2E)
11. API REST (NestJS, ApiKey `mg_*`, error format, `request_id`, conversion minor)
12. Dashboard (React/Tailwind, auth sécurisée, collections, audit, export)
13. Providers supplémentaires (un par un)

## Definition of Done v1

Référence : critères spec §17 + scénarios §18 + checklist §20. Points critiques :
- `supports()` ne fait jamais d'appel réseau ; provider incompatible non appelé.
- `temporary → retry` même clé ; `unknown/timeout → verify()` obligatoire, pas de fallback si `verify=unknown/pending`.
- `definitive + confirmed_failed → fallback` possible ; `definitive + !confirmed → unknown`, pas de fallback.
- `succeeded` jamais rétrogradé ; webhook tardif après `expired` → `is_late=true` + AuditLog, pas de transition.
- Webhook dupliqué → traité 1 seule fois ; signature invalide → `401/403` ; erreur interne temporaire → `500`.
- Webhook marchand : `event_id` + `attempt_id` + HMAC + secret généré affiché 1 fois.
- `GET` et webhook marchand exposent le même état final ; polling + webhooks concurrents → pas d'incohérence.
- Tentative traçable avec `providerIdempotencyKey` ; retry même clé → pas de double débit.
- Dashboard : timeline + Collections + export CSV + AuditLog ; login protégé (rate limit, lockout, CSRF, Argon2) ; API key affichée 1 fois.
- Système OK si un provider est down ; expiration → `expired`/`unknown`, jamais `failed` auto.

## Règle d'or (spec §21)

```
1 intention de paiement
      ↓
0 double débit (idempotence provider + verify avant fallback)
      ↓
1 état final cohérent (state machine stricte + expired≠unknown)
      ↓
1 historique traçable (correlation_id + is_late + AuditLog)
      ↓
1 notification fiable (event_id + HMAC + retry configurable)
```

## Workflow git

- Rebase avant modif, push direct. Commits courts et ciblés avec le code associé.
- Toute modif routage/priorité = audit-log + migration/seed si structurelle.

## Pièges connus (ne pas reproduire)

- on/off provider en DB → dérive config↔DB, trous de routage silencieux.
- Réseau modélisé en string unique ("airtel") → `CD` vs `CG` inroutable.
- Pas de `PaymentAttempt` persisté → debug fallback et collections par provider impossibles.
- `supports()` async/réseau → latence + pannes sur le chemin de routage.
- `failed` ambigu traité comme fallback-éligible → doubles débits.
- Webhook tardif qui mute un état final → incohérence ; toujours `is_late` + AuditLog.
- Secret webhook fourni par le marchand → toujours généré serveur, affiché 1 fois.
