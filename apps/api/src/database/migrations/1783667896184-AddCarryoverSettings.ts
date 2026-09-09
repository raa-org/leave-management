import { MigrationInterface, QueryRunner } from "typeorm";

export class AddCarryoverSettings1783667896184 implements MigrationInterface {
    name = 'AddCarryoverSettings1783667896184'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "leave_settings" ADD "carryoverPolicy" character varying NOT NULL DEFAULT 'none'`);
        await queryRunner.query(`ALTER TABLE "leave_settings" ADD "carryoverCapDays" integer NOT NULL DEFAULT '0'`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "leave_settings" DROP COLUMN "carryoverCapDays"`);
        await queryRunner.query(`ALTER TABLE "leave_settings" DROP COLUMN "carryoverPolicy"`);
    }

}
