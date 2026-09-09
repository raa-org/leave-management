import { MigrationInterface, QueryRunner } from "typeorm";

export class ReplaceAuditTableWithActivityFeed1783679812401 implements MigrationInterface {
    name = 'ReplaceAuditTableWithActivityFeed1783679812401'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "leave_request_activities" ADD "statusAtEvent" character varying`);
        await queryRunner.query(`CREATE INDEX "idx_leave_request_activities_feed" ON "leave_request_activities" ("occurredAt", "id") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."idx_leave_request_activities_feed"`);
        await queryRunner.query(`ALTER TABLE "leave_request_activities" DROP COLUMN "statusAtEvent"`);
    }

}
