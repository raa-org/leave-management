import { MigrationInterface, QueryRunner } from "typeorm";

export class AddUnpaidLeaveDays1785178934950 implements MigrationInterface {
    name = 'AddUnpaidLeaveDays1785178934950'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "leave_requests" ADD "unpaidLeaveDays" text array NOT NULL DEFAULT '{}'`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "leave_requests" DROP COLUMN "unpaidLeaveDays"`);
    }

}
