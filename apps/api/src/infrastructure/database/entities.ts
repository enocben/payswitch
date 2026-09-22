// @payswitch/api — entités TypeORM (miroir exact database/migrations/*.sql).
// Le schéma reste possédé par les migrations SQL racine (synchronize: false) ;
// ces entités sont le client typé (spec §14 : client/config uniquement).
// Montants BIGINT ↔ bigint via transformer (jamais decimal/float).

import { Column, Entity, Index, PrimaryColumn } from "typeorm";

const bigintTransformer = {
  to: (v: bigint | null | undefined) =>
    v === null || v === undefined ? v : v.toString(),
  from: (v: string | number | bigint | null) =>
    v === null || v === undefined ? v : BigInt(v as string | number | bigint),
};

@Entity("countries")
export class CountryEntity {
  @PrimaryColumn("uuid")
  id!: string;

  @Column({ type: "text", unique: true })
  code!: string;

  @Column({ type: "text" })
  name!: string;

  @Column({ type: "char", length: 3 })
  currency_default!: string;

  @Column({ type: "text", nullable: true })
  phone_prefix!: string | null;

  @Column({ type: "timestamptz", default: () => "now()" })
  created_at!: Date;

  @Column({ type: "timestamptz", default: () => "now()" })
  updated_at!: Date;
}

@Entity("networks")
@Index("uq_network_country_code", ["country_id", "code"], { unique: true })
export class NetworkEntity {
  @PrimaryColumn("uuid")
  id!: string;

  @Column("uuid")
  country_id!: string;

  @Column({ type: "text" })
  code!: string;

  @Column({ type: "text" })
  display_name!: string;

  @Column({ type: "text", nullable: true })
  logo_url!: string | null;

  @Column({ type: "boolean", default: true })
  is_active!: boolean;

  @Column({ type: "timestamptz", default: () => "now()" })
  created_at!: Date;

  @Column({ type: "timestamptz", default: () => "now()" })
  updated_at!: Date;
}

@Entity("providers")
export class ProviderEntity {
  @PrimaryColumn("uuid")
  id!: string;

  @Column({ type: "text", unique: true })
  code!: string;

  @Column({ type: "text" })
  display_name!: string;

  @Column({ type: "boolean", default: true })
  is_enabled!: boolean;

  @Column({ type: "boolean", default: true })
  is_healthy!: boolean;

  @Column({ type: "jsonb", default: () => "'{}'" })
  capabilities!: Record<string, unknown>;

  @Column({ type: "boolean", default: true })
  supports_idempotency!: boolean;

  @Column({ type: "jsonb", default: () => "'{}'" })
  config!: Record<string, unknown>;

  @Column({ type: "timestamptz", default: () => "now()" })
  created_at!: Date;

  @Column({ type: "timestamptz", default: () => "now()" })
  updated_at!: Date;
}

@Entity("routing_rules")
@Index("uq_routing_triplet", ["country_id", "network_id", "provider_id"], { unique: true })
@Index("uq_routing_priority", ["country_id", "network_id", "priority"], { unique: true })
export class RoutingRuleEntity {
  @PrimaryColumn("uuid")
  id!: string;

  @Column("uuid")
  country_id!: string;

  @Column("uuid")
  network_id!: string;

  @Column("uuid")
  provider_id!: string;

  @Column({ type: "int" })
  priority!: number;

  @Column({ type: "timestamptz", default: () => "now()" })
  created_at!: Date;

  @Column({ type: "timestamptz", default: () => "now()" })
  updated_at!: Date;
}

@Entity("payments")
@Index("ix_payments_status_poll", ["status", "next_poll_at"])
@Index("ix_payments_external_ref", ["external_reference"])
export class PaymentEntity {
  @PrimaryColumn("uuid")
  id!: string;

  @Column({ type: "text", unique: true })
  idempotency_key!: string;

  @Column({ type: "text" })
  request_hash!: string;

  @Column({ type: "text", nullable: true })
  external_reference!: string | null;

  @Column({ type: "bigint", transformer: bigintTransformer })
  amount_minor!: bigint;

  @Column({ type: "char", length: 3 })
  currency!: string;

  @Column({ type: "text" })
  phone!: string;

  @Column({ type: "text" })
  phone_hash!: string;

  @Column({ type: "char", length: 4 })
  phone_last4!: string;

  @Column("uuid")
  country_id!: string;

  @Column("uuid")
  network_id!: string;

  @Column({ type: "text", default: "created" })
  status!: string;

  @Column({ type: "bigint", nullable: true, transformer: bigintTransformer })
  gross_amount_minor!: bigint | null;

  @Column({ type: "bigint", nullable: true, transformer: bigintTransformer })
  provider_fee_minor!: bigint | null;

  @Column({ type: "bigint", nullable: true, transformer: bigintTransformer })
  net_amount_minor!: bigint | null;

  @Column({ type: "jsonb", default: () => "'{}'" })
  metadata!: Record<string, unknown>;

  @Column({ type: "text" })
  correlation_id!: string;

  @Column({ type: "text" })
  request_id!: string;

  @Column({ type: "timestamptz" })
  expires_at!: Date;

  @Column({ type: "int", default: 0 })
  poll_attempts!: number;

  @Column({ type: "timestamptz", nullable: true })
  next_poll_at!: Date | null;

  @Column({ type: "timestamptz", default: () => "now()" })
  created_at!: Date;

  @Column({ type: "timestamptz", default: () => "now()" })
  updated_at!: Date;
}

@Entity("payment_attempts")
@Index("uq_attempt_number", ["payment_id", "attempt_number"], { unique: true })
export class PaymentAttemptEntity {
  @PrimaryColumn("uuid")
  id!: string;

  @Column("uuid")
  payment_id!: string;

  @Column("uuid")
  provider_id!: string;

  @Column({ type: "int" })
  attempt_number!: number;

  @Column({ type: "text", default: "created" })
  status!: string;

  @Column({ type: "text", nullable: true })
  provider_reference!: string | null;

  @Column({ type: "text" })
  provider_idempotency_key!: string;

  @Column({ type: "jsonb", nullable: true })
  provider_raw_request!: unknown;

  @Column({ type: "jsonb", nullable: true })
  provider_raw_response!: unknown;

  @Column({ type: "jsonb", nullable: true })
  normalized_response!: unknown;

  @Column({ type: "text", nullable: true })
  error_code!: string | null;

  @Column({ type: "text", nullable: true })
  error_message!: string | null;

  @Column({ type: "text", nullable: true })
  error_outcome!: string | null;

  @Column({ type: "boolean", default: false })
  confirmed!: boolean;

  @Column({ type: "timestamptz", default: () => "now()" })
  created_at!: Date;

  @Column({ type: "timestamptz", default: () => "now()" })
  updated_at!: Date;
}

@Entity("webhook_events")
@Index("uq_webhook_provider_event", ["provider_id", "provider_event_id"], { unique: true })
export class WebhookEventEntity {
  @PrimaryColumn("uuid")
  id!: string;

  @Column("uuid")
  provider_id!: string;

  @Column({ type: "uuid", nullable: true })
  payment_id!: string | null;

  @Column({ type: "text" })
  provider_event_id!: string;

  @Column({ type: "jsonb", nullable: true })
  raw_body!: unknown;

  @Column({ type: "boolean", default: false })
  signature_valid!: boolean;

  @Column({ type: "text", nullable: true })
  normalized_status!: string | null;

  @Column({ type: "boolean", default: false })
  is_late!: boolean;

  @Column({ type: "timestamptz", nullable: true })
  processed_at!: Date | null;

  @Column({ type: "timestamptz", default: () => "now()" })
  created_at!: Date;
}

@Entity("api_keys")
export class ApiKeyEntity {
  @PrimaryColumn("uuid")
  id!: string;

  @Column({ type: "text" })
  name!: string;

  @Column({ type: "text" })
  key_hash!: string;

  @Column({ type: "text" })
  prefix!: string;

  @Column({ type: "jsonb", default: () => "'[]'" })
  scopes!: string[];

  @Column({ type: "timestamptz", nullable: true })
  last_used_at!: Date | null;

  @Column({ type: "timestamptz", default: () => "now()" })
  created_at!: Date;

  @Column({ type: "timestamptz", nullable: true })
  revoked_at!: Date | null;
}

@Entity("webhook_subscriptions")
export class WebhookSubscriptionEntity {
  @PrimaryColumn("uuid")
  id!: string;

  @Column({ type: "text" })
  url!: string;

  @Column({ type: "jsonb", default: () => "'[]'" })
  events!: string[];

  @Column({ type: "text" })
  secret_hash!: string;

  @Column({ type: "boolean", default: true })
  is_active!: boolean;

  @Column({ type: "timestamptz", default: () => "now()" })
  created_at!: Date;

  @Column({ type: "timestamptz", default: () => "now()" })
  updated_at!: Date;
}

@Entity("webhook_deliveries")
export class WebhookDeliveryEntity {
  @PrimaryColumn("uuid")
  id!: string;

  @Column({ type: "uuid", unique: true })
  event_id!: string;

  @Column({ type: "uuid", nullable: true })
  subscription_id!: string | null;

  @Column({ type: "uuid", nullable: true })
  payment_id!: string | null;

  @Column({ type: "uuid", nullable: true })
  attempt_id!: string | null;

  @Column({ type: "text" })
  url!: string;

  @Column({ type: "text" })
  event_type!: string;

  @Column({ type: "jsonb", default: () => "'{}'" })
  payload!: Record<string, unknown>;

  @Column({ type: "text" })
  signature!: string;

  @Column({ type: "text", default: "pending" })
  status!: string;

  @Column({ type: "int", default: 0 })
  attempts!: number;

  @Column({ type: "timestamptz", nullable: true })
  next_retry_at!: Date | null;

  @Column({ type: "int", nullable: true })
  last_response_code!: number | null;

  @Column({ type: "text", nullable: true })
  last_response_body!: string | null;

  @Column({ type: "timestamptz", default: () => "now()" })
  created_at!: Date;

  @Column({ type: "timestamptz", default: () => "now()" })
  updated_at!: Date;
}

@Entity("dashboard_users")
export class DashboardUserEntity {
  @PrimaryColumn("uuid")
  id!: string;

  @Column({ type: "text", unique: true })
  email!: string;

  @Column({ type: "text" })
  password_hash!: string;

  @Column({ type: "text", nullable: true })
  totp_secret!: string | null;

  @Column({ type: "timestamptz", default: () => "now()" })
  created_at!: Date;

  @Column({ type: "timestamptz", default: () => "now()" })
  updated_at!: Date;
}

@Entity("audit_logs")
export class AuditLogEntity {
  @PrimaryColumn("uuid")
  id!: string;

  @Column({ type: "text" })
  action!: string;

  @Column({ type: "text" })
  actor!: string;

  @Column({ type: "text", nullable: true })
  resource_type!: string | null;

  @Column({ type: "text", nullable: true })
  resource_id!: string | null;

  @Column({ type: "jsonb", nullable: true })
  old_value!: unknown;

  @Column({ type: "jsonb", nullable: true })
  new_value!: unknown;

  @Column({ type: "text", nullable: true })
  ip!: string | null;

  @Column({ type: "text", nullable: true })
  request_id!: string | null;

  @Column({ type: "timestamptz", default: () => "now()" })
  created_at!: Date;
}

export const ALL_ENTITIES = [
  CountryEntity,
  NetworkEntity,
  ProviderEntity,
  RoutingRuleEntity,
  PaymentEntity,
  PaymentAttemptEntity,
  WebhookEventEntity,
  ApiKeyEntity,
  WebhookSubscriptionEntity,
  WebhookDeliveryEntity,
  DashboardUserEntity,
  AuditLogEntity,
];
