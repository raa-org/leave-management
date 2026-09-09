import { MigrationInterface, QueryRunner } from "typeorm";

export class AddCarryoverLedgerReasons1785342374258 implements MigrationInterface {
    name = 'AddCarryoverLedgerReasons1785342374258'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TYPE "public"."leave_balance_changes_reason_enum" RENAME TO "leave_balance_changes_reason_enum_old"`);
        await queryRunner.query(`CREATE TYPE "public"."leave_balance_changes_reason_enum" AS ENUM('accrual', 'hold', 'release', 'spent', 'adjustment', 'carryover_in', 'carryover_out', 'expired')`);
        await queryRunner.query(`ALTER TABLE "leave_balance_changes" ALTER COLUMN "reason" TYPE "public"."leave_balance_changes_reason_enum" USING "reason"::"text"::"public"."leave_balance_changes_reason_enum"`);
        await queryRunner.query(`DROP TYPE "public"."leave_balance_changes_reason_enum_old"`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TYPE "public"."leave_balance_changes_reason_enum_old" AS ENUM('accrual', 'hold', 'release', 'spent', 'adjustment')`);
        await queryRunner.query(`ALTER TABLE "leave_balance_changes" ALTER COLUMN "reason" TYPE "public"."leave_balance_changes_reason_enum_old" USING "reason"::"text"::"public"."leave_balance_changes_reason_enum_old"`);
        await queryRunner.query(`DROP TYPE "public"."leave_balance_changes_reason_enum"`);
        await queryRunner.query(`ALTER TYPE "public"."leave_balance_changes_reason_enum_old" RENAME TO "leave_balance_changes_reason_enum"`);
    }

}
