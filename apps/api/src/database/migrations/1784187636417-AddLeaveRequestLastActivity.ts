import { MigrationInterface, QueryRunner } from "typeorm";

export class AddLeaveRequestLastActivity1784187636417 implements MigrationInterface {
    name = 'AddLeaveRequestLastActivity1784187636417'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "leave_requests" ADD "lastAction" character varying`);
        await queryRunner.query(`ALTER TABLE "leave_requests" ADD "lastActivityAt" TIMESTAMP WITH TIME ZONE`);
        // Backfill from the newest HUMAN activity per request, falling back to
        // the submission for requests without timeline rows. System events
        // (actorUserId IS NULL, e.g. 'consumed') never enter the snapshot —
        // this mirrors addActivity's runtime rule.
        await queryRunner.query(`
            UPDATE "leave_requests" r
            SET "lastAction" = la."action", "lastActivityAt" = la."occurredAt"
            FROM (
                SELECT DISTINCT ON ("requestId") "requestId", "action", "occurredAt"
                FROM "leave_request_activities"
                WHERE "actorUserId" IS NOT NULL
                ORDER BY "requestId", "occurredAt" DESC, "createdAt" DESC, "id" DESC
            ) la
            WHERE la."requestId" = r."id"
        `);
        await queryRunner.query(`UPDATE "leave_requests" SET "lastAction" = 'submitted', "lastActivityAt" = "submittedAt" WHERE "lastActivityAt" IS NULL`);
        await queryRunner.query(`ALTER TABLE "leave_requests" ALTER COLUMN "lastAction" SET NOT NULL`);
        await queryRunner.query(`ALTER TABLE "leave_requests" ALTER COLUMN "lastActivityAt" SET NOT NULL`);
        await queryRunner.query(`CREATE INDEX "idx_leave_requests_feed" ON "leave_requests" ("lastActivityAt", "id") `);
        await queryRunner.query(`DROP INDEX "public"."idx_leave_request_activities_feed"`);
        await queryRunner.query(`ALTER TABLE "leave_request_activities" DROP COLUMN "statusAtEvent"`);
        await queryRunner.query(`DROP TYPE "public"."leave_request_activities_statusatevent_enum"`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TYPE "public"."leave_request_activities_statusatevent_enum" AS ENUM('pending', 'approved', 'rejected', 'cancelled')`);
        // statusAtEvent data is not recoverable; the column returns nullable
        // and empty, matching its pre-UseNativeEnums shape.
        await queryRunner.query(`ALTER TABLE "leave_request_activities" ADD "statusAtEvent" "public"."leave_request_activities_statusatevent_enum"`);
        await queryRunner.query(`CREATE INDEX "idx_leave_request_activities_feed" ON "leave_request_activities" ("occurredAt", "id") `);
        await queryRunner.query(`DROP INDEX "public"."idx_leave_requests_feed"`);
        await queryRunner.query(`ALTER TABLE "leave_requests" DROP COLUMN "lastActivityAt"`);
        await queryRunner.query(`ALTER TABLE "leave_requests" DROP COLUMN "lastAction"`);
    }

}
