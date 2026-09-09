import { MigrationInterface, QueryRunner } from "typeorm";

export class AddImportAuditEvents1786018991773 implements MigrationInterface {
    name = 'AddImportAuditEvents1786018991773'

    public async up(queryRunner: QueryRunner): Promise<void> {
        // Adds the `import` category and its single event, `import.completed`
        // (the per-run summary the data import writes). What files under the
        // category is stated once, on AuditCategory in the shared contracts.
        // Recreating the types rather than ALTER TYPE ... ADD VALUE is what
        // keeps a down() possible at all; each list is the FULL current value
        // set, because recreating a pg enum replaces the whole type.
        await queryRunner.query(`DROP INDEX "public"."idx_audit_logs_category"`);
        await queryRunner.query(`ALTER TYPE "public"."audit_logs_eventtype_enum" RENAME TO "audit_logs_eventtype_enum_old"`);
        await queryRunner.query(`CREATE TYPE "public"."audit_logs_eventtype_enum" AS ENUM('user.login', 'user.provisioned', 'user.profile_synced', 'user.roles_assigned', 'user.login_refused', 'user.deactivated', 'user.reactivated', 'user.sync_conflict', 'user.identity_conflict', 'ldap_sync.completed', 'ldap_sync.failed', 'employee.profile_updated', 'employee.allocation_updated', 'employee.leave_data_reset', 'leave_request.submitted', 'leave_request.cancelled', 'leave_request.approved', 'leave_request.rejected', 'leave_request.force_approved', 'leave_request.force_rejected', 'leave_request.auto_approved', 'leave_request.approver_removed', 'leave_request.modification_submitted', 'leave_request.superseded', 'policy.created', 'policy.updated', 'policy.superseded', 'policy.deleted', 'policy.default_changed', 'policy.membership_assigned', 'policy.membership_transferred', 'policy.membership_transfer_scheduled', 'policy.membership_transfer_schedule_canceled', 'policy.membership_transfer_blocked', 'policy.membership_backdated', 'policy.allocation_materialized', 'import.completed', 'settings.updated', 'country.created', 'country.updated', 'country.deleted', 'holiday_calendar.replaced', 'holiday_calendar.cloned', 'holiday_calendar.deleted')`);
        await queryRunner.query(`ALTER TABLE "audit_logs" ALTER COLUMN "eventType" TYPE "public"."audit_logs_eventtype_enum" USING "eventType"::"text"::"public"."audit_logs_eventtype_enum"`);
        await queryRunner.query(`DROP TYPE "public"."audit_logs_eventtype_enum_old"`);
        await queryRunner.query(`ALTER TYPE "public"."audit_logs_category_enum" RENAME TO "audit_logs_category_enum_old"`);
        await queryRunner.query(`CREATE TYPE "public"."audit_logs_category_enum" AS ENUM('auth', 'role', 'employee', 'leave_request', 'approval', 'settings', 'country', 'holiday', 'policy', 'ldap_sync', 'import')`);
        await queryRunner.query(`ALTER TABLE "audit_logs" ALTER COLUMN "category" TYPE "public"."audit_logs_category_enum" USING "category"::"text"::"public"."audit_logs_category_enum"`);
        await queryRunner.query(`DROP TYPE "public"."audit_logs_category_enum_old"`);
        await queryRunner.query(`CREATE INDEX "idx_audit_logs_category" ON "audit_logs" ("category", "occurredAt", "id") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        // Drops ONLY this migration's values. A surviving import.completed row
        // aborts the revert rather than being silently relabelled — reverting
        // a run summary is a data decision, not a schema one. Two generator
        // artifacts are corrected by hand, as in AddLdapSyncAuditCategory: the
        // value lists keep their declaration order (the generator alphabetizes
        // them), and the index is recreated with its real column order (the
        // generator reverses it, which would leave category-filtered keyset
        // reads unindexed after a revert).
        await queryRunner.query(`DROP INDEX "public"."idx_audit_logs_category"`);
        await queryRunner.query(`CREATE TYPE "public"."audit_logs_category_enum_old" AS ENUM('auth', 'role', 'employee', 'leave_request', 'approval', 'settings', 'country', 'holiday', 'policy', 'ldap_sync')`);
        await queryRunner.query(`ALTER TABLE "audit_logs" ALTER COLUMN "category" TYPE "public"."audit_logs_category_enum_old" USING "category"::"text"::"public"."audit_logs_category_enum_old"`);
        await queryRunner.query(`DROP TYPE "public"."audit_logs_category_enum"`);
        await queryRunner.query(`ALTER TYPE "public"."audit_logs_category_enum_old" RENAME TO "audit_logs_category_enum"`);
        await queryRunner.query(`CREATE TYPE "public"."audit_logs_eventtype_enum_old" AS ENUM('user.login', 'user.provisioned', 'user.profile_synced', 'user.roles_assigned', 'user.login_refused', 'user.deactivated', 'user.reactivated', 'user.sync_conflict', 'user.identity_conflict', 'ldap_sync.completed', 'ldap_sync.failed', 'employee.profile_updated', 'employee.allocation_updated', 'employee.leave_data_reset', 'leave_request.submitted', 'leave_request.cancelled', 'leave_request.approved', 'leave_request.rejected', 'leave_request.force_approved', 'leave_request.force_rejected', 'leave_request.auto_approved', 'leave_request.approver_removed', 'leave_request.modification_submitted', 'leave_request.superseded', 'policy.created', 'policy.updated', 'policy.superseded', 'policy.deleted', 'policy.default_changed', 'policy.membership_assigned', 'policy.membership_transferred', 'policy.membership_transfer_scheduled', 'policy.membership_transfer_schedule_canceled', 'policy.membership_transfer_blocked', 'policy.membership_backdated', 'policy.allocation_materialized', 'settings.updated', 'country.created', 'country.updated', 'country.deleted', 'holiday_calendar.replaced', 'holiday_calendar.cloned', 'holiday_calendar.deleted')`);
        await queryRunner.query(`ALTER TABLE "audit_logs" ALTER COLUMN "eventType" TYPE "public"."audit_logs_eventtype_enum_old" USING "eventType"::"text"::"public"."audit_logs_eventtype_enum_old"`);
        await queryRunner.query(`DROP TYPE "public"."audit_logs_eventtype_enum"`);
        await queryRunner.query(`ALTER TYPE "public"."audit_logs_eventtype_enum_old" RENAME TO "audit_logs_eventtype_enum"`);
        await queryRunner.query(`CREATE INDEX "idx_audit_logs_category" ON "audit_logs" ("category", "occurredAt", "id") `);
    }

}
