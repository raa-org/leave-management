import { MigrationInterface, QueryRunner } from "typeorm";

export class AddLedgerAccruedSnapshot1783670305248 implements MigrationInterface {
    name = 'AddLedgerAccruedSnapshot1783670305248'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "leave_balance_changes" ADD "accruedDays" numeric(6,2)`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "leave_balance_changes" DROP COLUMN "accruedDays"`);
    }

}
