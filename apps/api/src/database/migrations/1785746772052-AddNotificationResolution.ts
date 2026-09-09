import { MigrationInterface, QueryRunner } from "typeorm";

export class AddNotificationResolution1785746772052 implements MigrationInterface {
    name = 'AddNotificationResolution1785746772052'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "notifications" ADD "resolvedAt" TIMESTAMP WITH TIME ZONE`);
        await queryRunner.query(`ALTER TABLE "notifications" ADD "resolvedByUserId" uuid`);
        await queryRunner.query(`ALTER TABLE "notifications" ADD "resolvedByLabel" character varying`);
        await queryRunner.query(`ALTER TABLE "notifications" ADD "resolutionText" character varying`);
        await queryRunner.query(`CREATE INDEX "idx_notifications_resolved_by" ON "notifications" ("resolvedByUserId") `);
        await queryRunner.query(`CREATE INDEX "idx_notifications_open_asks" ON "notifications" ("recipientUserId") WHERE "type" = 'approval_needed' AND "resolvedAt" IS NULL`);
        await queryRunner.query(`CREATE INDEX "idx_notifications_request" ON "notifications" ("requestId") `);
        await queryRunner.query(`ALTER TABLE "notifications" ADD CONSTRAINT "FK_cc5878463767f0e6ccf473b2074" FOREIGN KEY ("resolvedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "notifications" DROP CONSTRAINT "FK_cc5878463767f0e6ccf473b2074"`);
        await queryRunner.query(`DROP INDEX "public"."idx_notifications_request"`);
        await queryRunner.query(`DROP INDEX "public"."idx_notifications_open_asks"`);
        await queryRunner.query(`DROP INDEX "public"."idx_notifications_resolved_by"`);
        await queryRunner.query(`ALTER TABLE "notifications" DROP COLUMN "resolutionText"`);
        await queryRunner.query(`ALTER TABLE "notifications" DROP COLUMN "resolvedByLabel"`);
        await queryRunner.query(`ALTER TABLE "notifications" DROP COLUMN "resolvedByUserId"`);
        await queryRunner.query(`ALTER TABLE "notifications" DROP COLUMN "resolvedAt"`);
    }

}
