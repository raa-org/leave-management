import { MigrationInterface, QueryRunner } from "typeorm";

export class HardenClosedSetColumns1783683134312 implements MigrationInterface {
    name = 'HardenClosedSetColumns1783683134312'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "holiday_calendars" DROP CONSTRAINT "FK_521adef4062ef84ff39490f1a91"`);
        await queryRunner.query(`ALTER TABLE "users" DROP CONSTRAINT "FK_a0ed47f0ee7de871cdbcf9d1f93"`);
        await queryRunner.query(`ALTER TABLE "countries" DROP CONSTRAINT "UQ_b47cbb5311bad9c9ae17b8c1eda"`);
        await queryRunner.query(`ALTER TABLE "user_roles" ALTER COLUMN "assignedAt" SET DEFAULT clock_timestamp()`);
        await queryRunner.query(`CREATE UNIQUE INDEX "uq_countries_code" ON "countries" ("code") `);
        await queryRunner.query(`ALTER TABLE "leave_allocations" ADD CONSTRAINT "chk_leave_allocations_leave_type" CHECK ("leaveType" IN ('vacation', 'sick'))`);
        await queryRunner.query(`ALTER TABLE "leave_requests" ADD CONSTRAINT "chk_leave_requests_status" CHECK ("status" IN ('pending', 'approved', 'rejected', 'cancelled'))`);
        await queryRunner.query(`ALTER TABLE "leave_requests" ADD CONSTRAINT "chk_leave_requests_leave_type" CHECK ("leaveType" IN ('vacation', 'sick'))`);
        await queryRunner.query(`ALTER TABLE "leave_approval_decisions" ADD CONSTRAINT "chk_leave_approval_decisions_action" CHECK ("action" IN ('approve', 'reject'))`);
        await queryRunner.query(`ALTER TABLE "leave_balances" ADD CONSTRAINT "chk_leave_balances_leave_type" CHECK ("leaveType" IN ('vacation', 'sick'))`);
        await queryRunner.query(`ALTER TABLE "leave_balance_changes" ADD CONSTRAINT "chk_leave_balance_changes_reason" CHECK ("reason" IN ('accrual', 'hold', 'release', 'spent', 'adjustment'))`);
        await queryRunner.query(`ALTER TABLE "leave_balance_changes" ADD CONSTRAINT "chk_leave_balance_changes_leave_type" CHECK ("leaveType" IN ('vacation', 'sick'))`);
        await queryRunner.query(`ALTER TABLE "leave_request_activities" ADD CONSTRAINT "chk_leave_request_activities_status_at_event" CHECK ("statusAtEvent" IN ('pending', 'approved', 'rejected', 'cancelled'))`);
        await queryRunner.query(`ALTER TABLE "leave_request_approvers" ADD CONSTRAINT "chk_leave_request_approvers_decision" CHECK ("decision" IN ('pending', 'approved', 'rejected'))`);
        await queryRunner.query(`ALTER TABLE "leave_request_approvers" ADD CONSTRAINT "chk_leave_request_approvers_kind" CHECK ("kind" IN ('to', 'cc'))`);
        await queryRunner.query(`ALTER TABLE "leave_settings" ADD CONSTRAINT "chk_leave_settings_carryover_policy" CHECK ("carryoverPolicy" IN ('none', 'capped', 'full'))`);
        await queryRunner.query(`ALTER TABLE "leave_settings" ADD CONSTRAINT "chk_leave_settings_singleton" CHECK ("id" = 1)`);
        await queryRunner.query(`ALTER TABLE "user_roles" ADD CONSTRAINT "chk_user_roles_role_name" CHECK ("roleName" IN ('employee', 'administrator'))`);
        await queryRunner.query(`ALTER TABLE "notification_deliveries" ADD CONSTRAINT "chk_notification_deliveries_status" CHECK ("status" IN ('pending', 'sent', 'failed'))`);
        await queryRunner.query(`ALTER TABLE "holiday_calendars" ADD CONSTRAINT "FK_521adef4062ef84ff39490f1a91" FOREIGN KEY ("countryCode") REFERENCES "countries"("code") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "users" ADD CONSTRAINT "FK_a0ed47f0ee7de871cdbcf9d1f93" FOREIGN KEY ("countryCode") REFERENCES "countries"("code") ON DELETE SET NULL ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "users" DROP CONSTRAINT "FK_a0ed47f0ee7de871cdbcf9d1f93"`);
        await queryRunner.query(`ALTER TABLE "holiday_calendars" DROP CONSTRAINT "FK_521adef4062ef84ff39490f1a91"`);
        await queryRunner.query(`ALTER TABLE "notification_deliveries" DROP CONSTRAINT "chk_notification_deliveries_status"`);
        await queryRunner.query(`ALTER TABLE "user_roles" DROP CONSTRAINT "chk_user_roles_role_name"`);
        await queryRunner.query(`ALTER TABLE "leave_settings" DROP CONSTRAINT "chk_leave_settings_singleton"`);
        await queryRunner.query(`ALTER TABLE "leave_settings" DROP CONSTRAINT "chk_leave_settings_carryover_policy"`);
        await queryRunner.query(`ALTER TABLE "leave_request_approvers" DROP CONSTRAINT "chk_leave_request_approvers_kind"`);
        await queryRunner.query(`ALTER TABLE "leave_request_approvers" DROP CONSTRAINT "chk_leave_request_approvers_decision"`);
        await queryRunner.query(`ALTER TABLE "leave_request_activities" DROP CONSTRAINT "chk_leave_request_activities_status_at_event"`);
        await queryRunner.query(`ALTER TABLE "leave_balance_changes" DROP CONSTRAINT "chk_leave_balance_changes_leave_type"`);
        await queryRunner.query(`ALTER TABLE "leave_balance_changes" DROP CONSTRAINT "chk_leave_balance_changes_reason"`);
        await queryRunner.query(`ALTER TABLE "leave_balances" DROP CONSTRAINT "chk_leave_balances_leave_type"`);
        await queryRunner.query(`ALTER TABLE "leave_approval_decisions" DROP CONSTRAINT "chk_leave_approval_decisions_action"`);
        await queryRunner.query(`ALTER TABLE "leave_requests" DROP CONSTRAINT "chk_leave_requests_leave_type"`);
        await queryRunner.query(`ALTER TABLE "leave_requests" DROP CONSTRAINT "chk_leave_requests_status"`);
        await queryRunner.query(`ALTER TABLE "leave_allocations" DROP CONSTRAINT "chk_leave_allocations_leave_type"`);
        await queryRunner.query(`DROP INDEX "public"."uq_countries_code"`);
        await queryRunner.query(`ALTER TABLE "user_roles" ALTER COLUMN "assignedAt" SET DEFAULT now()`);
        await queryRunner.query(`ALTER TABLE "countries" ADD CONSTRAINT "UQ_b47cbb5311bad9c9ae17b8c1eda" UNIQUE ("code")`);
        await queryRunner.query(`ALTER TABLE "users" ADD CONSTRAINT "FK_a0ed47f0ee7de871cdbcf9d1f93" FOREIGN KEY ("countryCode") REFERENCES "countries"("code") ON DELETE SET NULL ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "holiday_calendars" ADD CONSTRAINT "FK_521adef4062ef84ff39490f1a91" FOREIGN KEY ("countryCode") REFERENCES "countries"("code") ON DELETE RESTRICT ON UPDATE NO ACTION`);
    }

}
