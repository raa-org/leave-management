import { MigrationInterface, QueryRunner } from "typeorm";

export class AddLdapSyncAuditEvents1784829928296 implements MigrationInterface {
    name = 'AddLdapSyncAuditEvents1784829928296'

    public async up(queryRunner: QueryRunner): Promise<void> {
        // New values for the LDAP directory sync + identity keying:
        // user.login_refused, user.deactivated, user.reactivated,
        // user.sync_conflict, user.identity_conflict, ldap_sync.completed,
        // ldap_sync.failed.
        //
        // Deliberately covers events that have no writer yet too (user.reactivated
        // for the admin's manual resolution, ldap_sync.failed for the scheduler's
        // catch) and the login-time user.identity_conflict (subject/email split at
        // login): recreating a pg enum is a heavyweight migration, so adding
        // every value the feature needs in ONE pass beats a second identical
        // migration later. Unused values are inert.
        //
        // The list below is the FULL union of every AuditEventType, not just the
        // base set plus this migration's seven. Recreating a pg enum replaces the
        // whole type, and AddForwardPlanningAndSupersede1784851035269 (merged in
        // from the leave forward-planning branch, timestamped later) recreates the
        // same type for its own two values. Whichever of the two runs second would
        // otherwise drop the other's values, and its USING cast would abort
        // outright on a database that already holds a row using them. With both
        // lists carrying the union the end state is the same in either order.
        await queryRunner.query(`ALTER TYPE "public"."audit_logs_eventtype_enum" RENAME TO "audit_logs_eventtype_enum_old"`);
        await queryRunner.query(`CREATE TYPE "public"."audit_logs_eventtype_enum" AS ENUM('user.login', 'user.provisioned', 'user.profile_synced', 'user.roles_assigned', 'user.login_refused', 'user.deactivated', 'user.reactivated', 'user.sync_conflict', 'user.identity_conflict', 'ldap_sync.completed', 'ldap_sync.failed', 'employee.profile_updated', 'employee.allocation_updated', 'employee.leave_data_reset', 'leave_request.submitted', 'leave_request.cancelled', 'leave_request.approved', 'leave_request.rejected', 'leave_request.force_approved', 'leave_request.force_rejected', 'leave_request.approver_removed', 'leave_request.modification_submitted', 'leave_request.superseded', 'settings.updated', 'country.created', 'country.updated', 'country.deleted', 'holiday_calendar.replaced', 'holiday_calendar.cloned', 'holiday_calendar.deleted')`);
        await queryRunner.query(`ALTER TABLE "audit_logs" ALTER COLUMN "eventType" TYPE "public"."audit_logs_eventtype_enum" USING "eventType"::"text"::"public"."audit_logs_eventtype_enum"`);
        await queryRunner.query(`DROP TYPE "public"."audit_logs_eventtype_enum_old"`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        // Down migration fails if any row already uses the new values — that is
        // deliberate: dropping them would silently corrupt audit history.
        //
        // Drops only THIS migration's seven values and keeps the forward-planning
        // pair, for the same reason up() carries the union: reverting this
        // migration must not void audit rows the other one is responsible for.
        await queryRunner.query(`CREATE TYPE "public"."audit_logs_eventtype_enum_old" AS ENUM('user.login', 'user.provisioned', 'user.profile_synced', 'user.roles_assigned', 'employee.profile_updated', 'employee.allocation_updated', 'employee.leave_data_reset', 'leave_request.submitted', 'leave_request.cancelled', 'leave_request.approved', 'leave_request.rejected', 'leave_request.force_approved', 'leave_request.force_rejected', 'leave_request.approver_removed', 'leave_request.modification_submitted', 'leave_request.superseded', 'settings.updated', 'country.created', 'country.updated', 'country.deleted', 'holiday_calendar.replaced', 'holiday_calendar.cloned', 'holiday_calendar.deleted')`);
        await queryRunner.query(`ALTER TABLE "audit_logs" ALTER COLUMN "eventType" TYPE "public"."audit_logs_eventtype_enum_old" USING "eventType"::"text"::"public"."audit_logs_eventtype_enum_old"`);
        await queryRunner.query(`DROP TYPE "public"."audit_logs_eventtype_enum"`);
        await queryRunner.query(`ALTER TYPE "public"."audit_logs_eventtype_enum_old" RENAME TO "audit_logs_eventtype_enum"`);
    }

}
