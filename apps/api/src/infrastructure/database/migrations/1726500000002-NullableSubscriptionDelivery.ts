import { MigrationInterface, QueryRunner } from "typeorm";

export class NullableSubscriptionDelivery1726500000002 implements MigrationInterface {
  name = "NullableSubscriptionDelivery1726500000002";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE webhook_deliveries ALTER COLUMN subscription_id DROP NOT NULL;
      ALTER TABLE webhook_deliveries ALTER COLUMN payment_id DROP NOT NULL;
    `);
    // Nettoie l'ancienne table de suivi SQL (idempotence)
    await queryRunner.query(`DELETE FROM schema_migrations WHERE version = '002_webhook_delivery_audit.sql'`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE webhook_deliveries ALTER COLUMN subscription_id SET NOT NULL;
      ALTER TABLE webhook_deliveries ALTER COLUMN payment_id SET NOT NULL;
    `);
  }
}
