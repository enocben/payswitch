# Cahier de Charge — Orchestrateur Mobile Money Open Source

> **Statut :** Draft v1.3 — Corrigé après revue v1.2 (12 points critiques + stack figée)
> **Date :** 19 septembre 2026
> **Licence :** Apache 2.0
> **Repo :** [enocben/payswitch](https://github.com/enocben/payswitch) — monorepo Bun
> **Stack :** NestJS + React + Tailwind CSS + Bun + PostgreSQL
> **Package core :** `@payswitch/core` (framework agnostic, exportable npm)
> **Base :** v1.2 + document complémentaire `corrections_cahier_charge_orchestrateur_v1_2.pdf`

---

## 1. Vision & Contexte

### 1.1 Problème
Les agrégateurs Mobile Money (Pawapay, CinetPay, Flutterwave, Hubtel, etc.) couvrent plusieurs pays et réseaux (Airtel, Orange, Wave, MTN, Moov...), mais **aucun n'est fiable partout**. Un réseau peut être stable chez un provider et instable chez un autre selon le pays.

### 1.2 Solution
Un **orchestrateur mono-tenant, self-hostable, open source** qui expose **une seule API d'encaissement** et route chaque paiement vers le meilleur provider selon une règle statique :

```
(Pays + Réseau) → [Provider prio 1, Provider prio 2, ...]
CD-AIRTEL → Pawapay (prio 1), CinetPay (prio 2)
CG-AIRTEL → CinetPay (prio 1), Pawapay (prio 2)
UG-AIRTEL → Flutterwave (prio 1)
```

Le moteur garantit **1 intention = 0 double débit, 1 état final cohérent, 1 historique traçable, 1 notification fiable**.

### 1.3 Positionnement
- **Mono-repo Bun pour v1** (`enocben/payswitch`, workspaces `apps/*` + `packages/*`) — extraction `@payswitch/core` après stabilisation.
- Mono-tenant v1 (1 instance = 1 marchand), Bring Your Own Account.
- **Stack figée :** NestJS (API + jobs), React + Tailwind CSS (dashboard), Bun (runtime + package manager), PostgreSQL, queue (BullMQ ou Nest scheduler).
- **Database à la racine** (`/database/migrations` + `/database/seeds`) partagée par `apps/api` et `packages/core`.

```
Merchant SaaS → REST API (NestJS) → Payment Service → Orchestrator (capability check, routing, state machine, retry, verification, fallback)
                                        ↓
                              Pawapay Adapter / CinetPay Adapter → Mobile Money
                                        ↑
                         Webhooks → Webhook Processor → State Machine → Merchant Webhook (HMAC, retry)
                         PostgreSQL + Queue/Scheduler + Logs + Metrics + Dashboard (React/Tailwind)
```

---

## 2. Périmètre v1 (MVP)

### 2.1 Inclus
- Encaissement uniquement (collect).
- Routing statique `pays + réseau → liste priorisée` **avec vérification locale `supports()`** (pays, réseau, devise, montant min/max, opération) — **sans appel réseau**.
- **Retry / fallback sécurisé** : `definitive_failure / temporary_failure / unknown` + distinction `confirmed_failed` vs `unknown` + **idempotence provider** (`supportsIdempotency`, clé provider déterministe persistée).
- Interface provider avec `supports(): boolean`, `supportsIdempotency(): boolean`, mapping réseau interne → code provider, montants en **unités mineures (BIGINT)** en interne.
- Config providers via `config/providers.ts` + `.env` (secrets). Pas de toggle dashboard v1.
- Webhooks entrants `POST /webhooks/:provider` avec vérif signature + idempotence `UNIQUE(provider_id, provider_event_id)` + `500` sur erreur interne temporaire.
- Webhooks sortants vers marchand : secret **généré par le système** (affiché 1 fois), `event_id + attempt_id`, HMAC-SHA256, retries configurables.
- Polling de secours avec backoff configurable via queue (`next_poll_at`, `poll_attempts`) + expiration globale (`expired` ≠ `unknown`).
- Idempotency marchand : `idempotency_key` (clé métier libre) + `request_hash` → `409` si payload différent.
- State machine stricte + concurrence (transactions, verrous) + règle **webhook tardif après expiration** (AuditLog, pas de rétrogradation aveugle).
- Dashboard React/Tailwind : transactions, routing, **Collections**, webhooks, audit, export CSV, health monitoring, **sécurité renforcée** (Argon2, HttpOnly/Secure, CSRF, rate limit, lockout).
- Modèle : `Country, Network, Provider, RoutingRule, Payment, PaymentAttempt, WebhookEvent, WebhookDelivery, ApiKey, AuditLog` + `MockProvider` obligatoire + `TEST/LIVE`.

### 2.2 Hors périmètre v1
- Payout, remboursement, routing dynamique, multi-tenant, billing, ledger complet, hot reload, 2FA (prévu v2).

---

## 3. Acteurs

| Acteur | Description |
|--------|-------------|
| **Marchand / Dev SaaS** | Intègre l'API, self-héberge l'instance (Bun + NestJS). |
| **Utilisateur final** | Paye via PIN sur téléphone. |
| **Provider** | Pawapay, CinetPay, Flutterwave, etc. |
| **Admin** | Le marchand lui-même (mono-tenant). |

---

## 4. User Stories

### 4.1 Intégration API
- **US-01** — `POST /payments` avec `{amount, currency, phone, country, network, external_reference?, metadata?, idempotency_key}` → `201 {id, status, request_id}`. Montant exposé côté API en format devise, stocké en interne en **minor units (BIGINT)**.
- **US-02** — `GET /payments/:id` → même état final que le webhook marchand.
- **US-03** — Même `idempotency_key` + même `request_hash` → `200` même Payment. Même key + hash différent → `409 IDEMPOTENCY_KEY_REUSED`.
- **US-04** — `external_reference` indexé + `metadata` libre retrouvés dans dashboard/webhooks.

### 4.2 Routing & Providers
- **US-05** — `config/providers.ts` + `.env` pour activer/configurer.
- **US-06** — Dashboard : réordonner priorités par `pays + réseau`.
- **US-07** — `definitive_failure` + `confirmed_failed` → fallback possible si `canFallback`. `temporary_failure` → retry. `unknown/timeout` → `verify()` obligatoire, **pas de fallback tant que `verify()` reste `unknown/pending`** → reste `pending` + polling.
- **US-08** — Provider custom implémentant `PaymentProvider` (avec `supports(): boolean`, `supportsIdempotency()`, mapping réseau) → sans toucher au core.

### 4.3 Webhooks
- **US-09** — `POST /webhooks/:provider` : `401/403` si signature invalide, `200` si déjà traité, `500` si erreur interne temporaire, `200` si traité.
- **US-10** — `POST /api/v1/webhooks` → le système **génère** le `secret` (affiché 1 fois, stocké hashé), payload `event_id + attempt_id` + HMAC, retries configurables, Replay.
- **US-11** — Sans webhook → `verify()` via queue/backoff ; à `PAYMENT_EXPIRATION_HOURS` (défaut 24h) → `expired` ou `unknown` (jamais `failed` auto). **Webhook tardif après `expired/unknown`** : enregistré + `AuditLog`, pas de changement d'état aveugle, orienté reconciliation future.

### 4.4 Dashboard
- **US-12** — Liste paginée + filtres + recherche `external_reference`/metadata/phone masqué.
- **US-13** — Détail : timeline, `correlation_id`, `amount_minor`, `gross/net/fee`, `providerReference`, `providerIdempotencyKey`.
- **US-14** — **Collections** : `Total collected` par pays/réseau/provider/période, export CSV.
- **US-15** — Réordonner routing (audit loggé).
- **US-16** — Pays/réseaux seedés avec logos.

---

## 5. Modèle de Données

### 5.1 Entités

```
Country
- id (uuid7), code (ISO), name, currency_default (CHAR3, indicatif)
- created_at, updated_at

Network
- id (uuid7), country_id (FK), code, display_name, logo_url, is_active
- UNIQUE(country_id, code) → CD-AIRTEL ≠ CG-AIRTEL

Provider
- id (uuid7), code, display_name
- is_enabled (config), is_healthy (runtime, v1 lecture seule)
- capabilities (JSON: supported_countries, networks, currencies, min_amount_minor, max_amount_minor, operations)
- supports_idempotency (bool)
- config (JSON non sensible)
- created_at, updated_at

RoutingRule
- id (uuid7), country_id, network_id, provider_id, priority (int)
- UNIQUE(country_id, network_id, provider_id)
- UNIQUE(country_id, network_id, priority)

Payment — intention globale
- id (uuid7, PK)
- idempotency_key (string, UNIQUE — clé métier libre)
- request_hash (string, SHA256 payload normalisé)
- external_reference (string, nullable, indexé)
- amount_minor (BIGINT — unité mineure, ex: CDF centimes)
- currency (CHAR3, ISO 4217 — devise effective)
- phone (string, E.164 — masqué en logs, prévoir phone_hash/last4)
- country_id, network_id (FK)
- status (enum: created, processing, pending, succeeded, failed, unknown, expired)
  - unknown = le système ne sait pas ce qui s'est passé chez le provider
  - expired = fenêtre métier dépassée sans confirmation finale
- gross_amount_minor, provider_fee_minor, net_amount_minor (BIGINT, nullable)
- metadata (JSONB), correlation_id/request_id (string)
- expires_at (timestamp), poll_attempts (int), next_poll_at (timestamp)
- created_at, updated_at
- INDEX(external_reference), INDEX(status, next_poll_at)

PaymentAttempt — tentative chez un provider
- id (uuid7), payment_id (FK), provider_id (FK), attempt_number (int)
- status (enum: created, sending, accepted, pending, succeeded, failed, timeout, unknown, cancelled)
- provider_reference (string, nullable)
- provider_idempotency_key (string — clé déterministe persistée, ex: hash(payment_id + attempt_number))
- provider_raw_request/response (JSONB, redacted)
- normalized_response (JSONB)
- error_code, error_message, error_outcome (definitive/temporary/unknown)
- confirmed (bool — true si échec confirmé par provider, false si ambigu)
- created_at, updated_at

WebhookEvent — entrant
- id (uuid7), provider_id, payment_id (nullable)
- provider_event_id (string)
- raw_body (JSONB, redacted), signature_valid (bool)
- normalized_status (enum)
- is_late (bool — true si arrivé après expired/unknown)
- processed_at, created_at
- UNIQUE(provider_id, provider_event_id)

WebhookDelivery — sortant
- id (uuid7), event_id (uuid7, UNIQUE), payment_id, attempt_id (nullable)
- url, event_type (payment.succeeded/failed/unknown)
- payload (JSONB), signature (HMAC)
- status (pending/delivered/failed/retrying)
- attempts, next_retry_at, last_response_code, last_response_body
- created_at, updated_at

ApiKey
- id (uuid7), name, key_hash (Argon2), prefix (mg_live_ / mg_test_)
- scopes (JSON), last_used_at, created_at, revoked_at
- Règle : clé complète affichée uniquement à la création, ensuite hash/prefix seuls, révocation immédiate.

AuditLog
- id (uuid7), action, actor, resource_type, resource_id
- old_value, new_value (JSONB), ip, request_id, created_at
```

### 5.2 Machines à états

**Payment**
```
created → processing → pending → succeeded
                          ↓→ failed          (definitive + confirmed_failed)
                          ↓→ unknown         (pas de confirmation, incertain)
                          ↓→ expired         (fenêtre PAYMENT_EXPIRATION_HOURS dépassée)

Règle d'or : un état final (succeeded, failed, unknown, expired) ne peut jamais être rétrogradé.
pending → succeeded ✓ | succeeded → failed ✗ | expired → succeeded ✗ (webhook tardif → log + AuditLog, pas de transition aveugle)
```

**PaymentAttempt**
```
created → sending → accepted → pending → succeeded
                        ↓→ failed (confirmed) / timeout / unknown / cancelled
```

### 5.3 Concurrence
- Transaction DB + `SELECT FOR UPDATE` ou optimistic locking.
- Contraintes uniques + validation transitions avant UPDATE.
- 1 seul changement métier + 1 seule notification par événement.

### 5.4 Webhook tardif après expiration
```
Payment = expired (24h sans confirmation)
  → provider envoie webhook succeeded (tardif)
    → NE PAS faire expired → succeeded automatiquement
    → Enregistrer WebhookEvent(is_late=true) + AuditLog
    → Exposer dans dashboard comme "late webhook — requires reconciliation"
    → v2 : orienter vers Settlement/Reconciliation manuelle
```
Politique v1 : tout webhook arrivant après un état final `expired/unknown` est **journalisé mais ne mute pas** le Payment sans règle explicite.

---

## 6. Interface Provider (Adapter Pattern)

### 6.1 Contrat (corrigé)

```ts
interface PaymentProvider {
  readonly code: string
  readonly displayName: string

  // Vérification locale, SYNCHRONE, basée sur capabilities — pas d'appel réseau
  supports(params: SupportParams): boolean

  // Le provider supporte-t-il l'idempotence native ?
  supportsIdempotency(): boolean

  initiate(params: InitiateParams): Promise<InitiateResult>
  verify(params: VerifyParams): Promise<VerifyResult>
  verifyWebhookSignature(rawBody: string, headers: Record<string, string>): boolean
  parseWebhook(rawBody: string, headers: Record<string, string>): NormalizedWebhookEvent
  normalizeError(rawError: unknown): NormalizedError

  mapNetwork?(internal: { country: string; network: string }): string
}

type SupportParams = {
  country: string; network: string; currency: string
  amountMinor: number // BIGINT en JS = number/bigint selon env, stocké BIGINT en DB
  operation?: 'collect'
}

type InitiateParams = {
  amountMinor: number; currency: string; phone: string
  country: string; network: string
  paymentId: string; idempotencyKey: string
  providerIdempotencyKey: string // déterministe, persisté dans PaymentAttempt
  externalReference?: string
  metadata?: Record<string, unknown>
  correlationId: string
}

type InitiateResult = {
  providerReference: string // vide si unknown
  status: 'pending' | 'failed' | 'unknown'
  rawRequest: unknown; rawResponse: unknown
  outcome: 'success' | 'definitive_failure' | 'temporary_failure' | 'unknown'
  confirmed: boolean // true = échec confirmé, false = ambigu
}

type VerifyParams = { providerReference: string; paymentId: string; providerIdempotencyKey?: string }
type VerifyResult = {
  status: 'succeeded' | 'confirmed_failed' | 'pending' | 'unknown'
  rawResponse: unknown
}
type NormalizedWebhookEvent = {
  providerReference: string; providerEventId: string
  status: 'succeeded' | 'confirmed_failed' | 'unknown'; rawBody: unknown
}
type ErrorOutcome = 'definitive_failure' | 'temporary_failure' | 'unknown'
type NormalizedError = {
  code: string; message: string
  outcome: ErrorOutcome
  confirmed: boolean
  canRetry: boolean; canFallback: boolean; requiresVerification: boolean
  rawError?: unknown
}
```

**Idempotence provider :**
- `providerIdempotencyKey` = déterministe (ex: `SHA256(paymentId + attempt_number)` ou `idempotency_key:attempt`) et **persistée** dans `PaymentAttempt`.
- Sur retry involontaire (timeout → retry), la même clé est réutilisée → le provider ne crée pas un second paiement.
- Si `supportsIdempotency() === false`, l'orchestrateur ne doit pas retenter aveuglément ; il doit `verify()` d'abord.

### 6.2 Capabilities locales (pas d'appel réseau dans supports)

```ts
// capabilities du provider (config)
{
  supported_countries: ["CD", "CG", "UG"],
  supported_networks: { CD: ["AIRTEL", "ORANGE"], CG: ["AIRTEL"] },
  supported_currencies: ["CDF", "XAF", "UGX"],
  min_amount_minor: 100, // 100 = 1.00 selon devise
  max_amount_minor: 100000000,
  operations: ["collect"],
  supports_idempotency: true
}
// supports() teste ces règles en mémoire — initiate()/verify() font les vrais appels HTTP
```

### 6.3 Enregistrement (NestJS)

```ts
// config/providers.ts
import { PawapayProvider } from './providers/pawapay.provider'
import { CinetPayProvider } from './providers/cinetpay.provider'

export const providers = {
  pawapay: {
    enabled: true,
    provider: new PawapayProvider({
      apiKey: process.env.PAWAPAY_API_KEY!,
      webhookSecret: process.env.PAWAPAY_WEBHOOK_SECRET!,
    }),
  },
  cinetpay: { enabled: true, provider: new CinetPayProvider({ ... }) },
}
```

### 6.4 MockProvider (obligatoire)
Simule `success, confirmed_failed, temporary_failure, timeout/unknown, pending, duplicate webhook, webhook delayed` — pour tests auto et dev local avec `mg_test_` keys.

---

## 7. API REST (v1) — NestJS

### 7.1 Authentification & corrélation
- `X-API-Key: mg_live_...` ou `mg_test_...` → `ApiKey.key_hash` (Argon2), `prefix` visible.
- Clé complète affichée **une seule fois** à la création.
- `request_id` / `correlation_id` (uuid7) par requête → header `X-Request-Id` + logs.

### 7.2 Endpoints

```
POST   /api/v1/payments
  Body: { amount, currency, phone, country, network, external_reference?, metadata?, idempotency_key }
  → amount accepté en format décimal (ex: 5000) ou minor selon doc, stocké en amount_minor
  → 201 { id, status, amount_minor, currency, provider, external_reference, request_id }
  → 200 si même key + même hash
  → 409 { error: { code: "IDEMPOTENCY_KEY_REUSED" } } si même key + hash différent
  → 422 validation

GET    /api/v1/payments/:id
  → 200 { id, idempotency_key, external_reference, amount_minor, currency, phone_masked, country, network, status, provider, provider_reference, attempts[], metadata, correlation_id }

GET    /api/v1/payments
  Query: ?status=&country=&network=&provider=&phone=&external_reference=&from=&to=&page=&per_page=
  → 200 { data: [...], meta: { total, page, per_page } }

POST   /api/v1/webhooks
  Body: { url, events: ["payment.succeeded", "payment.failed", "payment.unknown"] }
  → 201 { id, url, events, secret: "whsec_..." }  // secret généré, affiché 1 fois !
  → secret stocké hashé (Argon2), utilisé pour HMAC

GET    /api/v1/webhooks
DELETE /api/v1/webhooks/:id

GET    /api/v1/countries
GET    /api/v1/networks?country=CD
GET    /api/v1/routing
PUT    /api/v1/routing  // [{country, network, providers: ["pawapay", ...]}]

POST   /webhooks/:provider  // entrant provider, public
  → 401/403 | 200 (idempotent) | 500 (retry) | 200 (traité)

GET    /api/v1/collections  // ex-wallet
  → 200 { by_country: [...], by_network: [...], by_provider: [...] }
GET    /api/v1/collections/export?format=csv&...

GET    /health
```

### 7.3 Validation & erreurs
- `phone` E.164, `amount` > 0, `currency` ISO 4217, `country+network` existants + au moins un provider `supports() === true`.
- Format d'erreur uniforme :

```json
{
  "error": {
    "code": "INVALID_PHONE",
    "message": "Invalid phone number",
    "details": { "field": "phone" },
    "request_id": "01k..."
  }
}
```

### 7.4 Montants — unités mineures
- **Interne (DB, moteur) :** `BIGINT amount_minor` (ex: `500000` pour `5000.00 CDF` si 2 décimales). Évite les erreurs `decimal`.
- **API (externe) :** le marchand envoie `amount: 5000` (format humain) ou `amount_minor` selon doc — le controller convertit en `amount_minor` via `currency → minor factor`.
- Dashboard affiche le format humain, mais `amount_minor` reste la source de vérité.

---

## 8. Webhooks

### 8.1 Entrants (Provider → Nous)
```
signature valide ? → non → 401/403
              → oui → déjà traité (UNIQUE) ? → oui → 200
                                    → non → is_late (Payment déjà expired/unknown) ? → log + AuditLog + 200 (pas de mutation aveugle)
                                                          → sinon → process en transaction → 200 | 500
```

### 8.2 Sortants (Nous → Marchand)
- Secret **généré** à la création du webhook (`whsec_...`), affiché 1 fois, stocké hashé, HMAC-SHA256 (`X-Webhook-Signature`, `X-Event-Id`).
- `event_id` unique + `attempt_id` pour idempotence marchand.
- Retry **configurable** (`WEBHOOK_RETRY_SCHEDULE=1m,5m,15m,1h,6h,24h`, `WEBHOOK_MAX_RETRIES`).
- Replay depuis dashboard.

---

## 9. Routing & Fallback (sécurisé — double débit interdit)

### 9.1 Configuration
- Seed `config/routing.ts` → `RoutingRule`. Dashboard drag & drop → `AuditLog`.
- États provider : `configured / enabled / healthy / available` (v1 `healthy` lecture seule).

### 9.2 Logique (corrigée)

```
1. POST /payments {CD, AIRTEL, CDF, 500000 minor}
2. RoutingRule WHERE country=CD AND network=AIRTEL ORDER BY priority → [pawapay(1), cinetpay(2)]
3. Filtrer par supports() LOCAL (pas d'appel réseau) → [pawapay, cinetpay]
4. pawapay.initiate({ providerIdempotencyKey: SHA256(paymentId+":1") })
   ├── success → pending
   ├── definitive_failure + confirmed=true + canFallback → fallback → cinetpay
   ├── definitive_failure + confirmed=false → PAS de fallback → unknown (verify)
   ├── temporary_failure → retry 1 fois (même providerIdempotencyKey)
   │     └── 2e temporary + canFallback → fallback
   └── unknown/timeout
         └── verify() OBLIGATOIRE (même providerReference/providerIdempotencyKey)
               ├── succeeded → terminé
               ├── confirmed_failed + canFallback → fallback
               ├── confirmed_failed + !canFallback → failed
               ├── unknown/pending → rester pending, programmer next_poll_at (backoff), PAS de fallback
               └── pending → rester pending

5. Polling via queue : next_poll_at avec backoff configurable (30s, 2m, 5m, 10m, 30m, 1h, 2h)
6. À expires_at (24h défaut) → expired (si pending) ou unknown (si incertain) — jamais failed auto
7. Webhook tardif après expired/unknown → is_late=true, AuditLog, dashboard "late — reconciliation"
```

**Règle absolue :** aucun fallback tant que l'état du premier provider n'est pas `confirmed_failed` ou `succeeded`. `unknown/pending` → on attend.

---

## 10. Dashboard (React + Tailwind CSS)

### 10.1 Stack
- **Frontend :** React + Tailwind CSS (proposé), **Backend :** NestJS, **Runtime :** Bun, **DB :** PostgreSQL.
- Auth admin local (mono-tenant) — **sécurité renforcée** :

```
- Argon2 pour hash mot de passe
- Session avec cookies HttpOnly + Secure + SameSite
- Protection CSRF (double submit ou CSRF token)
- Rate limiting login (ex: 5 tentatives / 15min / IP)
- Backoff / lockout progressif
- Reset password (token à usage unique, expiry courte)
- 2FA : prévu v2 (TOTP), architecture prête
```

### 10.2 Pages

| Page | Contenu |
|------|---------|
| **Transactions** | Tableau + filtres + recherche, téléphone masqué, `amount_minor` formaté. |
| **Transaction détail** | Timeline, `providerIdempotencyKey`, `is_late`, `gross/net/fee`, `request_id`. |
| **Routing** | Matrice Pays×Réseau, capabilities + `supportsIdempotency`, drag & drop + AuditLog. |
| **Collections** | Par pays/réseau/provider/période, export CSV. |
| **Webhooks** | URL, `secret` (masqué après création), logs, Replay, `is_late` badge. |
| **Pays / Réseaux** | Seedés, logos. |
| **Audit Log** | Historique admin. |
| **API Keys** | `mg_live_`/`mg_test_`, création (clé affichée 1 fois), révocation immédiate. |

### 10.3 Health
Métriques par `provider × country × network × currency` : `success, p95 latency, timeout, error, fallback rate`.

---

## 11. Sécurité & Conformité

- Secrets en `.env`, jamais en `raw`/logs (redaction).
- `ApiKey` Argon2, `prefix` visible, révocation immédiate.
- Webhook secret généré, hashé, affiché 1 fois.
- Rate limiting `POST /payments`, validation stricte, error format + `request_id`.
- PII masquée, retention `raw` (30j), `phone_hash/last4` prévu.

---

## 12. Observabilité & Ops (NestJS + Bun)

- Logs structurés (Pino) avec `request_id, payment_id, attempt_id, provider_reference, providerIdempotencyKey, webhook_event_id`.
- Health : `GET /health`.
- Déploiement : `Bun` + `Docker` (ou Dokploy), Postgres, queue BullMQ / `@nestjs/schedule` pour polling + retries.
- `bun.lockb` + `bun install`, `bun run dev/build/test`.

---

## 13. Seed Pays / Réseaux

```ts
countries: [
  { code: "CD", name: "RDC", currency_default: "CDF" },
  { code: "CG", name: "Congo", currency_default: "XAF" },
  { code: "UG", name: "Ouganda", currency_default: "UGX" },
  { code: "CI", name: "Côte d'Ivoire", currency_default: "XOF" },
]
networks: [
  { country: "CD", code: "AIRTEL", display_name: "Airtel RDC", logo: "/logos/airtel.png" },
  { country: "CD", code: "ORANGE", display_name: "Orange RDC", logo: "/logos/orange.png" },
  { country: "CG", code: "AIRTEL", display_name: "Airtel Congo", logo: "/logos/airtel.png" },
  { country: "CI", code: "WAVE", display_name: "Wave CI", logo: "/logos/wave.png" },
]
```

---

## 14. Architecture Technique (Mono-repo Bun — payswitch)

```
payswitch/                           # enocben/payswitch — Apache 2.0
│
├── apps/
│   ├── api/                         # NestJS + Bun
│   │   └── src/
│   │       ├── modules/
│   │       │   ├── payments/
│   │       │   ├── webhooks/        # entrants provider + sortants marchand
│   │       │   ├── routing/
│   │       │   ├── providers/       # adapters Nest (injectent @payswitch/core)
│   │       │   ├── api-keys/
│   │       │   └── health/
│   │       ├── jobs/                # polling, webhook-delivery (BullMQ)
│   │       └── infrastructure/
│   │           ├── database/        # TypeORM/Prisma client, config
│   │           └── queue/
│   │
│   └── dashboard/                   # React + Tailwind + Vite
│       └── src/
│           ├── pages/               (Transactions, Detail, Routing, Collections)
│           └── components/
│
├── packages/
│   └── core/                        # @payswitch/core — framework agnostic, exportable npm
│       └── src/
│           ├── domain/
│           │   ├── payment/         (entity, status, transitions)
│           │   ├── attempt/         (entity, outcome)
│           │   ├── country/ & network/
│           │   └── state-machine/   (transitions Payment vs Attempt)
│           ├── engine/
│           │   ├── payment-engine.ts
│           │   ├── routing-engine.ts  (supports() local)
│           │   ├── idempotency.ts     (key + request_hash)
│           │   └── verification.ts    (verify avant fallback)
│           ├── providers/
│           │   ├── contract.ts      (supports(), supportsIdempotency(), mapNetwork(), BIGINT)
│           │   └── mock.ts
│           ├── errors/ & types/
│           └── index.ts             # barrel export
│
├── database/                        # racine, partagée (migrations + seeds)
│   ├── migrations/
│   └── seeds/ (countries, networks, routing)
│
├── tests/ (unit + integration — MockProvider)
├── docs/ (cahier v1.3)
├── docker/ (Dockerfile api + dashboard + compose)
├── package.json  # workspaces: ["apps/*", "packages/*"]
└── bun.lockb
```

- `package.json` racine : `"workspaces": ["apps/*", "packages/*"]`, `"packageManager": "bun"`
- `packages/core/package.json` : `"name": "@payswitch/core", "version": "0.1.0", "license": "Apache-2.0"`
- `apps/api` importe `import { PaymentEngine } from "@payswitch/core"` en `workspace:*`
- 1 `bun install` à la racine, `bun run dev` lance api + dashboard
- Extraction npm de `@payswitch/core` en v2 sans toucher au reste

---

## 15. Roadmap

### v1
Domain + State Machine + Provider Contract (sync supports + idempotency) + MockProvider + PostgreSQL (BIGINT) + Engine sécurisé + Idempotency + Webhooks (secret généré, is_late) + Queue/Polling/Expiration + 1er provider réel + API REST + Dashboard (sécurisé) + providers supplémentaires

### v2
`@mobgateway/core`, payout/refund, multi-tenant, routing dynamique, ledger, 2FA, hot reload.

---

## 16. Décisions figées

| Question | Décision v1.3 |
|----------|---------------|
| Repo | **enocben/payswitch** (https://github.com/enocben/payswitch) |
| Licence | **Apache 2.0** |
| Package core | **@payswitch/core** (framework agnostic, `packages/core`) |
| Monorepo | **Bun workspaces** `apps/*` + `packages/*`, `database/` à la racine |
| Stack | **NestJS + React + Tailwind + Bun + PostgreSQL** |
| Mono-tenant | Oui |
| Mono-repo | Oui |
| Montants | **BIGINT minor units en interne** |
| supports() | **Sync boolean, local capabilities** |
| Idempotence provider | **Clé déterministe persistée par tentative** |
| Fallback | **Uniquement sur confirmed_failed, jamais sur unknown/pending** |
| expired vs unknown | **Distincts** (expired=fenêtre dépassée, unknown=incertain) |
| Webhook tardif | **Log + AuditLog, pas de mutation aveugle** |
| Webhook secret | **Généré, affiché 1 fois, stocké hashé** |
| Dashboard auth | **Argon2 + HttpOnly/Secure + CSRF + rate limit + lockout** |
| API Keys | **mg_live_/mg_test_, affichée 1 fois, révocation immédiate** |
| Timeout | `PAYMENT_EXPIRATION_HOURS` défaut 24h → `expired` |
| Polling | Queue + backoff `30s,2m,5m,10m,30m,1h,2h` |
| Sandbox | MockProvider obligatoire |

---

## 17. Critères d'acceptation v1.3

```
[ ] POST /payments → provider compatible (supports() local) par priorité
[ ] supports() ne fait jamais d'appel réseau
[ ] amount stocké en BIGINT minor, exposé formaté
[ ] provider incompatible non appelé
[ ] definitive + confirmed_failed → fallback possible
[ ] definitive + !confirmed → pas de fallback → unknown
[ ] temporary → retry avec même providerIdempotencyKey
[ ] unknown/timeout → verify() obligatoire, pas de fallback si verify=unknown/pending
[ ] verify=confirmed_failed → fallback possible
[ ] succeeded ne peut plus être rétrogradé
[ ] webhook tardif après expired → is_late + AuditLog, pas de transition
[ ] même key + même hash → même Payment
[ ] même key + hash différent → 409
[ ] webhook dupliqué → 1 seule fois
[ ] webhook valide + erreur interne → 500
[ ] webhook marchand : event_id + attempt_id + HMAC + secret généré
[ ] GET et webhook exposent même état final
[ ] polling + webhooks concurrents → pas d'incohérence
[ ] tentative traçable avec providerIdempotencyKey
[ ] dashboard : timeline + Collections + export CSV + AuditLog
[ ] login protégé (rate limit, lockout, CSRF, Argon2)
[ ] API key affichée 1 fois, mg_live_/mg_test_
[ ] MockProvider couvre tous les cas
[ ] système OK si provider down
[ ] expiration → expired/unknown, pas failed
```

---

## 18. Scénarios de tests obligatoires

### Routing
```
[ ] CD-AIRTEL → prio 1 | incompatible → suivant | supports() local
```

### Retry / fallback (provider-safe)
```
[ ] success → pas de fallback
[ ] definitive confirmed → fallback
[ ] definitive !confirmed → pas de fallback
[ ] temporary → retry même clé
[ ] timeout → verify, si unknown → pas de fallback, reste pending
[ ] verify confirmed_failed → fallback
```

### Idempotence
```
[ ] même key + même payload → même Payment
[ ] même key + payload différent → 409
[ ] retry provider avec même providerIdempotencyKey → pas de double débit (mock)
[ ] duplicate webhook → 1 fois
```

### Concurrence + late webhook
```
[ ] webhook + polling simultanés
[ ] deux webhooks identiques simultanés
[ ] succeeded ne revient pas à failed
[ ] webhook tardif après expired → is_late + AuditLog
```

### Webhooks & provider
```
[ ] signature invalide → 401 | erreur temporaire → 500
[ ] webhook marchand down → retry + Replay
[ ] MockProvider tous cas + supportsIdempotency
```

---

## 19. Ordre de développement (corrigé)

1. **Domain model** (Payment, Attempt, Provider, Country, Network, RoutingRule, ApiKey, AuditLog — BIGINT)
2. **State Machine + invariants** (transitions, expired vs unknown, late webhook)
3. **Provider Contract** (`supports(): boolean`, `supportsIdempotency()`, `providerIdempotencyKey`, mapping)
4. **MockProvider** (tous cas + idempotence)
5. **PostgreSQL + contraintes** (UNIQUE, BIGINT, enums, is_late)
6. **Payment Engine** (create, resolve, supports local, initiate, verify, retry/fallback sécurisé)
7. **Idempotency + concurrence** (request_hash, 409, transactions, verrous)
8. **Webhooks** (entrant idempotent + sortant secret généré)
9. **Queue / polling / expiration** (backoff, `next_poll_at`, `expired/unknown`)
10. **Premier provider réel** (1 seul, E2E)
11. **API REST** (NestJS, ApiKey mg_*, error format, request_id, minor conversion)
12. **Dashboard** (React/Tailwind, auth sécurisée, collections, audit, export)
13. **Providers supplémentaires**

---

## 20. Checklist avant démarrage

```
[ ] Idempotence provider définie et testée (clé déterministe persistée)
[ ] Retry provider-safe (même clé sur retry)
[ ] Fallback interdit sur unknown/pending (verify obligatoire)
[ ] confirmed_failed distingué de unknown
[ ] supports() sync local basé sur capabilities
[ ] Montants en BIGINT minor units
[ ] expired et unknown distincts + politique webhook tardif
[ ] Secrets webhook générés et protégés (affichés 1 fois)
[ ] Dashboard protégé (Argon2, HttpOnly/Secure, CSRF, rate limit, lockout, reset)
[ ] API keys mg_live_/mg_test_ non récupérables
[ ] Tests concurrence + double débit automatisés
[ ] Stack Bun + NestJS + React + Tailwind prête
```

## 21. Règle d'or

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

*Fin du cahier v1.3 corrigé — prêt pour démarrage avec NestJS/React/Tailwind/Bun.*
