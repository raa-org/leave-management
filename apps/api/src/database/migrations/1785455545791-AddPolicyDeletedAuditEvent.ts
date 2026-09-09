import { MigrationInterface, QueryRunner } from "typeorm";

export class AddPolicyDeletedAuditEvent1785455545791 implements MigrationInterface {
    name = 'AddPolicyDeletedAuditEvent1785455545791'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TYPE "public"."audit_logs_eventtype_enum" RENAME TO "audit_logs_eventtype_enum_old"`);
        await queryRunner.query(`CREATE TYPE "public"."audit_logs_eventtype_enum" AS ENUM('user.login', 'user.provisioned', 'user.profile_synced', 'user.roles_assigned', 'user.login_refused', 'user.deactivated', 'user.reactivated', 'user.sync_conflict', 'user.identity_conflict', 'ldap_sync.completed', 'ldap_sync.failed', 'employee.profile_updated', 'employee.allocation_updated', 'employee.leave_data_reset', 'leave_request.submitted', 'leave_request.cancelled', 'leave_request.approved', 'leave_request.rejected', 'leave_request.force_approved', 'leave_request.force_rejected', 'leave_request.approver_removed', 'leave_request.modification_submitted', 'leave_request.superseded', 'policy.created', 'policy.updated', 'policy.superseded', 'policy.deleted', 'policy.default_changed', 'policy.membership_assigned', 'policy.membership_transferred', 'policy.membership_transfer_scheduled', 'policy.membership_transfer_schedule_canceled', 'policy.membership_transfer_blocked', 'policy.membership_backdated', 'policy.allocation_materialized', 'settings.updated', 'country.created', 'country.updated', 'country.deleted', 'holiday_calendar.replaced', 'holiday_calendar.cloned', 'holiday_calendar.deleted')`);
        await queryRunner.query(`ALTER TABLE "audit_logs" ALTER COLUMN "eventType" TYPE "public"."audit_logs_eventtype_enum" USING "eventType"::"text"::"public"."audit_logs_eventtype_enum"`);
        await queryRunner.query(`DROP TYPE "public"."audit_logs_eventtype_enum_old"`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TYPE "public"."audit_logs_eventtype_enum_old" AS ENUM('country.created', 'country.deleted', 'country.updated', 'employee.allocation_updated', 'employee.leave_data_reset', 'employee.profile_updated', 'holiday_calendar.cloned', 'holiday_calendar.deleted', 'holiday_calendar.replaced', 'ldap_sync.completed', 'ldap_sync.failed', 'leave_request.approved', 'leave_request.approver_removed', 'leave_request.cancelled', 'leave_request.force_approved', 'leave_request.force_rejected', 'leave_request.modification_submitted', 'leave_request.rejected', 'leave_request.submitted', 'leave_request.superseded', 'policy.allocation_materialized', 'policy.created', 'policy.default_changed', 'policy.membership_assigned', 'policy.membership_backdated', 'policy.membership_transfer_blocked', 'policy.membership_transfer_schedule_canceled', 'policy.membership_transfer_scheduled', 'policy.membership_transferred', 'policy.superseded', 'policy.updated', 'settings.updated', 'user.deactivated', 'user.identity_conflict', 'user.login', 'user.login_refused', 'user.profile_synced', 'user.provisioned', 'user.reactivated', 'user.roles_assigned', 'user.sync_conflict')`);
        await queryRunner.query(`ALTER TABLE "audit_logs" ALTER COLUMN "eventType" TYPE "public"."audit_logs_eventtype_enum_old" USING "eventType"::"text"::"public"."audit_logs_eventtype_enum_old"`);
        await queryRunner.query(`DROP TYPE "public"."audit_logs_eventtype_enum"`);
        await queryRunner.query(`ALTER TYPE "public"."audit_logs_eventtype_enum_old" RENAME TO "audit_logs_eventtype_enum"`);
    }

}
