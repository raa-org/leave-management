import { MigrationInterface, QueryRunner } from "typeorm";

export class AddNotifications1784293362831 implements MigrationInterface {
    name = 'AddNotifications1784293362831'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TYPE "public"."notifications_type_enum" AS ENUM('approval_needed', 'approval_progressed', 'request_approved', 'request_rejected', 'request_cancelled')`);
        await queryRunner.query(`CREATE TABLE "notifications" ("id" uuid NOT NULL, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT clock_timestamp(), "occurredAt" TIMESTAMP WITH TIME ZONE NOT NULL, "recipientUserId" uuid NOT NULL, "type" "public"."notifications_type_enum" NOT NULL, "requestId" uuid NOT NULL, "summary" character varying NOT NULL, "readAt" TIMESTAMP WITH TIME ZONE, CONSTRAINT "PK_6a72c3c0f683f6462415e653c3a" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "idx_notifications_recipient_feed" ON "notifications" ("recipientUserId", "occurredAt", "id") `);
        await queryRunner.query(`ALTER TABLE "notifications" ADD CONSTRAINT "FK_0be815cabd15a62a5546a4b1357" FOREIGN KEY ("recipientUserId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "notifications" ADD CONSTRAINT "FK_7f30bf6237f6d8c74823f183960" FOREIGN KEY ("requestId") REFERENCES "leave_requests"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "notifications" DROP CONSTRAINT "FK_7f30bf6237f6d8c74823f183960"`);
        await queryRunner.query(`ALTER TABLE "notifications" DROP CONSTRAINT "FK_0be815cabd15a62a5546a4b1357"`);
        await queryRunner.query(`DROP INDEX "public"."idx_notifications_recipient_feed"`);
        await queryRunner.query(`DROP TABLE "notifications"`);
        await queryRunner.query(`DROP TYPE "public"."notifications_type_enum"`);
    }

}
