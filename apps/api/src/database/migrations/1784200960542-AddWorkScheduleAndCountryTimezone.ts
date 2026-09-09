import { MigrationInterface, QueryRunner } from "typeorm";

export class AddWorkScheduleAndCountryTimezone1784200960542 implements MigrationInterface {
    name = 'AddWorkScheduleAndCountryTimezone1784200960542'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "countries" ADD "timezone" character varying`);
        await queryRunner.query(`ALTER TABLE "users" ADD "workdayStartTime" character varying`);
        await queryRunner.query(`ALTER TABLE "users" ADD "workdayEndTime" character varying`);
        await queryRunner.query(`ALTER TABLE "leave_settings" ADD "workdayStartTime" character varying NOT NULL DEFAULT '10:00'`);
        await queryRunner.query(`ALTER TABLE "leave_settings" ADD "workdayEndTime" character varying NOT NULL DEFAULT '19:00'`);
        await queryRunner.query(`ALTER TABLE "leave_settings" ADD "defaultTimezone" character varying NOT NULL DEFAULT 'Europe/Kyiv'`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "leave_settings" DROP COLUMN "defaultTimezone"`);
        await queryRunner.query(`ALTER TABLE "leave_settings" DROP COLUMN "workdayEndTime"`);
        await queryRunner.query(`ALTER TABLE "leave_settings" DROP COLUMN "workdayStartTime"`);
        await queryRunner.query(`ALTER TABLE "users" DROP COLUMN "workdayEndTime"`);
        await queryRunner.query(`ALTER TABLE "users" DROP COLUMN "workdayStartTime"`);
        await queryRunner.query(`ALTER TABLE "countries" DROP COLUMN "timezone"`);
    }

}
