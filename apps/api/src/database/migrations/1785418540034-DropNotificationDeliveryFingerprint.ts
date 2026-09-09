import { MigrationInterface, QueryRunner } from "typeorm";

export class DropNotificationDeliveryFingerprint1785418540034 implements MigrationInterface {
    name = 'DropNotificationDeliveryFingerprint1785418540034'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."idx_notification_deliveries_fingerprint"`);
        await queryRunner.query(`ALTER TABLE "notification_deliveries" DROP COLUMN "fingerprint"`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "notification_deliveries" ADD "fingerprint" character varying NOT NULL`);
        await queryRunner.query(`CREATE INDEX "idx_notification_deliveries_fingerprint" ON "notification_deliveries" ("fingerprint") `);
    }

}
