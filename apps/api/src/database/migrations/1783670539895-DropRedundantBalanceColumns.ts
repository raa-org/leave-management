import { MigrationInterface, QueryRunner } from "typeorm";

export class DropRedundantBalanceColumns1783670539895 implements MigrationInterface {
    name = 'DropRedundantBalanceColumns1783670539895'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "leave_balances" DROP COLUMN "totalDays"`);
        await queryRunner.query(`ALTER TABLE "leave_balances" DROP COLUMN "availableDays"`);
        await queryRunner.query(`ALTER TABLE "leave_balance_changes" DROP COLUMN "availableDays"`);
        await queryRunner.query(`ALTER TABLE "leave_balance_changes" ALTER COLUMN "accruedDays" SET NOT NULL`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "leave_balance_changes" ALTER COLUMN "accruedDays" DROP NOT NULL`);
        await queryRunner.query(`ALTER TABLE "leave_balance_changes" ADD "availableDays" numeric(6,2) NOT NULL`);
        await queryRunner.query(`ALTER TABLE "leave_balances" ADD "availableDays" numeric(6,2) NOT NULL`);
        await queryRunner.query(`ALTER TABLE "leave_balances" ADD "totalDays" numeric(6,2) NOT NULL`);
    }

}
