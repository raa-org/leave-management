import { MigrationInterface, QueryRunner } from "typeorm";

export class SetLeaveYearNotNull1783617871202 implements MigrationInterface {
    name = 'SetLeaveYearNotNull1783617871202'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."uq_leave_balances_user_type"`);
        await queryRunner.query(`DROP INDEX "public"."idx_leave_balance_changes_user_type"`);
        await queryRunner.query(`ALTER TABLE "leave_requests" ALTER COLUMN "leaveYear" SET NOT NULL`);
        await queryRunner.query(`ALTER TABLE "leave_balances" ALTER COLUMN "year" SET NOT NULL`);
        await queryRunner.query(`ALTER TABLE "leave_balance_changes" ALTER COLUMN "year" SET NOT NULL`);
        await queryRunner.query(`CREATE UNIQUE INDEX "uq_leave_balances_user_type_year" ON "leave_balances" ("userId", "leaveType", "year") `);
        await queryRunner.query(`CREATE INDEX "idx_leave_balance_changes_user_type" ON "leave_balance_changes" ("userId", "leaveType", "year", "createdAt") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."idx_leave_balance_changes_user_type"`);
        await queryRunner.query(`DROP INDEX "public"."uq_leave_balances_user_type_year"`);
        await queryRunner.query(`ALTER TABLE "leave_balance_changes" ALTER COLUMN "year" DROP NOT NULL`);
        await queryRunner.query(`ALTER TABLE "leave_balances" ALTER COLUMN "year" DROP NOT NULL`);
        await queryRunner.query(`ALTER TABLE "leave_requests" ALTER COLUMN "leaveYear" DROP NOT NULL`);
        await queryRunner.query(`CREATE INDEX "idx_leave_balance_changes_user_type" ON "leave_balance_changes" ("createdAt", "leaveType", "userId") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "uq_leave_balances_user_type" ON "leave_balances" ("leaveType", "userId") `);
    }

}
