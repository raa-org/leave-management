import { MigrationInterface, QueryRunner } from "typeorm";

export class AddCarryoverCapMode1785351259965 implements MigrationInterface {
    name = 'AddCarryoverCapMode1785351259965'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TYPE "public"."leave_settings_carryovercapmode_enum" AS ENUM('days', 'percent')`);
        await queryRunner.query(`ALTER TABLE "leave_settings" ADD "carryoverCapMode" "public"."leave_settings_carryovercapmode_enum" NOT NULL DEFAULT 'percent'`);
        await queryRunner.query(`ALTER TABLE "leave_settings" ADD "carryoverCapPercent" integer NOT NULL DEFAULT '50'`);
        await queryRunner.query(`ALTER TABLE "leave_settings" ALTER COLUMN "carryoverPolicy" SET DEFAULT 'capped'`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "leave_settings" ALTER COLUMN "carryoverPolicy" SET DEFAULT 'none'`);
        await queryRunner.query(`ALTER TABLE "leave_settings" DROP COLUMN "carryoverCapPercent"`);
        await queryRunner.query(`ALTER TABLE "leave_settings" DROP COLUMN "carryoverCapMode"`);
        await queryRunner.query(`DROP TYPE "public"."leave_settings_carryovercapmode_enum"`);
    }

}
