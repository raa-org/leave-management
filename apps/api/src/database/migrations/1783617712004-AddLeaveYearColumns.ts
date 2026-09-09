import { MigrationInterface, QueryRunner } from "typeorm";

export class AddLeaveYearColumns1783617712004 implements MigrationInterface {
    name = 'AddLeaveYearColumns1783617712004'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "leave_requests" ADD "leaveYear" integer`);
        await queryRunner.query(`ALTER TABLE "leave_balances" ADD "year" integer`);
        await queryRunner.query(`ALTER TABLE "leave_balance_changes" ADD "year" integer`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "leave_balance_changes" DROP COLUMN "year"`);
        await queryRunner.query(`ALTER TABLE "leave_balances" DROP COLUMN "year"`);
        await queryRunner.query(`ALTER TABLE "leave_requests" DROP COLUMN "leaveYear"`);
    }

}
