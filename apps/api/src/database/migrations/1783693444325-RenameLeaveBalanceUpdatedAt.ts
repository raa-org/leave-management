import { MigrationInterface, QueryRunner } from "typeorm";

export class RenameLeaveBalanceUpdatedAt1783693444325 implements MigrationInterface {
    name = 'RenameLeaveBalanceUpdatedAt1783693444325'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "leave_balances" RENAME COLUMN "lastUpdatedAt" TO "updatedAt"`);
        await queryRunner.query(`ALTER TABLE "leave_balances" ALTER COLUMN "updatedAt" SET DEFAULT clock_timestamp()`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "leave_balances" ALTER COLUMN "updatedAt" DROP DEFAULT`);
        await queryRunner.query(`ALTER TABLE "leave_balances" RENAME COLUMN "updatedAt" TO "lastUpdatedAt"`);
    }

}
