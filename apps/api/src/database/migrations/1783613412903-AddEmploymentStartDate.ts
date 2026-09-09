import { MigrationInterface, QueryRunner } from "typeorm";

export class AddEmploymentStartDate1783613412903 implements MigrationInterface {
    name = 'AddEmploymentStartDate1783613412903'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "users" ADD "employmentStartDate" date`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "users" DROP COLUMN "employmentStartDate"`);
    }

}
