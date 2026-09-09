import { MigrationInterface, QueryRunner } from 'typeorm'

/**
 * Sticky admin vacation balance adjustments for the open leave year, plus audit
 * of `employee.balance_adjusted`. The column is a running signed offset folded
 * into the accrual target so monthly accrual neither undoes a removal nor
 * double-counts a credit; year-end carryover still reads residual accrued, so
 * the offset is "baked into" leftover and does not copy as a separate field
 * into the next year.
 */
export class AddManualAdjustmentDays1786314452352 implements MigrationInterface {
  name = 'AddManualAdjustmentDays1786314452352'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "leave_allocations" ADD "manualAdjustmentDays" numeric(6,2) NOT NULL DEFAULT 0`,
    )
    await queryRunner.query(
      `ALTER TYPE "public"."audit_logs_eventtype_enum" RENAME TO "audit_logs_eventtype_enum_old"`,
    )
    await queryRunner.query(
      `CREATE TYPE "public"."audit_logs_eventtype_enum" AS ENUM('user.login', 'user.provisioned', 'user.profile_synced', 'user.roles_assigned', 'user.login_refused', 'user.deactivated', 'user.reactivated', 'user.sync_conflict', 'user.identity_conflict', 'ldap_sync.completed', 'ldap_sync.failed', 'employee.profile_updated', 'employee.allocation_updated', 'employee.balance_adjusted', 'employee.leave_data_reset', 'leave_request.submitted', 'leave_request.cancelled', 'leave_request.approved', 'leave_request.rejected', 'leave_request.force_approved', 'leave_request.force_rejected', 'leave_request.auto_approved', 'leave_request.approver_removed', 'leave_request.modification_submitted', 'leave_request.superseded', 'policy.created', 'policy.updated', 'policy.superseded', 'policy.deleted', 'policy.default_changed', 'policy.membership_assigned', 'policy.membership_transferred', 'policy.membership_transfer_scheduled', 'policy.membership_transfer_schedule_canceled', 'policy.membership_transfer_blocked', 'policy.membership_backdated', 'policy.allocation_materialized', 'import.completed', 'settings.updated', 'country.created', 'country.updated', 'country.deleted', 'holiday_calendar.replaced', 'holiday_calendar.cloned', 'holiday_calendar.deleted')`,
    )
    await queryRunner.query(
      `ALTER TABLE "audit_logs" ALTER COLUMN "eventType" TYPE "public"."audit_logs_eventtype_enum" USING "eventType"::"text"::"public"."audit_logs_eventtype_enum"`,
    )
    await queryRunner.query(`DROP TYPE "public"."audit_logs_eventtype_enum_old"`)
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "public"."audit_logs_eventtype_enum_old" AS ENUM('user.login', 'user.provisioned', 'user.profile_synced', 'user.roles_assigned', 'user.login_refused', 'user.deactivated', 'user.reactivated', 'user.sync_conflict', 'user.identity_conflict', 'ldap_sync.completed', 'ldap_sync.failed', 'employee.profile_updated', 'employee.allocation_updated', 'employee.leave_data_reset', 'leave_request.submitted', 'leave_request.cancelled', 'leave_request.approved', 'leave_request.rejected', 'leave_request.force_approved', 'leave_request.force_rejected', 'leave_request.auto_approved', 'leave_request.approver_removed', 'leave_request.modification_submitted', 'leave_request.superseded', 'policy.created', 'policy.updated', 'policy.superseded', 'policy.deleted', 'policy.default_changed', 'policy.membership_assigned', 'policy.membership_transferred', 'policy.membership_transfer_scheduled', 'policy.membership_transfer_schedule_canceled', 'policy.membership_transfer_blocked', 'policy.membership_backdated', 'policy.allocation_materialized', 'import.completed', 'settings.updated', 'country.created', 'country.updated', 'country.deleted', 'holiday_calendar.replaced', 'holiday_calendar.cloned', 'holiday_calendar.deleted')`,
    )
    await queryRunner.query(
      `ALTER TABLE "audit_logs" ALTER COLUMN "eventType" TYPE "public"."audit_logs_eventtype_enum_old" USING "eventType"::"text"::"public"."audit_logs_eventtype_enum_old"`,
    )
    await queryRunner.query(`DROP TYPE "public"."audit_logs_eventtype_enum"`)
    await queryRunner.query(
      `ALTER TYPE "public"."audit_logs_eventtype_enum_old" RENAME TO "audit_logs_eventtype_enum"`,
    )
    await queryRunner.query(
      `ALTER TABLE "leave_allocations" DROP COLUMN "manualAdjustmentDays"`,
    )
  }
}
