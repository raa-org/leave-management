import { MigrationInterface, QueryRunner } from "typeorm";

export class AddForwardPlanningAndSupersede1784851035269 implements MigrationInterface {
    name = 'AddForwardPlanningAndSupersede1784851035269'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "leave_allocations" ADD "carryoverFinalized" boolean NOT NULL DEFAULT true`);
        await queryRunner.query(`ALTER TABLE "leave_requests" ADD "supersedesRequestId" uuid`);
        // The list below is the FULL union of every AuditEventType, not just the
        // base set plus this migration's two values. Recreating a pg enum replaces
        // the whole type, and AddLdapSyncAuditEvents1784829928296 (merged in from
        // development, timestamped earlier) recreates the same type for its own
        // seven values. Whichever of the two runs second would otherwise drop the
        // other's values, and its USING cast would abort outright on a database
        // that already holds a row using them. With both lists carrying the union
        // the end state is the same in either order.
        await queryRunner.query(`ALTER TYPE "public"."audit_logs_eventtype_enum" RENAME TO "audit_logs_eventtype_enum_old"`);
        await queryRunner.query(`CREATE TYPE "public"."audit_logs_eventtype_enum" AS ENUM('user.login', 'user.provisioned', 'user.profile_synced', 'user.roles_assigned', 'user.login_refused', 'user.deactivated', 'user.reactivated', 'user.sync_conflict', 'user.identity_conflict', 'ldap_sync.completed', 'ldap_sync.failed', 'employee.profile_updated', 'employee.allocation_updated', 'employee.leave_data_reset', 'leave_request.submitted', 'leave_request.cancelled', 'leave_request.approved', 'leave_request.rejected', 'leave_request.force_approved', 'leave_request.force_rejected', 'leave_request.approver_removed', 'leave_request.modification_submitted', 'leave_request.superseded', 'settings.updated', 'country.created', 'country.updated', 'country.deleted', 'holiday_calendar.replaced', 'holiday_calendar.cloned', 'holiday_calendar.deleted')`);
        await queryRunner.query(`ALTER TABLE "audit_logs" ALTER COLUMN "eventType" TYPE "public"."audit_logs_eventtype_enum" USING "eventType"::"text"::"public"."audit_logs_eventtype_enum"`);
        await queryRunner.query(`DROP TYPE "public"."audit_logs_eventtype_enum_old"`);
        await queryRunner.query(`ALTER TYPE "public"."leave_requests_status_enum" RENAME TO "leave_requests_status_enum_old"`);
        await queryRunner.query(`CREATE TYPE "public"."leave_requests_status_enum" AS ENUM('pending', 'approved', 'rejected', 'cancelled', 'superseded')`);
        await queryRunner.query(`ALTER TABLE "leave_requests" ALTER COLUMN "status" TYPE "public"."leave_requests_status_enum" USING "status"::"text"::"public"."leave_requests_status_enum"`);
        await queryRunner.query(`DROP TYPE "public"."leave_requests_status_enum_old"`);
        await queryRunner.query(`CREATE UNIQUE INDEX "uq_leave_requests_pending_supersede" ON "leave_requests" ("supersedesRequestId") WHERE "status" = 'pending' AND "supersedesRequestId" IS NOT NULL`);
        await queryRunner.query(`CREATE INDEX "idx_leave_requests_supersedes" ON "leave_requests" ("supersedesRequestId") `);
        await queryRunner.query(`ALTER TABLE "leave_requests" ADD CONSTRAINT "FK_17e797264b83412983588fccb5b" FOREIGN KEY ("supersedesRequestId") REFERENCES "leave_requests"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        // Data backfill (the DDL above is generated; this statement is not).
        // carryoverFinalized defaults to true, which is right for every year
        // that has begun. A row for a year still in the future was created by
        // the old rollover from a mid-year leftover, so its carryover is
        // meaningless: mark it unfinalized and let the first accrual run in
        // that year compute the real figure.
        await queryRunner.query(`UPDATE "leave_allocations" SET "carryoverFinalized" = false WHERE "year" > EXTRACT(YEAR FROM now())`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "leave_requests" DROP CONSTRAINT "FK_17e797264b83412983588fccb5b"`);
        await queryRunner.query(`DROP INDEX "public"."idx_leave_requests_supersedes"`);
        await queryRunner.query(`DROP INDEX "public"."uq_leave_requests_pending_supersede"`);
        await queryRunner.query(`CREATE TYPE "public"."leave_requests_status_enum_old" AS ENUM('pending', 'approved', 'rejected', 'cancelled')`);
        await queryRunner.query(`ALTER TABLE "leave_requests" ALTER COLUMN "status" TYPE "public"."leave_requests_status_enum_old" USING "status"::"text"::"public"."leave_requests_status_enum_old"`);
        await queryRunner.query(`DROP TYPE "public"."leave_requests_status_enum"`);
        await queryRunner.query(`ALTER TYPE "public"."leave_requests_status_enum_old" RENAME TO "leave_requests_status_enum"`);
        // Drops only THIS migration's two values and keeps the LDAP sync set, for
        // the same reason up() carries the union: reverting this migration must
        // not void audit rows the other one is responsible for.
        await queryRunner.query(`CREATE TYPE "public"."audit_logs_eventtype_enum_old" AS ENUM('user.login', 'user.provisioned', 'user.profile_synced', 'user.roles_assigned', 'user.login_refused', 'user.deactivated', 'user.reactivated', 'user.sync_conflict', 'user.identity_conflict', 'ldap_sync.completed', 'ldap_sync.failed', 'employee.profile_updated', 'employee.allocation_updated', 'employee.leave_data_reset', 'leave_request.submitted', 'leave_request.cancelled', 'leave_request.approved', 'leave_request.rejected', 'leave_request.force_approved', 'leave_request.force_rejected', 'leave_request.approver_removed', 'settings.updated', 'country.created', 'country.updated', 'country.deleted', 'holiday_calendar.replaced', 'holiday_calendar.cloned', 'holiday_calendar.deleted')`);
        await queryRunner.query(`ALTER TABLE "audit_logs" ALTER COLUMN "eventType" TYPE "public"."audit_logs_eventtype_enum_old" USING "eventType"::"text"::"public"."audit_logs_eventtype_enum_old"`);
        await queryRunner.query(`DROP TYPE "public"."audit_logs_eventtype_enum"`);
        await queryRunner.query(`ALTER TYPE "public"."audit_logs_eventtype_enum_old" RENAME TO "audit_logs_eventtype_enum"`);
        await queryRunner.query(`ALTER TABLE "leave_requests" DROP COLUMN "supersedesRequestId"`);
        await queryRunner.query(`ALTER TABLE "leave_allocations" DROP COLUMN "carryoverFinalized"`);
    }

}
