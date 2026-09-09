import { MigrationInterface, QueryRunner } from "typeorm";

export class AddAuditLogs1783944652482 implements MigrationInterface {
    name = 'AddAuditLogs1783944652482'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TYPE "public"."audit_logs_eventtype_enum" AS ENUM('user.login', 'user.provisioned', 'user.profile_synced', 'user.roles_assigned', 'employee.profile_updated', 'employee.allocation_updated', 'leave_request.submitted', 'leave_request.cancelled', 'leave_request.approved', 'leave_request.rejected', 'leave_request.force_approved', 'leave_request.force_rejected', 'leave_request.approver_removed', 'settings.updated', 'country.created', 'country.updated', 'country.deleted', 'holiday_calendar.replaced', 'holiday_calendar.cloned', 'holiday_calendar.deleted')`);
        await queryRunner.query(`CREATE TYPE "public"."audit_logs_category_enum" AS ENUM('auth', 'role', 'employee', 'leave_request', 'approval', 'settings', 'country', 'holiday')`);
        await queryRunner.query(`CREATE TYPE "public"."audit_logs_action_enum" AS ENUM('create', 'update', 'delete', 'state_change', 'login')`);
        await queryRunner.query(`CREATE TABLE "audit_logs" ("id" uuid NOT NULL, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT clock_timestamp(), "occurredAt" TIMESTAMP WITH TIME ZONE NOT NULL, "eventType" "public"."audit_logs_eventtype_enum" NOT NULL, "category" "public"."audit_logs_category_enum" NOT NULL, "action" "public"."audit_logs_action_enum" NOT NULL, "actorUserId" uuid, "actorLabel" character varying NOT NULL, "actorEmail" character varying, "actorRoles" jsonb NOT NULL DEFAULT '[]', "targetUserId" uuid, "targetLabel" character varying, "entityType" character varying NOT NULL, "entityId" character varying, "summary" character varying NOT NULL, "beforeState" jsonb, "afterState" jsonb, "changedFields" jsonb, "requestId" uuid, CONSTRAINT "PK_1bb179d048bbc581caa3b013439" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "idx_audit_logs_category" ON "audit_logs" ("category", "occurredAt", "id") `);
        await queryRunner.query(`CREATE INDEX "idx_audit_logs_actor" ON "audit_logs" ("actorUserId", "occurredAt", "id") `);
        await queryRunner.query(`CREATE INDEX "idx_audit_logs_target" ON "audit_logs" ("targetUserId", "occurredAt", "id") `);
        await queryRunner.query(`CREATE INDEX "idx_audit_logs_feed" ON "audit_logs" ("occurredAt", "id") `);
        await queryRunner.query(`ALTER TABLE "audit_logs" ADD CONSTRAINT "FK_e36d23e1e7cf81ea77758bef795" FOREIGN KEY ("actorUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "audit_logs" ADD CONSTRAINT "FK_5b7fbc8045a0654e5f8db27dc5c" FOREIGN KEY ("targetUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "audit_logs" DROP CONSTRAINT "FK_5b7fbc8045a0654e5f8db27dc5c"`);
        await queryRunner.query(`ALTER TABLE "audit_logs" DROP CONSTRAINT "FK_e36d23e1e7cf81ea77758bef795"`);
        await queryRunner.query(`DROP INDEX "public"."idx_audit_logs_feed"`);
        await queryRunner.query(`DROP INDEX "public"."idx_audit_logs_target"`);
        await queryRunner.query(`DROP INDEX "public"."idx_audit_logs_actor"`);
        await queryRunner.query(`DROP INDEX "public"."idx_audit_logs_category"`);
        await queryRunner.query(`DROP TABLE "audit_logs"`);
        await queryRunner.query(`DROP TYPE "public"."audit_logs_action_enum"`);
        await queryRunner.query(`DROP TYPE "public"."audit_logs_category_enum"`);
        await queryRunner.query(`DROP TYPE "public"."audit_logs_eventtype_enum"`);
    }

}
